import { mkdir, mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { SeedPreparationService } from './seed-preparation.service';

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
});
