import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { Test, TestingModule } from '@nestjs/testing';
import { StorageModule } from './storage.module';
import { STORAGE_SERVICE } from './interfaces/storage.interface';
import { SNAPSHOT_PROMPT_WRITER } from './interfaces/snapshot-prompt-writer.interface';
import { LocalStorageService } from './local/local-storage.service';

// The DB provider migrates whatever DB_PATH points at; pointing the suite at
// the operator's live database would both mutate real data and couple test
// results to that database's migration history.
describe('StorageModule binding', () => {
  const originalEnv = {
    DB_PATH: process.env.DB_PATH,
    DB_FILENAME: process.env.DB_FILENAME,
  };
  let module: TestingModule;
  let dbDir: string | null = null;

  beforeAll(async () => {
    dbDir = await mkdtemp(join(tmpdir(), 'devchain-storage-binding-'));
    process.env.DB_PATH = dbDir;
    process.env.DB_FILENAME = 'test.db';
    module = await Test.createTestingModule({
      imports: [StorageModule],
    }).compile();
  });

  afterAll(async () => {
    await module.close();
    if (dbDir) {
      await rm(dbDir, { recursive: true, force: true });
      dbDir = null;
    }
    process.env.DB_PATH = originalEnv.DB_PATH;
    process.env.DB_FILENAME = originalEnv.DB_FILENAME;
  });

  it('should bind STORAGE_SERVICE token to LocalStorageService instance', () => {
    const storageService = module.get(STORAGE_SERVICE);

    expect(storageService).toBeDefined();
    expect(storageService).toBeInstanceOf(LocalStorageService);
  });

  it('should provide a singleton LocalStorageService instance', () => {
    const instance1 = module.get(STORAGE_SERVICE);
    const instance2 = module.get(STORAGE_SERVICE);

    expect(instance1).toBe(instance2);
  });

  it('binds the trusted Snapshot writer as a separate capability on the same instance', () => {
    const storageService = module.get(STORAGE_SERVICE);
    const snapshotPromptWriter = module.get(SNAPSHOT_PROMPT_WRITER);

    expect(snapshotPromptWriter).toBe(storageService);
  });
});
