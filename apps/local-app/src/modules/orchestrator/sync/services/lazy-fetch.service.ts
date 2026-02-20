import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { eq, inArray, sql } from 'drizzle-orm';
import { createLogger } from '../../../../common/logging/logger';
import { GitWorktreeService } from '../../git/services/git-worktree.service';
import {
  ORCHESTRATOR_DB_CONNECTION,
  OrchestratorDatabase,
} from '../../orchestrator-storage/db/orchestrator.provider';
import { mergedAgents, mergedEpics } from '../../../storage/db/schema';
import { WORKTREES_STORE, WorktreeRecord, WorktreesStore } from '../../worktrees/worktrees.store';
import {
  MergedEpicDto,
  MergedEpicHierarchyDto,
  MergedEpicHierarchyNodeDto,
  WorktreeSnapshot,
} from '../dtos/overview.dto';

const logger = createLogger('OrchestratorLazyFetchService');

const CACHE_TTL_MS = 30_000;
const CONTAINER_FETCH_TIMEOUT_MS = 5_000;

type MergedEpicRow = typeof mergedEpics.$inferSelect;

interface CacheEntry<T> {
  signature: string;
  expiresAt: number;
  value: T;
}

interface MergedSummary {
  epicCount: number;
  agentCount: number;
  mergedAt: string;
}

interface AggregateSummaryRow {
  worktreeId: string;
  rowCount: number;
  mergedAt: string | null;
}

interface ContainerEpicsResponse {
  total?: number;
  items?: Array<{ statusId?: string | null }>;
}

interface ContainerAgentsResponse {
  total?: number;
  items?: Array<{
    sessionId?: string | null;
    online?: boolean;
    active?: boolean;
    status?: string | null;
  }>;
}

@Injectable()
export class LazyFetchService {
  private readonly snapshotCache = new Map<string, CacheEntry<WorktreeSnapshot>>();
  private readonly gitStatusCache = new Map<
    string,
    CacheEntry<{ commitsAhead: number; commitsBehind: number }>
  >();
  private readonly liveDataCache = new Map<
    NonNullable<WorktreeRecord['id']>,
    CacheEntry<NonNullable<WorktreeSnapshot['live']>>
  >();
  private readonly mergedSummaryCache = new Map<string, CacheEntry<Map<string, MergedSummary>>>();

  constructor(
    @Inject(WORKTREES_STORE) private readonly store: WorktreesStore,
    private readonly gitService: GitWorktreeService,
    @Inject(ORCHESTRATOR_DB_CONNECTION) private readonly db: OrchestratorDatabase,
  ) {}

  async fetchWorktreeStatus(worktreeId: string): Promise<WorktreeSnapshot> {
    const row = await this.store.getById(worktreeId);
    if (!row) {
      throw new NotFoundException(`Worktree not found: ${worktreeId}`);
    }

    const mergedSummaryById = await this.getMergedSummaryByWorktreeId([worktreeId]);
    return this.buildSnapshot(row, mergedSummaryById.get(worktreeId));
  }

  async fetchAllWorktreeStatuses(): Promise<WorktreeSnapshot[]> {
    const rows = await this.store.list();
    const mergedSummaryById = await this.getMergedSummaryByWorktreeId(rows.map((row) => row.id));
    return Promise.all(rows.map((row) => this.buildSnapshot(row, mergedSummaryById.get(row.id))));
  }

  async listMergedEpics(worktreeId?: string): Promise<MergedEpicDto[]> {
    const rows = await this.readMergedEpics(worktreeId);
    return rows
      .sort((a, b) => this.toEpochMs(b.mergedAt) - this.toEpochMs(a.mergedAt))
      .map((row) => this.toMergedEpicDto(row));
  }

