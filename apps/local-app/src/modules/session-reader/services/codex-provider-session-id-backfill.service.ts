import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import type Database from 'better-sqlite3';
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as fs from 'node:fs/promises';
import { DB_CONNECTION } from '../../storage/db/db.provider';
import { getRawSqliteClient } from '../../storage/db/sqlite-raw';
import { CodexSessionReaderAdapter } from '../adapters/codex-session-reader.adapter';
import { TranscriptPersistenceListener } from './transcript-persistence.listener';

const BACKFILL_LIMIT = 5_000;

interface CodexProviderSessionIdBackfillRow {
  id: string;
  transcript_path: string;
}

export interface CodexProviderSessionIdBackfillResult {
  status: 'completed' | 'already_running';
  scanned: number;
  repaired: number;
  missingFile: number;
  parseFailed: number;
}

@Injectable()
export class CodexProviderSessionIdBackfillService implements OnApplicationBootstrap {
  private readonly logger = new Logger(CodexProviderSessionIdBackfillService.name);
  private readonly sqlite: Database.Database;
  private running = false;

  constructor(
    @Inject(DB_CONNECTION) db: BetterSQLite3Database,
    private readonly codexAdapter: CodexSessionReaderAdapter,
    private readonly transcriptPersistence: TranscriptPersistenceListener,
  ) {
    this.sqlite = getRawSqliteClient(db);
  }

  onApplicationBootstrap(): void {
    setImmediate(() => {
      void this.runBackfill().catch((error) => {
        this.logger.error(
          { error: error instanceof Error ? error.message : String(error) },
          'Codex provider session id backfill failed',
        );
      });
    });
  }

  async runBackfill(): Promise<CodexProviderSessionIdBackfillResult> {
    if (this.running) {
      this.logger.debug('Codex provider session id backfill already running — skipping');
      return this.createResult('already_running');
    }

    this.running = true;
    const result = this.createResult('completed');

    try {
      const rows = this.findRowsToBackfill();
      result.scanned = rows.length;

      for (const row of rows) {
        const providerSessionId = await this.extractProviderSessionId(row);
        if (!providerSessionId) {
          if (await this.isMissingFile(row.transcript_path)) {
            result.missingFile += 1;
          } else {
            result.parseFailed += 1;
            this.logger.warn(
              { sessionId: row.id, transcriptPath: row.transcript_path },
              'Failed to parse Codex provider session id for backfill',
            );
          }
          continue;
        }

        const outcome = await this.transcriptPersistence.backfillProviderSessionIdForTranscriptPath(
          {
            sessionId: row.id,
            providerName: 'codex',
            transcriptPath: row.transcript_path,
            providerSessionId,
            emitEvent: false,
          },
        );

        if (outcome.kind === 'backfilledId') {
          result.repaired += 1;
        }
      }

      if (result.scanned > 0) {
        this.logger.log(
          {
            scanned: result.scanned,
            repaired: result.repaired,
            missingFile: result.missingFile,
            parseFailed: result.parseFailed,
          },
          'Codex provider session id backfill complete',
        );
      }

      return result;
    } finally {
      this.running = false;
    }
  }

  private findRowsToBackfill(): CodexProviderSessionIdBackfillRow[] {
    return this.sqlite
      .prepare(
        `SELECT id, transcript_path
         FROM sessions
         WHERE provider_name_at_launch = 'codex'
           AND transcript_path IS NOT NULL
           AND provider_session_id IS NULL
         LIMIT ?`,
      )
      .all(BACKFILL_LIMIT) as CodexProviderSessionIdBackfillRow[];
  }

  private async extractProviderSessionId(
    row: CodexProviderSessionIdBackfillRow,
  ): Promise<string | null> {
    try {
      return await this.codexAdapter.extractProviderSessionIdFromFile(row.transcript_path);
    } catch (error) {
      this.logger.warn(
        {
          error: error instanceof Error ? error.message : String(error),
          sessionId: row.id,
          transcriptPath: row.transcript_path,
        },
        'Failed to read Codex transcript for provider session id backfill',
      );
      return null;
    }
  }

  private async isMissingFile(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return false;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        this.logger.warn(
          { transcriptPath: filePath },
          'Codex transcript missing on disk for provider session id backfill',
        );
        return true;
      }
      return false;
    }
  }

  private createResult(
    status: CodexProviderSessionIdBackfillResult['status'],
  ): CodexProviderSessionIdBackfillResult {
    return {
      status,
      scanned: 0,
      repaired: 0,
      missingFile: 0,
      parseFailed: 0,
    };
  }
}
