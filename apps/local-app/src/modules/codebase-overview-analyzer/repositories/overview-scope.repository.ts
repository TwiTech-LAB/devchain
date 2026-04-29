import { Injectable, Inject } from '@nestjs/common';
import { writeFile, rename, mkdir } from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import { join, resolve, relative } from 'path';
import { randomUUID } from 'crypto';
import { SettingsService } from '../../settings/services/settings.service';
import { DB_CONNECTION } from '../../storage/db/db.provider';
import { getRawSqliteClient } from '../../storage/db/sqlite-raw';
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { FolderScopeEntry } from '../types/scope.types';
import { ScopeConfig } from '../types/scope.types';
import { FolderScopeEntrySchema, ScopeConfigSchema } from '../types/scope.schema';
import { createLogger } from '../../../common/logging/logger';
import Database from 'better-sqlite3';

const logger = createLogger('OverviewScopeRepository');

const SETTINGS_KEY = 'codebaseScope.projects';
const CONFIG_DIR = '.devchain';
const CONFIG_FILE = 'overview.json';

export interface ScopeWriteError {
  code: 'PERMISSION_DENIED' | 'READ_ONLY_FILESYSTEM' | 'DISK_FULL' | 'INVALID_PATH';
  message: string;
  manualEditPath?: string;
}

@Injectable()
export class OverviewScopeRepository {
  private sqlite: Database.Database;

  constructor(
    private readonly settingsService: SettingsService,
    @Inject(DB_CONNECTION) private readonly db: BetterSQLite3Database,
  ) {
    this.sqlite = getRawSqliteClient(db);
  }

  readUserEntries(projectRoot: string, projectId: string): FolderScopeEntry[] {
    const repoFilePath = this.getRepoFilePath(projectRoot);

    if (existsSync(repoFilePath)) {
      return this.readFromRepoFile(repoFilePath);
    }

    return this.readFromSqlite(projectId);
  }

  async writeUserEntries(
    projectRoot: string,
    projectId: string,
    entries: FolderScopeEntry[],
  ): Promise<void> {
    const repoFilePath = this.getRepoFilePath(projectRoot);

    if (existsSync(repoFilePath)) {
      await this.writeToRepoFile(projectRoot, repoFilePath, entries);
    } else {
      this.writeToSqlite(projectId, entries);
    }
  }

  getStorageMode(projectRoot: string): 'repo-file' | 'local-only' {
    return existsSync(this.getRepoFilePath(projectRoot)) ? 'repo-file' : 'local-only';
  }

  private getRepoFilePath(projectRoot: string): string {
    return join(projectRoot, CONFIG_DIR, CONFIG_FILE);
  }

  private readFromRepoFile(filePath: string): FolderScopeEntry[] {
    try {
      const content = readFileSync(filePath, 'utf-8');
      const result = ScopeConfigSchema.safeParse(JSON.parse(content));
      if (!result.success) {
        logger.warn({ filePath, issues: result.error.issues }, 'Repo scope file failed validation');
        return [];
      }
      return result.data.entries;
    } catch (error) {
      logger.warn({ error, filePath }, 'Failed to read repo scope file');
      return [];
    }
  }

  private readFromSqlite(projectId: string): FolderScopeEntry[] {
    const raw = this.settingsService.getSetting(SETTINGS_KEY);
    if (!raw) return [];

    try {
      const map = JSON.parse(raw) as Record<string, unknown[]>;
      const rawEntries = map[projectId];
      if (!Array.isArray(rawEntries)) return [];

      const valid: FolderScopeEntry[] = [];
      for (const entry of rawEntries) {
        const result = FolderScopeEntrySchema.safeParse(entry);
        if (result.success) {
          valid.push(result.data);
        } else {
          logger.warn(
            { projectId, entry, issues: result.error.issues },
            'Dropping invalid SQLite scope entry',
          );
        }
      }
      return valid;
    } catch (error) {
      logger.warn({ error, projectId }, 'Failed to parse SQLite scope data');
      return [];
    }
  }

  private async writeToRepoFile(
    projectRoot: string,
    filePath: string,
    entries: FolderScopeEntry[],
  ): Promise<void> {
    const configDir = join(projectRoot, CONFIG_DIR);
    const validatedDir = this.validatePath(configDir, projectRoot);
    const validatedFile = this.validatePath(filePath, projectRoot);

    try {
      if (!existsSync(validatedDir)) {
        await mkdir(validatedDir, { recursive: true });
      }

      const tmpPath = validatedFile + '.tmp';
      const content = JSON.stringify({ schemaVersion: 1, entries } as ScopeConfig, null, 2);
      await writeFile(tmpPath, content, 'utf-8');
      await rename(tmpPath, validatedFile);

      logger.info({ filePath: validatedFile }, 'Scope config written to repo file');
    } catch (error: unknown) {
      throw this.shapeWriteError(error as NodeJS.ErrnoException, validatedFile);
    }
  }

  private writeToSqlite(projectId: string, entries: FolderScopeEntry[]): void {
    const raw = this.settingsService.getSetting(SETTINGS_KEY);
    let map: Record<string, FolderScopeEntry[]> = {};
    try {
      if (raw) map = JSON.parse(raw);
    } catch {
      map = {};
    }

    map[projectId] = entries;

    const now = new Date().toISOString();
    this.sqlite
      .prepare(
        `INSERT INTO settings (id, key, value, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at`,
      )
      .run(randomUUID(), SETTINGS_KEY, JSON.stringify(map), now, now);

    logger.info({ projectId }, 'Scope config written to SQLite');
  }

  private validatePath(targetPath: string, projectRoot: string): string {
    const resolved = resolve(targetPath);
    const resolvedRoot = resolve(projectRoot);
    const rel = relative(resolvedRoot, resolved);

    if (rel.startsWith('..')) {
      throw {
        code: 'INVALID_PATH' as const,
        message: `Path escapes project root: ${targetPath}`,
      } satisfies ScopeWriteError;
    }

    return resolved;
  }

  private shapeWriteError(err: NodeJS.ErrnoException, filePath: string): ScopeWriteError {
    const manualEditPath = filePath;

    if (err.code === 'EACCES') {
      return {
        code: 'PERMISSION_DENIED',
        message: `Permission denied writing to ${filePath}. Check file/directory permissions.`,
        manualEditPath,
      };
    }

    if (err.code === 'EROFS') {
      return {
        code: 'READ_ONLY_FILESYSTEM',
        message: `Filesystem is read-only. Cannot write to ${filePath}.`,
        manualEditPath,
      };
    }

    if (err.code === 'ENOSPC') {
      return {
        code: 'DISK_FULL',
        message: `Disk full. Cannot write to ${filePath}.`,
        manualEditPath,
      };
    }

    return {
      code: 'PERMISSION_DENIED',
      message: `Failed to write scope config: ${err.message}`,
      manualEditPath,
    };
  }
}
