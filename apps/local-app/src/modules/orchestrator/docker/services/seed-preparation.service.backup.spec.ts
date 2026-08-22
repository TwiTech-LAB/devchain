import { mkdir, mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { SeedIsolationError, SeedPreparationService } from './seed-preparation.service';

const FAKE_CIPHERTEXT_MARKER = 'TEST_ONLY_SEED_CIPHERTEXT_REMNANT_6F3A91C8B2474D55';

async function readFileIfPresent(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      return null;
    }
    throw error;
  }
}

function isSqliteBusyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'SQLITE_BUSY'
  );
}

function waitForNextTick(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

describe('SeedPreparationService WAL backup safety', () => {
  const originalHome = process.env.HOME;
  const originalDbPath = process.env.DB_PATH;
  const originalDbFilename = process.env.DB_FILENAME;

  let tempRoot: string;
  let hostHome: string;
  let hostDataPath: string;
  let targetDataPath: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'seed-prep-backup-'));
    hostHome = join(tempRoot, 'host-home');
    hostDataPath = join(hostHome, '.devchain');
    targetDataPath = join(tempRoot, 'target-data');

    await mkdir(hostDataPath, { recursive: true });
    await mkdir(targetDataPath, { recursive: true });

    process.env.HOME = hostHome;
    delete process.env.DB_PATH;
    delete process.env.DB_FILENAME;
  });

  afterEach(async () => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }

    if (originalDbPath === undefined) {
      delete process.env.DB_PATH;
    } else {
      process.env.DB_PATH = originalDbPath;
    }

    if (originalDbFilename === undefined) {
      delete process.env.DB_FILENAME;
    } else {
      process.env.DB_FILENAME = originalDbFilename;
    }

    await rm(tempRoot, { recursive: true, force: true });
  });

  it('produces a consistent seed snapshot while concurrent WAL writes are happening', async () => {
    const sourceDbPath = join(hostDataPath, 'devchain.db');
    const targetDbPath = join(targetDataPath, 'devchain.db');

    const sourceDb = new Database(sourceDbPath);
    sourceDb.pragma('journal_mode = WAL');
    sourceDb.exec(`
      CREATE TABLE IF NOT EXISTS seed_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        value TEXT NOT NULL
      );
      CREATE TABLE integration_connections (id TEXT PRIMARY KEY);
      CREATE TABLE external_task_links (id TEXT PRIMARY KEY, connection_id TEXT NOT NULL);
    `);
    const insertSeedEvent = sourceDb.prepare('INSERT INTO seed_events (value) VALUES (?)');
    for (let index = 0; index < 2_000; index += 1) {
      insertSeedEvent.run(`baseline-${index}`);
    }
    insertSeedEvent.run('wal-before-seed');

    const writerDb = new Database(sourceDbPath);
    writerDb.pragma('journal_mode = WAL');
    const insertLiveEvent = writerDb.prepare('INSERT INTO seed_events (value) VALUES (?)');

    const service = new SeedPreparationService();
    const migrationSpy = jest
      .spyOn(
        service as unknown as { runMigrationsOnCopy: (dbPath: string) => Promise<void> },
        'runMigrationsOnCopy',
      )
      .mockResolvedValue(undefined);

    let keepWriting = true;
    let liveWriteCount = 0;
    const liveWriter = (async () => {
      while (keepWriting) {
        try {
          insertLiveEvent.run(`live-${liveWriteCount}`);
          liveWriteCount += 1;
        } catch (error) {
          if (!isSqliteBusyError(error)) {
            throw error;
          }
        }
        await waitForNextTick();
      }
    })();

    try {
      await service.prepareSeedData(targetDataPath);
    } finally {
      keepWriting = false;
      await liveWriter;
      writerDb.close();
      sourceDb.close();
    }

    const snapshotDb = new Database(targetDbPath, { readonly: true, fileMustExist: true });
    const integrity = snapshotDb.pragma('integrity_check', { simple: true }) as string;
    const walCommittedRow = snapshotDb
      .prepare('SELECT COUNT(*) as count FROM seed_events WHERE value = ?')
      .get('wal-before-seed') as { count: number };
    const totalRows = snapshotDb.prepare('SELECT COUNT(*) as count FROM seed_events').get() as {
      count: number;
    };
    snapshotDb.close();

    expect(integrity).toBe('ok');
    expect(walCommittedRow.count).toBe(1);
    expect(totalRows.count).toBeGreaterThanOrEqual(2_001);
    expect(liveWriteCount).toBeGreaterThan(0);
    expect(migrationSpy).toHaveBeenCalledWith(targetDbPath);
  });

  it('removes integration links before connections from the copied database', async () => {
    const sourceDbPath = join(hostDataPath, 'devchain.db');
    const targetDbPath = join(targetDataPath, 'devchain.db');
    const sourceDb = new Database(sourceDbPath);
    sourceDb.exec(`
      CREATE TABLE integration_connections (id TEXT PRIMARY KEY);
      CREATE TABLE external_task_links (
        id TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL REFERENCES integration_connections(id)
      );
      CREATE TRIGGER require_links_deleted_first
      BEFORE DELETE ON integration_connections
      WHEN EXISTS (
        SELECT 1 FROM external_task_links WHERE connection_id = OLD.id
      )
      BEGIN
        SELECT RAISE(ABORT, 'external task links remain');
      END;
      INSERT INTO integration_connections (id) VALUES ('connection-1');
      INSERT INTO external_task_links (id, connection_id)
      VALUES ('link-1', 'connection-1');
    `);
    sourceDb.close();

    const service = new SeedPreparationService();
    jest
      .spyOn(
        service as unknown as { runMigrationsOnCopy: (dbPath: string) => Promise<void> },
        'runMigrationsOnCopy',
      )
      .mockResolvedValue(undefined);

    await service.prepareSeedData(targetDataPath);

    const snapshotDb = new Database(targetDbPath, { readonly: true, fileMustExist: true });
    const linkCount = snapshotDb
      .prepare('SELECT COUNT(*) AS count FROM external_task_links')
      .get() as { count: number };
    const connectionCount = snapshotDb
      .prepare('SELECT COUNT(*) AS count FROM integration_connections')
      .get() as { count: number };
    snapshotDb.close();

    expect(linkCount.count).toBe(0);
    expect(connectionCount.count).toBe(0);
  });

  it.each(['DELETE', 'WAL'] as const)(
    'removes scrubbed credential bytes from a %s-mode copied database',
    async (journalMode) => {
      const copiedDbPath = join(targetDataPath, `credential-seed-${journalMode}.db`);
      const copiedDb = new Database(copiedDbPath);
      copiedDb.pragma(`journal_mode = ${journalMode}`);
      copiedDb.pragma('secure_delete = OFF');
      copiedDb.exec(`
        CREATE TABLE seed_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          value TEXT NOT NULL
        );
        CREATE TABLE integration_connections (
          id TEXT PRIMARY KEY,
          credential_ciphertext TEXT NOT NULL
        );
        CREATE TABLE external_task_links (
          id TEXT PRIMARY KEY,
          connection_id TEXT NOT NULL REFERENCES integration_connections(id)
        );
      `);
      copiedDb.prepare('INSERT INTO seed_events (value) VALUES (?)').run('unrelated-seed-data');
      copiedDb
        .prepare('INSERT INTO integration_connections (id, credential_ciphertext) VALUES (?, ?)')
        .run(
          'connection-with-fake-ciphertext',
          `v1:${FAKE_CIPHERTEXT_MARKER}:${'x'.repeat(8_192)}`,
        );
      copiedDb
        .prepare('INSERT INTO external_task_links (id, connection_id) VALUES (?, ?)')
        .run('linked-task', 'connection-with-fake-ciphertext');
      if (journalMode === 'WAL') {
        copiedDb.pragma('wal_checkpoint(TRUNCATE)');
      }
      copiedDb.close();

      const marker = Buffer.from(FAKE_CIPHERTEXT_MARKER);
      expect((await readFile(copiedDbPath)).includes(marker)).toBe(true);

      const service = new SeedPreparationService();
      (
        service as unknown as {
          scrubIntegrationData: (dbPath: string) => void;
        }
      ).scrubIntegrationData(copiedDbPath);

      const snapshotDb = new Database(copiedDbPath, {
        readonly: true,
        fileMustExist: true,
      });
      const linkCount = snapshotDb
        .prepare('SELECT COUNT(*) AS count FROM external_task_links')
        .get() as { count: number };
      const connectionCount = snapshotDb
        .prepare('SELECT COUNT(*) AS count FROM integration_connections')
        .get() as { count: number };
      const unrelatedSeedData = snapshotDb.prepare('SELECT value FROM seed_events').all() as Array<{
        value: string;
      }>;
      snapshotDb.close();

      expect(linkCount.count).toBe(0);
      expect(connectionCount.count).toBe(0);
      expect(unrelatedSeedData).toEqual([{ value: 'unrelated-seed-data' }]);

      for (const path of [
        copiedDbPath,
        `${copiedDbPath}-wal`,
        `${copiedDbPath}-shm`,
        `${copiedDbPath}-journal`,
      ]) {
        const bytes = await readFileIfPresent(path);
        if (bytes) {
          expect(bytes.includes(marker)).toBe(false);
        }
      }
    },
  );

  it('fails closed with a safe security error when copied rows survive the scrub', async () => {
    const sourceDbPath = join(hostDataPath, 'devchain.db');
    const sourceDb = new Database(sourceDbPath);
    sourceDb.exec(`
      CREATE TABLE integration_connections (id TEXT PRIMARY KEY);
      CREATE TABLE external_task_links (id TEXT PRIMARY KEY, connection_id TEXT NOT NULL);
      CREATE TRIGGER retain_external_task_links
      BEFORE DELETE ON external_task_links
      BEGIN
        SELECT RAISE(IGNORE);
      END;
      INSERT INTO integration_connections (id) VALUES ('connection-1');
      INSERT INTO external_task_links (id, connection_id)
      VALUES ('link-1', 'connection-1');
    `);
    sourceDb.close();

    const service = new SeedPreparationService();
    jest
      .spyOn(
        service as unknown as { runMigrationsOnCopy: (dbPath: string) => Promise<void> },
        'runMigrationsOnCopy',
      )
      .mockResolvedValue(undefined);

    await expect(service.prepareSeedData(targetDataPath)).rejects.toMatchObject({
      name: SeedIsolationError.name,
      message: 'Security validation failed while isolating worktree seed data',
    });
  });
});
