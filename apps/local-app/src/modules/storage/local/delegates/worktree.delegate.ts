import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { and, asc, eq, sql } from 'drizzle-orm';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  WorktreeCapReachedError,
} from '../../../../common/errors/error-types';
import { worktrees } from '../../db/schema';
import type { WorktreeStorage } from '../../interfaces/storage.interface';
import type { CreateWorktree, Worktree } from '../../models/domain.models';
import { BaseStorageDelegate, type StorageDelegateContext } from './base-storage.delegate';

export class WorktreeStorageDelegate extends BaseStorageDelegate implements WorktreeStorage {
  constructor(context: StorageDelegateContext) {
    super(context);
  }

  async createWorktree(data: CreateWorktree): Promise<Worktree> {
    return this.txRunner.runImmediateQueued(() => this.insertWorktree(data));
  }

  async createWorktreeAtomicCapped(data: CreateWorktree, maxWorktrees: number): Promise<Worktree> {
    if (!Number.isSafeInteger(maxWorktrees) || maxWorktrees < 0) {
      throw new ValidationError('Worktree cap must be a non-negative integer.');
    }
    return this.txRunner.runImmediateAsync(async () => {
      const { count } = this.db
        .select({ count: sql<number>`count(*)` })
        .from(worktrees)
        .where(eq(worktrees.projectId, data.projectId))
        .get()!;
      if (count >= maxWorktrees) {
        throw new WorktreeCapReachedError(maxWorktrees, count);
      }
      return this.insertWorktree(data);
    });
  }

  async getWorktree(id: string): Promise<Worktree> {
    const row = this.db.select().from(worktrees).where(eq(worktrees.id, id)).get();
    if (!row) throw new NotFoundError('Worktree', id);
    return row;
  }

  async getWorktreeByName(projectId: string, name: string): Promise<Worktree | null> {
    return (
      this.db.select().from(worktrees).where(this.namePredicate(projectId, name)).get() ?? null
    );
  }

  async listWorktrees(projectId: string): Promise<Worktree[]> {
    return this.db
      .select()
      .from(worktrees)
      .where(eq(worktrees.projectId, projectId))
      .orderBy(asc(worktrees.name), asc(worktrees.id))
      .all();
  }

  async deleteWorktree(id: string): Promise<void> {
    await this.txRunner.runImmediateQueued(() => {
      const result = this.db.delete(worktrees).where(eq(worktrees.id, id)).run();
      if (result.changes === 0) throw new NotFoundError('Worktree', id);
    });
  }

  private namePredicate(projectId: string, name: string) {
    return and(eq(worktrees.projectId, projectId), sql`${worktrees.name} = ${name} COLLATE NOCASE`);
  }

  private insertWorktree(data: CreateWorktree): Worktree {
    if (!isAbsolute(data.path)) {
      throw new ValidationError('Worktree path must be absolute.');
    }
    const existing = this.db
      .select({ id: worktrees.id })
      .from(worktrees)
      .where(this.namePredicate(data.projectId, data.name))
      .get();
    if (existing) {
      throw new ConflictError(`Worktree with name "${data.name}" already exists in project`, {
        projectId: data.projectId,
        name: data.name,
      });
    }
    const now = new Date().toISOString();
    const row: Worktree = {
      ...data,
      id: data.id ?? randomUUID(),
      epicId: data.epicId ?? null,
      createdByAgentId: data.createdByAgentId ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.db.insert(worktrees).values(row).run();
    return row;
  }
}
