import { Inject, Injectable, Logger, Optional, forwardRef } from '@nestjs/common';
import {
  STORAGE_SERVICE,
  type StorageService,
  type CreateEpicForProjectInput,
  type ListOptions,
  type ListResult,
} from '../../storage/interfaces/storage.interface';
import type { Epic, UpdateEpic, CreateEpic } from '../../storage/models/domain.models';
import { EventsService } from '../../events/services/events.service';
import { TerminalGateway } from '../../terminal/gateways/terminal.gateway';
import { ValidationError } from '../../../common/errors/error-types';
import { SettingsService } from '../../settings/services/settings.service';

/**
 * Context for epic operations, providing caller/actor information.
 */
export interface EpicOperationContext {
  /** Actor who triggered this operation (agent or guest), null if unknown/system */
  actor?: { type: 'agent' | 'guest'; id: string } | null;
}

@Injectable()
export class EpicsService {
  private readonly logger = new Logger(EpicsService.name);

  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    private readonly eventsService: EventsService,
    private readonly settingsService: SettingsService,
    @Optional()
    @Inject(forwardRef(() => TerminalGateway))
    private readonly terminalGateway?: TerminalGateway,
  ) {}

  async createEpic(data: CreateEpic, context?: EpicOperationContext): Promise<Epic> {
    // Clear agentId if creating in an auto-clean status
    this.applyAutoCleanIfNeeded(data.projectId, data.statusId, data);

    const epic = await this.storage.createEpic(data);

    // Publish epic.created event (best-effort persisted event - failures logged but don't block create)
    let resolvedNames: Awaited<ReturnType<typeof this.resolveEpicCreatedNames>> = {};
    try {
      resolvedNames = await this.resolveEpicCreatedNames(epic);
      await this.eventsService.publish('epic.created', {
        epicId: epic.id,
        projectId: epic.projectId,
        title: epic.title,
        statusId: epic.statusId ?? null,
        agentId: epic.agentId ?? null,
        parentId: epic.parentId ?? null,
        actor: context?.actor ?? null,
        ...resolvedNames,
      });
    } catch (error) {
      this.logger.error(
        { epicId: epic.id, projectId: epic.projectId, error },
        'Failed to publish epic.created event',
      );
      // Don't fail the create - gracefully continue
    }

    this.broadcastEpicEvent(epic.projectId, 'created', {
      epic: this.buildEpicSnapshot(epic),
    });

    return epic;
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
    input: CreateEpicForProjectInput,
    context?: EpicOperationContext,
  ): Promise<Epic> {
    // Clear agentId if creating in an auto-clean status
    this.applyAutoCleanIfNeeded(projectId, input.statusId, input);

    const epic = await this.storage.createEpicForProject(projectId, input);

    // Publish epic.created event (best-effort persisted event - failures logged but don't block create)
    let resolvedNames: Awaited<ReturnType<typeof this.resolveEpicCreatedNames>> = {};
    try {
      resolvedNames = await this.resolveEpicCreatedNames(epic);
      await this.eventsService.publish('epic.created', {
        epicId: epic.id,
        projectId: epic.projectId,
        title: epic.title,
        statusId: epic.statusId ?? null,
        agentId: epic.agentId ?? null,
        parentId: epic.parentId ?? null,
        actor: context?.actor ?? null,
        ...resolvedNames,
      });
    } catch (error) {
      this.logger.error(
        { epicId: epic.id, projectId: epic.projectId, error },
        'Failed to publish epic.created event',
      );
      // Don't fail the create - gracefully continue
    }

    this.broadcastEpicEvent(epic.projectId, 'created', {
      epic: this.buildEpicSnapshot(epic),
    });

    return epic;
  }

  async updateEpic(
    id: string,
    data: UpdateEpic,
    expectedVersion: number,
    context?: EpicOperationContext,
  ): Promise<Epic> {
    const before = await this.storage.getEpic(id);

    // Clear agentId if moving to an auto-clean status
    if (data.statusId !== undefined && data.statusId !== before.statusId) {
      this.applyAutoCleanIfNeeded(before.projectId, data.statusId, data);
    }

    const updated = await this.storage.updateEpic(id, data, expectedVersion);

    // Publish epic.updated event (best-effort persisted event - failures logged but don't block update)
    try {
      const changes = await this.buildEpicChangesWithNames(before, updated, data);
      // Only publish if there are actual changes
      if (Object.keys(changes).length > 0) {
        // Resolve project name for context
        let projectName: string | undefined;
        try {
          const project = await this.storage.getProject(updated.projectId);
          projectName = project.name;
        } catch (error) {
          this.logger.warn(
            { epicId: updated.id, projectId: updated.projectId, error },
            'Failed to resolve project name for epic.updated',
          );
        }

        await this.eventsService.publish('epic.updated', {
          epicId: updated.id,
          projectId: updated.projectId,
          version: updated.version,
          epicTitle: updated.title,
          projectName,
          actor: context?.actor ?? null,
          changes,
        });
      }
    } catch (error) {
      this.logger.error(
        { epicId: updated.id, projectId: updated.projectId, error },
        'Failed to publish epic.updated event',
      );
      // Don't fail the update - gracefully continue
    }

    this.broadcastEpicEvent(updated.projectId, 'updated', {
      epic: this.buildEpicSnapshot(updated),
      changes: this.buildEpicChanges(before, updated, data),
    });

    // CASCADE: Clear all sub-epics' agents when parent moves to auto-clean status
    if (data.statusId !== undefined && data.statusId !== before.statusId) {
      const autoCleanIds = this.settingsService.getAutoCleanStatusIds(before.projectId);
      if (autoCleanIds.includes(data.statusId)) {
        await this.cascadeClearSubEpicAgents(updated.id);
      }
    }

    return updated;
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

  async deleteEpic(id: string): Promise<void> {
    const epic = await this.storage.getEpic(id);
    await this.storage.deleteEpic(id);

    this.broadcastEpicEvent(epic.projectId, 'deleted', {
      epicId: epic.id,
      projectId: epic.projectId,
      parentId: epic.parentId,
    });
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

        // WS broadcast for UI sync only (not a persisted event)
        const updated = await this.storage.getEpic(subEpic.id);
        this.broadcastEpicEvent(updated.projectId, 'updated', {
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
  private async resolveEpicCreatedNames(epic: Epic): Promise<{
    projectName?: string;
    statusName?: string;
    agentName?: string;
    parentTitle?: string;
  }> {
    const result: {
      projectName?: string;
      statusName?: string;
      agentName?: string;
      parentTitle?: string;
    } = {};

    // Resolve project name
    try {
      const project = await this.storage.getProject(epic.projectId);
      result.projectName = project.name;
    } catch (error) {
      this.logger.warn(
        { epicId: epic.id, projectId: epic.projectId, error },
        'Failed to resolve project name for epic.created',
      );
    }

    // Resolve status name (if statusId is set)
    if (epic.statusId) {
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
    if (epic.agentId) {
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
    if (epic.parentId) {
      try {
        const parent = await this.storage.getEpic(epic.parentId);
        result.parentTitle = parent.title;
      } catch (error) {
        this.logger.warn(
          { epicId: epic.id, parentId: epic.parentId, error },
          'Failed to resolve parent title for epic.created',
        );
      }
    }

    return result;
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

  private buildEpicChanges(before: Epic, after: Epic, data?: UpdateEpic) {
    const changes: {
      title?: { previous: string; current: string };
      statusId?: { previous: string | null; current: string | null };
      agentId?: { previous: string | null; current: string | null };
    } = {};

    if (before.title !== after.title) {
      changes.title = { previous: before.title, current: after.title };
    }
    if (before.statusId !== after.statusId) {
      changes.statusId = { previous: before.statusId ?? null, current: after.statusId ?? null };
    }
    if (before.agentId !== after.agentId || (data !== undefined && 'agentId' in data)) {
      changes.agentId = { previous: before.agentId ?? null, current: after.agentId ?? null };
    }

    return changes;
  }

  /**
   * Builds epic changes with resolved names for event publishing.
   * Includes parentId tracking and human-readable names for status, agent, and parent.
   *
   * Uses parallel lookups (Promise.allSettled) for performance optimization.
   * Individual lookup failures are logged but don't affect other resolutions.
   */
  private async buildEpicChangesWithNames(
    before: Epic,
    after: Epic,
    data?: UpdateEpic,
  ): Promise<{
    title?: { previous: string; current: string };
    statusId?: {
      previous: string | null;
      current: string | null;
      previousName?: string;
      currentName?: string;
    };
    agentId?: {
      previous: string | null;
      current: string | null;
      previousName?: string;
      currentName?: string;
    };
    parentId?: {
      previous: string | null;
      current: string | null;
      previousTitle?: string;
      currentTitle?: string;
    };
  }> {
    const changes: {
      title?: { previous: string; current: string };
      statusId?: {
        previous: string | null;
        current: string | null;
        previousName?: string;
        currentName?: string;
      };
      agentId?: {
        previous: string | null;
        current: string | null;
        previousName?: string;
        currentName?: string;
      };
      parentId?: {
        previous: string | null;
        current: string | null;
        previousTitle?: string;
        currentTitle?: string;
      };
    } = {};

    // Track title changes (no async lookup needed)
    if (before.title !== after.title) {
      changes.title = { previous: before.title, current: after.title };
    }

    // Determine which lookups are needed
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

    // Build statusId change object
    if (statusChanged) {
      changes.statusId = {
        previous: before.statusId ?? null,
        current: after.statusId ?? null,
        previousName: resolved.prevStatus,
        currentName: resolved.currStatus,
      };
    }

    // Build agentId change object
    if (agentChanged) {
      changes.agentId = {
        previous: before.agentId ?? null,
        current: after.agentId ?? null,
        previousName: resolved.prevAgent,
        currentName: resolved.currAgent,
      };
    }

    // Build parentId change object
    if (parentChanged) {
      changes.parentId = {
        previous: before.parentId ?? null,
        current: after.parentId ?? null,
        previousTitle: resolved.prevParent,
        currentTitle: resolved.currParent,
      };
    }

    return changes;
  }

  private broadcastEpicEvent(
    projectId: string,
    type: 'created' | 'updated' | 'deleted',
    payload: unknown,
  ): void {
    if (!this.terminalGateway) {
      this.logger.warn(
        { projectId, type },
        'TerminalGateway not available; skipping epic broadcast event',
      );
      return;
    }

    const topic = `project/${projectId}/epics`;
    try {
      this.terminalGateway.broadcastEvent(topic, type, payload);
    } catch (error) {
      this.logger.error({ projectId, type, error }, 'Failed to broadcast epic event');
    }
  }
}
