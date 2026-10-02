import { Inject, Injectable } from '@nestjs/common';
import type Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { z } from 'zod';
import { createLogger } from '../../../common/logging/logger';
import { DB_CONNECTION } from '../../storage/db/db.provider';
import { getRawSqliteClient } from '../../storage/db/sqlite-raw';

const logger = createLogger('DockerImportInventoryStore');

/**
 * The `docker.importInventory` setting: a JSON map of project id to remote id
 * to what a Connect imported on that remote. Deliberately home-side only —
 * host routes never read it — and it outlives the binding (`unbind`), so the
 * next Connect knows what it replaces.
 */
const SETTINGS_KEY = 'docker.importInventory';

/** A volume DevChain copied for an imported item. */
const InventoryVolumeSchema = z
  .object({
    name: z.string().min(1).max(255),
    /** Measured copy size in bytes; null when it could not be measured. */
    sizeBytes: z.number().int().nonnegative().nullable(),
  })
  .strict();

/**
 * One imported Docker item. Strict on purpose: container settings and Env
 * never travel into the inventory, and an attempt to store them fails loudly.
 */
const InventoryItemSchema = z
  .object({
    /** The container's name on the home PC at import time. */
    name: z.string().min(1).max(255),
    /** The image the item's VM-side container is created from, by ID. */
    imageId: z.string().min(1).max(255),
    /**
     * The VM engine's ID for `imageId`, written only when it differs (the engines
     * use different image stores). Valid only together with this `imageId`.
     */
    vmImageId: z.string().min(1).max(255).optional(),
    volumes: z.array(InventoryVolumeSchema).max(1000),
    /** In-project data subtrees DevChain owns and keeps out of file sync. */
    bindPaths: z.array(z.string().min(1).max(4096)).max(1000),
    /** Measured size of the item's copied data; null when unknown. */
    sizeBytes: z.number().int().nonnegative().nullable(),
  })
  .strict();

export const DockerDataGroupRecordSchema = z
  .object({
    volumes: z.array(z.string().min(1).max(255)).max(1000),
    bindPaths: z.array(z.string().min(1).max(4096)).max(1000),
    lastSyncedAt: z.string().datetime().optional(),
    lastSyncDirection: z.enum(['to-vm', 'to-home']).optional(),
    homeDiscardedAt: z.string().datetime().optional(),
    vmDiscardedAt: z.string().datetime().optional(),
  })
  .strict()
  .refine(
    (record) =>
      Boolean(record.lastSyncedAt) === Boolean(record.lastSyncDirection) &&
      Boolean(record.lastSyncedAt || record.homeDiscardedAt || record.vmDiscardedAt),
    'A group needs a verified sync or an explicit discard baseline',
  );
export type DockerDataGroupRecord = z.infer<typeof DockerDataGroupRecordSchema>;

export const DockerImportInventorySchema = z
  .object({
    items: z.array(InventoryItemSchema).max(1000),
    groups: z.array(DockerDataGroupRecordSchema).max(1000).optional(),
    /** When the import that produced this inventory completed. */
    importedAt: z.string().datetime(),
  })
  .strict();
export type DockerImportInventory = z.infer<typeof DockerImportInventorySchema>;

/**
 * The IDs under which the VM can hold a home image: the home ID itself, then the
 * VM IDs that earlier imports paired with exactly this home ID. Image IDs are
 * content digests, so the presence of either one means the VM has the image.
 */
export function vmImageCandidates(
  inventory: DockerImportInventory | null | undefined,
  homeId: string,
): string[] {
  const paired = (inventory?.items ?? []).flatMap((item) =>
    item.imageId === homeId && item.vmImageId ? [item.vmImageId] : [],
  );
  return [...new Set([homeId, ...paired])];
}

@Injectable()
export class DockerImportInventoryStore {
  private readonly sqlite: Database.Database;

  constructor(@Inject(DB_CONNECTION) db: BetterSQLite3Database) {
    this.sqlite = getRawSqliteClient(db);
  }

  get(projectId: string, remoteId: string): DockerImportInventory | null {
    return this.readMap()[projectId]?.[remoteId] ?? null;
  }

  /** Replaces the pair's inventory; a re-import overwrites what it replaced. */
  set(projectId: string, remoteId: string, inventory: unknown): DockerImportInventory {
    const parsed = DockerImportInventorySchema.parse(inventory);
    const map = this.readMap();
    const remotes = map[projectId] ?? {};
    remotes[remoteId] = parsed;
    map[projectId] = remotes;
    this.writeMap(map);
    return parsed;
  }

  delete(projectId: string, remoteId: string): void {
    const map = this.readMap();
    const remotes = map[projectId];
    if (!remotes) return;
    delete remotes[remoteId];
    if (Object.keys(remotes).length === 0) delete map[projectId];
    this.writeMap(map);
  }

  deleteRemote(remoteId: string): void {
    const map = this.readMap();
    for (const [projectId, remotes] of Object.entries(map)) {
      delete remotes[remoteId];
      if (Object.keys(remotes).length === 0) delete map[projectId];
    }
    this.writeMap(map);
  }

  private writeMap(map: Record<string, Record<string, DockerImportInventory>>): void {
    const now = new Date().toISOString();
    this.sqlite
      .prepare(
        `INSERT INTO settings (id, key, value, created_at, updated_at)
         VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(SETTINGS_KEY, JSON.stringify(map), now, now);
  }

  private readMap(): Record<string, Record<string, DockerImportInventory>> {
    const row = this.sqlite
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(SETTINGS_KEY) as { value: string } | undefined;
    if (!row) return {};
    try {
      const parsed = JSON.parse(row.value) as Record<string, unknown>;
      const map: Record<string, Record<string, DockerImportInventory>> = {};
      for (const [projectId, remotes] of Object.entries(parsed)) {
        if (remotes === null || typeof remotes !== 'object') continue;
        const entries: Record<string, DockerImportInventory> = {};
        for (const [remoteId, inventory] of Object.entries(remotes as Record<string, unknown>)) {
          const result = DockerImportInventorySchema.safeParse(inventory);
          if (result.success) entries[remoteId] = result.data;
        }
        if (Object.keys(entries).length > 0) map[projectId] = entries;
      }
      return map;
    } catch {
      logger.warn('Stored Docker import inventory is invalid; treating it as empty');
      return {};
    }
  }
}
