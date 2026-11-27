import { Injectable } from '@nestjs/common';
import type { ProjectReplicaIdSets, ProjectReplicaV1 } from '@devchain/shared';
import type { EventsService } from '../../events/services/events.service';
import type { PreparedEvent } from '../../events/services/durable-event-registry.service';
import { createLogger } from '../../../common/logging/logger';
import { AppError } from '../../../common/errors/error-types';
import type { ManagedProjectionLock } from '../../external-integrations/subscribers/managed-projection-lock';
import type {
  ProjectReplicaApplyMode,
  ProjectReplicaApplySummary,
  ProjectReplicaStorage,
} from '../../storage/interfaces/storage.interface';

const logger = createLogger('ProjectReplicaApplier');

export interface ApplyProjectReplicaOptions {
  mode: ProjectReplicaApplyMode;
  /** Remote the replica came from; null when this instance is the host receiving an attach. */
  remoteId: string | null;
  /** Host-side ISO timestamp the replica reflects. */
  cursor: string | null;
  /** Refuse (409 `PROJECT_EXISTS`) instead of applying over an existing project. */
  requireNewProjects?: boolean;
  /** Host ID sets from a full changes feed; a `live` apply deletes rows missing from them. */
  idSets?: ProjectReplicaIdSets;
  /**
   * Keep this instance's provider env values and scope rows, provider
   * catalogs, provider scalars and plugin policy (home re-snapshots).
   */
  keepInstanceConfig?: boolean;
  /** Commit the payload projects frozen at this time (a host importing an attach). */
  frozenAt?: string;
}

/**
 * Applies a replica and announces `remote.project.synced` after commit. The
 * storage transaction appends the events, so a rollback leaves none behind.
 *
 * A managed projection the apply releases is released only while this applier holds
 * its projection lock, which managed sync holds from admission through the vendor
 * call and its confirmation: the apply waits for an in-flight dispatch, and a later
 * dispatch finds its row released. The set is known only inside the transaction, so
 * an apply that releases an unlocked projection rolls back and runs again holding it.
 * Locks are never awaited inside the transaction.
 */
@Injectable()
export class ProjectReplicaApplier {
  constructor(
    private readonly storage: Pick<ProjectReplicaStorage, 'applyProjectReplica'>,
    // `publish` sends the link-view hint; test doubles that do not check it may omit it.
    private readonly events: Pick<EventsService, 'prepareCommitted' | 'emitCommitted'> &
      Partial<Pick<EventsService, 'publish'>>,
    private readonly projectionLock: Pick<ManagedProjectionLock, 'runCovering'>,
  ) {}

  async apply(
    replica: ProjectReplicaV1,
    options: ApplyProjectReplicaOptions,
  ): Promise<ProjectReplicaApplySummary[]> {
    let prepared: PreparedEvent[] = [];
    const summaries = await this.projectionLock.runCovering(
      [],
      (lockedIds) => {
        prepared = [];
        return this.applyOnce(replica, options, lockedIds, prepared);
      },
      () =>
        new AppError(
          'Managed subtask sync keeps adding subtasks in this project; try again.',
          'MANAGED_SUBTASK_SYNC_BUSY',
          409,
          { projectIds: replica.tables.projects.map(({ id }) => id), retryable: true },
        ),
    );
    for (const event of prepared) {
      this.events.emitCommitted(event);
    }
    await this.publishLinkScopeHint(replica.workspace.id, summaries);
    for (const { projectId, skippedUnknownSkillCount } of summaries) {
      if (skippedUnknownSkillCount > 0) {
        logger.warn(
          { projectId, remoteId: options.remoteId, skippedUnknownSkillCount },
          'Skipped skill switches for skills not installed on this instance',
        );
      }
    }
    return summaries;
  }

  private applyOnce(
    replica: ProjectReplicaV1,
    options: ApplyProjectReplicaOptions,
    lockedProjectionIds: readonly string[],
    prepared: PreparedEvent[],
  ): Promise<ProjectReplicaApplySummary[]> {
    return this.storage.applyProjectReplica(
      replica,
      options.mode,
      (summary) => {
        const event = this.events.prepareCommitted('remote.project.synced', {
          projectId: summary.projectId,
          changedEpicIds: summary.changedEpicIds,
          deletedEpicIds: summary.deletedEpicIds,
          linkChangedEpicIds: summary.linkChangedEpicIds,
          workspaceId: replica.workspace.id,
          remoteId: options.remoteId,
          cursor: options.cursor,
        });
        prepared.push(event);
        return event;
      },
      {
        requireNewProjects: options.requireNewProjects,
        idSets: options.idSets,
        keepInstanceConfig: options.keepInstanceConfig,
        frozenAt: options.frozenAt,
        lockedProjectionIds,
      },
    );
  }

  /**
   * A link a VM agent set or removed refreshes the home link views like a local
   * link change does. A deleted epic can take its link with it; linkChangedEpicIds
   * holds only epics that stay. Best effort: the replica is already committed.
   */
  private async publishLinkScopeHint(
    workspaceId: string,
    summaries: ProjectReplicaApplySummary[],
  ): Promise<void> {
    const changed = summaries.some(
      (summary) => summary.linkChangedEpicIds.length > 0 || summary.deletedEpicIds.length > 0,
    );
    if (!changed || !this.events.publish) return;
    try {
      await this.events.publish('epic.time.scope.invalidated', {
        workspaceId,
        externalLinks: true,
      });
    } catch (error) {
      logger.warn({ workspaceId, error }, 'Failed to publish the link scope hint after a replica');
    }
  }
}
