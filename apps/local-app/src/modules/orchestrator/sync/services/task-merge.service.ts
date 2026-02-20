import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { OnEvent } from '@nestjs/event-emitter';
import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { createLogger } from '../../../../common/logging/logger';
import { getEnvConfig } from '../../../../common/config/env.config';
import {
  ORCHESTRATOR_DB_CONNECTION,
  OrchestratorDatabase,
} from '../../orchestrator-storage/db/orchestrator.provider';
import { mergedAgents, mergedEpics } from '../../../storage/db/schema';
import { WORKTREES_STORE, WorktreesStore } from '../../worktrees/worktrees.store';
import {
  WORKTREE_TASK_MERGE_REQUESTED_EVENT,
  WorktreeTaskMergeRequestedEvent,
} from '../events/task-merge.events';
import { TaskMergeResult } from '../dtos/task-merge.dto';
import { getRawSqliteClient } from '../../../storage/db/sqlite-raw';
import { MainProjectBootstrapService } from '../../../projects/services/main-project-bootstrap.service';
import { STORAGE_SERVICE, StorageService } from '../../../storage/interfaces/storage.interface';
import { Epic, Status } from '../../../storage/models/domain.models';
import { basename, resolve } from 'path';

const logger = createLogger('OrchestratorTaskMergeService');

const CONTAINER_FETCH_TIMEOUT_MS = 5_000;
const UNKNOWN_STATUS_LABEL = 'Unknown';
const UNKNOWN_STATUS_COLOR = '#6c757d';
const UNKNOWN_PROFILE_LABEL = 'Unknown';
const SQLITE_EPIC_PAGE_SIZE = 500;
const SQLITE_STATUS_PAGE_SIZE = 500;
const SQLITE_AGENT_PAGE_SIZE = 500;
const MERGED_TAG_PREFIX = 'merged:';

interface NormalizedEpic {
  id: string;
  title: string;
  description: string | null;
  statusId: string | null;
  parentId: string | null;
  agentId: string | null;
  tags: string[];
  createdAtSource: string | null;
}

interface ContainerListResponse<T> {
  items?: T[];
}

interface ContainerEpicItem {
  id?: string;
  title?: string;
  description?: string | null;
  statusId?: string | null;
  parentId?: string | null;
  agentId?: string | null;
  tags?: string[] | null;
  createdAt?: string | null;
}

interface ContainerAgentItem {
  id?: string;
  name?: string | null;
  profileId?: string | null;
  epicsCompleted?: number | null;
  completedEpics?: number | null;
  activityCount?: number | null;
}

interface ContainerStatusItem {
  id?: string;
  label?: string;
  color?: string;
}

interface ContainerProfileItem {
  id?: string;
  name?: string;
}

interface ResolvedStatus {
  label: string;
  color: string;
}

@Injectable()
export class TaskMergeService {
  private sqliteMergeImportQueue: Promise<void> = Promise.resolve();

  constructor(
    @Inject(WORKTREES_STORE) private readonly store: WorktreesStore,
    @Inject(ORCHESTRATOR_DB_CONNECTION) private readonly db: OrchestratorDatabase,
    @Optional() @Inject(STORAGE_SERVICE) private readonly storage?: StorageService,
    @Optional() private readonly mainProjectBootstrap?: MainProjectBootstrapService,
    @Optional() private readonly moduleRef?: ModuleRef,
  ) {}

  @OnEvent(WORKTREE_TASK_MERGE_REQUESTED_EVENT, { async: true })
  async handleTaskMergeRequested(
    payload: WorktreeTaskMergeRequestedEvent,
  ): Promise<TaskMergeResult> {
    return this.mergeTasksFromContainer(payload.worktreeId);
  }

