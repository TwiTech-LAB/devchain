import type { Stats } from 'fs';
import * as fs from 'fs/promises';
import Database from 'better-sqlite3';
import { SeedIsolationError, SeedPreparationService } from './seed-preparation.service';
import { getDbConfig } from '../../../storage/db/db.config';

const mockBackup = jest.fn();
const mockClose = jest.fn();
const mockExec = jest.fn();
const mockPragma = jest.fn();
const mockSqlEvents: string[] = [];
const mockPrepare = jest.fn((sql: string) => ({
  run: jest.fn(() => {
    mockSqlEvents.push(sql);
  }),
  get: jest.fn(() => {
    mockSqlEvents.push(sql);
    return { count: 0 };
  }),
  sql,
}));

jest.mock('fs/promises', () => ({
  mkdir: jest.fn(),
  rename: jest.fn(),
  cp: jest.fn(),
  rm: jest.fn(),
  stat: jest.fn(),
}));

jest.mock('better-sqlite3', () => {
  return jest.fn().mockImplementation(() => ({
    backup: mockBackup,
    close: mockClose,
    exec: mockExec,
    pragma: mockPragma,
    prepare: mockPrepare,
    transaction: jest.fn((callback: () => void) => callback),
  }));
});

jest.mock('../../../storage/db/db.config', () => ({
  getDbConfig: jest.fn(() => ({
    dbPath: '/host/.devchain/devchain.db',
    busyTimeout: 5000,
  })),
}));

function makeFileStats(): Stats {
  return {
    isFile: () => true,
    isDirectory: () => false,
  } as Stats;
}

function makeDirectoryStats(): Stats {
  return {
    isFile: () => false,
    isDirectory: () => true,
  } as Stats;
}

function makeNotFoundError(path: string): NodeJS.ErrnoException {
  const error = new Error(
    `ENOENT: no such file or directory, stat '${path}'`,
  ) as NodeJS.ErrnoException;
  error.code = 'ENOENT';
  return error;
}

