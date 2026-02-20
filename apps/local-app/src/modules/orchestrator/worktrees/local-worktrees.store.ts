import { randomUUID } from 'crypto';
import { Inject, Injectable } from '@nestjs/common';
import { eq, inArray } from 'drizzle-orm';
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { DB_CONNECTION } from '../../storage/db/db.provider';
import { worktrees as sqliteWorktrees } from '../../storage/db/schema';
import {
  CreateWorktreeRecordInput,
  UpdateWorktreeRecordInput,
  WorktreeRecord,
  WorktreesStore,
} from './worktrees.store';

type SqliteWorktreeRow = typeof sqliteWorktrees.$inferSelect;
type SqliteWorktreeInsert = typeof sqliteWorktrees.$inferInsert;

@Injectable()
export class LocalWorktreesStore implements WorktreesStore {
  constructor(@Inject(DB_CONNECTION) private readonly db: BetterSQLite3Database) {}

  async create(data: CreateWorktreeRecordInput): Promise<WorktreeRecord> {
    const nowIso = new Date().toISOString();
    const values: SqliteWorktreeInsert = {
      id: randomUUID(),
      name: data.name as string,
      branchName: data.branchName as string,
      baseBranch: data.baseBranch as string,
      repoPath: data.repoPath as string,
      worktreePath: (data.worktreePath as string | null | undefined) ?? null,
      containerId: (data.containerId as string | null | undefined) ?? null,
      containerPort: (data.containerPort as number | null | undefined) ?? null,
      templateSlug: data.templateSlug as string,
      ownerProjectId: data.ownerProjectId as string,
      status: ((data.status as string | null | undefined) ?? 'creating') as string,
      description: (data.description as string | null | undefined) ?? null,
      devchainProjectId: (data.devchainProjectId as string | null | undefined) ?? null,
      mergeCommit: (data.mergeCommit as string | null | undefined) ?? null,
      mergeConflicts: (data.mergeConflicts as string | null | undefined) ?? null,
      errorMessage: (data.errorMessage as string | null | undefined) ?? null,
      runtimeType: (data.runtimeType as string | undefined) ?? 'container',
      processId: (data.processId as number | null | undefined) ?? null,
      runtimeToken: (data.runtimeToken as string | null | undefined) ?? null,
      startedAt: this.normalizeDateInput(data.startedAt),
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    const [created] = await this.db.insert(sqliteWorktrees).values(values).returning();
    if (!created) {
      throw new Error('Failed to create worktree row');
    }
    return this.toWorktreeRecord(created);
  }

  async list(): Promise<WorktreeRecord[]> {
    const rows = await this.db.select().from(sqliteWorktrees);
    return rows.map((row) => this.toWorktreeRecord(row));
  }

  async listByOwnerProject(ownerProjectId: string): Promise<WorktreeRecord[]> {
    const rows = await this.db
      .select()
      .from(sqliteWorktrees)
      .where(eq(sqliteWorktrees.ownerProjectId, ownerProjectId));
    return rows.map((row) => this.toWorktreeRecord(row));
  }

  async getById(id: string): Promise<WorktreeRecord | null> {
    const [row] = await this.db.select().from(sqliteWorktrees).where(eq(sqliteWorktrees.id, id));
    return row ? this.toWorktreeRecord(row) : null;
  }

  async getByName(name: string): Promise<WorktreeRecord | null> {
    const [row] = await this.db
      .select()
      .from(sqliteWorktrees)
      .where(eq(sqliteWorktrees.name, name));
    return row ? this.toWorktreeRecord(row) : null;
  }

  async getByContainerId(containerId: string): Promise<WorktreeRecord | null> {
    const [row] = await this.db
      .select()
      .from(sqliteWorktrees)
      .where(eq(sqliteWorktrees.containerId, containerId));
    return row ? this.toWorktreeRecord(row) : null;
  }

  async listMonitored(): Promise<WorktreeRecord[]> {
    const rows = await this.db
      .select()
      .from(sqliteWorktrees)
      .where(inArray(sqliteWorktrees.status, ['running', 'error']));
    return rows.map((row) => this.toWorktreeRecord(row));
  }

  async update(id: string, patch: UpdateWorktreeRecordInput): Promise<WorktreeRecord | null> {
    const values = this.toSqlitePatch(patch);

    const [updated] = await this.db
      .update(sqliteWorktrees)
      .set(values)
      .where(eq(sqliteWorktrees.id, id))
      .returning();
    return updated ? this.toWorktreeRecord(updated) : null;
  }

  async remove(id: string): Promise<void> {
    await this.db.delete(sqliteWorktrees).where(eq(sqliteWorktrees.id, id));
  }

  private toSqlitePatch(patch: UpdateWorktreeRecordInput): Partial<SqliteWorktreeInsert> {
    const values: Partial<SqliteWorktreeInsert> = {
      updatedAt:
        patch.updatedAt instanceof Date ? patch.updatedAt.toISOString() : new Date().toISOString(),
    };

    if (patch.name !== undefined) values.name = patch.name as string;
    if (patch.branchName !== undefined) values.branchName = patch.branchName as string;
    if (patch.baseBranch !== undefined) values.baseBranch = patch.baseBranch as string;
    if (patch.repoPath !== undefined) values.repoPath = patch.repoPath as string;
    if (patch.worktreePath !== undefined) values.worktreePath = patch.worktreePath as string | null;
    if (patch.containerId !== undefined) values.containerId = patch.containerId as string | null;
    if (patch.containerPort !== undefined)
      values.containerPort = patch.containerPort as number | null;
    if (patch.templateSlug !== undefined) values.templateSlug = patch.templateSlug as string;
    if (patch.ownerProjectId !== undefined) values.ownerProjectId = patch.ownerProjectId as string;
    if (patch.status !== undefined) values.status = patch.status as string;
    if (patch.description !== undefined) values.description = patch.description as string | null;
    if (patch.devchainProjectId !== undefined) {
      values.devchainProjectId = patch.devchainProjectId as string | null;
    }
    if (patch.mergeCommit !== undefined) values.mergeCommit = patch.mergeCommit as string | null;
    if (patch.mergeConflicts !== undefined) {
      values.mergeConflicts = patch.mergeConflicts as string | null;
    }
    if (patch.errorMessage !== undefined) values.errorMessage = patch.errorMessage as string | null;
    if (patch.runtimeType !== undefined) values.runtimeType = patch.runtimeType as string;
    if (patch.processId !== undefined) values.processId = patch.processId as number | null;
    if (patch.runtimeToken !== undefined) values.runtimeToken = patch.runtimeToken as string | null;
    if (patch.startedAt !== undefined) values.startedAt = this.normalizeDateInput(patch.startedAt);

    return values;
  }

  private toWorktreeRecord(row: SqliteWorktreeRow): WorktreeRecord {
    return {
      id: row.id,
      name: row.name,
      branchName: row.branchName,
      baseBranch: row.baseBranch,
      repoPath: row.repoPath,
      worktreePath: row.worktreePath,
      containerId: row.containerId,
      containerPort: row.containerPort,
      templateSlug: row.templateSlug,
      ownerProjectId: row.ownerProjectId,
      status: row.status,
      description: row.description,
      devchainProjectId: row.devchainProjectId,
      mergeCommit: row.mergeCommit,
      mergeConflicts: row.mergeConflicts,
      errorMessage: row.errorMessage,
      runtimeType: row.runtimeType,
      processId: row.processId,
      runtimeToken: row.runtimeToken,
      startedAt: row.startedAt ? new Date(row.startedAt) : null,
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt),
    };
  }

  private normalizeDateInput(value: unknown): string | null {
    if (value == null) {
      return null;
    }
    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? null : value.toISOString();
    }
    if (typeof value === 'string') {
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
    }
    return null;
  }
}