  async getMergedEpicHierarchy(worktreeId: string): Promise<MergedEpicHierarchyDto> {
    const worktree = await this.store.getById(worktreeId);
    if (!worktree) {
      throw new NotFoundException(`Worktree not found: ${worktreeId}`);
    }

    const rows = (await this.readMergedEpics(worktreeId)).sort(
      (a, b) => this.toEpochMs(a.mergedAt) - this.toEpochMs(b.mergedAt),
    );

    const nodeByEpicId = new Map<string, MergedEpicHierarchyNodeDto>();
    for (const row of rows) {
      const mapped = this.toMergedEpicDto(row);
      nodeByEpicId.set(row.devchainEpicId, { ...mapped, children: [] });
    }

    const roots: MergedEpicHierarchyNodeDto[] = [];
    for (const row of rows) {
      const node = nodeByEpicId.get(row.devchainEpicId);
      if (!node) {
        continue;
      }

      const parentEpicId = row.parentEpicId ?? null;
      if (!parentEpicId) {
        roots.push(node);
        continue;
      }

      const parent = nodeByEpicId.get(parentEpicId);
      if (!parent) {
        roots.push(node);
        continue;
      }
      parent.children.push(node);
    }

    return {
      worktreeId,
      total: rows.length,
      roots,
    };
  }

  private async buildSnapshot(
    row: WorktreeRecord,
    mergedSummary: MergedSummary | undefined,
  ): Promise<WorktreeSnapshot> {
    const signature = this.snapshotSignature(row, mergedSummary);
    const now = Date.now();
    const cached = this.snapshotCache.get(row.id);
    if (cached && cached.signature === signature && cached.expiresAt > now) {
      return cached.value;
    }

    const git = await this.getGitStatus(row);
    const snapshot: WorktreeSnapshot = {
      worktreeId: row.id,
      worktreeName: row.name,
      branchName: row.branchName,
      status: row.status,
      git,
      fetchedAt: new Date().toISOString(),
    };

    if (String(row.status).toLowerCase() === 'running') {
      snapshot.live = await this.getLiveData(row);
    }

    if (mergedSummary) {
      snapshot.merged = {
        epicCount: mergedSummary.epicCount,
        agentCount: mergedSummary.agentCount,
        mergeCommit: row.mergeCommit ?? null,
        mergedAt: mergedSummary.mergedAt,
      };
    }

    this.snapshotCache.set(row.id, {
      signature,
      expiresAt: now + CACHE_TTL_MS,
      value: snapshot,
    });

    return snapshot;
  }

  private async getGitStatus(
    row: WorktreeRecord,
  ): Promise<{ commitsAhead: number; commitsBehind: number }> {
    const signature = [row.repoPath, row.baseBranch, row.branchName].join('|');
    const cacheKey = row.id;
    const now = Date.now();
    const cached = this.gitStatusCache.get(cacheKey);
    if (cached && cached.signature === signature && cached.expiresAt > now) {
      return cached.value;
    }

    try {
      const branchStatus = await this.gitService.getBranchStatus(
        row.repoPath,
        row.baseBranch,
        row.branchName,
      );
      const value = {
        commitsAhead: branchStatus.commitsAhead,
        commitsBehind: branchStatus.commitsBehind,
      };
      this.gitStatusCache.set(cacheKey, {
        signature,
        expiresAt: now + CACHE_TTL_MS,
        value,
      });
      return value;
    } catch (error) {
      logger.warn({ error, worktreeId: row.id }, 'Failed to compute git status for overview');
      return { commitsAhead: 0, commitsBehind: 0 };
    }
  }

