import { DockerImportInventoryStore } from './docker-import-inventory.store';
import { Inject, Injectable } from '@nestjs/common';
import { ConflictError } from '../../../common/errors/error-types';
import { STORAGE_SERVICE, type RemoteStorage } from '../../storage/interfaces/storage.interface';
import type { RemoteOperation } from '../../storage/models/domain.models';
import {
  ProviderAuthWritebackService,
  type PullFamiliesResult,
} from '../../provider-auth/provider-auth-writeback.service';
import { VmProvidersService } from '../../vm-providers/vm-providers.service';
import { AttachOperation } from './attach.operation';
import { CreateVmOperation, type CreateVmDetails } from './create-vm.operation';
import { DetachOperation, type DetachDetails } from './detach.operation';
import { RemoteOperationStepRefusedError } from './remote-operation.errors';
import { destroyGuardedVm } from './guarded-vm-destroy';
import { MIN_VM_MEMORY_MIB } from './vm-operations.dto';
import {
  stepStarted,
  type RemoteOperationDefinition,
  type RemoteOperationStepDefinition,
  type RemoteOperationStepRun,
  prefixSteps,
  withStepPrefix,
} from './remote-operation.types';

export interface ResetVmDetails extends CreateVmDetails {
  oldIdentity: string;
  projectIds: string[];
  force: boolean;
  familyPull?: PullFamiliesResult;
  oldVmid?: number;
  oldDestroyAttempted?: boolean;
  detachDetails?: Record<string, DetachDetails>;
  attachDetails?: Record<string, Record<string, unknown>>;
  forcedLoss?: Array<{
    projectId: string;
    detach: DetachDetails['forcedLoss'];
    families: PullFamiliesResult['families'];
  }>;
}

