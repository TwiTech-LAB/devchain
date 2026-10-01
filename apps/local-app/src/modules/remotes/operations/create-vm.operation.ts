import { Inject, Injectable } from '@nestjs/common';
import { ProxmoxRemoteError } from '@devchain/proxmox-client';
import { getEnvConfig } from '../../../common/config/env.config';
import {
  BUILT_IN_HOST_IMAGE,
  selectHostImageSource,
  type BuiltInHostImage,
  type HostImageEnvironment,
} from '../../../common/config/host-image.config';
import { ConflictError } from '../../../common/errors/error-types';
import { STORAGE_SERVICE, type RemoteStorage } from '../../storage/interfaces/storage.interface';
import type { RemoteOperation, VmSpec } from '../../storage/models/domain.models';
import {
  ProxmoxVmLifecycleService,
  type HostImage,
} from '../../vm-providers/proxmox-vm-lifecycle.service';
import { VmProvidersService } from '../../vm-providers/vm-providers.service';
import { ClaimOperation, type ClaimDetails } from './claim.operation';
import { MIN_VM_MEMORY_MIB } from './vm-operations.dto';
import { RemoteOperationStepRefusedError } from './remote-operation.errors';
import { RemoteHostClient } from './remote-host.client';
import { sleep } from './remote-operation.timing';
import {
  type RemoteOperationDefinition,
  type RemoteOperationStepDefinition,
  type RemoteOperationStepRun,
  stepStarted,
  prefixSteps,
  withStepPrefix,
} from './remote-operation.types';

export interface CreateVmDetails extends ClaimDetails {
  connectionId: string;
  vmName: string;
  spec: VmSpec;
  image?: HostImage;
  templateVmid?: number;
  vmid?: number;
  imageVolid?: string;
  vmIdentity?: string;
}

const BOOTSTRAP_READY_TIMEOUT_MS = 60_000;

export function resolveCreateVmImage(
  lifecycle: Pick<ProxmoxVmLifecycleService, 'image'>,
  environment: HostImageEnvironment,
  builtInImage: BuiltInHostImage | null = BUILT_IN_HOST_IMAGE,
): HostImage | null {
  const source = selectHostImageSource(environment, builtInImage);
  if (!source) return null;
  const image = lifecycle.image(source.url, source.sha256);
  if (source.version && source.version !== image.version) {
    throw new ConflictError('The built-in host image version does not match its URL.');
  }
  return image;
}

