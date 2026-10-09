import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  NotFoundError,
  ProjectFrozenError,
  ProjectRemoteError,
} from '../../../common/errors/error-types';
import { createLogger } from '../../../common/logging/logger';
import type { ProjectHostStorage, RemoteStorage } from '../interfaces/storage.interface';
import type { RemoteBindingState } from '../models/domain.models';

const logger = createLogger('ProjectWriteGate');

const REMOTE_OWNED_STATES: ReadonlySet<RemoteBindingState> = new Set([
  'attaching',
  'remote',
  'detaching',
]);

export interface RemoteOwnedProject {
  projectId: string;
  remoteId: string;
  remoteName: string | null;
  state: RemoteBindingState;
}

type ProjectWriteGateStorage = Pick<RemoteStorage, 'listRemoteProjectBindings' | 'getRemote'> &
  Pick<ProjectHostStorage, 'listFrozenProjects'>;

@Injectable()
export class ProjectWriteGate implements OnModuleInit {
  private storage: ProjectWriteGateStorage | null = null;
  private remoteOwned = new Map<string, RemoteOwnedProject>();
  private readonly frozen = new Map<string, string>();

  // StorageModule binds this before lifecycle hooks. Constructor injection here
  // would form a cycle when storage injects the gate to guard its writes.
  bindStorage(storage: ProjectWriteGateStorage): void {
    this.storage = storage;
  }

  async onModuleInit(): Promise<void> {
    await this.refresh();
    for (const { projectId, frozenAt } of await this.getStorage().listFrozenProjects()) {
      this.markFrozen(projectId, frozenAt);
    }
    if (this.frozen.size > 0) {
      logger.info({ projectIds: this.frozenProjectIds() }, 'Restored frozen projects');
    }
  }

  async refresh(): Promise<void> {
    const storage = this.getStorage();
    const bindings = (await storage.listRemoteProjectBindings()).filter((binding) =>
      REMOTE_OWNED_STATES.has(binding.state),
    );
    const names = new Map<string, string | null>();
    for (const remoteId of new Set(bindings.map((binding) => binding.remoteId))) {
      names.set(remoteId, await this.readRemoteName(remoteId));
    }
    const next = new Map<string, RemoteOwnedProject>();
    for (const binding of bindings) {
      next.set(binding.projectId, {
        projectId: binding.projectId,
        remoteId: binding.remoteId,
        remoteName: names.get(binding.remoteId) ?? null,
        state: binding.state,
      });
    }
    this.remoteOwned = next;
  }

  assertWritable(projectId: string | null | undefined): void {
    if (!projectId) return;
    // A home project may also be frozen; the ownership error must name its remote.
    const owned = this.remoteOwned.get(projectId);
    if (owned) {
      throw new ProjectRemoteError(projectId, owned.remoteId, owned.remoteName);
    }
    if (this.isFrozen(projectId)) {
      throw new ProjectFrozenError(projectId);
    }
  }

  isWritable(projectId: string): boolean {
    return !this.isFrozen(projectId) && !this.remoteOwned.has(projectId);
  }

  getRemoteOwner(projectId: string): RemoteOwnedProject | null {
    return this.remoteOwned.get(projectId) ?? null;
  }

  hasBlockedProjects(): boolean {
    return this.remoteOwned.size > 0 || this.frozen.size > 0;
  }

  listNonWritableProjectIds(): string[] {
    return [...new Set([...this.frozen.keys(), ...this.remoteOwned.keys()])];
  }

  listRemoteOwnedProjectIds(): string[] {
    return [...this.remoteOwned.keys()];
  }

  isFrozen(projectId: string): boolean {
    return this.frozen.has(projectId);
  }

  frozenProjectIds(): string[] {
    return [...this.frozen.keys()];
  }

  getFrozenAt(projectId: string): string | null {
    return this.frozen.get(projectId) ?? null;
  }

  markFrozen(projectId: string, frozenAt: string): void {
    this.frozen.set(projectId, frozenAt);
  }

  markThawed(projectId: string): void {
    this.frozen.delete(projectId);
  }

  private getStorage(): ProjectWriteGateStorage {
    if (!this.storage) {
      throw new Error('ProjectWriteGate storage is not bound.');
    }
    return this.storage;
  }

  private async readRemoteName(remoteId: string): Promise<string | null> {
    try {
      return (await this.getStorage().getRemote(remoteId)).name;
    } catch (error) {
      if (error instanceof NotFoundError) {
        logger.warn({ remoteId }, 'Binding references a missing remote');
        return null;
      }
      throw error;
    }
  }
}
