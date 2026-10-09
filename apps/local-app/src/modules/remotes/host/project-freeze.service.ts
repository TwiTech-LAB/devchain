import { Inject, Injectable } from '@nestjs/common';
import { ProjectFrozenError } from '../../../common/errors/error-types';
import { createLogger } from '../../../common/logging/logger';
import {
  STORAGE_SERVICE,
  type FrozenProject,
  type ProjectHostStorage,
} from '../../storage/interfaces/storage.interface';
import { ProjectWriteGate } from '../../storage/write-gate/project-write-gate';

const logger = createLogger('ProjectFreezeService');

/**
 * The remote-handoff write freeze. Persisted in `projects.frozen_at` so it
 * survives a restart, and mirrored in memory so write guards check it without
 * a query.
 */
@Injectable()
export class ProjectFreezeService {
  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: ProjectHostStorage,
    private readonly gate: ProjectWriteGate,
  ) {}

  isFrozen(projectId: string): boolean {
    return this.gate.isFrozen(projectId);
  }

  frozenProjectIds(): string[] {
    return this.gate.frozenProjectIds();
  }

  /** Throws `ProjectFrozenError` (423 `PROJECT_FROZEN`) while the project is frozen. */
  assertWritable(projectId: string): void {
    if (this.gate.isFrozen(projectId)) {
      throw new ProjectFrozenError(projectId);
    }
  }

  /** Idempotent: freezing a frozen project keeps its original `frozenAt`. */
  async freeze(projectId: string): Promise<FrozenProject> {
    const frozenAt = this.gate.getFrozenAt(projectId) ?? new Date().toISOString();
    await this.storage.setProjectFrozen(projectId, frozenAt);
    this.gate.markFrozen(projectId, frozenAt);
    logger.info({ projectId }, 'Project frozen');
    return { projectId, frozenAt };
  }

  /**
   * Freezes in memory only, for a project whose row is about to be written
   * frozen (an import). Keeps an existing `frozenAt`; returns the one in force.
   */
  hold(projectId: string, frozenAt: string): string {
    const current = this.gate.getFrozenAt(projectId) ?? frozenAt;
    this.gate.markFrozen(projectId, current);
    return current;
  }

  async thaw(projectId: string): Promise<void> {
    await this.storage.setProjectFrozen(projectId, null);
    this.gate.markThawed(projectId);
    logger.info({ projectId }, 'Project thawed');
  }

  /** Drops the in-memory flag of a project whose row no longer exists. */
  forget(projectId: string): void {
    this.gate.markThawed(projectId);
  }
}
