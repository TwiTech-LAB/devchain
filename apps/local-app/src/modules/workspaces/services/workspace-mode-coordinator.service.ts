import { Inject, Injectable, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ValidationError } from '../../../common/errors/error-types';
import { createLogger } from '../../../common/logging/logger';
import {
  STORAGE_SERVICE,
  type ProjectWorkspaceStorage,
} from '../../storage/interfaces/storage.interface';
import type {
  DeleteProjectWorkspaceResult,
  ProjectWorkspace,
} from '../../storage/models/domain.models';
import {
  PROJECT_WORKSPACE_CHANGED_EVENT,
  type ProjectWorkspaceChangedEvent,
} from '../../projects/events/project-workspace-changed.events';
import {
  type WorkspaceModeCleanupHook,
  WORKSPACE_MODE_CHANGED_EVENT,
  type WorkspaceModeSnapshot,
} from './workspace-mode-control';

const logger = createLogger('WorkspaceModeCoordinator');

@Injectable()
export class WorkspaceModeCoordinatorService {
  private mutationTail: Promise<void> = Promise.resolve();
  private failClosedPending = false;
  private readonly cleanupHooks = new Map<string, WorkspaceModeCleanupHook>();

  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: ProjectWorkspaceStorage,
    @Optional() private readonly eventEmitter?: EventEmitter2,
  ) {}

  getSnapshot(): Promise<WorkspaceModeSnapshot> {
    return this.storage.listProjectWorkspaces().then((workspaces) => ({
      multiWorkspaceMode: workspaces.length > 1,
      failClosedPending: this.failClosedPending,
    }));
  }

  list(): Promise<ProjectWorkspace[]> {
    return this.storage.listProjectWorkspaces();
  }

  registerCleanupHook(name: string, hook: WorkspaceModeCleanupHook): () => void {
    if (!name.trim()) throw new ValidationError('Workspace cleanup hook name is required');
    if (this.cleanupHooks.has(name)) {
      throw new ValidationError(`Workspace cleanup hook "${name}" is already registered`);
    }
    this.cleanupHooks.set(name, hook);
    return () => {
      if (this.cleanupHooks.get(name) === hook) this.cleanupHooks.delete(name);
    };
  }

  create(name: string): Promise<ProjectWorkspace> {
    return this.serialize(async () => {
      const before = await this.storage.listProjectWorkspaces();
      if (before.length !== 1) return this.storage.createProjectWorkspace(name);

      this.failClosedPending = true;
      this.publishSnapshot(false);
      try {
        await this.runCleanupHooks();
        const created = await this.storage.createProjectWorkspace(name);
        this.failClosedPending = false;
        this.publishSnapshot(true);
        return created;
      } catch (error) {
        this.failClosedPending = false;
        this.publishSnapshot(false);
        throw error;
      }
    });
  }

  rename(id: string, name: string): Promise<ProjectWorkspace> {
    return this.serialize(() => this.storage.renameProjectWorkspace(id, name));
  }

  reorder(workspaceIds: string[]): Promise<ProjectWorkspace[]> {
    return this.serialize(() => this.storage.reorderProjectWorkspaces(workspaceIds));
  }

  delete(id: string, replacementWorkspaceId: string): Promise<DeleteProjectWorkspaceResult> {
    return this.serialize(async () => {
      const before = await this.storage.listProjectWorkspaces();
      const result = await this.storage.deleteProjectWorkspace(id, replacementWorkspaceId);
      if (result.movedProjectCount > 0) {
        const event: ProjectWorkspaceChangedEvent = {
          previousWorkspaceId: id,
          workspaceId: replacementWorkspaceId,
        };
        this.emitSafely(PROJECT_WORKSPACE_CHANGED_EVENT, event);
      }
      if (before.length === 2) {
        this.publishSnapshot(false);
      }
      return result;
    });
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutationTail.then(operation);
    this.mutationTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private publishSnapshot(multiWorkspaceMode: boolean): void {
    this.emitSafely(WORKSPACE_MODE_CHANGED_EVENT, {
      multiWorkspaceMode,
      failClosedPending: this.failClosedPending,
    } satisfies WorkspaceModeSnapshot);
  }

  private emitSafely(eventName: string, event: unknown): void {
    try {
      this.eventEmitter?.emit(eventName, event);
    } catch (error) {
      logger.warn({ error, eventName }, 'Local workspace event listener failed');
    }
  }

  private async runCleanupHooks(): Promise<void> {
    for (const [name, hook] of this.cleanupHooks) {
      try {
        await hook();
      } catch (error) {
        logger.warn({ error, hook: name }, 'Local workspace-mode cleanup hook failed');
        throw error;
      }
    }
  }
}
