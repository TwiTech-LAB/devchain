import { Inject, Injectable } from '@nestjs/common';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger } from '../../common/logging/logger';
import type { ProviderSessionArtifacts } from '../runtime-context-capture/provider-artifacts.types';
import { existingImageDirectories, isImagePartial } from './session-image-files';
import {
  RUNTIME_DIRECTORY_HOST,
  SESSION_FILES_DIRECTORY,
  type ResolvedRuntimeDirectory,
  type RuntimeDirectoryHost,
  type RuntimeProtection,
  resolveRuntimeDirectory,
  resolveSystemdRuntimeDirectory,
  runtimeDirectoryCandidates,
} from './runtime-directory';

const logger = createLogger('RuntimeDirectoryService');

export const LAUNCH_SCRIPT_DIRECTORY = 'launch';
export { SESSION_FILES_DIRECTORY };

const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export interface RuntimeDirectoryStatus {
  readonly protection: RuntimeProtection;
  readonly lingerHint: boolean;
}

export function runtimeSessionDirectory(root: string, sessionId: string): string {
  if (!SAFE_SESSION_ID.test(sessionId)) {
    throw new Error('Session id is not safe as a directory name.');
  }
  return join(root, SESSION_FILES_DIRECTORY, sessionId);
}

/**
 * Owns the per-instance runtime directory: launch scripts in `launch/`, per-session files in
 * `session-files/<sessionId>/`. Resolution runs on every call because linger, mounts and the
 * environment can change while DevChain runs.
 */
@Injectable()
export class RuntimeDirectoryService implements ProviderSessionArtifacts {
  constructor(@Inject(RUNTIME_DIRECTORY_HOST) private readonly host: RuntimeDirectoryHost) {}

  resolve(): Promise<ResolvedRuntimeDirectory> {
    return resolveRuntimeDirectory(this.host);
  }

  instanceRoots(): string[] {
    return runtimeDirectoryCandidates(this.host, false);
  }

  resolveSystemd(): Promise<{ path: string; tmpfs: boolean } | null> {
    return resolveSystemdRuntimeDirectory(this.host);
  }

  async getStatus(): Promise<RuntimeDirectoryStatus> {
    const { protection, lingerHint } = await this.resolve();
    return { protection, lingerHint };
  }

  async cleanupSession(sessionId: string): Promise<void> {
    if (!SAFE_SESSION_ID.test(sessionId)) return;
    for (const root of runtimeDirectoryCandidates(this.host)) {
      await rm(runtimeSessionDirectory(root, sessionId), { recursive: true, force: true });
    }
  }

  /** At startup no launch is in flight, so every launch script left behind is an orphan. */
  async reconcileStartup(
    _nonLiveSessionIds: ReadonlySet<string>,
    liveSessionIds: ReadonlySet<string>,
  ): Promise<void> {
    for (const root of runtimeDirectoryCandidates(this.host)) {
      await this.removeEntries(join(root, LAUNCH_SCRIPT_DIRECTORY), () => true);
      await this.removeEntries(
        join(root, SESSION_FILES_DIRECTORY),
        (name) => !liveSessionIds.has(name),
      );
    }
    for await (const { directory } of existingImageDirectories(this.instanceRoots())) {
      await this.removeEntries(directory, isImagePartial);
    }
  }

  private async removeEntries(directory: string, shouldRemove: (name: string) => boolean) {
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn({ directory, error }, 'Failed to read runtime directory at startup');
      }
      return;
    }
    for (const name of names.filter(shouldRemove)) {
      try {
        await rm(join(directory, name), { recursive: true, force: true });
      } catch (error) {
        logger.warn({ directory, error }, 'Failed to remove a runtime file at startup');
      }
    }
  }
}
