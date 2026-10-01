import { watch, type FSWatcher } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createLogger } from '../../common/logging/logger';
import { OPENCODE_AUTH_FILE_PATH, PROVIDER_AUTH_ADAPTERS } from './provider-auth-adapters';

const logger = createLogger('ProviderAuthWatcher');

/** One changed login file in a families report; `path` is the home-relative adapter path. */
export interface ProviderAuthFamilyFile {
  path: string;
  contentBase64: string;
  /** Epoch ms of the file's last change; home echoes it back as `since`. */
  mtime: number;
}

export interface ProviderAuthFamilyReport {
  provider: string;
  files: ProviderAuthFamilyFile[];
}

/** The family files of the adapter table: which login file belongs to which provider. */
export function familyFilePaths(): Array<{ provider: string; path: string }> {
  const files: Array<{ provider: string; path: string }> = [];
  for (const [provider, spec] of Object.entries(PROVIDER_AUTH_ADAPTERS)) {
    if (spec.payloadKind === 'files') {
      files.push({ provider, path: spec.filePath });
    }
  }
  files.push({ provider: 'opencode', path: OPENCODE_AUTH_FILE_PATH });
  return files;
}

// Editors and the claim rewrite files by rename, so the containing directory is
// the stable thing to watch; events are coalesced before the cache refresh.
const WATCH_DEBOUNCE_MS = 500;

/**
 * Watches the family login files of a claimed host (host role). The VM's CLIs
 * refresh these files on their own; this service keeps a base64 snapshot warm
 * so home's health-poll pull (`GET /api/host/provider-auth/families?since=`)
 * serves changed content without re-reading a file mid-rewrite. Contents are
 * never logged — only providers, paths and mtimes.
 */
@Injectable()
export class ProviderAuthWatcherService implements OnModuleInit, OnModuleDestroy {
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly snapshot = new Map<string, { contentBase64: string; mtimeMs: number }>();
  private refreshTimer: NodeJS.Timeout | null = null;

  onModuleInit(): void {
    this.ensureWatchers();
  }

  onModuleDestroy(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
  }

  /** Only files changed after `sinceMs`, with content; an empty answer is the cheap path. */
  async getFamilies(sinceMs: number): Promise<ProviderAuthFamilyReport[]> {
    this.ensureWatchers();
    const reports: ProviderAuthFamilyReport[] = [];
    for (const { provider, path } of familyFilePaths()) {
      const absolute = this.absolute(path);
      let mtimeMs: number;
      try {
        mtimeMs = (await stat(absolute)).mtimeMs;
      } catch {
        continue; // No login file → the family is not in use on this host.
      }
      if (!(mtimeMs > sinceMs)) continue;
      const contentBase64 = await this.readSnapshotted(absolute, mtimeMs);
      reports.push({ provider, files: [{ path, contentBase64, mtime: mtimeMs }] });
    }
    if (reports.length > 0) {
      logger.info(
        { providers: reports.map((report) => report.provider) },
        'Reporting changed provider families',
      );
    }
    return reports;
  }

  private async readSnapshotted(absolute: string, mtimeMs: number): Promise<string> {
    const cached = this.snapshot.get(absolute);
    if (cached && cached.mtimeMs === mtimeMs) {
      return cached.contentBase64;
    }
    const contentBase64 = (await readFile(absolute)).toString('base64');
    this.snapshot.set(absolute, { contentBase64, mtimeMs });
    return contentBase64;
  }

  /** Watches each family file's directory once it exists; the poll retries missing ones. */
  private ensureWatchers(): void {
    for (const { path } of familyFilePaths()) {
      const dir = dirname(this.absolute(path));
      if (this.watchers.has(dir)) continue;
      try {
        const watcher = watch(dir, { persistent: false }, () => this.scheduleRefresh());
        watcher.on('error', () => this.dropWatcher(dir));
        this.watchers.set(dir, watcher);
      } catch {
        // The directory appears with the claim; watched on a later poll.
      }
    }
  }

  private dropWatcher(dir: string): void {
    this.watchers.get(dir)?.close();
    this.watchers.delete(dir);
  }

  /** Debounced cache refresh so a rename sequence produces one read of the final content. */
  private scheduleRefresh(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refreshSnapshot();
    }, WATCH_DEBOUNCE_MS);
    this.refreshTimer.unref?.();
  }

  private async refreshSnapshot(): Promise<void> {
    for (const { path } of familyFilePaths()) {
      const absolute = this.absolute(path);
      try {
        const mtimeMs = (await stat(absolute)).mtimeMs;
        const cached = this.snapshot.get(absolute);
        if (!cached || cached.mtimeMs !== mtimeMs) {
          this.snapshot.set(absolute, {
            contentBase64: (await readFile(absolute)).toString('base64'),
            mtimeMs,
          });
        }
      } catch {
        this.snapshot.delete(absolute);
      }
    }
  }

  private absolute(relativePath: string): string {
    return join(process.env.HOME || homedir(), relativePath);
  }
}
