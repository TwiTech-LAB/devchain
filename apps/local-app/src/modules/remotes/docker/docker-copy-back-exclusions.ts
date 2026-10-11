import { Injectable } from '@nestjs/common';
import { join, relative, sep } from 'node:path';
import { AppError } from '../../../common/errors/error-types';
import { codeIgnores, type SyncFolderIgnores } from '../../file-sync/file-sync.dto';
import { FileSyncManagedExclusionsStore } from '../../file-sync/file-sync-managed-exclusions.store';
import { FileSyncService, codeFolderId } from '../../file-sync/file-sync.service';
import { firstMatch, ignoreListExcludesSubtree } from '../../file-sync/ignore-pattern-matcher';
import {
  isSelectableExclusion,
  SyncRelativePathSchema,
} from '../../file-sync/sync-path-inspection.dto';
import { RemoteHostClient } from '../operations/remote-host.client';
import { RemoteBindingsService } from '../services/remote-bindings.service';
import { FileSyncSuggestionsService } from '../sync/file-sync-suggestions.service';
import { within } from './docker-plan-files';

export interface DockerCopyBackExclusionProof {
  revision: number;
  confirmed: string[];
  /** A prepared attempt is consumed when copying begins; Retry must prepare again. */
  pending: boolean;
}

/** Operation-owned file protection; normal upkeep and ignore saves defer while detaching. */
@Injectable()
export class DockerCopyBackExclusions {
  constructor(
    private readonly files: FileSyncService,
    private readonly host: RemoteHostClient,
    private readonly suggestions: FileSyncSuggestionsService,
    private readonly managed: FileSyncManagedExclusionsStore,
    private readonly bindings: RemoteBindingsService,
  ) {}

  /** Read-only dialog evidence; copy authorization still requires an operation-owned attempt. */
  async preview(
    projectId: string,
    remoteId: string,
    root: string,
    targets: string[],
    signal?: AbortSignal,
  ): Promise<string[]> {
    if (!targets.length) return [];
    signal?.throwIfAborted();
    const revision = this.files.getIgnoresRevision(projectId);
    const binding = await this.bindings.get(projectId);
    if (binding?.remoteId !== remoteId || !['remote', 'detaching'].includes(binding.state))
      return [];
    const state = binding.state;
    try {
      const installed = await this.installedOnBoth(projectId, remoteId);
      signal?.throwIfAborted();
      const current = await this.bindings.get(projectId);
      if (
        current?.remoteId !== remoteId ||
        current.state !== state ||
        this.files.getIgnoresRevision(projectId) !== revision
      )
        return [];
      return targets.filter(
        (target) => !this.overlapsGit(root, target) && this.excludedOnBoth(root, target, installed),
      );
    } catch {
      signal?.throwIfAborted();
      return [];
    }
  }

