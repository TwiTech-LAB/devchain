import { Inject, Injectable } from '@nestjs/common';
import { ConflictError, NotFoundError } from '../../../common/errors/error-types';
import { ProviderAuthVaultService } from '../../provider-auth/provider-auth-vault.service';
import { STORAGE_SERVICE, type RemoteStorage } from '../../storage/interfaces/storage.interface';
import type { RemoteOperation } from '../../storage/models/domain.models';
import { RemoteOperationRunner } from './remote-operation.runner';
import { RemoteOperationsService } from './remote-operations.service';
import {
  createVmSchemaForNamePrefix,
  type DestroyVmData,
  type ResetVmData,
} from './vm-operations.dto';
import type { CreateVmDetails } from './create-vm.operation';
import type { ResetVmDetails } from './reset-vm.operation';
import type { DestroyVmDetails } from './destroy-vm.operation';
import type { ClaimDetails, ClaimProviderState } from './claim.operation';
import { VmProvidersService } from '../../vm-providers/vm-providers.service';
import { stepStarted } from './remote-operation.types';
import { CLAIM_IDENTITY_KINDS } from '../home-identity';
import { ProxmoxVmLifecycleService } from '../../vm-providers/proxmox-vm-lifecycle.service';
import { REMOTE_HEALTH_PORT, type RemoteHealthPort } from '../ports/remote-health.port';
import { createLogger } from '../../../common/logging/logger';

const logger = createLogger('VmOperationsService');

