import { Injectable } from '@nestjs/common';
import type { Stats } from 'fs';
import { existsSync } from 'fs';
import * as fs from 'fs/promises';
import { homedir } from 'os';
import { dirname, join } from 'path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { createLogger } from '../../../../common/logging/logger';
import { getDbConfig } from '../../../storage/db/db.config';

const logger = createLogger('SeedPreparationService');

const DEVCHAIN_DIRNAME = '.devchain';
const SKILLS_DIRNAME = 'skills';
const TARGET_DB_FILENAME = 'devchain.db';
const PREFERRED_HOST_DB_FILENAME = 'devchain.db';
const LEGACY_HOST_DB_FILENAME = 'local.db';
const TEMP_DB_PREFIX = '.devchain.db.tmp-';

export class SeedIsolationError extends Error {
  constructor() {
    super('Security validation failed while isolating worktree seed data');
    this.name = 'SeedIsolationError';
  }
}

@Injectable()
export class SeedPreparationService {
  async prepareSeedData(targetDataPath: string): Promise<void> {
    await fs.mkdir(targetDataPath, { recursive: true });

    const sourceDbPath = await this.resolveHostDbPath();
    const targetDbPath = join(targetDataPath, TARGET_DB_FILENAME);
    await this.backupDatabaseSafely(sourceDbPath, targetDbPath);

    const sourceSkillsPath = join(this.getHostHomeDir(), DEVCHAIN_DIRNAME, SKILLS_DIRNAME);
    const targetSkillsPath = join(targetDataPath, SKILLS_DIRNAME);
    await this.copySkillsDirectory(sourceSkillsPath, targetSkillsPath);

    await this.runMigrationsOnCopy(targetDbPath);
    this.scrubIntegrationData(targetDbPath);

    logger.info(
      {
        sourceDbPath,
        targetDbPath,
        sourceSkillsPath,
        targetSkillsPath,
      },
      'Prepared container seed data',
    );
  }

  private async resolveHostDbPath(): Promise<string> {
    const hostDevchainDir = join(this.getHostHomeDir(), DEVCHAIN_DIRNAME);
    const configuredDbPath = getDbConfig().dbPath;
    const candidates = Array.from(
      new Set([
        join(hostDevchainDir, PREFERRED_HOST_DB_FILENAME),
        configuredDbPath,
        join(hostDevchainDir, LEGACY_HOST_DB_FILENAME),
      ]),
    );

    for (const candidate of candidates) {
      const stats = await this.tryStat(candidate);
      if (stats?.isFile()) {
        return candidate;
      }
    }

    throw new Error(`Host SQLite database not found. Checked: ${candidates.join(', ')}`);
  }

  private async backupDatabaseSafely(sourcePath: string, targetPath: string): Promise<void> {
    const tempPath = join(
      dirname(targetPath),
      `${TEMP_DB_PREFIX}${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const sourceDb = new Database(sourcePath, {
      readonly: true,
      fileMustExist: true,
    });

    try {
      await sourceDb.backup(tempPath);
      await fs.rename(tempPath, targetPath);
    } catch (error) {
      await fs.rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    } finally {
      sourceDb.close();
    }
  }

  private async copySkillsDirectory(sourcePath: string, targetPath: string): Promise<void> {
    const sourceStats = await this.tryStat(sourcePath);
    if (!sourceStats) {
      await fs.mkdir(targetPath, { recursive: true });
      return;
    }

    if (!sourceStats.isDirectory()) {
      throw new Error(`Host skills path is not a directory: ${sourcePath}`);
    }

    await fs.mkdir(targetPath, { recursive: true });
    await fs.cp(sourcePath, targetPath, {
      recursive: true,
      force: true,
    });
  }

  private async runMigrationsOnCopy(dbPath: string): Promise<void> {
    const sqlite = new Database(dbPath);
    const db = drizzle(sqlite);
    const migrationsFolder = this.resolveMigrationsFolder();

    try {
      sqlite.pragma('foreign_keys = OFF');
      migrate(db, { migrationsFolder });
    } finally {
      sqlite.pragma('foreign_keys = ON');
      sqlite.close();
    }
  }

  private scrubIntegrationData(dbPath: string): void {
    const sqlite = new Database(dbPath, { fileMustExist: true });

    try {
      sqlite.pragma('foreign_keys = ON');
      const scrub = sqlite.transaction(() => {
        sqlite.prepare('DELETE FROM external_task_links').run();
        sqlite.prepare('DELETE FROM integration_connections').run();
      });
      scrub();

      this.assertIntegrationDataRemoved(sqlite);
      sqlite.exec('VACUUM');

      const checkpoint = sqlite.pragma('wal_checkpoint(TRUNCATE)') as Array<{
        busy: number;
      }>;
      if (checkpoint.length !== 1 || checkpoint[0].busy !== 0) {
        throw new SeedIsolationError();
      }

      this.assertIntegrationDataRemoved(sqlite);
      const integrity = sqlite.pragma('integrity_check', { simple: true }) as string;
      if (integrity !== 'ok') {
        throw new SeedIsolationError();
      }
    } catch (error) {
      if (error instanceof SeedIsolationError) {
        throw error;
      }
      throw new SeedIsolationError();
    } finally {
      sqlite.close();
    }
  }

  private assertIntegrationDataRemoved(sqlite: Database.Database): void {
    const externalTaskLinks = sqlite
      .prepare('SELECT COUNT(*) AS count FROM external_task_links')
      .get() as { count: number };
    const integrationConnections = sqlite
      .prepare('SELECT COUNT(*) AS count FROM integration_connections')
      .get() as { count: number };

    if (externalTaskLinks.count !== 0 || integrationConnections.count !== 0) {
      throw new SeedIsolationError();
    }
  }

  private resolveMigrationsFolder(): string {
    const possiblePaths = [
      join(__dirname, '../../../../../drizzle'),
      join(__dirname, '../../../../../../drizzle'),
      join(process.cwd(), 'apps/local-app/drizzle'),
      join(process.cwd(), 'drizzle'),
    ];

    for (const path of possiblePaths) {
      if (existsSync(path)) {
        return path;
      }
    }

    throw new Error('Migrations folder not found for seed preparation');
  }

  private getHostHomeDir(): string {
    return process.env.HOME?.trim() || homedir();
  }

  private async tryStat(path: string): Promise<Stats | null> {
    try {
      return await fs.stat(path);
    } catch (error) {
      if (this.isNotFoundError(error)) {
        return null;
      }
      throw error;
    }
  }

  private isNotFoundError(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    );
  }
}
