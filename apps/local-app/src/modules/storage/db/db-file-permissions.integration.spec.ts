import { Test, type TestingModule } from '@nestjs/testing';
import Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as dbConfig from './db.config';
import { dbProvider, DB_CONNECTION } from './db.provider';
import { runMigrations } from './migrate';
import { getRawSqliteClient } from './sqlite-raw';
import { createLogger } from '../../../common/logging/logger';

jest.mock('../../../common/logging/logger', () => {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { createLogger: () => logger };
});

const logger = jest.mocked(createLogger('test'));

// Real provider/migration opens are required to verify SQLite's side-file mode inheritance.
describe('SQLite database file permissions', () => {
  let root: string;
  let dbPath: string;
  let originalUmask: number;
  let module: TestingModule | undefined;
  let connections: Database.Database[];
  const mode = (path: string) => fs.statSync(path).mode & 0o777;
  const files = () => [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];

  beforeEach(() => {
    jest.clearAllMocks();
    originalUmask = process.umask(0o022);
    root = fs.mkdtempSync(join(tmpdir(), 'db-file-permissions-'));
    fs.chmodSync(root, 0o755);
    dbPath = join(root, 'test.db');
    connections = [];
    module = undefined;
    jest.spyOn(dbConfig, 'getDbConfig').mockReturnValue({ dbPath, busyTimeout: 5000 });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    for (const sqlite of connections.reverse()) {
      if (sqlite.open) sqlite.close();
    }
    await module?.close();
    process.umask(originalUmask);
    fs.rmSync(root, { recursive: true, force: true });
  });

  const openProvider = async () => {
    module = await Test.createTestingModule({ providers: [dbProvider] }).compile();
    const sqlite = getRawSqliteClient(module.get<BetterSQLite3Database>(DB_CONNECTION));
    connections.push(sqlite);
    return sqlite;
  };

  const openLegacyDatabase = () => {
    // Keep this connection open so SQLite retains its WAL and SHM during the second open.
    const sqlite = new Database(dbPath);
    connections.push(sqlite);
    sqlite.pragma('journal_mode = WAL');
    sqlite.exec('CREATE TABLE permission_probe (id INTEGER PRIMARY KEY)');
    for (const path of files()) {
      fs.chmodSync(path, 0o644);
      expect(mode(path)).toBe(0o644);
    }
    return sqlite;
  };

  it('creates the main database and new WAL/SHM files as 0600 through the provider', async () => {
    await openProvider();
    expect(files().map(mode)).toEqual([0o600, 0o600, 0o600]);
    expect(mode(root)).toBe(0o755);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('repairs existing 0644 database and side files while preserving writes', async () => {
    const legacy = openLegacyDatabase();
    const sqlite = await openProvider();
    expect(files().map(mode)).toEqual([0o600, 0o600, 0o600]);
    sqlite.prepare('INSERT INTO permission_probe (id) VALUES (?)').run(42);
    expect(legacy.prepare('SELECT id FROM permission_probe').all()).toEqual([{ id: 42 }]);
  });

  it.each([
    ['database', ''],
    ['wal', '-wal'],
    ['shm', '-shm'],
  ])('warns without a path and continues opening when chmod fails for %s', async (file, suffix) => {
    openLegacyDatabase();
    const failingPath = `${dbPath}${suffix}`;
    const chmod = fs.chmodSync;
    jest.spyOn(fs, 'chmodSync').mockImplementation((path, permissions) => {
      if (path === failingPath) throw new Error(`Permission denied: ${failingPath}`);
      chmod(path, permissions);
    });
    const sqlite = await openProvider();
    sqlite.prepare('INSERT INTO permission_probe (id) VALUES (?)').run(7);
    expect(sqlite.prepare('SELECT id FROM permission_probe').all()).toEqual([{ id: 7 }]);
    expect(mode(failingPath)).toBe(0o644);
    expect(
      files()
        .filter((path) => path !== failingPath)
        .map(mode),
    ).toEqual([0o600, 0o600]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      { file },
      'Could not set SQLite file permissions to 0600',
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(root);
  });

  it.each(['new', 'existing'])(
    'secures a %s database through the standalone migration path',
    async (state) => {
      if (state === 'existing') openLegacyDatabase();
      await runMigrations();
      expect(mode(dbPath)).toBe(0o600);
      if (state === 'existing') expect(files().map(mode)).toEqual([0o600, 0o600, 0o600]);
      const sqlite = new Database(dbPath);
      connections.push(sqlite);
      const result = sqlite.prepare('SELECT count(*) AS count FROM __drizzle_migrations').get() as {
        count: number;
      };
      expect(result.count).toBeGreaterThan(0);
    },
  );
});
