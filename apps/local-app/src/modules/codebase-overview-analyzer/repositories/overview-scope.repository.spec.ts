import { Test, TestingModule } from '@nestjs/testing';
import { existsSync, readFileSync } from 'fs';
import { OverviewScopeRepository } from './overview-scope.repository';
import { SettingsService } from '../../settings/services/settings.service';
import { DB_CONNECTION } from '../../storage/db/db.provider';
import type { FolderScopeEntry } from '../types/scope.types';

jest.mock('fs', () => {
  const actualFs = jest.requireActual('fs');
  return { ...actualFs, existsSync: jest.fn(), readFileSync: jest.fn() };
});

jest.mock('fs/promises', () => ({
  writeFile: jest.fn(),
  rename: jest.fn(),
  mkdir: jest.fn(),
}));

const mockedExistsSync = existsSync as jest.Mock;
const mockedReadFileSync = readFileSync as jest.Mock;

import * as fsPromises from 'fs/promises';
const mockedWriteFile = fsPromises.writeFile as jest.Mock;
const mockedRename = fsPromises.rename as jest.Mock;
const mockedMkdir = fsPromises.mkdir as jest.Mock;

describe('OverviewScopeRepository', () => {
  let repository: OverviewScopeRepository;
  let mockSettingsService: { getSetting: jest.Mock; updateSettings: jest.Mock };
  let mockDb: object;
  let mockSqlite: { prepare: jest.Mock };

  const projectRoot = '/projects/test';
  const projectId = 'p1';

  const userEntries: FolderScopeEntry[] = [
    { folder: 'dist', purpose: 'generated', reason: 'User override', origin: 'user' },
  ];

  beforeEach(async () => {
    mockSqlite = {
      prepare: jest.fn().mockReturnValue({ run: jest.fn() }),
    };
    mockDb = {};
    mockSettingsService = {
      getSetting: jest.fn(),
      updateSettings: jest.fn(),
    };

    mockedWriteFile.mockResolvedValue(undefined);
    mockedRename.mockResolvedValue(undefined);
    mockedMkdir.mockResolvedValue(undefined);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OverviewScopeRepository,
        { provide: SettingsService, useValue: mockSettingsService },
        { provide: DB_CONNECTION, useValue: mockDb },
      ],
    }).compile();

    repository = module.get(OverviewScopeRepository);
    (repository as unknown as { sqlite: typeof mockSqlite }).sqlite = mockSqlite;

    jest.clearAllMocks();
    mockedWriteFile.mockResolvedValue(undefined);
    mockedRename.mockResolvedValue(undefined);
    mockedMkdir.mockResolvedValue(undefined);
  });

  describe('readUserEntries', () => {
    it('reads from repo file when it exists', () => {
      mockedExistsSync.mockReturnValue(true);
      mockedReadFileSync.mockReturnValue(
        JSON.stringify({ schemaVersion: 1, entries: userEntries }),
      );

      const result = repository.readUserEntries(projectRoot, projectId);

      expect(result).toEqual(userEntries);
      expect(mockSettingsService.getSetting).not.toHaveBeenCalled();
    });

    it('falls back to SQLite when repo file does not exist', () => {
      mockedExistsSync.mockReturnValue(false);
      mockSettingsService.getSetting.mockReturnValue(JSON.stringify({ p1: userEntries }));

      const result = repository.readUserEntries(projectRoot, projectId);

      expect(result).toEqual(userEntries);
      expect(mockSettingsService.getSetting).toHaveBeenCalledWith('codebaseScope.projects');
    });

    it('repo-file-wins: ignores SQLite when repo file present', () => {
      const sqliteEntries: FolderScopeEntry[] = [
        { folder: 'build', purpose: 'excluded', reason: 'SQLite', origin: 'user' },
      ];
      mockedExistsSync.mockReturnValue(true);
      mockedReadFileSync.mockReturnValue(
        JSON.stringify({ schemaVersion: 1, entries: userEntries }),
      );
      mockSettingsService.getSetting.mockReturnValue(JSON.stringify({ p1: sqliteEntries }));

      const result = repository.readUserEntries(projectRoot, projectId);

      expect(result).toEqual(userEntries);
      expect(mockSettingsService.getSetting).not.toHaveBeenCalled();
    });

    it('returns empty array when repo file is malformed', () => {
      mockedExistsSync.mockReturnValue(true);
      mockedReadFileSync.mockReturnValue('not json');

      const result = repository.readUserEntries(projectRoot, projectId);

      expect(result).toEqual([]);
    });

    it('returns empty array when no SQLite data exists', () => {
      mockedExistsSync.mockReturnValue(false);
      mockSettingsService.getSetting.mockReturnValue(undefined);

      const result = repository.readUserEntries(projectRoot, projectId);

      expect(result).toEqual([]);
    });

    it('repo-file: returns [] when entry has numeric folder (schema violation)', () => {
      mockedExistsSync.mockReturnValue(true);
      mockedReadFileSync.mockReturnValue(
        JSON.stringify({
          schemaVersion: 1,
          entries: [{ folder: 42, purpose: 'excluded', reason: '', origin: 'user' }],
        }),
      );

      const result = repository.readUserEntries(projectRoot, projectId);

      expect(result).toEqual([]);
    });

    it('repo-file: returns [] when entry has unknown purpose', () => {
      mockedExistsSync.mockReturnValue(true);
      mockedReadFileSync.mockReturnValue(
        JSON.stringify({
          schemaVersion: 1,
          entries: [{ folder: 'dist', purpose: 'unknown-purpose', reason: '', origin: 'user' }],
        }),
      );

      const result = repository.readUserEntries(projectRoot, projectId);

      expect(result).toEqual([]);
    });

    it('repo-file: returns [] when entry has extra fields (strict schema)', () => {
      mockedExistsSync.mockReturnValue(true);
      mockedReadFileSync.mockReturnValue(
        JSON.stringify({
          schemaVersion: 1,
          entries: [
            { folder: 'dist', purpose: 'excluded', reason: '', origin: 'user', extraField: true },
          ],
        }),
      );

      const result = repository.readUserEntries(projectRoot, projectId);

      expect(result).toEqual([]);
    });

    it('SQLite: drops invalid entries and keeps valid ones', () => {
      mockedExistsSync.mockReturnValue(false);
      mockSettingsService.getSetting.mockReturnValue(
        JSON.stringify({
          p1: [
            { folder: 'dist', purpose: 'generated', reason: 'valid', origin: 'user' },
            { folder: 42, purpose: 'excluded', reason: '', origin: 'user' }, // invalid: numeric folder
            { folder: 'src', purpose: 'source', reason: 'valid too', origin: 'default' },
          ],
        }),
      );

      const result = repository.readUserEntries(projectRoot, projectId);

      expect(result).toHaveLength(2);
      expect(result[0].folder).toBe('dist');
      expect(result[1].folder).toBe('src');
    });

    it('SQLite: returns [] when all entries are invalid', () => {
      mockedExistsSync.mockReturnValue(false);
      mockSettingsService.getSetting.mockReturnValue(
        JSON.stringify({
          p1: [
            { folder: 42, purpose: 'excluded', reason: '', origin: 'user' },
            { folder: 'dist', purpose: 'not-a-purpose', reason: '', origin: 'user' },
          ],
        }),
      );

      const result = repository.readUserEntries(projectRoot, projectId);

      expect(result).toEqual([]);
    });
  });

  describe('writeUserEntries', () => {
    it('writes to repo file when it exists', async () => {
      mockedExistsSync.mockReturnValue(true);

      await repository.writeUserEntries(projectRoot, projectId, userEntries);

      expect(mockedWriteFile).toHaveBeenCalled();
      expect(mockedRename).toHaveBeenCalled();
      expect(mockSqlite.prepare).not.toHaveBeenCalled();
    });

    it('writes to SQLite when repo file does not exist', async () => {
      mockedExistsSync.mockReturnValue(false);
      mockSettingsService.getSetting.mockReturnValue(undefined);

      await repository.writeUserEntries(projectRoot, projectId, userEntries);

      expect(mockSqlite.prepare).toHaveBeenCalled();
    });

    it('shapes permission-denied error from EACCES', async () => {
      mockedExistsSync.mockReturnValue(true);

      const writeErr = new Error('Permission denied') as NodeJS.ErrnoException;
      writeErr.code = 'EACCES';
      mockedWriteFile.mockRejectedValue(writeErr);

      await expect(
        repository.writeUserEntries(projectRoot, projectId, userEntries),
      ).rejects.toEqual(
        expect.objectContaining({
          code: 'PERMISSION_DENIED',
        }),
      );
    });

    it('shapes read-only filesystem error from EROFS', async () => {
      mockedExistsSync.mockReturnValue(true);

      const writeErr = new Error('Read-only') as NodeJS.ErrnoException;
      writeErr.code = 'EROFS';
      mockedWriteFile.mockRejectedValue(writeErr);

      await expect(
        repository.writeUserEntries(projectRoot, projectId, userEntries),
      ).rejects.toEqual(
        expect.objectContaining({
          code: 'READ_ONLY_FILESYSTEM',
        }),
      );
    });

    it('shapes disk-full error from ENOSPC', async () => {
      mockedExistsSync.mockReturnValue(true);

      const writeErr = new Error('No space') as NodeJS.ErrnoException;
      writeErr.code = 'ENOSPC';
      mockedWriteFile.mockRejectedValue(writeErr);

      await expect(
        repository.writeUserEntries(projectRoot, projectId, userEntries),
      ).rejects.toEqual(
        expect.objectContaining({
          code: 'DISK_FULL',
        }),
      );
    });
  });

  describe('getStorageMode', () => {
    it('returns repo-file when .devchain/overview.json exists', () => {
      mockedExistsSync.mockReturnValue(true);
      expect(repository.getStorageMode(projectRoot)).toBe('repo-file');
    });

    it('returns local-only when no repo file', () => {
      mockedExistsSync.mockReturnValue(false);
      expect(repository.getStorageMode(projectRoot)).toBe('local-only');
    });
  });
});
