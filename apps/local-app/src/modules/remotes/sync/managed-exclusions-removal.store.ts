import { Inject, Injectable } from '@nestjs/common';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { FileSyncAutoFixStore } from '../../file-sync/file-sync-auto-fix.store';
import { FileSyncManagedExclusionsStore } from '../../file-sync/file-sync-managed-exclusions.store';
import { within } from '../../file-sync/sync-path-inspection.dto';
import { DB_CONNECTION } from '../../storage/db/db.provider';
import { getRawSqliteClient } from '../../storage/db/sqlite-raw';
import { TransactionRunner } from '../../storage/db/transaction-runner';
import { projectAnchoredPath, strictlyWithin } from '../docker/docker-plan-files';
import { DockerImportInventoryStore } from '../operations/docker-import-inventory.store';

@Injectable()
export class ManagedExclusionsRemovalStore {
  private readonly transactions: TransactionRunner;

  constructor(
    @Inject(DB_CONNECTION) db: BetterSQLite3Database,
    private readonly managed: FileSyncManagedExclusionsStore,
    private readonly inventory: DockerImportInventoryStore,
    private readonly history: FileSyncAutoFixStore,
  ) {
    this.transactions = new TransactionRunner(getRawSqliteClient(db));
  }

  remove(projectId: string, remoteId: string, root: string, passed: readonly string[]): boolean {
    return this.transactions.runImmediate(() => {
      const patterns = this.managed.get(projectId);
      const keep = (path: string) => !passed.some((folder) => within(path, folder));
      const removed = patterns.filter((pattern) => !keep(pattern));
      if (!removed.length) return false;
      this.managed.set(projectId, patterns.filter(keep));

      const inventory = this.inventory.get(projectId, remoteId);
      if (inventory) {
        const stripGroups = <T extends { bindPaths: string[]; volumes: string[] }>(groups: T[]) =>
          groups
            .map((group) => ({
              ...group,
              bindPaths: group.bindPaths.filter(
                (path) => !strictlyWithin(root, path) || keep(projectAnchoredPath(root, path)),
              ),
            }))
            .filter((group) => group.volumes.length || group.bindPaths.length);
        this.inventory.set(projectId, remoteId, {
          ...inventory,
          items: inventory.items.map((item) => ({
            ...item,
            bindPaths: item.bindPaths.filter(keep),
            ...(item.dataRepresentations && {
              dataRepresentations: stripGroups(item.dataRepresentations),
            }),
          })),
          ...(inventory.groups && { groups: stripGroups(inventory.groups) }),
        });
      }
      this.history.recordInTransaction(projectId, {
        kind: 'docker-exclusion-removed',
        at: new Date().toISOString(),
        patterns: removed,
      });
      return true;
    });
  }
}
