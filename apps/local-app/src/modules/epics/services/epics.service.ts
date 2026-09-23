import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  STORAGE_SERVICE,
  type StorageService,
  type CreateEpicForProjectInput,
  type ListOptions,
  type ListResult,
} from '../../storage/interfaces/storage.interface';
import type {
  Epic,
  EpicComment,
  EpicRelationCandidate,
  ExternalTaskLink,
  UpdateEpic,
  CreateEpic,
  CreateEpicWithExternalTaskLink,
  CreateEpicWithExternalTaskLinkResult,
  IntegrationProvider,
  EpicRelationType,
} from '../../storage/models/domain.models';
import { EventsService } from '../../events/services/events.service';
import {
  AppError,
  NotFoundError,
  StorageError,
  ValidationError,
  IndexedRelationError,
  RelationConfirmationRequiredError,
  RelationRouteConflictError,
  type RelationRouteEffectFacts,
} from '../../../common/errors/error-types';
import { SettingsService } from '../../settings/services/settings.service';
import { normalizeExternalTaskSourceUrl } from '../../external-integrations/models/external-task-source';
import type { ExternalTaskSourceSummary } from '../../external-integrations/models/external-provider.models';
import type { PreparedEvent } from '../../events/services/durable-event-registry.service';
import { resolveEpicRelationTarget } from './epic-relation-target-resolver';
import {
  applyEpicDescriptionEdits,
  type EpicDescriptionEdit,
  type EpicDescriptionEditOutcome,
} from '../utils/apply-description-edits';
interface EpicBroadcastPayload {
  projectId: string;
  type: 'created' | 'updated' | 'deleted' | 'comment.created';
  data: unknown;
}

type EpicUpdatedChanges = PreparedEvent<'epic.updated'>['payload']['changes'];

interface EpicUpdatedChangeNames {
  statusId?: { previousName?: string; currentName?: string };
  agentId?: { previousName?: string; currentName?: string };
  parentId?: { previousTitle?: string; currentTitle?: string };
}

interface EpicCreatedNames {
  projectName?: string;
  statusName?: string;
  agentName?: string;
  parentTitle?: string;
  parentAgentId?: string;
  parentAgentName?: string;
  creatorName?: string;
}

interface EpicCreatedLookup {
  id?: string;
  projectId: string;
  statusId?: string;
  agentId?: string | null;
  parentId?: string | null;
  createdBy?: string | null;
}

/**
 * Context for epic operations, providing caller/actor information.
 */
export interface EpicOperationContext {
  /** Actor who triggered this operation (agent or guest), null if unknown/system */
  actor?: { type: 'agent' | 'guest'; id: string } | null;
  /** Trusted agent-name snapshot captured at the operation boundary. */
  creatorAgentName?: string;
}

export interface UpdateEpicOutcome {
  statusChanged: boolean;
  agentUnchanged: boolean;
  previousAssigneeAgent: { id: string; name: string } | null;
  /**
   * Present when descriptionEdits or appendDescription ran; carries the final
   * text plus context snippets for the response, so callers need no re-read.
   */
  descriptionEdit?: EpicDescriptionEditOutcome;
}

/**
 * Service-level update input: scalar UpdateEpic fields plus patch-style
 * description changes the service resolves against the epic it reads under
 * the caller's expected version.
 */
export interface UpdateEpicOperationInput extends UpdateEpic {
  descriptionEdits?: EpicDescriptionEdit[];
  appendDescription?: string;
}

export interface ImportExternalTaskInput {
  projectId: string;
  statusId: string;
  title: string;
  description: string | null;
  remote: {
    provider: IntegrationProvider;
    scopeKey: string;
    taskId: string;
    remoteKey: string;
    title: string;
    description: string | null;
    webUrl: string;
    workAreaId: string;
    workAreaName: string;
    statusName: string;
  };
}

/** One relation attachment for atomic Epic creation. */
export interface EpicRelationInputOperation {
  relatedEpicId: string;
  relation: EpicRelationType;
}

export interface CreateEpicForProjectOperationInput extends CreateEpicForProjectInput {
  relation?: EpicRelationInputOperation;
  relations?: EpicRelationInputOperation[];
}

@Injectable()
export class EpicsService {
  private readonly logger = new Logger(EpicsService.name);

  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    private readonly eventsService: EventsService,
    private readonly settingsService: SettingsService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async createEpic(data: CreateEpic, context?: EpicOperationContext): Promise<Epic> {
    // Clear agentId if creating in an auto-clean status
    this.applyAutoCleanIfNeeded(data.projectId, data.statusId, data);
    const createData = { ...data, createdBy: this.deriveCreatedBy(context) };
    const names = await this.resolveEpicCreatedNames(createData, context?.actor);

    let prepared: PreparedEvent<'epic.created'> | null = null;
    const epic = await this.storage.createEpic(
      createData,
      (created) => (prepared = this.prepareEpicCreatedEvent(created, context, names)),
    );

    this.emitPreparedCreated(prepared);

    return epic;
  }