  async prepare(
    projectId: string,
    remoteId: string,
    root: string,
    targets: string[],
    signal: AbortSignal,
  ): Promise<DockerCopyBackExclusionProof> {
    await this.admit(projectId, remoteId, signal);
    const revision = this.files.getIgnoresRevision(projectId);
    const unconfirmed = (): DockerCopyBackExclusionProof => ({
      revision,
      confirmed: this.outside(root, targets),
      pending: true,
    });
    const paths = targets.filter(
      (target) => target !== root && within(root, target) && !this.overlapsGit(root, target),
    );
    const names = paths
      .map((path) => this.projectPath(root, path))
      .filter((path) => SyncRelativePathSchema.safeParse(path).success);
    let additions: string[];
    try {
      const inspected = await this.suggestions.vmSuggestions(projectId, remoteId, names);
      signal.throwIfAborted();
      additions = inspected.groups
        .filter(
          (group) =>
            isSelectableExclusion(group) &&
            group.selected &&
            group.patternChecksPassed === true &&
            names.some((name) => {
              const match = firstMatch(group.patterns, name);
              return match.kind === 'matched' && match.ignored;
            }),
        )
        .flatMap((group) => group.patterns);
    } catch {
      await this.admit(projectId, remoteId, signal);
      return unconfirmed();
    }
    await this.admit(projectId, remoteId, signal);
    const current = this.files.getIgnores(projectId);
    const list = [...new Set([...current, ...additions])];
    // Never overwrite an edit that arrived while inspection was reading either Git index.
    if (this.files.getIgnoresRevision(projectId) !== revision) return unconfirmed();
    if (list.length !== current.length) this.files.setIgnores(projectId, list, revision);
    const savedRevision = this.files.getIgnoresRevision(projectId);
    const installed = codeIgnores(this.managed.get(projectId), this.files.getIgnores(projectId));
    const folderId = codeFolderId(projectId);
    let applied = true;
    for (const apply of [
      () => this.host.syncFolderType(remoteId, folderId, { ignores: installed }),
      () => this.files.updateFolder(folderId, { ignores: installed }),
    ]) {
      await this.admit(projectId, remoteId, signal);
      try {
        await apply();
      } catch {
        applied = false;
      }
      signal.throwIfAborted();
    }
    const confirmed = applied
      ? await this.confirm(projectId, remoteId, root, targets, savedRevision, signal)
      : this.outside(root, targets);
    await this.admit(projectId, remoteId, signal);
    return { revision: savedRevision, confirmed, pending: true };
  }

  async confirm(
    projectId: string,
    remoteId: string,
    root: string,
    targets: string[],
    revision: number,
    signal: AbortSignal,
  ): Promise<string[]> {
    await this.admit(projectId, remoteId, signal);
    const outside = this.outside(root, targets);
    if (this.files.getIgnoresRevision(projectId) !== revision) return outside;
    let installed: SyncFolderIgnores[];
    try {
      installed = await this.installedOnBoth(projectId, remoteId);
    } catch {
      await this.admit(projectId, remoteId, signal);
      return outside;
    }
    await this.admit(projectId, remoteId, signal);
    if (this.files.getIgnoresRevision(projectId) !== revision) return outside;
    return targets.filter((target) => {
      if (this.overlapsGit(root, target)) return false;
      return outside.includes(target) || this.excludedOnBoth(root, target, installed);
    });
  }

  /** The folder's installed ignore list on this side, then on the VM. */
  private installedOnBoth(projectId: string, remoteId: string): Promise<SyncFolderIgnores[]> {
    const folderId = codeFolderId(projectId);
    return Promise.all([
      this.files.installedIgnores(folderId),
      this.host.syncFolderIgnores(remoteId, folderId),
    ]);
  }

  private projectPath(root: string, target: string): string {
    return relative(root, target).split(sep).join('/');
  }

  /** True when a target inside the project is a selectable path that both peers already ignore. */
  private excludedOnBoth(root: string, target: string, installed: SyncFolderIgnores[]): boolean {
    if (target === root || !within(root, target)) return false;
    const path = this.projectPath(root, target);
    return (
      SyncRelativePathSchema.safeParse(path).success &&
      installed.every((peer) => ignoreListExcludesSubtree(peer.ignore, path))
    );
  }

  private outside(root: string, targets: string[]): string[] {
    return targets.filter(
      (target) => !within(root, target) && !within(target, root) && !this.overlapsGit(root, target),
    );
  }

  private overlapsGit(root: string, target: string): boolean {
    const gitRoot = join(root, '.git');
    return within(gitRoot, target) || within(target, gitRoot);
  }

  private async admit(projectId: string, remoteId: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const binding = await this.bindings.get(projectId);
    signal.throwIfAborted();
    if (binding?.remoteId !== remoteId || binding.state !== 'detaching')
      throw new AppError('The Disconnect binding changed.', 'FILE_SYNC_COPY_BACK_CHANGED', 409);
  }
}
