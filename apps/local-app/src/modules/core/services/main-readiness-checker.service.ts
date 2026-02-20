import { Inject, Injectable, Optional } from '@nestjs/common';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { getRawSqliteClient } from '../../storage/db/sqlite-raw';
import { DB_CONNECTION } from '../../storage/db/db.provider';
import type { HealthReadinessChecker } from './health.service';
import {
  ORCHESTRATOR_DB_CONNECTION,
  OrchestratorDatabase,
} from '../../orchestrator/orchestrator-storage/db/orchestrator.provider';
import { OrchestratorDockerService } from '../../orchestrator/docker/services/docker.service';

@Injectable()
export class MainReadinessCheckerService implements HealthReadinessChecker {
  constructor(
    @Optional() @Inject(DB_CONNECTION) private readonly db?: BetterSQLite3Database,
    @Optional()
    @Inject(ORCHESTRATOR_DB_CONNECTION)
    private readonly orchestratorDb?: OrchestratorDatabase,
    @Optional() private readonly dockerService?: OrchestratorDockerService,
  ) {}

  async getChecks(): Promise<Record<string, 'ok' | 'fail'>> {
    const [dbReady, orchestratorDbReady, dockerReady] = await Promise.all([
      this.checkDbReady(),
      this.checkOrchestratorDbReady(),
      this.checkDockerReady(),
    ]);

    return {
      db: dbReady ? 'ok' : 'fail',
      orchestratorDb: orchestratorDbReady ? 'ok' : 'fail',
      docker: dockerReady ? 'ok' : 'fail',
    };
  }

  private async checkDbReady(): Promise<boolean> {
    if (!this.db) {
      return false;
    }

    try {
      const sqlite = getRawSqliteClient(this.db);
      sqlite.prepare('SELECT 1').get();
      return true;
    } catch {
      return false;
    }
  }

  private async checkOrchestratorDbReady(): Promise<boolean> {
    if (!this.orchestratorDb) {
      return false;
    }

    try {
      const sqlite = getRawSqliteClient(this.orchestratorDb);
      sqlite.prepare('SELECT 1').get();
      return true;
    } catch {
      return false;
    }
  }

  private async checkDockerReady(): Promise<boolean> {
    if (!this.dockerService) {
      return false;
    }

    return this.dockerService.ping();
  }
}