  async createEpicWithExternalTaskLink(
    data: CreateEpicWithExternalTaskLink,
    context?: EpicOperationContext,
  ): Promise<CreateEpicWithExternalTaskLinkResult> {
    const epic = { ...data.epic };
    this.applyAutoCleanIfNeeded(epic.projectId, epic.statusId, epic);
    const createData = { ...epic, createdBy: this.deriveCreatedBy(context) };
    const names = await this.resolveEpicCreatedNames(createData, context?.actor);

    let prepared: PreparedEvent<'epic.created'> | null = null;
    const result = await this.storage.createEpicWithExternalTaskLink(
      {
        ...data,
        epic: createData,
      },
      (created) =>
        created.created
          ? (prepared = this.prepareEpicCreatedEvent(created.epic, context, names))
          : null,
    );
    if (result.created) {
      this.emitPreparedCreated(prepared);
    }
    // The ordinary link row changes linked-boundary rollups for the workspace;
    // published after the storage call commits, never inside its transaction.
    const project = await this.storage.getProject(data.epic.projectId);
    await this.eventsService.publish('epic.time.scope.invalidated', {
      workspaceId: project.workspaceId,
    });
    return result;
  }

  async importExternalTask(
    input: ImportExternalTaskInput,
    context?: EpicOperationContext,
  ): Promise<CreateEpicWithExternalTaskLinkResult> {
    const [project, status, connection] = await Promise.all([
      this.storage.getProject(input.projectId),
      this.storage.getStatus(input.statusId),
      this.storage.getIntegrationConnection({
        projectId: input.projectId,
        provider: input.remote.provider,
      }),
    ]);
    if (status.projectId !== project.id) {
      throw new ValidationError('Select a status from the chosen DevChain project.', {
        field: 'statusId',
      });
    }
    if (!connection) {
      throw new ValidationError('Connect the integration before importing this task.', {
        provider: input.remote.provider,
        reason: 'not_connected',
      });
    }

    return this.createEpicWithExternalTaskLink(
      {
        epic: {
          projectId: project.id,
          statusId: status.id,
          title: input.title,
          description: input.description,
          parentId: null,
          agentId: null,
          data: null,
          skillsRequired: null,
          tags: [],
        },
        externalTaskLink: {
          connectionId: connection.id,
          provider: input.remote.provider,
          remoteScopeKey: input.remote.scopeKey,
          remoteTaskId: input.remote.taskId,
          sourceSnapshot: {
            remoteKey: input.remote.remoteKey,
            title: input.remote.title,
            description: input.remote.description,
            webUrl: input.remote.webUrl,
            workAreaId: input.remote.workAreaId,
            workAreaName: input.remote.workAreaName,
            statusName: input.remote.statusName,
          },
        },
      },
      context,
    );
  }

  async listExternalTaskSources(epicId: string): Promise<ExternalTaskSourceSummary[]> {
    const links = await this.storage.listExternalTaskLinksForEpic(epicId);
    return links.map((link) => this.projectExternalTaskSourceSummary(link));
  }

  async listExternalTaskSourcesBatch(
    epicIds: string[],
  ): Promise<Array<{ epicId: string } & ExternalTaskSourceSummary>> {
    // Deduplicate before the bounded IN query; missing and unlinked IDs simply
    // produce no rows and are omitted from the response.
    const uniqueIds = [...new Set(epicIds)];
    if (uniqueIds.length === 0) return [];
    const links = await this.storage.listExternalTaskLinksForEpics(uniqueIds);
    return links.map((link) => ({
      epicId: link.epicId,
      ...this.projectExternalTaskSourceSummary(link),
    }));
  }

  private projectExternalTaskSourceSummary(link: ExternalTaskLink): ExternalTaskSourceSummary {
    const snapshot = link.sourceSnapshot;
    const bounded = (value: unknown, fallback: string, max: number): string =>
      typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : fallback;
    return {
      provider: link.provider,
      remoteTaskId: link.remoteTaskId,
      remoteKey: bounded(snapshot.remoteKey, link.remoteTaskId, 256),
      title: bounded(snapshot.title, link.remoteTaskId, 1_000),
      workAreaName: bounded(snapshot.workAreaName, 'Unknown work area', 1_000),
      statusName: bounded(snapshot.statusName, 'Unknown', 256),
      webUrl: normalizeExternalTaskSourceUrl(link.provider, snapshot.webUrl),
      linkedAt: link.createdAt,
    };
  }

  async listEpics(params: {
    projectId?: string;
    statusId?: string;
    parentId?: string;
    type?: 'active' | 'archived' | 'all';
    options?: ListOptions;
  }): Promise<ListResult<Epic>> {
    const { projectId, statusId, parentId, type = 'active', options = {} } = params;

    if (parentId) {
      return this.storage.listSubEpics(parentId, options);
    }

    if (statusId) {
      return this.storage.listEpicsByStatus(statusId, options);
    }

    if (!projectId) {
      throw new ValidationError('Provide projectId, statusId, or parentId to list epics.');
    }

    return this.storage.listProjectEpics(projectId, { ...options, type });
  }

  async getEpicById(id: string): Promise<Epic> {
    return this.storage.getEpic(id);
  }

  async listSubEpics(parentId: string, options: ListOptions = {}): Promise<ListResult<Epic>> {
    return this.storage.listSubEpics(parentId, options);
  }

  async countSubEpicsByStatus(parentId: string): Promise<Record<string, number>> {
    return this.storage.countSubEpicsByStatus(parentId);
  }

