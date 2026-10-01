import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { ProjectFrozenError } from '../../../common/errors/error-types';
import { createLogger } from '../../../common/logging/logger';
import {
  STORAGE_SERVICE,
  type FrozenProject,
  type ProjectHostStorage,
} from '../../storage/interfaces/storage.interface';

const logger = createLogger('ProjectFreezeService');

/**
 * The remote-handoff write freeze. Persisted in `projects.frozen_at` so it
 * survives a restart, and mirrored in memory so write guards check it without
 * a query.
 */
@Injectable()
export class ProjectFreezeService implements OnModuleInit {
  private readonly frozen = new Map<string, string>();

  constructor(@Inject(STORAGE_SERVICE) private readonly storage: ProjectHostStorage) {}

  async onModuleInit(): Promise<void> {
    for (const { projectId, frozenAt } of await this.storage.listFrozenProjects()) {
      this.frozen.set(projectId, frozenAt);
    }
    if (this.frozen.size > 0) {
      logger.info({ projectIds: [...this.frozen.keys()] }, 'Restored frozen projects');
    }
  }

  isFrozen(projectId: string): boolean {
    return this.frozen.has(projectId);
  }

  frozenProjectIds(): string[] {
    return [...this.frozen.keys()];
  }

  /** Throws `ProjectFrozenError` (423 `PROJECT_FROZEN`) while the project is frozen. */
  assertWritable(projectId: string): void {
    if (this.frozen.has(projectId)) {
      throw new ProjectFrozenError(projectId);
    }
  }

  /** Idempotent: freezing a frozen project keeps its original `frozenAt`. */
  async freeze(projectId: string): Promise<FrozenProject> {
    const frozenAt = this.frozen.get(projectId) ?? new Date().toISOString();
    await this.storage.setProjectFrozen(projectId, frozenAt);
    this.frozen.set(projectId, frozenAt);
    logger.info({ projectId }, 'Project frozen');
    return { projectId, frozenAt };
  }

  /**
   * Freezes in memory only, for a project whose row is about to be written
   * frozen (an import). Keeps an existing `frozenAt`; returns the one in force.
   */
  hold(projectId: string, frozenAt: string): string {
    const current = this.frozen.get(projectId) ?? frozenAt;
    this.frozen.set(projectId, current);
    return current;
  }

  async thaw(projectId: string): Promise<void> {
    await this.storage.setProjectFrozen(projectId, null);
    this.frozen.delete(projectId);
    logger.info({ projectId }, 'Project thawed');
  }

  /** Drops the in-memory flag of a project whose row no longer exists. */
  forget(projectId: string): void {
    this.frozen.delete(projectId);
  }
}