  private async getLiveData(row: WorktreeRecord): Promise<NonNullable<WorktreeSnapshot['live']>> {
    const signature = [
      row.containerPort ?? '',
      row.devchainProjectId ?? '',
      row.updatedAt.toISOString(),
    ].join('|');
    const cacheKey = row.id;
    const now = Date.now();
    const cached = this.liveDataCache.get(cacheKey);
    if (cached && cached.signature === signature && cached.expiresAt > now) {
      return cached.value;
    }

    const fallback: NonNullable<WorktreeSnapshot['live']> = {
      epics: { total: 0, byStatus: {} },
      agents: { total: 0, active: 0 },
      fetchedAt: new Date().toISOString(),
      error: 'Container is not reachable',
    };

    if (!row.containerPort || !row.devchainProjectId) {
      this.liveDataCache.set(cacheKey, {
        signature,
        expiresAt: now + CACHE_TTL_MS,
        value: fallback,
      });
      return fallback;
    }

    const baseUrl = `http://127.0.0.1:${row.containerPort}`;
    try {
      const [epicsPayload, agentsPayload] = await Promise.all([
        this.fetchContainerJson<ContainerEpicsResponse>(
          `${baseUrl}/api/epics?projectId=${encodeURIComponent(row.devchainProjectId)}&limit=1000`,
        ),
        this.fetchContainerJson<ContainerAgentsResponse>(
          `${baseUrl}/api/agents?projectId=${encodeURIComponent(row.devchainProjectId)}`,
        ),
      ]);

      const byStatus = (epicsPayload.items ?? []).reduce<Record<string, number>>((acc, epic) => {
        const key = (epic.statusId ?? 'unknown').trim() || 'unknown';
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      }, {});

      const agentItems = agentsPayload.items ?? [];
      const inferredActive = agentItems.filter((agent) => {
        if (agent.online === true || agent.active === true || Boolean(agent.sessionId)) {
          return true;
        }
        const normalized = agent.status?.toLowerCase() ?? '';
        return normalized === 'active' || normalized === 'online' || normalized === 'running';
      }).length;
      const totalAgents =
        typeof agentsPayload.total === 'number' ? agentsPayload.total : agentItems.length;
      const activeAgents = inferredActive > 0 ? inferredActive : totalAgents;

      const liveData: NonNullable<WorktreeSnapshot['live']> = {
        epics: {
          total:
            typeof epicsPayload.total === 'number'
              ? epicsPayload.total
              : (epicsPayload.items?.length ?? 0),
          byStatus,
        },
        agents: {
          total: totalAgents,
          active: activeAgents,
        },
        fetchedAt: new Date().toISOString(),
      };

      this.liveDataCache.set(cacheKey, {
        signature,
        expiresAt: now + CACHE_TTL_MS,
        value: liveData,
      });
      return liveData;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Container is not reachable';
      const failed: NonNullable<WorktreeSnapshot['live']> = {
        ...fallback,
        fetchedAt: new Date().toISOString(),
        error: message,
      };
      this.liveDataCache.set(cacheKey, {
        signature,
        expiresAt: now + CACHE_TTL_MS,
        value: failed,
      });
      return failed;
    }
  }

  private async getMergedSummaryByWorktreeId(
    worktreeIds: string[],
  ): Promise<Map<string, MergedSummary>> {
    const normalizedIds = [
      ...new Set(worktreeIds.map((id) => id.trim()).filter((id) => id.length > 0)),
    ];
    if (normalizedIds.length === 0) {
      return new Map();
    }

    const signature = normalizedIds.slice().sort().join('|');
    const now = Date.now();
    const cached = this.mergedSummaryCache.get(signature);
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }

    const [epicsRows, agentsRows] = await Promise.all([
      this.readMergedEpicSummaryRows(normalizedIds),
      this.readMergedAgentSummaryRows(normalizedIds),
    ]);
    const byWorktree = new Map<string, MergedSummary>();

    for (const row of epicsRows) {
      const epicCount = this.normalizeCount(row.rowCount);
      const existing = byWorktree.get(row.worktreeId);
      const mergedAtIso = this.normalizeMergedAt(row.mergedAt);
      if (!existing) {
        byWorktree.set(row.worktreeId, {
          epicCount,
          agentCount: 0,
          mergedAt: mergedAtIso ?? new Date(0).toISOString(),
        });
        continue;
      }
      existing.epicCount += epicCount;
      if (mergedAtIso && mergedAtIso > existing.mergedAt) {
        existing.mergedAt = mergedAtIso;
      }
    }