  async createEpicForProject(
    projectId: string,
    input: CreateEpicForProjectOperationInput,
    context?: EpicOperationContext,
  ): Promise<Epic> {
    const { relation, relations, ...epicInput } = input;
    const relationList: EpicRelationInputOperation[] = relations ?? (relation ? [relation] : []);
    // Clear agentId if creating in an auto-clean status
    this.applyAutoCleanIfNeeded(projectId, epicInput.statusId, epicInput);
    const statusSnapshot = await this.resolveEpicCreatedStatusSnapshot(
      projectId,
      epicInput.statusId,
    );
    let agentId = epicInput.agentId;
    let agentName: string | undefined;
    if (!agentId && epicInput.agentName?.trim()) {
      const agent = await this.storage.getAgentByName(projectId, epicInput.agentName);
      agentId = agent.id;
      agentName = agent.name;
    }
    const createInput = {
      ...epicInput,
      statusId: statusSnapshot.statusId,
      agentId,
      createdBy: this.deriveCreatedBy(context),
    };
    const names = await this.resolveEpicCreatedNames(
      {
        projectId,
        statusId: createInput.statusId,
        agentId: createInput.agentId ?? null,
        parentId: createInput.parentId ?? null,
        createdBy: createInput.createdBy,
      },
      context?.actor,
      { statusName: statusSnapshot.statusName, agentName },
    );

    let prepared: PreparedEvent<'epic.created'> | null = null;
    let relationWorkspaceId: string | null = null;
    let epic: Epic;
    if (relationList.length > 0) {
      const relationStatusId = createInput.statusId;
      if (!relationStatusId) {
        throw new ValidationError('Project has no statuses configured.', { projectId });
      }
      const status = await this.storage.getStatus(relationStatusId);
      if (status.projectId !== projectId) {
        throw new ValidationError('Status must belong to the target project.', {
          statusId: status.id,
          projectId,
        });
      }
      epic = await this.storage.runInTransaction(() =>
        this.storage.createEpicWithinTransaction(
          {
            projectId,
            title: createInput.title,
            description: createInput.description ?? null,
            statusId: relationStatusId,
            parentId: createInput.parentId ?? null,
            agentId: createInput.agentId ?? null,
            createdBy: createInput.createdBy,
            skillsRequired: createInput.skillsRequired ?? null,
            tags: createInput.tags ?? [],
            data: null,
          },
          (created) => (prepared = this.prepareEpicCreatedEvent(created, context, names)),
          async (created) => {
            relationWorkspaceId = await this.attachEpicRelations(created.id, relationList, context);
          },
        ),
      );
    } else {
      epic = await this.storage.createEpicForProject(
        projectId,
        createInput,
        (created) => (prepared = this.prepareEpicCreatedEvent(created, context, names)),
      );
    }

    this.emitPreparedCreated(prepared);
    if (relationList.length > 0) {
      if (!relationWorkspaceId) {
        throw new StorageError('Epic relation creation did not resolve its workspace scope.');
      }
      await this.eventsService.publish('epic.relations.invalidated', {
        workspaceId: relationWorkspaceId,
      });
    }

    return epic;
  }

  /**
   * Resolves every relation target (rejecting duplicate resolved targets),
   * then writes each relation in input order inside the caller's create
   * transaction; any throw rolls back the Epic, its tags, every relation, and
   * the durable epic.created event. Relation errors carry the failing input
   * index, and a second eligible Related time route from the new Epic becomes
   * a create-specific route conflict instead of a displacement confirmation.
   */
  private async attachEpicRelations(
    createdEpicId: string,
    relationList: EpicRelationInputOperation[],
    context?: EpicOperationContext,
  ): Promise<string> {
    const resolvedTargets: Array<{ index: number; id: string }> = [];
    const seenTargetIds = new Set<string>();
    for (let index = 0; index < relationList.length; index += 1) {
      const relationInput = relationList[index];
      let target: EpicRelationCandidate;
      try {
        target = await resolveEpicRelationTarget(
          this.storage,
          createdEpicId,
          relationInput.relatedEpicId,
          {
            excludeMcpHidden: true,
          },
        );
      } catch (error) {
        throw this.indexRelationError(error, index);
      }
      if (seenTargetIds.has(target.id)) {
        throw this.indexRelationError(
          new ValidationError(
            'Duplicate related Epic in the relations list; each target Epic may appear once.',
            { duplicateRelatedEpicId: target.id },
          ),
          index,
        );
      }
      seenTargetIds.add(target.id);
      resolvedTargets.push({ index, id: target.id });
    }

    let workspaceId: string | null = null;
    for (const resolved of resolvedTargets) {
      try {
        const result = await this.storage.setEpicRelation(
          {
            epicId: createdEpicId,
            relatedEpicId: resolved.id,
            type: relationList[resolved.index].relation,
            createdBy: context?.actor?.type === 'agent' ? 'agent' : 'user',
            createdByAgentId: context?.actor?.type === 'agent' ? context.actor.id : null,
          },
          context?.actor ? { actor: context.actor } : {},
        );
        workspaceId = result.workspaceId;
      } catch (error) {
        if (error instanceof RelationConfirmationRequiredError) {
          const currentEffect = error.details?.currentEffect as
            | RelationRouteEffectFacts
            | undefined;
          const conflictingRelationIndex = currentEffect
            ? (resolvedTargets.find(
                (candidate) =>
                  candidate.id === currentEffect.targetEpicId && candidate.index < resolved.index,
              )?.index ?? null)
            : null;
          throw new RelationRouteConflictError(
            resolved.index,
            conflictingRelationIndex,
            currentEffect ?? { sourceEpicId: createdEpicId, targetEpicId: resolved.id },
          );
        }
        throw this.indexRelationError(error, resolved.index);
      }
    }
    if (!workspaceId) {
      throw new StorageError('Epic relation creation did not resolve its workspace scope.');
    }
    return workspaceId;
  }

