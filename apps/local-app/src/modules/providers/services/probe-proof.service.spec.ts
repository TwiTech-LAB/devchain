/**
 * Layer: module-integration
 * Why: ProbeProofService reads/writes SQLite directly. A real :memory: database
 * is the only way to verify persistence semantics (INSERT OR REPLACE, cascade
 * delete, restart-survival) without mocking away the thing under test.
 */
import { Test, TestingModule } from '@nestjs/testing';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { ProbeProofService } from './probe-proof.service';
import { DB_CONNECTION } from '../../storage/db/db.provider';

const SCHEMA = `
  CREATE TABLE providers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE
  );
  CREATE TABLE provider_probe_proofs (
    provider_id TEXT PRIMARY KEY REFERENCES providers(id) ON DELETE CASCADE,
    bin_path TEXT NOT NULL,
    recorded_at INTEGER NOT NULL
  );
`;

function buildDb() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(SCHEMA);
  return { sqlite, db: drizzle(sqlite) };
}

describe('ProbeProofService', () => {
  let service: ProbeProofService;
  let sqlite: Database.Database;

  beforeEach(async () => {
    const built = buildDb();
    sqlite = built.sqlite;
    sqlite.prepare("INSERT INTO providers (id, name) VALUES ('p1', 'claude')").run();

    const module: TestingModule = await Test.createTestingModule({
      providers: [ProbeProofService, { provide: DB_CONNECTION, useValue: built.db }],
    }).compile();

    service = module.get<ProbeProofService>(ProbeProofService);
  });

  afterEach(() => {
    sqlite.close();
  });

  describe('recordProof / hasValidProof', () => {
    it('returns false when no proof exists', () => {
      expect(service.hasValidProof('p1', '/bin/claude')).toBe(false);
    });

    it('returns true after recording a proof with matching binPath', () => {
      service.recordProof('p1', '/bin/claude');
      expect(service.hasValidProof('p1', '/bin/claude')).toBe(true);
    });

    it('returns false when binPath differs from recorded proof', () => {
      service.recordProof('p1', '/old/claude');
      expect(service.hasValidProof('p1', '/new/claude')).toBe(false);
    });

    it('overwrites old proof when called again with different binPath', () => {
      service.recordProof('p1', '/old/claude');
      service.recordProof('p1', '/new/claude');
      expect(service.hasValidProof('p1', '/old/claude')).toBe(false);
      expect(service.hasValidProof('p1', '/new/claude')).toBe(true);
    });
  });

  describe('clearProof', () => {
    it('removes proof so hasValidProof returns false', () => {
      service.recordProof('p1', '/bin/claude');
      service.clearProof('p1');
      expect(service.hasValidProof('p1', '/bin/claude')).toBe(false);
    });

    it('is a no-op when no proof exists', () => {
      expect(() => service.clearProof('p1')).not.toThrow();
    });
  });

  describe('restart-survival', () => {
    it('proof persists across service re-instantiation on the same DB', () => {
      service.recordProof('p1', '/bin/claude');

      // Simulate restart: new service instance pointing at same sqlite file
      const { db: db2 } = { db: drizzle(sqlite) };
      const service2 = new ProbeProofService(db2);

      expect(service2.hasValidProof('p1', '/bin/claude')).toBe(true);
    });
  });

  describe('cascade delete', () => {
    it('proof is removed when provider is deleted', () => {
      service.recordProof('p1', '/bin/claude');
      sqlite.prepare("DELETE FROM providers WHERE id = 'p1'").run();
      expect(service.hasValidProof('p1', '/bin/claude')).toBe(false);
    });
  });
});