@Injectable()
export class CreateVmOperation implements RemoteOperationDefinition {
  readonly kind = 'create_vm' as const;
  readonly steps: readonly RemoteOperationStepDefinition[];

  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: RemoteStorage,
    private readonly lifecycle: ProxmoxVmLifecycleService,
    private readonly providers: VmProvidersService,
    private readonly claim: ClaimOperation,
    private readonly host: RemoteHostClient,
  ) {
    this.steps = [
      {
        id: 'vm_preflight',
        label: 'Check VM settings and permissions',
        run: (c) => this.preflight(c),
      },
      { id: 'ensure_image', label: 'Import the host image', run: (c) => this.ensureImage(c) },
      {
        id: 'ensure_template',
        label: 'Prepare the image template',
        run: (c) => this.ensureTemplate(c),
      },
      { id: 'clone', label: 'Clone the VM', run: (c) => this.clone(c) },
      { id: 'configure', label: 'Configure VM resources', run: (c) => this.configure(c) },
      { id: 'start', label: 'Start the VM', run: (c) => this.start(c) },
      { id: 'wait_ip', label: 'Wait for the guest IP address', run: (c) => this.waitIp(c) },
      ...prefixSteps(claim.steps, 'claim_'),
    ];
  }

  assertCancellable(operation: RemoteOperation): void {
    if (stepStarted(operation, 'claim_claim'))
      this.claim.assertCancellable(claimOperation(operation));
  }

  interrupt(id: string): Promise<void> {
    return this.claim.interrupt(id);
  }
  forget(id: string): void {
    this.claim.forget(id);
  }

  retryFrom(operation: RemoteOperation): string | null {
    const failed = operation.steps.find((step) => step.state === 'failed');
    if (failed?.error?.code === 'VMID_TAKEN') return 'vm_preflight';
    const retry = this.claim.retryFrom(claimOperation(operation));
    return retry ? `claim_${retry}` : null;
  }

  async rollback(operation: RemoteOperation): Promise<Record<string, unknown>> {
    await this.rollbackNewVm(operation);
    // The operation row references this remote; deleting it would erase the
    // cancellation record through the database's cascade.
    return { vmCleanedUp: true };
  }

  async rollbackNewVm(operation: RemoteOperation): Promise<void> {
    await this.claim.rollback(claimOperation(operation));
    const details = operation.details as unknown as CreateVmDetails;
    if (details.vmid) {
      await this.lifecycle.destroyCreated(
        details.connectionId,
        details.vmid,
        details.vmName,
        operation.id,
      );
    }
  }

  private async preflight({ details }: RemoteOperationStepRun): Promise<void> {
    const vm = details as unknown as CreateVmDetails;
    if (
      !Number.isInteger(vm.spec.cores) ||
      vm.spec.cores < 1 ||
      !Number.isInteger(vm.spec.memory) ||
      vm.spec.memory < MIN_VM_MEMORY_MIB ||
      !Number.isInteger(vm.spec.disk) ||
      vm.spec.disk < 1
    ) {
      throw new RemoteOperationStepRefusedError(
        'VM_RESOURCES_INVALID',
        'VM creation needs at least one core, 4096 MiB of memory for the claim/update install, and one GiB of disk.',
      );
    }
    const config = getEnvConfig();
    const image = vm.image ?? resolveCreateVmImage(this.lifecycle, config);
    if (!image) {
      throw new RemoteOperationStepRefusedError(
        'HOST_IMAGE_NOT_CONFIGURED',
        'No host image is configured; set both HOST_IMAGE_URL and HOST_IMAGE_SHA256 or publish a built-in image entry.',
      );
    }
    await this.lifecycle.assertReachable(image);
    const permissions = await this.providers.checkPermissions(vm.connectionId);
    if (!permissions.ok) {
      throw new RemoteOperationStepRefusedError(
        'PROXMOX_PERMISSIONS_MISSING',
        `Proxmox permissions: ${permissions.missing.join(', ')}.`,
      );
    }
    const ids = await this.lifecycle.plan(vm.connectionId, image);
    Object.assign(vm, { image, ...ids });
  }

  private async ensureImage({ details }: RemoteOperationStepRun): Promise<void> {
    const vm = checked(details);
    vm.imageVolid = await this.lifecycle.ensureImage(vm.connectionId, vm.image!);
  }

  private async ensureTemplate({ details }: RemoteOperationStepRun): Promise<void> {
    const vm = checked(details);
    try {
      vm.templateVmid = await this.lifecycle.ensureTemplate(
        vm.connectionId,
        vm.image!,
        vm.templateVmid!,
        vm.imageVolid!,
      );
    } catch (error) {
      refuseVmidTaken(error);
    }
  }

  private async clone({ operation, details }: RemoteOperationStepRun): Promise<void> {
    const vm = checked(details);
    // A saved certificate belongs to the VM of an earlier clone; wait_ip reads it again.
    delete vm.tlsCertificate;
    try {
      vm.vmIdentity = await this.lifecycle.clone(
        vm.connectionId,
        vm.templateVmid!,
        vm.vmid!,
        vm.vmName,
        operation.id,
      );
    } catch (error) {
      refuseVmidTaken(error);
    }
    await this.storage.updateRemoteVmIdentity(operation.remoteId, vm.vmIdentity);
  }

  private async configure({ details }: RemoteOperationStepRun): Promise<void> {
    const vm = checked(details);
    await this.lifecycle.configure(vm.connectionId, vm.vmid!, vm.spec);
  }

  private async start({ details }: RemoteOperationStepRun): Promise<void> {
    const vm = checked(details);
    await this.lifecycle.start(vm.connectionId, vm.vmid!);
  }

  private async waitIp({ operation, details, progress }: RemoteOperationStepRun): Promise<void> {
    const vm = checked(details);
    const address = await this.lifecycle.waitIp(vm.connectionId, vm.vmid!, vm.port);
    await this.storage.updateRemoteBaseUrl(operation.remoteId, address.address);
    vm.bootstrapUrl = address.bootstrapUrl;
    const deadline = Date.now() + BOOTSTRAP_READY_TIMEOUT_MS;
    if (!vm.tlsCertificate) {
      vm.tlsCertificate = await this.readCertificate(vm, deadline);
      await progress({ tlsCertificate: vm.tlsCertificate });
    }
    await this.storage.updateRemoteTlsCertificate(operation.remoteId, vm.tlsCertificate);
    for (;;) {
      try {
        await this.host.runtimeAt(address.bootstrapUrl, vm.tlsCertificate);
        return;
      } catch {
        if (Date.now() >= deadline) {
          throw new RemoteOperationStepRefusedError(
            'VM_BOOTSTRAP_TIMEOUT',
            'The VM reported an IP address, but its bootstrap did not answer within 60 seconds.',
          );
        }
        await sleep(Math.min(2_000, deadline - Date.now()));
      }
    }
  }

  /** Home trusts only a certificate read over the pinned Proxmox API, never one the VM shows. */
  private async readCertificate(vm: CreateVmDetails, deadline: number): Promise<string> {
    for (;;) {
      let certificate: string | null;
      try {
        certificate = await this.lifecycle.readCertificate(vm.connectionId, vm.vmid!);
      } catch (error) {
        if (error instanceof ProxmoxRemoteError && error.code === 'proxmox_denied') {
          throw new RemoteOperationStepRefusedError(
            'PROXMOX_PERMISSIONS_MISSING',
            'Proxmox refused to read the VM certificate through the guest agent; grant VM.GuestAgent.FileRead (PVE 9) or VM.Monitor (PVE 8) on the pool.',
          );
        }
        throw error;
      }
      if (certificate) return certificate;
      if (Date.now() >= deadline) {
        throw new RemoteOperationStepRefusedError(
          'VM_CERTIFICATE_TIMEOUT',
          'The VM reported an IP address, but the guest agent could not read its TLS certificate within 60 seconds. Check that the VM runs a supported host image.',
        );
      }
      await sleep(Math.min(2_000, deadline - Date.now()));
    }
  }
}

/** A taken VMID is a refusal the runner retries with a new plan; anything else propagates. */
function refuseVmidTaken(error: unknown): never {
  if (error instanceof ConflictError && error.details?.code === 'VMID_TAKEN') {
    throw new RemoteOperationStepRefusedError('VMID_TAKEN', error.message);
  }
  throw error;
}

function checked(details: Record<string, unknown>): CreateVmDetails {
  const vm = details as unknown as CreateVmDetails;
  if (!vm.image || !vm.vmid || !vm.templateVmid) {
    throw new ConflictError('VM preflight did not finish; retry it before this step.');
  }
  return vm;
}

function claimOperation(operation: RemoteOperation): RemoteOperation {
  return withStepPrefix(operation, 'claim_');
}