  private indexRelationError(error: unknown, index: number): unknown {
    if (error instanceof AppError) {
      return new IndexedRelationError(index, error);
    }
    return error;
  }

  async updateEpic(
    id: string,
    data: UpdateEpicOperationInput,
    expectedVersion: number,
    context?: EpicOperationContext,
  ): Promise<Epic> {
    return (await this.updateEpicWithDescriptionEditOutcome(id, data, expectedVersion, context))
      .epic;
  }

  /**
   * Resolves descriptionEdits/appendDescription against the freshly read epic,
   * then performs the versioned update with the resulting description text.
   * The edit helper throws before any storage write when a `find` text cannot
   * be matched uniquely, leaving the stored description and version untouched.
   */
  private async updateEpicWithDescriptionEditOutcome(
    id: string,
    data: UpdateEpicOperationInput,
    expectedVersion: number,
    context?: EpicOperationContext,
  ): Promise<{ epic: Epic; descriptionEdit?: EpicDescriptionEditOutcome }> {
    const before = await this.storage.getEpic(id);

    const { descriptionEdits, appendDescription, ...updateData } = data;
    let descriptionEdit: EpicDescriptionEditOutcome | undefined;
    if (descriptionEdits !== undefined || appendDescription !== undefined) {
      descriptionEdit = applyEpicDescriptionEdits({
        text: before.description,
        edits: descriptionEdits ?? [],
        append: appendDescription,
      });
      updateData.description = descriptionEdit.text;
    }

    // Enforce 1-level hierarchy: a child with sub-epics cannot be moved under another parent
    if (updateData.parentId !== undefined && updateData.parentId !== null) {
      const children = await this.storage.listSubEpics(id, { limit: 1 });
      if (children.items.length > 0) {
        throw new ValidationError(
          'Cannot move an epic that has sub-epics under another parent (one-level hierarchy).',
          { epicId: id, parentId: updateData.parentId },
        );
      }
    }

    // Clear agentId if moving to an auto-clean status
    if (updateData.statusId !== undefined && updateData.statusId !== before.statusId) {
      this.applyAutoCleanIfNeeded(before.projectId, updateData.statusId, updateData);
    }

    const changeNames = await this.resolveEpicUpdatedChangeNames(
      before,
      {
        statusId: updateData.statusId ?? before.statusId,
        agentId: updateData.agentId !== undefined ? updateData.agentId : before.agentId,
        parentId: updateData.parentId !== undefined ? updateData.parentId : before.parentId,
      },
      updateData,
    );

    let projectName: string | undefined;
    let projectWorkspaceId: string | undefined;
    try {
      const project = await this.storage.getProject(before.projectId);
      projectName = project.name;
      projectWorkspaceId = project.workspaceId;
    } catch (error) {
      this.logger.warn(
        { epicId: before.id, projectId: before.projectId, error },
        'Failed to resolve project name for epic.updated',
      );
    }

    let prepared: PreparedEvent<'epic.updated'> | null = null;
    const updated = await this.storage.updateEpic(
      id,
      updateData,
      expectedVersion,
      (current, previous) => {
        const changes = this.buildEpicChanges(previous, current, updateData, changeNames);
        const tagsChanged = !this.haveSameExactTags(previous.tags, current.tags);
        if (Object.keys(changes).length === 0 && !tagsChanged) {
          return null;
        }
        prepared = this.eventsService.prepareCommitted('epic.updated', {
          epicId: current.id,
          projectId: current.projectId,
          parentId: current.parentId ?? null,
          version: current.version,
          epicTitle: current.title,
          projectName,
          actor: context?.actor ?? null,
          recipientIds: this.buildAgentRecipientIds(changes.agentId?.current, context?.actor),
          changes,
        });
        return prepared;
      },
    );

    if (prepared) {
      this.eventsService.emitCommitted(prepared);
    }

    // CASCADE: Clear all sub-epics' agents when parent moves to auto-clean status
    if (updateData.statusId !== undefined && updateData.statusId !== before.statusId) {
      const autoCleanIds = this.settingsService.getAutoCleanStatusIds(before.projectId);
      if (autoCleanIds.includes(updateData.statusId)) {
        await this.cascadeClearSubEpicAgents(updated.id);
      }
    }

    // A parent change reshapes related-time rollups for both endpoint scopes;
    // the hint rides after commit so it never lands inside the write transaction.
    if (
      projectWorkspaceId &&
      updateData.parentId !== undefined &&
      before.parentId !== updated.parentId
    ) {
      await this.eventsService.publish('epic.time.scope.invalidated', {
        workspaceId: projectWorkspaceId,
      });
    }

    return { epic: updated, descriptionEdit };
  }

