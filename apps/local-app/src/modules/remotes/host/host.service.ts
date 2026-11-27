import { Inject, Injectable } from '@nestjs/common';
import {
  ProjectReplicaV1Schema,
  type ProjectReplicaChanges,
  type ProjectReplicaImportResult,
  type ProjectReplicaOfScope,
  type ProjectReplicaPreflightError,
} from '@devchain/shared';
import {
  ConflictError,
  NotFoundError,
  ReplicaPreflightError,
  ValidationError,
} from '../../../common/errors/error-types';
import { createLogger } from '../../../common/logging/logger';
import { SettingsService } from '../../settings/services/settings.service';
import {
  STORAGE_SERVICE,
  type EpicStorage,
  type FrozenProject,
  type IntegrationStorage,
  type ProjectHostStorage,
  type StatusStorage,
  type ProjectStorage,
} from '../../storage/interfaces/storage.interface';
import { EventsService } from '../../events/services/events.service';
import type { PreparedEvent } from '../../events/services/durable-event-registry.service';
import type { HostExternalTaskImport, HostExternalTaskImportResult } from '../contract/host-routes';
import { ProjectSessionsStopper } from '../services/project-sessions-stopper.service';
import { ProjectReplicaApplier } from '../replica/project-replica.applier';
import {
  ProjectReplicaBuilder,
  type ProjectReplicaBuildResult,
} from '../replica/project-replica.builder';
import { ProjectFreezeService } from './project-freeze.service';
import { GitCoordinatorService } from '../git-coordinator/git-coordinator.service';
import { HostSkillSettingsService } from './host-skill-settings.service';
import type { HostChangesQuery } from './host.dto';
import { IntegrationVmCacheService } from '../../external-integrations/vm-cache/integration-vm-cache.service';
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

type HostStorage = ProjectHostStorage &
  Pick<IntegrationStorage, 'importHostedExternalTask' | 'deleteExternalTaskLink'> &
  Pick<EpicStorage, 'getEpic' | 'updateEpic'> &
  Pick<ProjectStorage, 'runInTransaction'> &
  Pick<StatusStorage, 'getStatus'>;

/** The routes a home instance calls on the instance hosting its project. */
@Injectable()
export class HostService {
  constructor(
    private readonly builder: ProjectReplicaBuilder,
    private readonly applier: ProjectReplicaApplier,
    private readonly freeze: ProjectFreezeService,
    @Inject(STORAGE_SERVICE) private readonly storage: HostStorage,
    private readonly sessionsStopper: ProjectSessionsStopper,
    private readonly timeSettler: ProjectTimeSettler,
    private readonly skillSettings: HostSkillSettingsService,
    private readonly settings: SettingsService,
    private readonly gitCoordinator: GitCoordinatorService,
    private readonly integrationCache: IntegrationVmCacheService,
    private readonly events: EventsService,
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
    // A VM takes ordinary links only from home's seed, which marks the project seeded,
    // and from its own writes, which leave receipts. Home's attach replicas carry no
    // link tables; one that does (a VM's own export) must not write links here.
    delete replica.tables.external_task_links;
    delete replica.tables.external_link_receipts;
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
    // A new connection starts with the VM owning Git at generation 0.
    if (!options.resnapshot) await this.gitCoordinator.forget(projectId);
    logger.info({ projectId, resnapshot: options.resnapshot }, 'Imported project replica');
    return { projectId, cursor };
  }

  async exportReplica<S extends 'attach' | 'detach'>(
    projectId: string,
    scope: S,
  ): Promise<ProjectReplicaOfScope<S>> {
    const result = await this.builder.build({
      projectIds: [projectId],
      scope,
      includeExternalLinks: true,
    });
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
        // Whole on every pull: a link change moves no epic past `since`.
        includeExternalLinks: true,
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
    // A claimed VM's connection rows are home's delivery, not its own: they go with the
    // project, and so do their cached credentials.
    if (this.integrationCache.isClaimedHost()) {
      await this.integrationCache.releaseProject(projectId);
    } else {
      await this.storage.releaseProject(projectId);
    }
    this.freeze.forget(projectId);
    await this.gitCoordinator.forget(projectId);
  }

  async findEpicByIdempotencyKey(projectId: string, key: string): Promise<{ epicId: string }> {
    const epicId = await this.storage.findEpicIdByIdempotencyKey(projectId, key);
    if (!epicId) {
      throw new NotFoundError('Epic with idempotency key', key);
    }
    return { epicId };
  }

  /**
   * Creates the task's epic and link in one transaction, or returns the task's
   * existing link in the project; a retry with the same key reuses its epic.
   */
  async importExternalTask(
    projectId: string,
    body: HostExternalTaskImport,
  ): Promise<HostExternalTaskImportResult> {
    this.assertClaimedHost();
    const status = await this.storage.getStatus(body.epic.statusId);
    if (status.projectId !== projectId) throw new NotFoundError('Status', body.epic.statusId);
    let prepared: PreparedEvent | null = null;
    const result = await this.storage.importHostedExternalTask(
      {
        idempotencyKey: body.idempotencyKey,
        epic: {
          projectId,
          statusId: body.epic.statusId,
          title: body.epic.title,
          description: body.epic.description,
          parentId: null,
          agentId: null,
          tags: [],
          data: { idempotencyKey: body.idempotencyKey },
        },
        link: body.link,
      },
      (epic) => {
        prepared = this.events.prepareCommitted('epic.created', {
          epicId: epic.id,
          projectId: epic.projectId,
          title: epic.title,
          epicTitle: epic.title,
          statusId: epic.statusId,
          agentId: null,
          parentId: null,
          actor: null,
          statusName: status.label || undefined,
        });
        return prepared;
      },
    );
    if (prepared) this.events.emitCommitted(prepared);
    return { epicId: result.epicId, linkId: result.link.id, created: result.created };
  }

  /**
   * Removes the epic's ordinary link with exactly `linkId`, writes its release receipt and
   * advances the epic's version, in one transaction: a refused unlink changes nothing.
   */
  async unlinkExternalTask(projectId: string, epicId: string, linkId: string): Promise<void> {
    this.assertClaimedHost();
    let prepared: PreparedEvent | null = null;
    await this.storage.runInTransaction(async () => {
      const epic = await this.storage.getEpic(epicId);
      if (epic.projectId !== projectId) throw new NotFoundError('Epic', epicId);
      const { link } = await this.storage.deleteExternalTaskLink(epicId, linkId, undefined, {
        vmHosted: true,
      });
      const remoteKey = link.sourceSnapshot.remoteKey;
      await this.storage.updateEpic(epicId, {}, epic.version, (current) => {
        prepared = this.events.prepareCommitted('epic.updated', {
          epicId: current.id,
          projectId: current.projectId,
          parentId: current.parentId ?? null,
          version: current.version,
          epicTitle: current.title,
          actor: null,
          changes: {
            externalTask: {
              previous: link.id,
              current: null,
              ...(typeof remoteKey === 'string' && remoteKey ? { previousKey: remoteKey } : {}),
            },
          },
        });
        return prepared;
      });
    });
    if (prepared) this.events.emitCommitted(prepared);
  }

  /** Only a claimed VM keeps the receipts that carry its link writes home. */
  private assertClaimedHost(): void {
    if (!this.integrationCache.isClaimedHost()) {
      throw new ConflictError('This instance is not a claimed VM host.', {
        code: 'HOST_NOT_CLAIMED',
      });
    }
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