  async mergeTasksFromContainer(worktreeId: string): Promise<TaskMergeResult> {
    const worktree = await this.store.getById(worktreeId);
    if (!worktree) {
      throw new NotFoundException(`Worktree not found: ${worktreeId}`);
    }
    if (!worktree.containerPort || !worktree.devchainProjectId) {
      throw new BadRequestException(
        `Worktree ${worktreeId} has no active container endpoint for task extraction`,
      );
    }

    const baseUrl = `http://127.0.0.1:${worktree.containerPort}`;
    const projectId = encodeURIComponent(worktree.devchainProjectId);

    let epicsPayload: ContainerListResponse<ContainerEpicItem>;
    let agentsPayload: ContainerListResponse<ContainerAgentItem>;
    let statusesPayload: ContainerListResponse<ContainerStatusItem> | null;
    let profilesPayload: ContainerListResponse<ContainerProfileItem> | null;

    try {
      [epicsPayload, agentsPayload, statusesPayload, profilesPayload] = await Promise.all([
        this.fetchContainerJson<ContainerListResponse<ContainerEpicItem>>(
          `${baseUrl}/api/epics?projectId=${projectId}&limit=1000&type=all`,
        ),
        this.fetchContainerJson<ContainerListResponse<ContainerAgentItem>>(
          `${baseUrl}/api/agents?projectId=${projectId}&limit=1000`,
        ),
        this.fetchContainerJsonSafe<ContainerListResponse<ContainerStatusItem>>(
          `${baseUrl}/api/statuses?projectId=${projectId}&limit=1000`,
        ),
        this.fetchProfilesForProject(baseUrl, projectId),
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new BadRequestException(
        `Failed to extract task history from worktree container ${worktree.name}: ${message}`,
      );
    }

    const nowIso = new Date().toISOString();
    const epics = this.normalizeEpics(epicsPayload.items ?? []);
    const agents = this.normalizeAgents(agentsPayload.items ?? []);
    const agentNameById = new Map(agents.map((agent) => [agent.id, agent.name] as const));
    const statusById = this.buildStatusMap(statusesPayload?.items ?? []);
    const profileNameById = this.buildProfileMap(profilesPayload?.items ?? []);

    const assignedEpicsByAgent = new Map<string, number>();
    for (const epic of epics) {
      if (!epic.agentId) {
        continue;
      }
      assignedEpicsByAgent.set(epic.agentId, (assignedEpicsByAgent.get(epic.agentId) ?? 0) + 1);
    }

    const mergedEpicRows: Array<typeof mergedEpics.$inferInsert> = epics.map((epic) => {
      const resolvedStatus = this.resolveStatus(epic.statusId, statusById);
      return {
        id: randomUUID(),
        worktreeId: worktree.id,
        devchainEpicId: epic.id,
        title: epic.title,
        description: epic.description,
        statusName: resolvedStatus.label,
        statusColor: resolvedStatus.color,
        agentName: epic.agentId ? (agentNameById.get(epic.agentId) ?? null) : null,
        parentEpicId: epic.parentId,
        tags: epic.tags,
        createdAtSource: epic.createdAtSource,
        mergedAt: nowIso,
      };
    });

    const mergedAgentRows: Array<typeof mergedAgents.$inferInsert> = agents.map((agent) => ({
      id: randomUUID(),
      worktreeId: worktree.id,
      devchainAgentId: agent.id,
      name: agent.name,
      profileName: this.resolveProfileName(agent.profileId, profileNameById),
      epicsCompleted:
        agent.epicsCompleted ??
        agent.completedEpics ??
        agent.activityCount ??
        assignedEpicsByAgent.get(agent.id) ??
        0,
      mergedAt: nowIso,
    }));

    await this.persistMergedRows(mergedEpicRows, mergedAgentRows);

    const sqliteImportSummary = await this.importEpicsIntoMainProject({
      worktreeId: worktree.id,
      worktreeName: worktree.name,
      epics,
      statusById,
      agentNameById,
    });

    logger.info(
      {
        worktreeId: worktree.id,
        worktreeName: worktree.name,
        epicsMerged: mergedEpicRows.length,
        agentsMerged: mergedAgentRows.length,
        sqliteEpicsImported: sqliteImportSummary.imported,
        sqliteEpicsSkipped: sqliteImportSummary.skipped,
        sqliteStatusesCreated: sqliteImportSummary.statusesCreated,
      },
      'Merged task history from container into orchestrator storage',
    );

    return {
      worktreeId: worktree.id,
      epicsMerged: mergedEpicRows.length,
      agentsMerged: mergedAgentRows.length,
    };
  }

  private async persistMergedRows(
    mergedEpicRows: Array<typeof mergedEpics.$inferInsert>,
    mergedAgentRows: Array<typeof mergedAgents.$inferInsert>,
  ): Promise<void> {
    type InsertTarget = Pick<OrchestratorDatabase, 'insert'>;

    const persist = async (targetDb: InsertTarget): Promise<void> => {
      if (mergedEpicRows.length > 0) {
        await targetDb
          .insert(mergedEpics)
          .values(mergedEpicRows)
          .onConflictDoNothing({
            target: [mergedEpics.worktreeId, mergedEpics.devchainEpicId],
          });
      }

      if (mergedAgentRows.length > 0) {
        await targetDb
          .insert(mergedAgents)
          .values(mergedAgentRows)
          .onConflictDoNothing({
            target: [mergedAgents.worktreeId, mergedAgents.devchainAgentId],
          });
      }
    };

    const rawSqlite = this.resolveRawSqliteClientForOrchestratorDb();
    if (!rawSqlite) {
      const dbWithTransaction = this.db as unknown as {
        transaction?: <T>(callback: (tx: unknown) => Promise<T>) => Promise<T>;
      };
      if (typeof dbWithTransaction.transaction === 'function') {
        await dbWithTransaction.transaction(async (tx) => {
          await persist(tx as InsertTarget);
        });
        return;
      }
      await persist(this.db as InsertTarget);
      return;
    }

    await this.runWithSqliteMergeLock(async () => {
      rawSqlite.exec('BEGIN IMMEDIATE TRANSACTION');
      try {
        await persist(this.db as InsertTarget);
        rawSqlite.exec('COMMIT');
      } catch (error) {
        try {
          rawSqlite.exec('ROLLBACK');
        } catch {
          // best-effort rollback; rethrow original error below
        }
        throw error;
      }
    });
  }

  private normalizeEpics(items: ContainerEpicItem[]): NormalizedEpic[] {
    return items
      .map((item) => {
        const id = item.id?.trim();
        if (!id) {
          return null;
        }

        const createdAtSource = this.parseIsoDate(item.createdAt);
        return {
          id,
          title: item.title?.trim() || 'Untitled Epic',
          description: item.description ?? null,
          statusId: item.statusId?.trim() || null,
          parentId: item.parentId?.trim() || null,
          agentId: item.agentId?.trim() || null,
          tags: Array.isArray(item.tags) ? item.tags.filter((tag) => typeof tag === 'string') : [],
          createdAtSource,
        };
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item));
  }

  private buildStatusMap(items: ContainerStatusItem[]): Map<string, ResolvedStatus> {
    const map = new Map<string, ResolvedStatus>();
    for (const item of items) {
      const id = item.id?.trim();
      if (!id) {
        continue;
      }
      const label = item.label?.trim() || `${UNKNOWN_STATUS_LABEL} (${id})`;
      const color = this.normalizeStatusColor(item.color);
      map.set(id, { label, color });
    }
    return map;
  }

  private buildProfileMap(items: ContainerProfileItem[]): Map<string, string> {
    const map = new Map<string, string>();
    for (const item of items) {
      const id = item.id?.trim();
      if (!id) {
        continue;
      }
      const name = item.name?.trim();
      map.set(id, name && name.length > 0 ? name : `${UNKNOWN_PROFILE_LABEL} (${id})`);
    }
    return map;
  }

  private resolveStatus(statusId: string | null, map: Map<string, ResolvedStatus>): ResolvedStatus {
    if (!statusId) {
      return { label: UNKNOWN_STATUS_LABEL, color: UNKNOWN_STATUS_COLOR };
    }
    return (
      map.get(statusId) ?? {
        label: `${UNKNOWN_STATUS_LABEL} (${statusId})`,
        color: UNKNOWN_STATUS_COLOR,
      }
    );
  }

  private resolveProfileName(profileId: string | null, map: Map<string, string>): string {
    if (!profileId) {
      return UNKNOWN_PROFILE_LABEL;
    }
    return map.get(profileId) ?? `${UNKNOWN_PROFILE_LABEL} (${profileId})`;
  }

  private normalizeStatusColor(color: string | undefined): string {
    const normalized = color?.trim();
    if (normalized && /^#[0-9a-fA-F]{6}$/.test(normalized)) {
      return normalized;
    }
    return UNKNOWN_STATUS_COLOR;
  }

  private normalizeAgents(items: ContainerAgentItem[]): Array<{
    id: string;
    name: string | null;
    profileId: string | null;
    epicsCompleted: number | null;
    completedEpics: number | null;
    activityCount: number | null;
  }> {
    return items
      .map((item) => {
        const id = item.id?.trim();
        if (!id) {
          return null;
        }

        return {
          id,
          name: item.name?.trim() || null,
          profileId: item.profileId?.trim() || null,
          epicsCompleted: this.toNumberOrNull(item.epicsCompleted),
          completedEpics: this.toNumberOrNull(item.completedEpics),
          activityCount: this.toNumberOrNull(item.activityCount),
        };
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item));
  }

  private toNumberOrNull(value: unknown): number | null {
    if (typeof value !== 'number' || Number.isNaN(value)) {
      return null;
    }
    return Math.max(0, Math.floor(value));
  }

  private parseIsoDate(value: string | null | undefined): string | null {
    if (!value) {
      return null;
    }
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      return null;
    }
    return parsed.toISOString();
  }

  private async fetchContainerJson<T>(url: string): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CONTAINER_FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Container request failed with HTTP ${response.status}`);
      }
      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Container request timed out after ${CONTAINER_FETCH_TIMEOUT_MS}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async fetchContainerJsonSafe<T>(url: string): Promise<T | null> {
    try {
      return await this.fetchContainerJson<T>(url);
    } catch (error) {
      logger.warn({ error, url }, 'Optional container lookup failed; using fallback values');
      return null;
    }
  }

  private async fetchProfilesForProject(
    baseUrl: string,
    projectId: string,
  ): Promise<ContainerListResponse<ContainerProfileItem> | null> {
    const primary = await this.fetchContainerJsonSafe<ContainerListResponse<ContainerProfileItem>>(
      `${baseUrl}/api/agent-profiles?projectId=${projectId}&limit=1000`,
    );
    if (primary?.items && primary.items.length > 0) {
      return primary;
    }

    const fallback = await this.fetchContainerJsonSafe<ContainerListResponse<ContainerProfileItem>>(
      `${baseUrl}/api/profiles?projectId=${projectId}&limit=1000`,
    );
    if (fallback?.items && fallback.items.length > 0) {
      return fallback;
    }
    return primary ?? fallback;
  }

  private async importEpicsIntoMainProject(input: {
    worktreeId: string;
    worktreeName: string;
    epics: NormalizedEpic[];
    statusById: Map<string, ResolvedStatus>;
    agentNameById: Map<string, string | null>;
  }): Promise<{ imported: number; skipped: number; statusesCreated: number }> {
    if (process.env.DEVCHAIN_MODE !== 'main') {
      return { imported: 0, skipped: input.epics.length, statusesCreated: 0 };
    }

    if (!this.storage) {
      logger.warn('Main mode epic import skipped because STORAGE_SERVICE is unavailable');
      return { imported: 0, skipped: input.epics.length, statusesCreated: 0 };
    }

    const targetProjectId = await this.resolveMainProjectId();
    if (!targetProjectId) {
      logger.warn(
        { worktreeId: input.worktreeId },
        'Main mode epic import skipped: no target project',
      );
      return { imported: 0, skipped: input.epics.length, statusesCreated: 0 };
    }

    const existingSourceToTarget = await this.loadExistingMergedEpicMap(
      targetProjectId,
      input.worktreeId,
    );
    const statusState = await this.buildStatusState(targetProjectId);
    const mainAgentByName = await this.buildMainAgentMap(targetProjectId);
    const mergeDateIso = new Date().toISOString();

    const pending = new Map(
      input.epics
        .filter((epic) => !existingSourceToTarget.has(epic.id))
        .map((epic) => [epic.id, epic] as const),
    );

    let imported = 0;
    const sourceToTargetId = new Map(existingSourceToTarget);

    while (pending.size > 0) {
      let progressed = false;

      for (const [sourceEpicId, epic] of [...pending.entries()]) {
        if (epic.parentId && pending.has(epic.parentId) && !sourceToTargetId.has(epic.parentId)) {
          continue;
        }

        const resolvedStatus = this.resolveStatus(epic.statusId, input.statusById);
        const statusId = await this.ensureMainStatus(targetProjectId, resolvedStatus, statusState);

        const sourceAgentName = epic.agentId
          ? (input.agentNameById.get(epic.agentId) ?? null)
          : null;
        const mappedAgentId = sourceAgentName
          ? (mainAgentByName.get(sourceAgentName.trim().toLowerCase()) ?? null)
          : null;

        const parentTargetId =
          epic.parentId && sourceToTargetId.has(epic.parentId)
            ? (sourceToTargetId.get(epic.parentId) ?? null)
            : null;

        const mergedTags = this.buildMergedTags(epic.tags, input.worktreeName);

        const mergeResult = await this.createMainEpicWithAtomicDedup({
          projectId: targetProjectId,
          worktreeId: input.worktreeId,
          sourceEpicId,
          createInput: {
            projectId: targetProjectId,
            title: epic.title,
            description: epic.description,
            statusId,
            parentId: parentTargetId,
            agentId: mappedAgentId,
            tags: mergedTags,
            data: {
              mergedFrom: {
                worktreeId: input.worktreeId,
                worktreeName: input.worktreeName,
                sourceEpicId,
                sourceParentEpicId: epic.parentId,
                sourceStatusId: epic.statusId,
                sourceAgentId: epic.agentId,
                sourceAgentName,
                mergedAt: mergeDateIso,
              },
            },
            skillsRequired: null,
          },
        });

        sourceToTargetId.set(sourceEpicId, mergeResult.epicId);
        pending.delete(sourceEpicId);
        if (mergeResult.inserted) {
          imported += 1;
        }
        progressed = true;
      }

      if (progressed) {
        continue;
      }

      for (const [sourceEpicId, epic] of [...pending.entries()]) {
        const resolvedStatus = this.resolveStatus(epic.statusId, input.statusById);
        const statusId = await this.ensureMainStatus(targetProjectId, resolvedStatus, statusState);
        const sourceAgentName = epic.agentId
          ? (input.agentNameById.get(epic.agentId) ?? null)
          : null;
        const mappedAgentId = sourceAgentName
          ? (mainAgentByName.get(sourceAgentName.trim().toLowerCase()) ?? null)
          : null;

        const mergedTags = this.buildMergedTags(epic.tags, input.worktreeName);

        const mergeResult = await this.createMainEpicWithAtomicDedup({
          projectId: targetProjectId,
          worktreeId: input.worktreeId,
          sourceEpicId,
          createInput: {
            projectId: targetProjectId,
            title: epic.title,
            description: epic.description,
            statusId,
            parentId: null,
            agentId: mappedAgentId,
            tags: mergedTags,
            data: {
              mergedFrom: {
                worktreeId: input.worktreeId,
                worktreeName: input.worktreeName,
                sourceEpicId,
                sourceParentEpicId: epic.parentId,
                sourceStatusId: epic.statusId,
                sourceAgentId: epic.agentId,
                sourceAgentName,
                mergedAt: mergeDateIso,
                unresolvedParent: Boolean(epic.parentId),
              },
            },
            skillsRequired: null,
          },
        });

        sourceToTargetId.set(sourceEpicId, mergeResult.epicId);
        pending.delete(sourceEpicId);
        if (mergeResult.inserted) {
          imported += 1;
        }
      }
      break;
    }

    return {
      imported,
      skipped: input.epics.length - imported,
      statusesCreated: statusState.createdCount,
    };
  }

  private async createMainEpicWithAtomicDedup(input: {
    projectId: string;
    worktreeId: string;
    sourceEpicId: string;
    createInput: Parameters<StorageService['createEpic']>[0];
  }): Promise<{ epicId: string; inserted: boolean }> {
    if (!this.storage) {
      throw new Error('Storage service is unavailable for main epic import');
    }
    const storage = this.storage;

    const rawSqlite = this.resolveRawSqliteClientForStorage(storage);
    if (!rawSqlite) {
      const created = await storage.createEpic(input.createInput);
      return { epicId: created.id, inserted: true };
    }

    const existingLookup = rawSqlite.prepare(
      `
        SELECT e.id AS id
        FROM epics e
        WHERE e.project_id = ?
          AND json_extract(json_extract(e.data, '$'), '$.mergedFrom.worktreeId') = ?
          AND json_extract(json_extract(e.data, '$'), '$.mergedFrom.sourceEpicId') = ?
        LIMIT 1
      `,
    );

    return this.runWithSqliteMergeLock(async () => {
      // Concurrency model:
      // - Service-level queue prevents overlapping transactions on the same SQLite connection.
      // - BEGIN IMMEDIATE acquires a write lock and serializes the check+insert section.
      // - We re-check mergedFrom existence inside this transaction and insert only when absent.
      rawSqlite.exec('BEGIN IMMEDIATE TRANSACTION');
      try {
        const existing = existingLookup.get(
          input.projectId,
          input.worktreeId,
          input.sourceEpicId,
        ) as { id: string } | undefined;

        if (existing?.id) {
          rawSqlite.exec('COMMIT');
          return { epicId: existing.id, inserted: false };
        }

        const created = await storage.createEpic(input.createInput);
        rawSqlite.exec('COMMIT');
        return { epicId: created.id, inserted: true };
      } catch (error) {
        try {
          rawSqlite.exec('ROLLBACK');
        } catch {
          // best-effort rollback; rethrow original error below
        }
        throw error;
      }
    });
  }

  private async resolveMainProjectId(): Promise<string | null> {
    if (!this.storage) {
      return null;
    }

    const bootstrapProjectId = this.resolveMainProjectBootstrapService()?.getMainProjectId();
    if (bootstrapProjectId) {
      return bootstrapProjectId;
    }

    const env = getEnvConfig();
    const repoRoot = resolve(env.REPO_ROOT ?? process.cwd());

    const existingByPath = await this.storage.findProjectByPath(repoRoot);
    if (existingByPath) {
      return existingByPath.id;
    }

    const allProjects = await this.storage.listProjects({ limit: 1000, offset: 0 });
    if (allProjects.total > 0 && allProjects.items.length > 0) {
      return allProjects.items[0].id;
    }

    const created = await this.storage.createProject({
      name: basename(repoRoot) || 'Main',
      description: 'Auto-created main project for merged worktree epics',
      rootPath: repoRoot,
      isTemplate: false,
    });
    return created.id;
  }

  private resolveMainProjectBootstrapService(): MainProjectBootstrapService | null {
    if (this.mainProjectBootstrap) {
      return this.mainProjectBootstrap;
    }

    if (!this.moduleRef) {
      return null;
    }

    try {
      return this.moduleRef.get(MainProjectBootstrapService, { strict: false });
    } catch {
      return null;
    }
  }

  private async buildStatusState(projectId: string): Promise<{
    byLabel: Map<string, Status>;
    nextPosition: { value: number };
    createdCount: number;
  }> {
    if (!this.storage) {
      return {
        byLabel: new Map<string, Status>(),
        nextPosition: { value: 0 },
        createdCount: 0,
      };
    }

    const allStatuses: Status[] = [];
    let offset = 0;
    while (true) {
      const page = await this.storage.listStatuses(projectId, {
        limit: SQLITE_STATUS_PAGE_SIZE,
        offset,
      });
      allStatuses.push(...page.items);
      offset += page.items.length;
      if (offset >= page.total || page.items.length === 0) {
        break;
      }
    }

    const byLabel = new Map<string, Status>();
    let maxPosition = -1;
    for (const status of allStatuses) {
      byLabel.set(status.label.trim().toLowerCase(), status);
      maxPosition = Math.max(maxPosition, status.position);
    }

    return {
      byLabel,
      nextPosition: { value: maxPosition + 1 },
      createdCount: 0,
    };
  }

  private async ensureMainStatus(
    projectId: string,
    resolvedStatus: ResolvedStatus,
    statusState: {
      byLabel: Map<string, Status>;
      nextPosition: { value: number };
      createdCount: number;
    },
  ): Promise<string> {
    if (!this.storage) {
      throw new Error('Storage service is unavailable for main status mapping');
    }

    const normalizedLabel = resolvedStatus.label.trim().toLowerCase();
    const existing = statusState.byLabel.get(normalizedLabel);
    if (existing) {
      return existing.id;
    }

    const created = await this.storage.createStatus({
      projectId,
      label: resolvedStatus.label,
      color: resolvedStatus.color,
      position: statusState.nextPosition.value++,
    });
    statusState.byLabel.set(normalizedLabel, created);
    statusState.createdCount += 1;
    return created.id;
  }

  private async buildMainAgentMap(projectId: string): Promise<Map<string, string>> {
    if (!this.storage) {
      return new Map();
    }

    const byName = new Map<string, string>();
    let offset = 0;
    while (true) {
      const page = await this.storage.listAgents(projectId, {
        limit: SQLITE_AGENT_PAGE_SIZE,
        offset,
      });
      for (const agent of page.items) {
        const normalized = agent.name.trim().toLowerCase();
        if (!byName.has(normalized)) {
          byName.set(normalized, agent.id);
        }
      }
      offset += page.items.length;
      if (offset >= page.total || page.items.length === 0) {
        break;
      }
    }

    return byName;
  }

  private async loadExistingMergedEpicMap(
    projectId: string,
    worktreeId: string,
  ): Promise<Map<string, string>> {
    if (!this.storage) {
      return new Map();
    }

    const sourceToTarget = new Map<string, string>();
    let offset = 0;
    while (true) {
      const page = await this.storage.listProjectEpics(projectId, {
        type: 'all',
        limit: SQLITE_EPIC_PAGE_SIZE,
        offset,
      });

      for (const epic of page.items) {
        const sourceEpicId = this.extractSourceEpicId(epic, worktreeId);
        if (sourceEpicId && !sourceToTarget.has(sourceEpicId)) {
          sourceToTarget.set(sourceEpicId, epic.id);
        }
      }

      offset += page.items.length;
      if (offset >= page.total || page.items.length === 0) {
        break;
      }
    }

    return sourceToTarget;
  }

  private extractSourceEpicId(epic: Epic, worktreeId: string): string | null {
    const data = epic.data;
    if (data && typeof data === 'object' && 'mergedFrom' in data) {
      const mergedFrom = (data as { mergedFrom?: Record<string, unknown> }).mergedFrom;
      if (mergedFrom && typeof mergedFrom === 'object') {
        const mergedWorktreeId = mergedFrom.worktreeId;
        const sourceEpicId = mergedFrom.sourceEpicId;
        if (
          typeof mergedWorktreeId === 'string' &&
          mergedWorktreeId === worktreeId &&
          typeof sourceEpicId === 'string' &&
          sourceEpicId.trim().length > 0
        ) {
          return sourceEpicId.trim();
        }
      }
    }

    return null;
  }

  private resolveRawSqliteClientForStorage(storage: StorageService): Database.Database | null {
    const storageWithDb = storage as unknown as {
      db?: BetterSQLite3Database;
    };
    if (!storageWithDb.db) {
      return null;
    }

    try {
      return getRawSqliteClient(storageWithDb.db);
    } catch {
      return null;
    }
  }

  private resolveRawSqliteClientForOrchestratorDb(): Database.Database | null {
    try {
      const raw = getRawSqliteClient(this.db as BetterSQLite3Database);
      if (!raw || typeof raw.exec !== 'function') {
        return null;
      }
      return raw;
    } catch {
      return null;
    }
  }

  private async runWithSqliteMergeLock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.sqliteMergeImportQueue;
    let release!: () => void;
    this.sqliteMergeImportQueue = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private buildMergedTags(sourceTags: string[], worktreeName: string): string[] {
    const tags = new Set<string>();
    for (const tag of sourceTags) {
      const trimmed = tag.trim();
      if (trimmed.length > 0) {
        tags.add(trimmed);
      }
    }

    tags.add(`${MERGED_TAG_PREFIX}${worktreeName}`);

    return [...tags];
  }
}