  async updateEpicWithOutcome(
    id: string,
    data: UpdateEpicOperationInput,
    expectedVersion: number,
    context?: EpicOperationContext,
  ): Promise<{ epic: Epic; outcome: UpdateEpicOutcome }> {
    const before = await this.storage.getEpic(id);

    const { epic: updated, descriptionEdit } = await this.updateEpicWithDescriptionEditOutcome(
      id,
      data,
      expectedVersion,
      context,
    );

    const statusChanged = before.statusId !== updated.statusId;
    const agentUnchanged = before.agentId === updated.agentId;

    let previousAssigneeAgent: { id: string; name: string } | null = null;
    if (before.agentId) {
      try {
        const agent = await this.storage.getAgent(before.agentId);
        previousAssigneeAgent = { id: agent.id, name: agent.name };
      } catch {
        // Agent may have been deleted; leave null
      }
    }

    return {
      epic: updated,
      outcome: { statusChanged, agentUnchanged, previousAssigneeAgent, descriptionEdit },
    };
  }

  // Bulk update delegates to updateEpic(), publishing epic.updated for each changed epic
  // Additional no-op skip: if targetAgentId === current.agentId, entire update is skipped
  async bulkUpdateEpics(
    updates: Array<{ id: string; statusId?: string; agentId?: string | null; version: number }>,
    expectedParentId: string | null = null,
    context?: EpicOperationContext,
  ): Promise<Epic[]> {
    if (!updates.length) {
      return [];
    }

    const seen = new Set<string>();
    const results: Epic[] = [];
    let projectId: string | null = null;

    for (const update of updates) {
      if (seen.has(update.id)) {
        throw new ValidationError('Duplicate epic id in bulk update payload', {
          epicId: update.id,
        });
      }
      seen.add(update.id);

      if (typeof update.version !== 'number') {
        throw new ValidationError('version is required for bulk epic updates', {
          epicId: update.id,
        });
      }

      const current = await this.storage.getEpic(update.id);

      if (projectId && current.projectId !== projectId) {
        throw new ValidationError('All epics in a bulk update must belong to the same project', {
          epicId: current.id,
          projectId: current.projectId,
          expectedProjectId: projectId,
        });
      }
      projectId = projectId ?? current.projectId;

      if (
        expectedParentId &&
        current.id !== expectedParentId &&
        current.parentId !== expectedParentId
      ) {
        throw new ValidationError('Epic is not part of the requested parent hierarchy', {
          epicId: current.id,
          parentId: current.parentId,
          expectedParentId,
        });
      }

      const targetStatusId = update.statusId ?? current.statusId;
      const targetAgentId =
        update.agentId === undefined ? current.agentId : (update.agentId ?? null);

      if (targetStatusId === current.statusId && targetAgentId === current.agentId) {
        continue; // skip no-op updates to avoid unnecessary version bumps
      }

      const payload: UpdateEpic = {};
      if (update.statusId !== undefined) {
        payload.statusId = update.statusId;
      }
      if (update.agentId !== undefined) {
        payload.agentId = update.agentId ?? null;
      }

      results.push(await this.updateEpic(update.id, payload, update.version, context));
    }

    return results;
  }

  async deleteEpic(id: string, context?: EpicOperationContext): Promise<void> {
    await this.storage.getEpic(id);
    const prepared: Array<PreparedEvent<'epic.deleted'>> = [];
    let workspaceId: string | null = null;
    await this.storage.deleteEpic(id, (deleted, currentWorkspaceId) => {
      workspaceId = currentWorkspaceId;
      const event = this.eventsService.prepareCommitted('epic.deleted', {
        epicId: deleted.id,
        projectId: deleted.projectId,
        title: deleted.title,
        parentId: deleted.parentId ?? null,
        actor: context?.actor ?? null,
      });
      prepared.push(event);
      return event;
    });

    if (prepared.length > 0) {
      for (const event of prepared) {
        this.eventsService.emitCommitted(event);
      }
    }
    if (!workspaceId) {
      throw new StorageError('Epic deletion did not resolve its workspace invalidation scope.');
    }
    await this.eventsService.publish('epic.relations.invalidated', {
      workspaceId,
    });
  }

  /**
   * Creates a comment on an epic with project-boundary validation and event publication.
   * This path is used when caller identity is known (agent/guest id + type).
   */
  async addEpicComment(
    epicId: string,
    projectId: string,
    content: string,
    authorId: string,
    authorType: 'agent' | 'guest',
  ): Promise<EpicComment> {
    const epic = await this.storage.getEpic(epicId);

    if (epic.projectId !== projectId) {
      throw new ValidationError(`Epic ${epicId} does not belong to project ${projectId}.`, {
        epicId,
        projectId,
        epicProjectId: epic.projectId,
      });
    }

    // Resolve author name from agent or guest storage
    let authorName: string;
    if (authorType === 'agent') {
      const agent = await this.storage.getAgent(authorId);
      authorName = agent.name;
    } else {
      const guest = await this.storage.getGuest(authorId);
      authorName = guest.name;
    }

    if (authorType === 'agent') {
      return this.addExactAgentEpicComment(epicId, projectId, content, authorId, authorName);
    }

    const comment = await this.storage.createEpicComment({
      epicId,
      authorName,
      content,
    });

    // Publish epic.comment.created event (best-effort)
    try {
      let projectName: string | undefined;
      try {
        const project = await this.storage.getProject(projectId);
        projectName = project.name;
      } catch {
        /* graceful */
      }

      await this.eventsService.publish('epic.comment.created', {
        commentId: comment.id,
        epicId,
        projectId,
        parentId: epic.parentId ?? null,
        authorName,
        content,
        actor: { type: authorType, id: authorId },
        projectName,
        epicTitle: epic.title,
        recipientIds: [],
      });
    } catch (error) {
      this.logger.error(
        { commentId: comment.id, epicId, projectId, error },
        'Failed to publish epic.comment.created event',
      );
    }

    return comment;
  }