    for (const row of agentsRows) {
      const agentCount = this.normalizeCount(row.rowCount);
      const existing = byWorktree.get(row.worktreeId);
      const mergedAtIso = this.normalizeMergedAt(row.mergedAt);
      if (!existing) {
        byWorktree.set(row.worktreeId, {
          epicCount: 0,
          agentCount,
          mergedAt: mergedAtIso ?? new Date(0).toISOString(),
        });
        continue;
      }
      existing.agentCount += agentCount;
      if (mergedAtIso && mergedAtIso > existing.mergedAt) {
        existing.mergedAt = mergedAtIso;
      }
    }

    this.mergedSummaryCache.set(signature, {
      signature,
      expiresAt: now + CACHE_TTL_MS,
      value: byWorktree,
    });

    return byWorktree;
  }

  private snapshotSignature(row: WorktreeRecord, mergedSummary: MergedSummary | undefined): string {
    return [
      row.updatedAt.toISOString(),
      row.status,
      row.containerPort ?? '',
      row.devchainProjectId ?? '',
      row.branchName,
      row.baseBranch,
      mergedSummary?.epicCount ?? 0,
      mergedSummary?.agentCount ?? 0,
      mergedSummary?.mergedAt ?? '',
    ].join('|');
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

  private normalizeCount(value: unknown): number {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return Math.max(0, Math.floor(value));
    }
    if (typeof value === 'string') {
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed)) {
        return Math.max(0, parsed);
      }
    }
    return 0;
  }

  private normalizeMergedAt(value: Date | string | null): string | null {
    if (!value) {
      return null;
    }
    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? null : value.toISOString();
    }
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      return null;
    }
    return parsed.toISOString();
  }

  private async readMergedEpics(worktreeId?: string): Promise<MergedEpicRow[]> {
    const condition = worktreeId ? eq(mergedEpics.worktreeId, worktreeId) : sql`true`;
    return this.db.select().from(mergedEpics).where(condition);
  }

  private async readMergedEpicSummaryRows(worktreeIds: string[]): Promise<AggregateSummaryRow[]> {
    return this.db
      .select({
        worktreeId: mergedEpics.worktreeId,
        rowCount: sql<number>`cast(count(*) as int)`,
        mergedAt: sql<string>`max(${mergedEpics.mergedAt})`,
      })
      .from(mergedEpics)
      .where(inArray(mergedEpics.worktreeId, worktreeIds))
      .groupBy(mergedEpics.worktreeId);
  }

  private async readMergedAgentSummaryRows(worktreeIds: string[]): Promise<AggregateSummaryRow[]> {
    return this.db
      .select({
        worktreeId: mergedAgents.worktreeId,
        rowCount: sql<number>`cast(count(*) as int)`,
        mergedAt: sql<string>`max(${mergedAgents.mergedAt})`,
      })
      .from(mergedAgents)
      .where(inArray(mergedAgents.worktreeId, worktreeIds))
      .groupBy(mergedAgents.worktreeId);
  }

  private toMergedEpicDto(row: MergedEpicRow): MergedEpicDto {
    const mergedAt = this.normalizeMergedAt(row.mergedAt) ?? new Date(0).toISOString();
    return {
      id: row.id,
      worktreeId: row.worktreeId,
      devchainEpicId: row.devchainEpicId,
      title: row.title,
      description: row.description ?? null,
      statusName: row.statusName ?? null,
      statusColor: row.statusColor ?? null,
      agentName: row.agentName ?? null,
      parentEpicId: row.parentEpicId ?? null,
      tags: Array.isArray(row.tags) ? row.tags : [],
      createdAtSource: this.normalizeMergedAt(row.createdAtSource),
      mergedAt,
    };
  }

  private toEpochMs(value: string | Date | null): number {
    const iso = this.normalizeMergedAt(value);
    if (!iso) {
      return 0;
    }
    return new Date(iso).getTime();
  }
}
