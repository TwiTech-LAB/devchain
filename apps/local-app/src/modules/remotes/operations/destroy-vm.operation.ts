import { Inject, Injectable } from '@nestjs/common';
import { ConflictError, NotFoundError } from '../../../common/errors/error-types';
import { createLogger } from '../../../common/logging/logger';
import {
  ProviderAuthWritebackService,
  type PullFamiliesResult,
} from '../../provider-auth/provider-auth-writeback.service';
import { STORAGE_SERVICE, type RemoteStorage } from '../../storage/interfaces/storage.interface';
import type { RemoteOperation } from '../../storage/models/domain.models';
import { ProxmoxVmLifecycleService } from '../../vm-providers/proxmox-vm-lifecycle.service';
import { VmProvidersService } from '../../vm-providers/vm-providers.service';
import { destroyGuardedVm, destroyGuardedVmid } from './guarded-vm-destroy';
import { RemoteOperationStepRefusedError } from './remote-operation.errors';
import {
  stepStarted,
  type RemoteOperationDefinition,
  type RemoteOperationStepDefinition,
  type RemoteOperationStepRun,
} from './remote-operation.types';

const logger = createLogger('DestroyVmOperation');

export interface DestroyVmDetails {
  connectionId: string;
  vmIdentity: string | null;
  expectedRemoteIdentity: string | null;
  /**
   * A superseded create/reset's planned clone. The pool, tag, prefix and range
   * guard matches every managed VM, so only this name plus the operation's clone
   * marker identify the clone.
   */
  targetVmid?: number;
  targetVmName?: string;
  supersededOperationId?: string;
  force: boolean;
  vmid?: number;
  destroyAttempted?: boolean;
  familyPull?: PullFamiliesResult;
}

@Injectable()
export class DestroyVmOperation implements RemoteOperationDefinition {
  readonly kind = 'destroy_vm' as const;
  readonly steps: readonly RemoteOperationStepDefinition[] = [
    {
      id: 'preflight',
      label: 'Check VM ownership and projects',
      run: (run) => this.preflight(run),
    },
    {
      id: 'pull_families',
      label: 'Save the logins from the VM',
      run: (run) => this.pullFamilies(run),
    },
    { id: 'destroy', label: 'Destroy the VM', run: (run) => this.destroy(run) },
  ];

  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: RemoteStorage,
    private readonly providers: VmProvidersService,
    private readonly writeback: ProviderAuthWritebackService,
    private readonly lifecycle: ProxmoxVmLifecycleService,
  ) {}

  assertCancellable(operation: RemoteOperation): void {
    if (stepStarted(operation, 'destroy')) {
      throw new ConflictError('VM deletion has started; retry the operation instead.', {
        code: 'REMOTE_OPERATION_NOT_CANCELLABLE',
        operationId: operation.id,
      });
    }
  }

  async rollback(): Promise<void> {}

  async completed(operation: RemoteOperation): Promise<void> {
    const details = operation.details as unknown as DestroyVmDetails;
    logger.info(
      { remoteId: operation.remoteId, vmid: details.vmid, operationId: operation.id },
      'Destroyed managed VM; removing remote registration',
    );
    await this.storage.deleteRemote(operation.remoteId);
  }

  private async preflight({ operation, details }: RemoteOperationStepRun): Promise<void> {
    const destroy = details as unknown as DestroyVmDetails;
    const remote = await this.storage.getRemote(operation.remoteId);
    if (
      remote.kind !== 'proxmox' ||
      remote.vmProviderConnectionId !== destroy.connectionId ||
      remote.vmIdentity !== destroy.expectedRemoteIdentity
    ) {
      throw new RemoteOperationStepRefusedError(
        'DESTROY_TARGET_CHANGED',
        'The managed VM changed after deletion was requested.',
      );
    }
    if (
      (await this.storage.listRemoteProjectBindings()).some(
        (binding) => binding.remoteId === operation.remoteId,
      )
    ) {
      throw new ConflictError('Disconnect every project before destroying its VM.', {
        code: 'REMOTE_HAS_PROJECT_BINDINGS',
        remoteId: operation.remoteId,
      });
    }
    if (!destroy.vmIdentity && destroy.targetVmid === undefined) return;
    try {
      const provider = await this.providers.forConnection(destroy.connectionId);
      if (destroy.vmIdentity) {
        destroy.vmid = await provider.assertOwnedVmIdentity(destroy.vmIdentity);
      } else if (destroy.targetVmid !== undefined) {
        if (!(await this.isSupersededClone(destroy))) {
          // The clone was never made or is gone, and the VMID may now belong to
          // another VM: remove the registration only.
          logger.warn(
            { remoteId: operation.remoteId, operationId: operation.id, vmid: destroy.targetVmid },
            'Planned VMID holds no clone of the failed operation; leaving it untouched',
          );
          destroy.targetVmid = undefined;
          return;
        }
        await provider.assertOwnedVmid(destroy.targetVmid);
        destroy.vmid = destroy.targetVmid;
      }
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
      throw new RemoteOperationStepRefusedError(
        'VM_NOT_FOUND',
        'The VM no longer exists. Delete the registration only.',
      );
    }
  }

  private async pullFamilies({ operation, details }: RemoteOperationStepRun): Promise<void> {
    const destroy = details as unknown as DestroyVmDetails;
    destroy.familyPull = await this.writeback.pullFamiliesNow(operation.remoteId);
    if (!destroy.familyPull.pulled && destroy.familyPull.families.length > 0) {
      if (!destroy.force) {
        throw new RemoteOperationStepRefusedError(
          'REMOTE_OFFLINE',
          'The host did not answer the final provider login pull. Retry or force deletion to use the last stored logins.',
        );
      }
      for (const family of destroy.familyPull.families) {
        logger.warn(
          {
            remoteId: operation.remoteId,
            operationId: operation.id,
            provider: family.provider,
            entryId: family.entryId,
            lastWritebackAt: family.lastWritebackAt,
          },
          'Forced VM deletion used the last stored provider login',
        );
      }
    }
  }

  private async destroy({ operation, details }: RemoteOperationStepRun): Promise<void> {
    const target = details as unknown as DestroyVmDetails;
    if (target.vmIdentity) {
      await destroyGuardedVm({
        storage: this.storage,
        providers: this.providers,
        operation,
        details,
        connectionId: target.connectionId,
        vmIdentity: target.vmIdentity,
        vmidKey: 'vmid',
        attemptKey: 'destroyAttempted',
      });
    } else if (target.targetVmid !== undefined && (await this.isSupersededClone(target))) {
      await destroyGuardedVmid({
        storage: this.storage,
        providers: this.providers,
        operation,
        details,
        connectionId: target.connectionId,
        vmid: target.targetVmid,
        attemptKey: 'destroyAttempted',
      });
    }
    await this.storage.updateRemoteBaseUrl(operation.remoteId, null);
    await this.storage.updateRemoteVmIdentity(operation.remoteId, null);
  }

  /** Checked again right before the delete, so a VMID taken over meanwhile is never destroyed. */
  private async isSupersededClone(target: DestroyVmDetails): Promise<boolean> {
    if (target.targetVmid === undefined || !target.targetVmName || !target.supersededOperationId) {
      return false;
    }
    return this.lifecycle.isOperationClone(
      target.connectionId,
      target.targetVmid,
      target.targetVmName,
      target.supersededOperationId,
    );
  }
}