  /**
   * Exact-agent comments are one-time Epic-time task touches: their factual event
   * and delivery rows commit atomically with the comment, or the comment rolls back.
   */
  private async addExactAgentEpicComment(
    epicId: string,
    projectId: string,
    content: string,
    agentId: string,
    authorName: string,
  ): Promise<EpicComment> {
    let projectName: string | undefined;
    try {
      const project = await this.storage.getProject(projectId);
      projectName = project.name;
    } catch {
      /* graceful */
    }

    let prepared: PreparedEvent<'epic.comment.created'> | null = null;
    const comment = await this.storage.createEpicComment(
      { epicId, authorName, content },
      (stored, committedEpic) => {
        prepared = this.eventsService.prepareCommitted('epic.comment.created', {
          commentId: stored.id,
          epicId: committedEpic.id,
          projectId: committedEpic.projectId,
          parentId: committedEpic.parentId ?? null,
          authorName: stored.authorName,
          content: stored.content,
          actor: { type: 'agent', id: agentId },
          projectName,
          epicTitle: committedEpic.title,
          agentName: stored.authorName,
          recipientIds: [],
        });
        return prepared;
      },
    );

    if (prepared) {
      this.eventsService.emitCommitted(prepared);
    }

    return comment;
  }

  /**
   * REST-friendly comment creation path used by EpicCommentsController.
   * Preserves existing authorName-based input while still publishing domain events.
   */
  async addEpicCommentFromRest(
    epicId: string,
    authorName: string,
    content: string,
  ): Promise<EpicComment> {
    const epic = await this.storage.getEpic(epicId);
    const comment = await this.storage.createEpicComment({
      epicId,
      authorName,
      content,
    });

    try {
      let projectName: string | undefined;
      try {
        const project = await this.storage.getProject(epic.projectId);
        projectName = project.name;
      } catch {
        /* graceful */
      }

      await this.eventsService.publish('epic.comment.created', {
        commentId: comment.id,
        epicId,
        projectId: epic.projectId,
        parentId: epic.parentId ?? null,
        authorName,
        content,
        actor: null,
        projectName,
        epicTitle: epic.title,
        recipientIds: [],
      });
    } catch (error) {
      this.logger.error(
        { commentId: comment.id, epicId, projectId: epic.projectId, error },
        'Failed to publish epic.comment.created event from REST path',
      );
    }

    return comment;
  }

  /**
   * Project-scoped comment deletion for the mobile board RPC. Verifies the epic
   * belongs to `projectId` (cross-project → clean not-found, no leak), then
   * deletes scoped to the owning epic (`WHERE id = ? AND epic_id = ?`). A comment
   * that belongs to another epic — or is already gone — yields a clean not-found.
   * No `epic.comment.deleted` event exists yet (v1 web parity; mobile refreshes).
   */
  async deleteEpicComment(projectId: string, epicId: string, commentId: string): Promise<void> {
    const epic = await this.storage.getEpic(epicId);
    if (epic.projectId !== projectId) {
      throw new NotFoundError('Epic', epicId);
    }

    const deleted = await this.storage.deleteEpicCommentScoped(epicId, commentId);
    if (!deleted) {
      throw new NotFoundError('Comment', commentId);
    }
  }

  /**
   * Clears agentId if the target status is configured for auto-clean.
   * Mutates the data object in place before storage operations.
   */
  private applyAutoCleanIfNeeded(
    projectId: string,
    targetStatusId: string | undefined,
    data: { agentId?: string | null },
  ): void {
    if (!targetStatusId) return;

    const autoCleanIds = this.settingsService.getAutoCleanStatusIds(projectId);
    if (autoCleanIds.includes(targetStatusId)) {
      data.agentId = null;
    }
  }

  /**
   * Recursively fetches all sub-epics (descendants) of a parent epic.
   */
  private async getAllSubEpicsRecursive(parentId: string): Promise<Epic[]> {
    const result: Epic[] = [];
    const { items: directChildren } = await this.storage.listSubEpics(parentId, { limit: 1000 });

    for (const child of directChildren) {
      result.push(child);
      const descendants = await this.getAllSubEpicsRecursive(child.id);
      result.push(...descendants);
    }

    return result;
  }

  /**
   * Cascades agent clearing to all sub-epics when parent moves to auto-clean status.
   *
   * EVENT SUPPRESSION: This method intentionally bypasses the service layer by calling
   * `this.storage.updateEpic()` directly. This prevents epic.updated
   * events from being published for each sub-epic, which would cause event spam when
   * a parent with many descendants moves to an auto-clean status.
   *
   * The WS broadcast is still sent for real-time UI updates (not persisted events).
   */
  private async cascadeClearSubEpicAgents(parentId: string): Promise<void> {
    const subEpics = await this.getAllSubEpicsRecursive(parentId);

    for (const subEpic of subEpics) {
      if (subEpic.agentId !== null) {
        // Direct storage update - bypasses service to suppress epic.updated events
        await this.storage.updateEpic(subEpic.id, { agentId: null }, subEpic.version);

        // Transient broadcast for UI sync only (not a persisted event)
        const updated = await this.storage.getEpic(subEpic.id);
        this.emitBroadcast(updated.projectId, 'updated', {
          epic: this.buildEpicSnapshot(updated),
          changes: { agentId: { previous: subEpic.agentId, current: null } },
        });
      }
    }
  }