@Injectable()
export class VmOperationsService {
  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: RemoteStorage,
    private readonly runner: RemoteOperationRunner,
    private readonly operations: RemoteOperationsService,
    private readonly vault: ProviderAuthVaultService,
    private readonly providers: VmProvidersService,
    private readonly lifecycle: ProxmoxVmLifecycleService,
    @Inject(REMOTE_HEALTH_PORT) private readonly health: RemoteHealthPort,
  ) {}

  /**
   * Starts a stopped managed VM. The ownership guard resolves the VMID, as
   * destroy does, because the lifecycle start trusts any VMID it is given.
   * DevChain on the VM needs a while to boot; health follows it.
   */
  async powerOn(remoteId: string): Promise<{ powerState: 'running' }> {
    const remote = await this.storage.getRemote(remoteId);
    if (remote.kind !== 'proxmox' || !remote.vmProviderConnectionId || !remote.vmIdentity) {
      throw new ConflictError('Only a registered managed VM can be powered on.', {
        code: 'REMOTE_NOT_VM_MANAGED',
        remoteId,
      });
    }
    await this.operations.assertNoOpenHostOperation(remoteId);
    const provider = await this.providers.forConnection(remote.vmProviderConnectionId);
    const vmid = await provider.assertOwnedVmIdentity(remote.vmIdentity);
    await this.lifecycle.start(remote.vmProviderConnectionId, vmid);
    // Not awaited: the first poll usually fails while DevChain boots.
    this.health.refresh(remoteId).catch((error: unknown) => {
      logger.warn({ err: error, remoteId }, 'Health refresh after power on failed');
    });
    return { powerState: 'running' };
  }

  async create(connectionId: string, request: unknown): Promise<RemoteOperation> {
    const connection = await this.storage.getVmProviderConnection(connectionId);
    const input = createVmSchemaForNamePrefix(connection.namePrefix).parse(request);
    const claim = await this.operations.claimDetails({
      bootstrapUrl: '',
      providerAuth: input.providerAuth,
      installDocker: input.installDocker,
      sshPublicKeys: input.sshPublicKeys,
      port: input.port,
    });
    const spec = { cores: input.cores, memory: input.memory, disk: input.disk };
    const remote = await this.storage.createRemote({
      name: input.name,
      kind: 'proxmox',
      baseUrl: null,
      vmProviderConnectionId: connectionId,
      vmIdentity: null,
      vmSpec: spec,
    });
    const details: CreateVmDetails = {
      ...claim,
      connectionId,
      spec,
      vmName: `${connection.namePrefix}${input.name}`,
    };
    try {
      return await this.runner.start({
        kind: 'create_vm',
        remoteId: remote.id,
        projectId: null,
        details: details as unknown as Record<string, unknown>,
      });
    } catch (error) {
      await this.storage.deleteRemote(remote.id);
      throw error;
    }
  }

  async reset(remoteId: string, input: ResetVmData): Promise<RemoteOperation> {
    const remote = await this.storage.getRemote(remoteId);
    if (
      remote.kind !== 'proxmox' ||
      !remote.vmProviderConnectionId ||
      !remote.vmIdentity ||
      !remote.vmSpec
    ) {
      throw new ConflictError('Only a registered Proxmox VM can be reset.');
    }
    await this.operations.assertNoOpenHostOperation(remoteId);
    const [bindings, families, lastClaims] = await Promise.all([
      this.storage.listRemoteProjectBindings(),
      this.vault.familiesOfRemote(remoteId),
      this.storage.listRemoteOperations({
        remoteId,
        kinds: CLAIM_IDENTITY_KINDS,
        states: ['done'],
        limit: 1,
      }),
    ]);
    const attached = bindings.filter((binding) => binding.remoteId === remoteId);
    if (attached.some((binding) => binding.state !== 'remote')) {
      throw new ConflictError('All projects must finish connecting or disconnecting before reset.');
    }
    const projectIds = attached.map((binding) => binding.projectId);
    const openProjectOperations = await Promise.all(
      projectIds.map((projectId) =>
        this.storage.listRemoteOperations({ projectId, states: ['running', 'failed'], limit: 1 }),
      ),
    );
    if (openProjectOperations.some((items) => items.length > 0)) {
      throw new ConflictError('Finish or cancel the open project operation before reset.');
    }
    const familyIds = new Map<string, string[]>();
    for (const family of families) {
      familyIds.set(family.provider, [...(familyIds.get(family.provider) ?? []), family.entryId]);
    }
    const dockerEnabled = await this.operations.lastInstallDockerChoice(remoteId);
    const previous = lastClaims[0]?.details as unknown as ClaimDetails | undefined;
    const entryIds = await this.rememberedEntries(previous, familyIds, input.providerAuth);
    for (const [provider, ids] of familyIds) {
      entryIds.set(provider, [...new Set([...(entryIds.get(provider) ?? []), ...ids])]);
    }
    const defaults = Object.fromEntries(
      [...entryIds]
        .filter(([, ids]) => ids.length > 0)
        .map(([provider, ids]) => [provider, `reuse:${ids[0]}`]),
    );
    const claim = await this.operations.claimDetails({
      bootstrapUrl: '',
      providerAuth: { ...defaults, ...input.providerAuth },
      port: input.port ?? previous?.port,
      installDocker: input.installDocker ?? dockerEnabled ?? previous?.installDocker,
      sshPublicKeys: input.sshPublicKeys ?? previous?.sshPublicKeys,
    });
    for (const [provider, ids] of entryIds) {
      if (input.providerAuth[provider] === undefined && claim.providerAuth[provider]) {
        claim.providerAuth[provider].entryIds = ids;
      }
    }
    const owned = await (
      await this.providers.forConnection(remote.vmProviderConnectionId)
    ).getOwnedVm(remote.vmIdentity);
    const details: ResetVmDetails = {
      ...claim,
      connectionId: remote.vmProviderConnectionId,
      vmName: owned.name,
      spec: remote.vmSpec,
      oldIdentity: remote.vmIdentity,
      projectIds,
      force: input.force,
    };
    return this.runner.start({
      kind: 'reset_vm',
      remoteId,
      projectId: null,
      details: details as unknown as Record<string, unknown>,
    });
  }

  private async rememberedEntries(
    previous: ClaimDetails | undefined,
    familyIds: Map<string, string[]>,
    overrides: Readonly<Record<string, unknown>>,
  ): Promise<Map<string, string[]>> {
    const remembered = new Map<string, string[]>();
    const states = previous?.providerAuth;
    if (!states || typeof states !== 'object' || Array.isArray(states)) return remembered;
    for (const [provider, rawState] of Object.entries(states)) {
      if (overrides[provider] !== undefined) continue;
      const state = rawState as ClaimProviderState | null;
      if (!state || !Array.isArray(state.entryIds)) continue;
      for (const entryId of state.entryIds) {
        if (typeof entryId !== 'string') continue;
        try {
          const entry = await this.vault.get(entryId);
          if (entry.provider !== provider) continue;
          if (entry.kind === 'family' && !familyIds.get(provider)?.includes(entryId)) continue;
          remembered.set(provider, [...(remembered.get(provider) ?? []), entryId]);
        } catch (error) {
          if (!(error instanceof NotFoundError)) throw error;
        }
      }
    }
    return remembered;
  }

  async destroy(remoteId: string, input: DestroyVmData): Promise<RemoteOperation> {
    const remote = await this.storage.getRemote(remoteId);
    if (remote.kind !== 'proxmox' || !remote.vmProviderConnectionId) {
      throw new ConflictError('Only a registered managed VM can be destroyed.', {
        code: 'REMOTE_NOT_VM_MANAGED',
        remoteId,
      });
    }
    const bindings = await this.storage.listRemoteProjectBindings();
    if (bindings.some((binding) => binding.remoteId === remoteId)) {
      throw new ConflictError('Disconnect every project before destroying its VM.', {
        code: 'REMOTE_HAS_PROJECT_BINDINGS',
        remoteId,
      });
    }
    const superseded = await this.runner.supersedeFailedVmOperation(remoteId);
    if (!remote.vmIdentity && !superseded) {
      throw new ConflictError('Only a registered managed VM can be destroyed.', {
        code: 'REMOTE_NOT_VM_MANAGED',
        remoteId,
      });
    }
    await this.operations.assertNoOpenHostOperation(remoteId);
    const failed = superseded?.details as unknown as CreateVmDetails | ResetVmDetails | undefined;
    const staleOldIdentity =
      superseded?.kind === 'reset_vm' &&
      superseded.steps.some((step) => step.id === 'destroy' && step.state === 'done') &&
      remote.vmIdentity === (failed as ResetVmDetails).oldIdentity;
    const vmIdentity = staleOldIdentity ? null : remote.vmIdentity;
    const cloneStep = superseded?.kind === 'create_vm' ? 'clone' : 'create_clone';
    const targetVmid =
      !vmIdentity &&
      superseded &&
      stepStarted(superseded, cloneStep) &&
      Number.isInteger(failed?.vmid)
        ? failed?.vmid
        : undefined;
    const details: DestroyVmDetails = {
      connectionId: remote.vmProviderConnectionId,
      vmIdentity,
      expectedRemoteIdentity: remote.vmIdentity,
      targetVmid,
      targetVmName: targetVmid === undefined ? undefined : failed?.vmName,
      supersededOperationId: superseded?.id,
      force: input.force,
    };
    return this.runner.start({
      kind: 'destroy_vm',
      remoteId,
      projectId: null,
      details: details as unknown as Record<string, unknown>,
    });
  }
}
