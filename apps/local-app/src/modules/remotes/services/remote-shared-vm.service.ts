import { Inject, Injectable } from '@nestjs/common';
import { AppError, ConflictError } from '../../../common/errors/error-types';
import { STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import type { RemoteStorage } from '../../storage/interfaces/storage.interface';
import type { RemoteOperation } from '../../storage/models/domain.models';
import type { RemoteOperationStepDefinition } from '../operations/remote-operation.types';
import { CLAIM_IDENTITY_KINDS, homeIdentity } from '../home-identity';
import { RemoteHostClient, RemoteHostRequestError } from '../operations/remote-host.client';
import {
  SHARED_VM_GUARD_CODE,
  SharedVmRosterSchema,
  sharedVmOccupied,
} from '../dtos/shared-vm.dto';
import type { SharedVmGuardContext, SharedVmOccupancy } from '../dtos/shared-vm.dto';
import { RemoteSharedVmStore } from './remote-shared-vm.store';
import type { SharedVmNotifyResult } from '../host/shared-vm.contract';
import { createLogger } from '../../../common/logging/logger';

const logger = createLogger('RemoteSharedVmService');

export interface SharedVmOperationDetails {
  forceOccupied?: boolean;
  confirmedOccupancy?: SharedVmOccupancy;
}

/**
 * Best-effort forced notice before a forced Reset or Destroy deletes the VM.
 * The service resolves at run time, because step lists can be class fields.
 */
export function notifyForcedStep(
  sharedVm: () => RemoteSharedVmService,
): RemoteOperationStepDefinition {
  return {
    id: 'notify_forced',
    label: 'Notify the other VM users',
    skip: (details) => details.forceOccupied !== true && details.force !== true,
    run: async ({ operation }) => {
      await sharedVm()
        .notify(operation.remoteId, { action: 'forced' })
        .catch(() => undefined);
    },
  };
}

@Injectable()
export class RemoteSharedVmService {
  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: RemoteStorage,
    private readonly client: RemoteHostClient,
    private readonly store: RemoteSharedVmStore,
  ) {}

  lastRoster(remoteId: string): ReturnType<RemoteSharedVmStore['read']> {
    return this.store.read(remoteId);
  }

  async context(remoteId: string): Promise<SharedVmGuardContext> {
    const remote = await this.storage.getRemote(remoteId);
    const lastRoster = this.store.read(remoteId);
    if (!remote.baseUrl) return { occupancy: { unavailable: true, instances: [] }, lastRoster };
    const [identity] = await this.storage.listRemoteOperations({
      remoteId,
      states: ['done'],
      kinds: CLAIM_IDENTITY_KINDS,
      limit: 1,
    });
    const ownUser =
      typeof identity?.details.userName === 'string'
        ? identity.details.userName
        : homeIdentity().user;
    let roster;
    try {
      roster = SharedVmRosterSchema.parse(await this.client.sharedVmRoster(remoteId));
      if (
        new Set(roster.instances.map(({ user }) => user)).size !== roster.instances.length ||
        !roster.instances.some(({ user }) => user === ownUser)
      ) {
        throw new Error('The roster does not identify this instance.');
      }
    } catch {
      return { occupancy: { unavailable: true, instances: [] }, lastRoster };
    }
    const saved = { roster, ownUser, at: new Date().toISOString(), vmIdentity: remote.vmIdentity };
    await this.store.write(remoteId, saved);
    return {
      occupancy: {
        unavailable: false,
        instances: roster.instances.filter(({ user }) => user !== ownUser),
      },
      lastRoster: saved,
    };
  }

  async assertAllowed(
    remoteId: string,
    input: SharedVmOperationDetails,
  ): Promise<SharedVmOccupancy> {
    const context = await this.context(remoteId);
    if (!input.forceOccupied && sharedVmOccupied(context.occupancy)) this.refuse(context);
    if (input.forceOccupied && input.confirmedOccupancy)
      this.assertConfirmed(context, input.confirmedOccupancy);
    return input.forceOccupied
      ? (input.confirmedOccupancy ?? context.occupancy)
      : context.occupancy;
  }

  async notify(
    remoteId: string,
    input: { action: 'reset' | 'destroy' | 'forced'; message?: string },
  ): Promise<SharedVmNotifyResult> {
    return this.client.sharedVmNotify(remoteId, input);
  }

  async fencedDestroy(input: {
    operation: RemoteOperation;
    details: SharedVmOperationDetails;
    destroy: () => Promise<void>;
    confirmedIdle: () => Promise<boolean>;
    previouslyAttempted?: boolean;
    confirmedGone?: () => Promise<boolean>;
  }): Promise<void> {
    const { operation, details } = input;
    if (input.previouslyAttempted && input.confirmedGone && (await input.confirmedGone())) {
      await input.destroy();
      return;
    }
    try {
      await this.client.sharedVmFence(operation.remoteId, {
        mode: 'set',
        operationId: operation.id,
      });
    } catch (error) {
      if (error instanceof RemoteHostRequestError && error.status !== null && error.status < 500)
        throw error;
      if (!details.forceOccupied) throw error;
    }
    try {
      const context = await this.context(operation.remoteId);
      if (!details.forceOccupied && sharedVmOccupied(context.occupancy)) this.refuse(context);
      this.assertConfirmed(
        context,
        details.confirmedOccupancy ?? { unavailable: false, instances: [] },
      );
    } catch (error) {
      // On a retry the earlier Proxmox call can still finish; only a proved idle VM releases the fence.
      await this.releaseFenceIfIdle(input, !input.previouslyAttempted);
      throw error;
    }
    try {
      await input.destroy();
    } catch (error) {
      await this.releaseFenceIfIdle(
        input,
        error instanceof ConflictError && !input.previouslyAttempted,
      );
      throw error;
    }
  }

  /** Clears the fence when `knownIdle` holds or the provider proves the VM idle; a failed lookup keeps it. */
  private async releaseFenceIfIdle(
    input: { operation: RemoteOperation; confirmedIdle: () => Promise<boolean> },
    knownIdle: boolean,
  ): Promise<void> {
    let idle = knownIdle;
    try {
      if (!idle) idle = await input.confirmedIdle();
    } catch {
      // A failed outcome lookup cannot prove deletion stopped.
    }
    if (idle) await this.clearFence(input.operation);
  }

  private assertConfirmed(context: SharedVmGuardContext, confirmed: SharedVmOccupancy): void {
    if (confirmed.unavailable) return;
    if (context.occupancy.unavailable) this.refuse(context);
    for (const current of context.occupancy.instances) {
      const previous = confirmed.instances.find(({ user }) => user === current.user);
      if (!previous) this.refuse(context);
      const confirmedIds = previous.connectedProjectIds;
      if (confirmedIds === 'unknown' || previous.connectedCount === 'unknown') continue;
      if (
        current.connectedProjectIds === 'unknown' ||
        current.connectedCount === 'unknown' ||
        current.connectedProjectIds.some((id) => !confirmedIds.includes(id))
      )
        this.refuse(context);
    }
  }

  private refuse(context: SharedVmGuardContext): never {
    const users = context.occupancy.instances.map(
      ({ user, connectedCount, connectedProjectIds }) =>
        `${user} (${connectedProjectIds === 'unknown' ? 'unknown' : connectedCount} projects)`,
    );
    throw new AppError(
      context.occupancy.unavailable
        ? 'Other users’ connected projects on this VM are unknown. Notify them or confirm a forced operation.'
        : `Other users are connected to this VM: ${users.join(', ')}. Notify them or confirm a forced operation.`,
      SHARED_VM_GUARD_CODE,
      409,
      { ...context },
    );
  }

  private async clearFence(operation: RemoteOperation): Promise<void> {
    await this.client
      .sharedVmFence(operation.remoteId, { mode: 'clear', operationId: operation.id })
      .catch((error: unknown) => {
        logger.warn(
          { remoteId: operation.remoteId, operationId: operation.id, error: String(error) },
          'Could not clear the destroy fence',
        );
      });
  }
}