  /**
   * Resolves human-readable names for epic.created event payload.
   * Returns partial object with resolved names; missing lookups are omitted (graceful degradation).
   */
  private async resolveEpicCreatedNames(
    epic: EpicCreatedLookup,
    actor?: EpicOperationContext['actor'],
    knownNames: EpicCreatedNames = {},
  ): Promise<EpicCreatedNames> {
    const result: EpicCreatedNames = { ...knownNames };

    // Resolve project name
    try {
      const project = await this.storage.getProject(epic.projectId);
      result.projectName ??= project.name;
    } catch (error) {
      this.logger.warn(
        { epicId: epic.id, projectId: epic.projectId, error },
        'Failed to resolve project name for epic.created',
      );
    }

    // Resolve status name (if statusId is set)
    if (epic.statusId && !result.statusName) {
      try {
        const status = await this.storage.getStatus(epic.statusId);
        result.statusName = status.label;
      } catch (error) {
        this.logger.warn(
          { epicId: epic.id, statusId: epic.statusId, error },
          'Failed to resolve status name for epic.created',
        );
      }
    }

    // Resolve agent name (if agentId is set)
    if (epic.agentId && !result.agentName) {
      try {
        const agent = await this.storage.getAgent(epic.agentId);
        result.agentName = agent.name;
      } catch (error) {
        this.logger.warn(
          { epicId: epic.id, agentId: epic.agentId, error },
          'Failed to resolve agent name for epic.created',
        );
      }
    }

    // Resolve parent title (if parentId is set)
    if (epic.parentId && !result.parentTitle) {
      try {
        const parent = await this.storage.getEpic(epic.parentId);
        result.parentTitle = parent.title;
        if (parent.agentId) {
          result.parentAgentId = parent.agentId;
          try {
            const parentAgent = await this.storage.getAgent(parent.agentId);
            result.parentAgentName = parentAgent.name;
          } catch (error) {
            this.logger.warn(
              { epicId: epic.id, parentId: epic.parentId, agentId: parent.agentId, error },
              'Failed to resolve parent agent name for epic.created',
            );
          }
        }
      } catch (error) {
        this.logger.warn(
          { epicId: epic.id, parentId: epic.parentId, error },
          'Failed to resolve parent title for epic.created',
        );
      }
    }

    if (actor?.type === 'agent' && epic.createdBy) {
      result.creatorName = epic.createdBy;
    } else if (actor) {
      try {
        if (actor.type === 'agent') {
          const agent = await this.storage.getAgent(actor.id);
          result.creatorName = agent.name;
        } else {
          const guest = await this.storage.getGuest(actor.id);
          result.creatorName = guest.name;
        }
      } catch (error) {
        this.logger.warn(
          { epicId: epic.id, actor, error },
          'Failed to resolve creator name for epic.created',
        );
      }
    }

    return result;
  }

  private prepareEpicCreatedEvent(
    epic: Epic,
    context?: EpicOperationContext,
    names: EpicCreatedNames = {},
  ): PreparedEvent<'epic.created'> {
    return this.eventsService.prepareCommitted('epic.created', {
      epicId: epic.id,
      projectId: epic.projectId,
      title: epic.title,
      epicTitle: epic.title,
      statusId: epic.statusId ?? null,
      agentId: epic.agentId ?? null,
      parentId: epic.parentId ?? null,
      actor: context?.actor ?? null,
      assignmentRecipientIds: this.buildAgentRecipientIds(epic.agentId, context?.actor),
      subEpicRecipientIds: this.buildAgentRecipientIds(names.parentAgentId, context?.actor),
      ...names,
    });
  }

  private async resolveEpicCreatedStatusSnapshot(
    projectId: string,
    statusId?: string,
  ): Promise<{ statusId: string | undefined; statusName: string | undefined }> {
    try {
      if (statusId) {
        const status = await this.storage.getStatus(statusId);
        return { statusId, statusName: status?.label };
      }

      const statuses = await this.storage.listStatuses(projectId, { limit: 1, offset: 0 });
      const defaultStatus = statuses.items[0];
      return {
        statusId: defaultStatus?.id,
        statusName: defaultStatus?.label,
      };
    } catch (error) {
      this.logger.warn(
        { projectId, statusId, error },
        'Failed to resolve status name before epic.created commit',
      );
      return { statusId, statusName: undefined };
    }
  }

  private emitPreparedCreated(prepared: PreparedEvent<'epic.created'> | null): void {
    if (!prepared) {
      throw new Error('Storage did not append the required epic.created event.');
    }
    this.eventsService.emitCommitted(prepared);
  }

  private deriveCreatedBy(context?: EpicOperationContext): string | null {
    return context?.actor?.type === 'agent' && context.creatorAgentName
      ? context.creatorAgentName
      : null;
  }