@Injectable()
export class ResetVmOperation implements RemoteOperationDefinition {
  readonly kind = 'reset_vm' as const;
  readonly steps: readonly RemoteOperationStepDefinition[] = [];

  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: RemoteStorage,
    private readonly providers: VmProvidersService,
    private readonly writeback: ProviderAuthWritebackService,
    private readonly detach: DetachOperation,
    private readonly create: CreateVmOperation,
    private readonly attach: AttachOperation,
    private readonly inventory: DockerImportInventoryStore,
  ) {}

  stepsFor(raw: Record<string, unknown>): readonly RemoteOperationStepDefinition[] {
    const details = raw as unknown as ResetVmDetails;
    return [
      { id: 'preflight', label: 'Check the VM', run: (c) => this.preflight(c) },
      {
        id: 'pull_families',
        label: 'Save the logins from the VM',
        run: (c) => this.pullFamilies(c),
      },
      ...details.projectIds.flatMap((projectId) =>
        this.detach
          .stepsFor({ force: details.force })
          .map((step) => this.projectStep('detach', projectId, step, details.force)),
      ),
      {
        id: 'record_loss',
        label: 'Record what the forced reset loses',
        run: (c) => this.recordLoss(c),
      },
      { id: 'destroy', label: 'Destroy the old VM', run: (c) => this.destroy(c) },
      ...prefixSteps(this.create.steps, 'create_'),
      ...details.projectIds.flatMap((projectId) =>
        this.attach.steps.map((step) => this.projectStep('attach', projectId, step, false)),
      ),
    ];
  }

  assertCancellable(operation: RemoteOperation): void {
    if (
      operation.steps.some(
        (step) =>
          step.id.startsWith('detach:') && step.state !== 'pending' && step.state !== 'skipped',
      ) ||
      stepStarted(operation, 'destroy')
    ) {
      throw new ConflictError(
        'Reset has begun moving projects or destroying the VM; retry it instead.',
        {
          code: 'REMOTE_OPERATION_NOT_CANCELLABLE',
          operationId: operation.id,
        },
      );
    }
  }

  async interrupt(id: string): Promise<void> {
    await this.attach.interrupt(id);
    await this.detach.interrupt(id);
    await this.create.interrupt(id);
  }
  forget(id: string): void {
    this.create.forget(id);
    this.attach.forget(id);
  }
  retryFrom(operation: RemoteOperation): string | null {
    const from = this.create.retryFrom(createOperation(operation));
    return from ? `create_${from}` : null;
  }
  async rollback(operation: RemoteOperation): Promise<void> {
    await this.create.rollbackNewVm(createOperation(operation));
  }

  private async preflight({ operation, details }: RemoteOperationStepRun): Promise<void> {
    const reset = details as unknown as ResetVmDetails;
    const remote = await this.storage.getRemote(operation.remoteId);
    if (
      remote.kind !== 'proxmox' ||
      remote.vmProviderConnectionId !== reset.connectionId ||
      !remote.vmIdentity ||
      remote.vmIdentity !== reset.oldIdentity
    ) {
      throw new RemoteOperationStepRefusedError(
        'RESET_TARGET_CHANGED',
        'The managed VM changed after reset was requested.',
      );
    }
    if (reset.spec.memory < MIN_VM_MEMORY_MIB) {
      throw new RemoteOperationStepRefusedError(
        'VM_MEMORY_TOO_SMALL',
        'Reset needs 4096 MiB of memory for the claim/update install.',
      );
    }
    const current = (await this.storage.listRemoteProjectBindings()).filter(
      (binding) => binding.remoteId === operation.remoteId,
    );
    if (
      current.length !== reset.projectIds.length ||
      current.some(
        (binding) => binding.state !== 'remote' || !reset.projectIds.includes(binding.projectId),
      )
    ) {
      throw new RemoteOperationStepRefusedError(
        'RESET_BINDINGS_CHANGED',
        'The connected projects changed after reset was requested.',
      );
    }
    for (const projectId of reset.projectIds) {
      const open = await this.storage.listRemoteOperations({
        projectId,
        states: ['running', 'failed'],
        limit: 1,
      });
      if (open.length > 0) {
        throw new RemoteOperationStepRefusedError(
          'RESET_PROJECT_OPERATION_OPEN',
          'A project operation is still open; finish it before reset.',
        );
      }
    }
  }

  private async pullFamilies({ operation, details }: RemoteOperationStepRun): Promise<void> {
    const reset = details as unknown as ResetVmDetails;
    reset.familyPull = await this.writeback.pullFamiliesNow(operation.remoteId);
    if (!reset.familyPull.pulled && !reset.force) {
      throw new RemoteOperationStepRefusedError(
        'REMOTE_OFFLINE',
        'The remote did not answer the final provider login pull; choose forced reset to use the last stored logins.',
      );
    }
  }

  private async recordLoss({ details }: RemoteOperationStepRun): Promise<void> {
    const reset = details as unknown as ResetVmDetails;
    reset.forcedLoss = reset.projectIds.flatMap((projectId) => {
      const loss = reset.detachDetails?.[projectId]?.forcedLoss;
      return loss ? [{ projectId, detach: loss, families: reset.familyPull?.families ?? [] }] : [];
    });
  }

  private async destroy({ operation, details }: RemoteOperationStepRun): Promise<void> {
    const reset = details as unknown as ResetVmDetails;
    await destroyGuardedVm({
      storage: this.storage,
      providers: this.providers,
      operation,
      details,
      connectionId: reset.connectionId,
      vmIdentity: reset.oldIdentity,
      vmidKey: 'oldVmid',
      attemptKey: 'oldDestroyAttempted',
    });
    this.inventory.deleteRemote(operation.remoteId);
    await this.storage.updateRemoteBaseUrl(operation.remoteId, null);
    await this.storage.updateRemoteVmIdentity(operation.remoteId, null);
    await this.storage.updateRemoteTlsCertificate(operation.remoteId, null);
  }

  private projectStep(
    phase: 'detach' | 'attach',
    projectId: string,
    step: RemoteOperationStepDefinition,
    force: boolean,
  ): RemoteOperationStepDefinition {
    const id = `${phase}:${projectId}:${step.id}`;
    return {
      id,
      label: `${phase === 'detach' ? 'Disconnect' : 'Reconnect'} ${projectId}: ${step.label}`,
      skip: step.skip ? () => step.skip!({ force }) : undefined,
      run: async (run) => {
        const reset = run.details as unknown as ResetVmDetails;
        const group =
          phase === 'detach' ? (reset.detachDetails ??= {}) : (reset.attachDetails ??= {});
        const nested = (group[projectId] ??
          (group[projectId] = phase === 'detach' ? { force } : {})) as Record<string, unknown>;
        const prefix = `${phase}:${projectId}:`;
        const synthetic: RemoteOperation = {
          ...withStepPrefix(run.operation, prefix),
          projectId,
          details: nested,
        };
        await step.run({
          operation: synthetic,
          details: nested,
          progress: (patch) => {
            Object.assign(nested, patch);
            return run.progress({
              [phase === 'detach' ? 'detachDetails' : 'attachDetails']: {
                ...group,
                [projectId]: nested,
              },
            });
          },
        });
      },
    };
  }
}

function createOperation(operation: RemoteOperation): RemoteOperation {
  return withStepPrefix(operation, 'create_');
}
