import { Inject, Injectable } from '@nestjs/common';
import {
  HOST_VAULT_VALUE_MAX_BYTES,
  type HostVaultCacheUnavailable,
  type HostVaultPush,
  type HostVaultStatus,
} from '@devchain/shared';
import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { getEnvConfig } from '../../common/config/env.config';
import { ConflictError, ValidationError } from '../../common/errors/error-types';
import { createLogger } from '../../common/logging/logger';
import { isClaimedHost } from '../remotes/host-api-key';
import { RuntimeDirectoryService } from '../runtime-directory/runtime-directory.service';
import { STORAGE_SERVICE, type VaultEntryStorage } from '../storage/interfaces/storage.interface';
import { vaultSnapshotRevision } from './vault-snapshot-revision';

const logger = createLogger('VaultVmCacheService');

/** In the systemd runtime directory, next to (not inside) the swept `launch/` and `session-files/`. */
export const VAULT_VM_CACHE_FILE = 'vault-cache.json';

const CacheFileSchema = z.object({
  version: z.literal(1),
  values: z.record(z.object({ revision: z.number().int(), valueBase64: z.string() })),
});
type CacheFile = z.infer<typeof CacheFileSchema>;

type CachedEntryRef = { readonly id: string; readonly revision: number };

type CacheStorage = Pick<VaultEntryStorage, 'readVaultSnapshot' | 'replaceVaultSnapshot'>;

type CacheDirectory =
  | { readonly path: string; readonly unavailable: null }
  | { readonly path: null; readonly unavailable: HostVaultCacheUnavailable };

/**
 * A claimed VM's copy of home's Vault: metadata in the DB, values only in a 0600 file
 * in the unit's tmpfs `$RUNTIME_DIRECTORY`. The file survives a DevChain restart and
 * is gone after a reboot, until home pushes again. Never log a value.
 */
@Injectable()
export class VaultVmCacheService {
  private applying: Promise<unknown> = Promise.resolve();

  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: CacheStorage,
    private readonly runtimeDirectory: RuntimeDirectoryService,
  ) {}

  isClaimedHost(): boolean {
    return isClaimedHost(getEnvConfig().DEVCHAIN_HOST_ETC_DIR);
  }

  /**
   * Writes the values first, then the snapshot, so the snapshot never names an entry
   * whose value the cache lacks. Pushes run one at a time.
   */
  apply(push: HostVaultPush): Promise<void> {
    const run = this.applying.then(() => this.applyNow(push));
    this.applying = run.catch(() => undefined);
    return run;
  }

  async status(): Promise<HostVaultStatus> {
    const snapshot = await this.storage.readVaultSnapshot();
    const { directory, cache } = await this.readCurrent();
    return {
      appliedRevision: vaultSnapshotRevision(snapshot),
      cacheReady: directory.unavailable === null && covers(cache, snapshot.entries),
      cacheUnavailable: directory.unavailable,
    };
  }

  /** Values of `entries` at their revisions, or null when the cache lacks any of them. */
  async readValues(entries: readonly CachedEntryRef[]): Promise<Map<string, Buffer> | null> {
    const cache = await this.readCacheFor(entries);
    if (!cache) return null;
    return new Map(
      entries.map((entry) => [entry.id, Buffer.from(cache.values[entry.id].valueBase64, 'base64')]),
    );
  }

  /** True when the cache holds every one of `entries` at its revision. */
  async holds(entries: readonly CachedEntryRef[]): Promise<boolean> {
    return (await this.readCacheFor(entries)) !== null;
  }

  private async readCacheFor(entries: readonly CachedEntryRef[]): Promise<CacheFile | null> {
    const { cache } = await this.readCurrent();
    return cache && covers(cache, entries) ? cache : null;
  }

  private async readCurrent(): Promise<{ directory: CacheDirectory; cache: CacheFile | null }> {
    const directory = await this.directory();
    const cache = directory.path ? await this.readCache(directory.path) : null;
    return { directory, cache };
  }

  private async applyNow(push: HostVaultPush): Promise<void> {
    // `HostVaultPushSchema` is strict, so the rest is exactly the snapshot fields.
    const { revision, values, ...snapshot } = push;
    if (vaultSnapshotRevision(snapshot) !== revision) {
      throw new ValidationError('The Vault push revision does not match its entries.', {
        code: 'VAULT_PUSH_REVISION_MISMATCH',
      });
    }
    for (const value of values) {
      if (Buffer.byteLength(value.valueBase64, 'base64') > HOST_VAULT_VALUE_MAX_BYTES) {
        throw new ValidationError('A Vault value is too large.', {
          code: 'VAULT_PUSH_VALUE_TOO_LARGE',
          entryId: value.entryId,
        });
      }
    }
    const directory = await this.directory();
    if (!directory.path) {
      throw new ConflictError(
        'This VM has no memory-only runtime directory for Vault values. Update the VM.',
        { code: 'VAULT_CACHE_UNAVAILABLE', reason: directory.unavailable },
      );
    }
    const file = join(directory.path, VAULT_VM_CACHE_FILE);
    if (snapshot.entries.length === 0) {
      await this.storage.replaceVaultSnapshot(snapshot);
      await rm(file, { force: true });
      logger.info('Cleared the Vault cache: home pushed no entries');
      return;
    }
    const pushed: CacheFile['values'] = Object.fromEntries(
      values.map((value) => [
        value.entryId,
        { revision: value.revision, valueBase64: value.valueBase64 },
      ]),
    );
    // Until the snapshot write commits, the cache must still serve the current snapshot;
    // a failed push (missing project, DB error) then leaves launches working.
    const current = await this.storage.readVaultSnapshot();
    const previous = (await this.readCache(directory.path))?.values ?? {};
    const kept: CacheFile['values'] = {};
    for (const entry of current.entries) {
      if (previous[entry.id]?.revision === entry.revision) kept[entry.id] = previous[entry.id];
    }
    await writeCache(file, { ...kept, ...pushed });
    await this.storage.replaceVaultSnapshot(snapshot);
    await writeCache(file, pushed);
    logger.info({ entries: snapshot.entries.length }, 'Applied the Vault push from home');
  }

  private async directory(): Promise<CacheDirectory> {
    const systemd = await this.runtimeDirectory.resolveSystemd();
    if (!systemd) return { path: null, unavailable: 'runtime_directory_missing' };
    if (!systemd.tmpfs) return { path: null, unavailable: 'runtime_directory_not_tmpfs' };
    return { path: systemd.path, unavailable: null };
  }

  /** A missing or unreadable cache reads as empty: home pushes again on its next poll. */
  private async readCache(directory: string): Promise<CacheFile | null> {
    let text: string;
    try {
      text = await readFile(join(directory, VAULT_VM_CACHE_FILE), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn({ code: (error as NodeJS.ErrnoException).code }, 'Vault cache unreadable');
      }
      return null;
    }
    try {
      return CacheFileSchema.parse(JSON.parse(text));
    } catch {
      logger.warn('Vault cache is not valid; waiting for the next push from home');
      return null;
    }
  }
}

/** True when `cache` holds every one of `entries` at its revision. */
function covers(cache: CacheFile | null, entries: readonly CachedEntryRef[]): boolean {
  return entries.every((entry) => cache?.values[entry.id]?.revision === entry.revision);
}

async function writeCache(file: string, values: CacheFile['values']): Promise<void> {
  const content: CacheFile = { version: 1, values };
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(content), { mode: 0o600, flag: 'wx' });
    await rename(temp, file);
  } finally {
    await rm(temp, { force: true });
  }
}