  private buildAgentRecipientIds(
    agentId: string | null | undefined,
    actor: EpicOperationContext['actor'] | undefined,
  ): string[] {
    if (!agentId) {
      return [];
    }
    if (actor?.type === 'agent' && actor.id === agentId) {
      return [];
    }
    return [agentId];
  }

  private buildEpicSnapshot(epic: Epic) {
    const {
      id,
      projectId,
      title,
      statusId,
      agentId,
      parentId,
      tags,
      version,
      createdAt,
      updatedAt,
    } = epic;
    return {
      id,
      projectId,
      title,
      statusId,
      agentId,
      parentId,
      tags,
      version,
      createdAt,
      updatedAt,
    };
  }

  private haveSameExactTags(left: string[], right: string[]): boolean {
    const leftSet = new Set(left);
    const rightSet = new Set(right);
    return leftSet.size === rightSet.size && [...leftSet].every((tag) => rightSet.has(tag));
  }

  private buildEpicChanges(
    before: Epic,
    after: Epic,
    data?: UpdateEpic,
    names: EpicUpdatedChangeNames = {},
  ): EpicUpdatedChanges {
    const changes: EpicUpdatedChanges = {};
    if (before.title !== after.title) {
      changes.title = { previous: before.title, current: after.title };
    }
    if (before.description !== after.description) {
      changes.description = {
        previous: before.description ?? null,
        current: after.description ?? null,
      };
    }
    if (before.statusId !== after.statusId) {
      changes.statusId = {
        previous: before.statusId ?? null,
        current: after.statusId ?? null,
        ...names.statusId,
      };
    }
    if (before.agentId !== after.agentId || (data !== undefined && 'agentId' in data)) {
      changes.agentId = {
        previous: before.agentId ?? null,
        current: after.agentId ?? null,
        ...names.agentId,
      };
    }
    if (before.parentId !== after.parentId) {
      changes.parentId = {
        previous: before.parentId ?? null,
        current: after.parentId ?? null,
        ...names.parentId,
      };
    }
    return changes;
  }

  private async resolveEpicUpdatedChangeNames(
    before: Epic,
    after: Pick<Epic, 'statusId' | 'agentId' | 'parentId'>,
    data?: UpdateEpic,
  ): Promise<EpicUpdatedChangeNames> {
    const statusChanged = before.statusId !== after.statusId;
    const agentChanged =
      before.agentId !== after.agentId || (data !== undefined && 'agentId' in data);
    const parentChanged = before.parentId !== after.parentId;

    // Build lookup tasks for parallel execution
    type LookupResult = {
      type: 'prevStatus' | 'currStatus' | 'prevAgent' | 'currAgent' | 'prevParent' | 'currParent';
      value: string;
    };
    const lookupTasks: Promise<LookupResult>[] = [];

    // Status lookups
    if (statusChanged) {
      if (before.statusId) {
        lookupTasks.push(
          this.storage
            .getStatus(before.statusId)
            .then((s) => ({ type: 'prevStatus' as const, value: s.label })),
        );
      }
      if (after.statusId) {
        lookupTasks.push(
          this.storage
            .getStatus(after.statusId)
            .then((s) => ({ type: 'currStatus' as const, value: s.label })),
        );
      }
    }

    // Agent lookups
    if (agentChanged) {
      if (before.agentId) {
        lookupTasks.push(
          this.storage
            .getAgent(before.agentId)
            .then((a) => ({ type: 'prevAgent' as const, value: a.name })),
        );
      }
      if (after.agentId) {
        lookupTasks.push(
          this.storage
            .getAgent(after.agentId)
            .then((a) => ({ type: 'currAgent' as const, value: a.name })),
        );
      }
    }

    // Parent lookups
    if (parentChanged) {
      if (before.parentId) {
        lookupTasks.push(
          this.storage
            .getEpic(before.parentId)
            .then((e) => ({ type: 'prevParent' as const, value: e.title })),
        );
      }
      if (after.parentId) {
        lookupTasks.push(
          this.storage
            .getEpic(after.parentId)
            .then((e) => ({ type: 'currParent' as const, value: e.title })),
        );
      }
    }

    // Execute all lookups in parallel with graceful error handling
    const results = await Promise.allSettled(lookupTasks);

    // Process results into a lookup map
    const resolved: Partial<Record<LookupResult['type'], string>> = {};
    for (const result of results) {
      if (result.status === 'fulfilled') {
        resolved[result.value.type] = result.value.value;
      } else {
        // Log individual failures (graceful degradation)
        this.logger.warn({ error: result.reason }, 'Failed to resolve name for epic.updated event');
      }
    }

    const names: EpicUpdatedChangeNames = {};
    if (statusChanged) {
      names.statusId = {
        previousName: resolved.prevStatus,
        currentName: resolved.currStatus,
      };
    }

    if (agentChanged) {
      names.agentId = {
        previousName: resolved.prevAgent,
        currentName: resolved.currAgent,
      };
    }

    if (parentChanged) {
      names.parentId = {
        previousTitle: resolved.prevParent,
        currentTitle: resolved.currParent,
      };
    }

    return names;
  }

  private emitBroadcast(
    projectId: string,
    type: EpicBroadcastPayload['type'],
    data: unknown,
  ): void {
    this.eventEmitter.emit('epic.broadcast', {
      projectId,
      type,
      data,
    } satisfies EpicBroadcastPayload);
  }
}