describe('SeedPreparationService', () => {
  const originalHome = process.env.HOME;
  const hostHome = '/host';
  const hostPreferredDbPath = '/host/.devchain/devchain.db';
  const hostLegacyDbPath = '/host/.devchain/local.db';
  const hostSkillsPath = '/host/.devchain/skills';
  const targetDataPath = '/target/worktrees/feature/data';
  const targetDbPath = '/target/worktrees/feature/data/devchain.db';
  const targetSkillsPath = '/target/worktrees/feature/data/skills';

  const fsMock = fs as jest.Mocked<typeof fs>;
  const getDbConfigMock = getDbConfig as jest.MockedFunction<typeof getDbConfig>;

  beforeEach(() => {
    process.env.HOME = hostHome;
    jest.clearAllMocks();
    mockSqlEvents.length = 0;

    mockExec.mockImplementation((sql: string) => {
      mockSqlEvents.push(sql);
    });
    mockPragma.mockImplementation((statement: string) => {
      mockSqlEvents.push(`PRAGMA ${statement}`);
      if (statement === 'wal_checkpoint(TRUNCATE)') {
        return [{ busy: 0, log: 0, checkpointed: 0 }];
      }
      if (statement === 'integrity_check') {
        return 'ok';
      }
      return undefined;
    });

    getDbConfigMock.mockReturnValue({
      dbPath: '/host/.devchain/devchain.db',
      busyTimeout: 5000,
    });

    fsMock.mkdir.mockResolvedValue(undefined);
    fsMock.rename.mockResolvedValue(undefined);
    fsMock.cp.mockResolvedValue(undefined);
    fsMock.rm.mockResolvedValue(undefined);
    mockBackup.mockResolvedValue({ totalPages: 10, remainingPages: 0 });
    mockClose.mockReturnValue(undefined);
  });

  afterEach(() => {
    process.env.HOME = originalHome;
  });

  it('copies sqlite atomically, copies skills, and migrates the copied database path', async () => {
    fsMock.stat.mockImplementation(async (path) => {
      if (path === hostPreferredDbPath) {
        return makeFileStats();
      }
      if (path === hostSkillsPath) {
        return makeDirectoryStats();
      }
      throw makeNotFoundError(String(path));
    });

    const service = new SeedPreparationService();
    const migrationSpy = jest
      .spyOn(
        service as unknown as { runMigrationsOnCopy: (dbPath: string) => Promise<void> },
        'runMigrationsOnCopy',
      )
      .mockResolvedValue(undefined);

    await service.prepareSeedData(targetDataPath);

    expect(fsMock.mkdir).toHaveBeenCalledWith(targetDataPath, { recursive: true });
    expect(mockBackup).toHaveBeenCalledTimes(1);
    expect(fsMock.rename).toHaveBeenCalledTimes(1);
    expect(Database as unknown as jest.Mock).toHaveBeenCalledWith(hostPreferredDbPath, {
      readonly: true,
      fileMustExist: true,
    });

    const tempPath = mockBackup.mock.calls[0][0] as string;
    expect(tempPath).toMatch(/^\/target\/worktrees\/feature\/data\/\.devchain\.db\.tmp-/);
    expect(fsMock.rename).toHaveBeenCalledWith(tempPath, targetDbPath);
    expect(mockClose).toHaveBeenCalledTimes(2);

    expect(fsMock.cp).toHaveBeenCalledWith(hostSkillsPath, targetSkillsPath, {
      recursive: true,
      force: true,
    });
    expect(migrationSpy).toHaveBeenCalledWith(targetDbPath);

    const preparedSql = mockPrepare.mock.calls.map(([sql]) => sql);
    expect(preparedSql.indexOf('DELETE FROM external_task_links')).toBeGreaterThanOrEqual(0);
    expect(preparedSql.indexOf('DELETE FROM integration_connections')).toBeGreaterThan(
      preparedSql.indexOf('DELETE FROM external_task_links'),
    );
    expect(preparedSql).toContain('SELECT COUNT(*) AS count FROM external_task_links');
    expect(preparedSql).toContain('SELECT COUNT(*) AS count FROM integration_connections');
    expect(mockExec).toHaveBeenCalledWith('VACUUM');
    expect(mockPragma).toHaveBeenCalledWith('wal_checkpoint(TRUNCATE)');
    expect(mockPragma).toHaveBeenCalledWith('integrity_check', { simple: true });

    expect(mockSqlEvents.indexOf('DELETE FROM integration_connections')).toBeLessThan(
      mockSqlEvents.indexOf('VACUUM'),
    );
    expect(mockSqlEvents.indexOf('VACUUM')).toBeLessThan(
      mockSqlEvents.indexOf('PRAGMA wal_checkpoint(TRUNCATE)'),
    );
  });

  it.each(['compaction', 'checkpoint', 'post-verification'] as const)(
    'fails closed when copied-database %s fails',
    async (failureStage) => {
      fsMock.stat.mockImplementation(async (path) => {
        if (path === hostPreferredDbPath) {
          return makeFileStats();
        }
        throw makeNotFoundError(String(path));
      });

      if (failureStage === 'compaction') {
        mockExec.mockImplementationOnce(() => {
          throw new Error('unsafe database detail');
        });
      } else if (failureStage === 'checkpoint') {
        mockPragma.mockImplementation((statement: string) => {
          if (statement === 'wal_checkpoint(TRUNCATE)') {
            throw new Error('unsafe checkpoint detail');
          }
          if (statement === 'integrity_check') {
            return 'ok';
          }
          return undefined;
        });
      } else {
        mockPragma.mockImplementation((statement: string) => {
          if (statement === 'wal_checkpoint(TRUNCATE)') {
            return [{ busy: 0, log: 0, checkpointed: 0 }];
          }
          if (statement === 'integrity_check') {
            return 'corrupt';
          }
          return undefined;
        });
      }

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
      expect(mockClose).toHaveBeenCalledTimes(2);
    },
  );

  it('creates an empty target skills directory when host skills directory is missing', async () => {
    fsMock.stat.mockImplementation(async (path) => {
      if (path === hostPreferredDbPath) {
        return makeFileStats();
      }
      throw makeNotFoundError(String(path));
    });

    const service = new SeedPreparationService();
    const migrationSpy = jest
      .spyOn(
        service as unknown as { runMigrationsOnCopy: (dbPath: string) => Promise<void> },
        'runMigrationsOnCopy',
      )
      .mockResolvedValue(undefined);

    await service.prepareSeedData(targetDataPath);

    expect(fsMock.cp).not.toHaveBeenCalled();
    expect(fsMock.mkdir).toHaveBeenCalledWith(targetSkillsPath, { recursive: true });
    expect(migrationSpy).toHaveBeenCalledWith(targetDbPath);
  });

  it('falls back to configured sqlite path when ~/.devchain/devchain.db is missing', async () => {
    const configuredDbPath = '/configured/storage/devchain.db';
    getDbConfigMock.mockReturnValue({
      dbPath: configuredDbPath,
      busyTimeout: 5000,
    });

    fsMock.stat.mockImplementation(async (path) => {
      if (path === configuredDbPath) {
        return makeFileStats();
      }
      throw makeNotFoundError(String(path));
    });

    const service = new SeedPreparationService();
    const migrationSpy = jest
      .spyOn(
        service as unknown as { runMigrationsOnCopy: (dbPath: string) => Promise<void> },
        'runMigrationsOnCopy',
      )
      .mockResolvedValue(undefined);

    await service.prepareSeedData(targetDataPath);

    expect(Database as unknown as jest.Mock).toHaveBeenCalledWith(configuredDbPath, {
      readonly: true,
      fileMustExist: true,
    });
    expect(migrationSpy).toHaveBeenCalledWith(targetDbPath);
  });

  it('falls back to legacy ~/.devchain/local.db when preferred and configured paths are missing', async () => {
    const configuredDbPath = '/configured/storage/devchain.db';
    getDbConfigMock.mockReturnValue({
      dbPath: configuredDbPath,
      busyTimeout: 5000,
    });

    fsMock.stat.mockImplementation(async (path) => {
      if (path === hostLegacyDbPath) {
        return makeFileStats();
      }
      throw makeNotFoundError(String(path));
    });

    const service = new SeedPreparationService();
    const migrationSpy = jest
      .spyOn(
        service as unknown as { runMigrationsOnCopy: (dbPath: string) => Promise<void> },
        'runMigrationsOnCopy',
      )
      .mockResolvedValue(undefined);

    await service.prepareSeedData(targetDataPath);

    expect(Database as unknown as jest.Mock).toHaveBeenCalledWith(hostLegacyDbPath, {
      readonly: true,
      fileMustExist: true,
    });
    expect(migrationSpy).toHaveBeenCalledWith(targetDbPath);
  });

  it('cleans up temp sqlite copy when backup fails', async () => {
    fsMock.stat.mockImplementation(async (path) => {
      if (path === hostPreferredDbPath) {
        return makeFileStats();
      }
      if (path === hostSkillsPath) {
        return makeDirectoryStats();
      }
      throw makeNotFoundError(String(path));
    });
    mockBackup.mockRejectedValue(new Error('backup failed'));

    const service = new SeedPreparationService();
    const migrationSpy = jest
      .spyOn(
        service as unknown as { runMigrationsOnCopy: (dbPath: string) => Promise<void> },
        'runMigrationsOnCopy',
      )
      .mockResolvedValue(undefined);

    await expect(service.prepareSeedData(targetDataPath)).rejects.toThrow('backup failed');

    expect(fsMock.rename).not.toHaveBeenCalled();
    expect(fsMock.cp).not.toHaveBeenCalled();
    expect(migrationSpy).not.toHaveBeenCalled();
    expect(mockClose).toHaveBeenCalledTimes(1);
    expect(fsMock.rm).toHaveBeenCalledWith(expect.stringMatching(/\.devchain\.db\.tmp-/), {
      force: true,
    });
  });
});
