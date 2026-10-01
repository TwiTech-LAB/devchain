import { Inject, Injectable } from '@nestjs/common';
import {
  ProjectReplicaV1Schema,
  type ProjectReplicaChanges,
  type ProjectReplicaImportResult,
  type ProjectReplicaOfScope,
  type ProjectReplicaPreflightError,
} from '@devchain/shared';
import {
  NotFoundError,
  ReplicaPreflightError,
  ValidationError,
} from '../../../common/errors/error-types';
import { createLogger } from '../../../common/logging/logger';
import { SettingsService } from '../../settings/services/settings.service';
import {
  STORAGE_SERVICE,
  type FrozenProject,
  type ProjectHostStorage,
} from '../../storage/interfaces/storage.interface';
import { ProjectSessionsStopper } from '../services/project-sessions-stopper.service';
import { ProjectReplicaApplier } from '../replica/project-replica.applier';
import {
  ProjectReplicaBuilder,
  type ProjectReplicaBuildResult,
} from '../replica/project-replica.builder';
import { ProjectFreezeService } from './project-freeze.service';
import { HostSkillSettingsService } from './host-skill-settings.service';
import type { HostChangesQuery } from './host.dto';
import {
  ProjectTimeSettler,
  type ProjectTimeSettlement,
} from '../time/project-time-settler.service';

const logger = createLogger('HostService');

/**
 * `since` is moved back by this much for epics and segments so a row committed
 * with a timestamp just before the previous cursor is not missed.
 */
export const CHANGES_OVERLAP_MS = 5_000;

/** The routes a home instance calls on the instance hosting its project. */
@Injectable()
export class HostService {
  constructor(
    private readonly builder: ProjectReplicaBuilder,
    private readonly applier: ProjectReplicaApplier,
    private readonly freeze: ProjectFreezeService,
    @Inject(STORAGE_SERVICE) private readonly storage: ProjectHostStorage,
    private readonly sessionsStopper: ProjectSessionsStopper,
    private readonly timeSettler: ProjectTimeSettler,
    private readonly skillSettings: HostSkillSettingsService,
    private readonly settings: SettingsService,
  ) {}

  async importProject(
    body: unknown,
    options: { resnapshot: boolean },
  ): Promise<ProjectReplicaImportResult> {
    const replica = ProjectReplicaV1Schema.parse(body);
    if (replica.scope !== 'attach' || replica.tables.projects.length !== 1) {
      throw new ValidationError('Import takes an attach replica of exactly one project.', {
        scope: replica.scope,
        projects: replica.tables.projects.length,
      });
    }
    const projectId = replica.tables.projects[0].id;
    // The project is frozen in memory before the apply starts and in its row by
    // the apply's own commit: only an explicit thaw admits host writes. The
    // cursor is read before the apply, so no host write can precede it.
    const heldBefore = this.freeze.isFrozen(projectId);
    const cursor = this.freeze.hold(projectId, new Date().toISOString());
    // The replica's instance settings can turn a global source switch on
    // during the apply; this map is the baseline that turns it into a sync.
    const sourcesEnabledBefore = this.settings.getStoredSkillSourcesEnabled();
    try {
      await this.applier.apply(replica, {
        mode: 'full',
        remoteId: null,
        cursor,
        requireNewProjects: !options.resnapshot,
        frozenAt: cursor,
      });
    } catch (error) {
      if (!heldBefore) this.freeze.forget(projectId);
      throw error;
    }
    this.skillSettings.syncSourcesTurnedOn(sourcesEnabledBefore);
    logger.info({ projectId, resnapshot: options.resnapshot }, 'Imported project replica');
    return { projectId, cursor };
  }

  async exportReplica<S extends 'attach' | 'detach'>(
    projectId: string,
    scope: S,
  ): Promise<ProjectReplicaOfScope<S>> {
    const result = await this.builder.build({ projectIds: [projectId], scope });
    return unwrap(result).replica;
  }

  async changes(projectId: string, query: HostChangesQuery): Promise<ProjectReplicaChanges> {
    const changedSince =
      query.since === undefined
        ? undefined
        : new Date(Date.parse(query.since) - CHANGES_OVERLAP_MS).toISOString();
    const result = unwrap(
      await this.builder.build({
        projectIds: [projectId],
        scope: 'live',
        changedSince,
        includeIdSets: query.full,
      }),
    );
    return {
      cursor: result.replica.generatedAt,
      replica: result.replica,
      ...(result.idSets && { idSets: result.idSets }),
    };
  }

  freezeProject(projectId: string): Promise<FrozenProject> {
    return this.freeze.freeze(projectId);
  }

  thawProject(projectId: string): Promise<void> {
    return this.freeze.thaw(projectId);
  }

  async stopProjectSessions(projectId: string): Promise<void> {
    await this.sessionsStopper.stop(projectId);
  }

  settleProjectTime(projectId: string): Promise<ProjectTimeSettlement> {
    return this.timeSettler.settle(projectId);
  }

  async releaseProject(projectId: string): Promise<void> {
    await this.storage.releaseProject(projectId);
    this.freeze.forget(projectId);
  }

  async findEpicByIdempotencyKey(projectId: string, key: string): Promise<{ epicId: string }> {
    const epicId = await this.storage.findEpicIdByIdempotencyKey(projectId, key);
    if (!epicId) {
      throw new NotFoundError('Epic with idempotency key', key);
    }
    return { epicId };
  }
}

function unwrap<S extends Parameters<ProjectReplicaBuilder['build']>[0]['scope']>(
  result: ProjectReplicaBuildResult<S>,
): Extract<ProjectReplicaBuildResult<S>, { ok: true }> {
  if (result.ok) return result;
  const missing = result.errors.find(
    (error): error is Extract<ProjectReplicaPreflightError, { code: 'PROJECT_NOT_FOUND' }> =>
      error.code === 'PROJECT_NOT_FOUND',
  );
  if (missing) throw new NotFoundError('Project', missing.projectId);
  throw new ReplicaPreflightError(result.errors);
}
