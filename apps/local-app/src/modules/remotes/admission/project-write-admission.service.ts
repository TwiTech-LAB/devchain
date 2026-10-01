import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { NotFoundError, ProjectRemoteError } from '../../../common/errors/error-types';
import { createLogger } from '../../../common/logging/logger';
import { STORAGE_SERVICE, type RemoteStorage } from '../../storage/interfaces/storage.interface';
import type { RemoteBindingState } from '../../storage/models/domain.models';
import { ProjectFreezeService } from '../host/project-freeze.service';

const logger = createLogger('ProjectWriteAdmissionService');

/** Binding states in which the remote, not this instance, owns the project's writes. */
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

/**
 * The single write gate for project-scoped data. Reads stay open; every write
 * entry point calls `assertWritable` before it changes anything.
 *
 * Both checks are synchronous map reads. The binding map is loaded on start and
 * reloaded with `refreshBindings()` after every binding write
 * (`RemoteBindingsService`) and remote rename.
 */
@Injectable()
export class ProjectWriteAdmissionService implements OnModuleInit {
  private remoteOwned = new Map<string, RemoteOwnedProject>();

  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: RemoteStorage,
    private readonly freeze: ProjectFreezeService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.refreshBindings();
  }

  async refreshBindings(): Promise<void> {
    const bindings = (await this.storage.listRemoteProjectBindings()).filter((binding) =>
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

  /**
   * Throws `ProjectFrozenError` (423 `PROJECT_FROZEN`) while a handoff freezes
   * the project here, or `ProjectRemoteError` (423 `PROJECT_REMOTE`) while a
   * remote owns it. A null project (global rows) is always writable.
   */
  assertWritable(projectId: string | null | undefined): void {
    if (!projectId) return;
    // Remote ownership first: home stays frozen for as long as a remote owns the
    // project, and the error should name that remote.
    const owned = this.remoteOwned.get(projectId);
    if (owned) {
      throw new ProjectRemoteError(projectId, owned.remoteId, owned.remoteName);
    }
    this.freeze.assertWritable(projectId);
  }

  isWritable(projectId: string): boolean {
    return !this.freeze.isFrozen(projectId) && !this.remoteOwned.has(projectId);
  }

  /** Projects that are frozen here or owned by a remote. */
  listNonWritableProjectIds(): string[] {
    return [...new Set([...this.freeze.frozenProjectIds(), ...this.remoteOwned.keys()])];
  }

  /** Projects whose writes (and time accounting) belong to a remote. */
  listRemoteOwnedProjectIds(): string[] {
    return [...this.remoteOwned.keys()];
  }

  /** The remote that owns the project, or null when this instance does. */
  getRemoteOwner(projectId: string): RemoteOwnedProject | null {
    return this.remoteOwned.get(projectId) ?? null;
  }

  private async readRemoteName(remoteId: string): Promise<string | null> {
    try {
      return (await this.storage.getRemote(remoteId)).name;
    } catch (error) {
      if (error instanceof NotFoundError) {
        logger.warn({ remoteId }, 'Binding references a missing remote');
        return null;
      }
      throw error;
    }
  }
}
