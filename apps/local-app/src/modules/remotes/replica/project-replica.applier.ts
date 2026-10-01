import { Injectable } from '@nestjs/common';
import type { ProjectReplicaIdSets, ProjectReplicaV1 } from '@devchain/shared';
import type { EventsService } from '../../events/services/events.service';
import type { PreparedEvent } from '../../events/services/durable-event-registry.service';
import { createLogger } from '../../../common/logging/logger';
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
 */
@Injectable()
export class ProjectReplicaApplier {
  constructor(
    private readonly storage: Pick<ProjectReplicaStorage, 'applyProjectReplica'>,
    private readonly events: Pick<EventsService, 'prepareCommitted' | 'emitCommitted'>,
  ) {}

  async apply(
    replica: ProjectReplicaV1,
    options: ApplyProjectReplicaOptions,
  ): Promise<ProjectReplicaApplySummary[]> {
    const prepared: PreparedEvent[] = [];
    const summaries = await this.storage.applyProjectReplica(
      replica,
      options.mode,
      (summary) => {
        const event = this.events.prepareCommitted('remote.project.synced', {
          projectId: summary.projectId,
          changedEpicIds: summary.changedEpicIds,
          deletedEpicIds: summary.deletedEpicIds,
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
      },
    );
    for (const event of prepared) {
      this.events.emitCommitted(event);
    }
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
}
