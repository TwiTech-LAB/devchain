import { Injectable, Inject } from '@nestjs/common';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type Database from 'better-sqlite3';
import { DB_CONNECTION } from '../../storage/db/db.provider';
import { getRawSqliteClient } from '../../storage/db/sqlite-raw';
import { createLogger } from '../../../common/logging/logger';

const logger = createLogger('ProbeProofService');

interface ProofRow {
  bin_path: string;
}

@Injectable()
export class ProbeProofService {
  private readonly sqlite: Database.Database;

  constructor(@Inject(DB_CONNECTION) db: BetterSQLite3Database) {
    this.sqlite = getRawSqliteClient(db);
  }

  recordProof(providerId: string, binPath: string): void {
    this.sqlite
      .prepare(
        `INSERT INTO provider_probe_proofs (provider_id, bin_path, recorded_at)
         VALUES (?, ?, ?)
         ON CONFLICT(provider_id) DO UPDATE SET bin_path = excluded.bin_path, recorded_at = excluded.recorded_at`,
      )
      .run(providerId, binPath, Date.now());
    logger.info({ providerId, binPath }, 'Recorded 1M probe proof');
  }

  hasValidProof(providerId: string, binPath: string): boolean {
    const row = this.sqlite
      .prepare('SELECT bin_path FROM provider_probe_proofs WHERE provider_id = ?')
      .get(providerId) as ProofRow | undefined;
    return row !== undefined && row.bin_path === binPath;
  }

  clearProof(providerId: string): void {
    this.sqlite.prepare('DELETE FROM provider_probe_proofs WHERE provider_id = ?').run(providerId);
  }
}
