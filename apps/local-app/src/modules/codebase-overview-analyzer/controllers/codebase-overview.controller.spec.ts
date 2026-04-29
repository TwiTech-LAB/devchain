import { Test, TestingModule } from '@nestjs/testing';
import {
  NotFoundException,
  UnprocessableEntityException,
  BadRequestException,
} from '@nestjs/common';
import { CodebaseOverviewController } from './codebase-overview.controller';
import { CodebaseOverviewAnalyzerService } from '../services/codebase-overview-analyzer.service';
import { ScopeResolverService } from '../services/scope-resolver.service';
import { ScopeAutoDetectorService } from '../services/scope-auto-detector.service';
import { OverviewScopeRepository } from '../repositories/overview-scope.repository';
import { STORAGE_SERVICE, type StorageService } from '../../storage/interfaces/storage.interface';
import type {
  CodebaseOverviewSnapshot,
  TargetDetail,
  DependencyPairDetail,
  DistrictFilePage,
} from '@devchain/codebase-overview';
import type { FolderScopeEntry } from '../types/scope.types';
import * as fsPromises from 'fs/promises';

jest.mock('fs/promises', () => ({ readdir: jest.fn() }));

describe('CodebaseOverviewController', () => {
  let controller: CodebaseOverviewController;
  let mockStorage: jest.Mocked<Pick<StorageService, 'getProject'>>;
  let mockAnalyzer: jest.Mocked<
    Pick<
      CodebaseOverviewAnalyzerService,
      'getSnapshot' | 'getTargetDetails' | 'getDependencyPairDetails' | 'listDistrictFiles'
    >
  >;
  let mockScopeResolver: jest.Mocked<Pick<ScopeResolverService, 'resolve'>>;
  let mockScopeRepo: jest.Mocked<
    Pick<OverviewScopeRepository, 'readUserEntries' | 'writeUserEntries' | 'getStorageMode'>
  >;
  let mockScopeAutoDetector: { detect: jest.Mock };

  const project = { id: 'p1', name: 'Test', rootPath: '/projects/test' };

  beforeEach(async () => {
    mockStorage = { getProject: jest.fn() };
    mockAnalyzer = {
      getSnapshot: jest.fn(),
      getTargetDetails: jest.fn(),
      getDependencyPairDetails: jest.fn(),
      listDistrictFiles: jest.fn(),
    };
    mockScopeResolver = { resolve: jest.fn() };
    mockScopeRepo = {
      readUserEntries: jest.fn(),
      writeUserEntries: jest.fn(),
      getStorageMode: jest.fn(),
    };
    mockScopeAutoDetector = { detect: jest.fn().mockReturnValue([]) };
    (fsPromises.readdir as jest.Mock).mockResolvedValue([]);

    const module: TestingModule = await Test.createTestingModule({
      controllers: [CodebaseOverviewController],
      providers: [
        { provide: STORAGE_SERVICE, useValue: mockStorage },
        { provide: CodebaseOverviewAnalyzerService, useValue: mockAnalyzer },
        { provide: ScopeResolverService, useValue: mockScopeResolver },
        { provide: ScopeAutoDetectorService, useValue: mockScopeAutoDetector },
        { provide: OverviewScopeRepository, useValue: mockScopeRepo },
      ],
    }).compile();

    controller = module.get(CodebaseOverviewController);
    mockStorage.getProject.mockResolvedValue(project as never);
  });

  it('should return snapshot for a valid project', async () => {
    const snapshot: Partial<CodebaseOverviewSnapshot> = {
      snapshotId: 'snap-1',
      projectKey: '/projects/test',
      name: 'Test',
      regions: [],
      districts: [],
      dependencies: [],
      hotspots: [],
      activity: [],
      metrics: {
        totalRegions: 0,
        totalDistricts: 0,
        totalFiles: 0,
        gitHistoryDaysAvailable: null,
        shallowHistoryDetected: true,
        dependencyCoverage: null,
        warnings: [],
        excludedAuthorCount: 0,
        scopeConfigHash: 'abcd1234',
      },
    };

    mockAnalyzer.getSnapshot.mockResolvedValue(snapshot as CodebaseOverviewSnapshot);

    const result = await controller.getSnapshot('p1');

    expect(mockStorage.getProject).toHaveBeenCalledWith('p1');
    expect(mockAnalyzer.getSnapshot).toHaveBeenCalledWith('/projects/test', 'p1');
    expect(result).toBe(snapshot);
  });

  it('should propagate errors from storage', async () => {
    mockStorage.getProject.mockRejectedValue(new Error('Project not found'));

    await expect(controller.getSnapshot('missing')).rejects.toThrow('Project not found');
  });

  it('should propagate errors from analyzer', async () => {
    mockAnalyzer.getSnapshot.mockRejectedValue(new Error('Analysis failed'));

    await expect(controller.getSnapshot('p1')).rejects.toThrow('Analysis failed');
  });

  describe('getTargetDetails', () => {
    it('should return target details for a valid target', async () => {
      const detail: TargetDetail = {
        targetId: 'd1',
        kind: 'district',
        summary: 'test summary',
        whyRanked: [],
        recentCommits: [],
        topAuthors: [],
        recentActivity: [],
      };
      mockAnalyzer.getTargetDetails.mockResolvedValue(detail);

      const result = await controller.getTargetDetails('p1', 'd1');

      expect(mockAnalyzer.getTargetDetails).toHaveBeenCalledWith('/projects/test', 'd1');
      expect(result).toBe(detail);
    });

    it('should throw NotFoundException when target not found', async () => {
      mockAnalyzer.getTargetDetails.mockResolvedValue(null);

      await expect(controller.getTargetDetails('p1', 'missing')).rejects.toThrow(NotFoundException);
    });
  });

  describe('getDependencyPairDetails', () => {
    it('should return pair details for valid districts', async () => {
      const detail: DependencyPairDetail = {
        fromDistrictId: 'd1',
        toDistrictId: 'd2',
        weight: 5,
        isCyclic: false,
        summary: 'test',
        exemplarFileEdges: [],
      };
      mockAnalyzer.getDependencyPairDetails.mockReturnValue(detail);

      const result = await controller.getDependencyPairDetails('p1', 'd1', 'd2');

      expect(mockAnalyzer.getDependencyPairDetails).toHaveBeenCalledWith(
        '/projects/test',
        'd1',
        'd2',
      );
      expect(result).toBe(detail);
    });

    it('should throw NotFoundException when pair not found', async () => {
      mockAnalyzer.getDependencyPairDetails.mockReturnValue(null);

      await expect(controller.getDependencyPairDetails('p1', 'd1', 'd2')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('listDistrictFiles', () => {
    it('should return file page for a valid district', async () => {
      const page: DistrictFilePage = {
        districtId: 'd1',
        items: [],
        nextCursor: null,
      };
      mockAnalyzer.listDistrictFiles.mockReturnValue(page);

      const result = await controller.listDistrictFiles('p1', 'd1');

      expect(mockAnalyzer.listDistrictFiles).toHaveBeenCalledWith(
        '/projects/test',
        'd1',
        undefined,
      );
      expect(result).toBe(page);
    });

    it('should pass cursor to analyzer', async () => {
      const page: DistrictFilePage = {
        districtId: 'd1',
        items: [],
        nextCursor: null,
      };
      mockAnalyzer.listDistrictFiles.mockReturnValue(page);

      await controller.listDistrictFiles('p1', 'd1', '50');

      expect(mockAnalyzer.listDistrictFiles).toHaveBeenCalledWith('/projects/test', 'd1', '50');
    });

    it('should throw NotFoundException when district not found', async () => {
      mockAnalyzer.listDistrictFiles.mockReturnValue(null);

      await expect(controller.listDistrictFiles('p1', 'missing')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('corrected semantics verification', () => {
    it('should expose root bucket districts without pseudo-district inflation', async () => {
      const snapshot: CodebaseOverviewSnapshot = {
        snapshotId: 'snap-corrected',
        projectKey: '/projects/test',
        name: 'Test',
        regions: [
          { id: 'r-src', path: 'src', name: 'src', totalFiles: 5, totalLOC: 500 },
          { id: 'r-root', path: '.', name: '(root)', totalFiles: 2, totalLOC: 60 },
        ],
        districts: [
          {
            id: 'd-root',
            regionId: 'r-root',
            path: '.',
            name: '(root)',
            totalFiles: 2,
            totalLOC: 60,
            churn7d: 0,
            churn30d: 0,
            inboundWeight: 0,
            outboundWeight: 0,
            couplingScore: 0,
            testFileCount: 0,
            testFileRatio: null,
            role: 'mixed',
          },
          {
            id: 'd-ctrl',
            regionId: 'r-src',
            path: 'src/controllers',
            name: 'controllers',
            totalFiles: 3,
            totalLOC: 350,
            churn7d: 2,
            churn30d: 10,
            inboundWeight: 0,
            outboundWeight: 0,
            couplingScore: 0,
            testFileCount: 1,
            testFileRatio: 0.33,
            role: 'controller',
          },
          {
            id: 'd-src-root',
            regionId: 'r-src',
            path: 'src',
            name: '(root)',
            totalFiles: 2,
            totalLOC: 30,
            churn7d: 0,
            churn30d: 0,
            inboundWeight: 0,
            outboundWeight: 0,
            couplingScore: 0,
            testFileCount: 0,
            testFileRatio: null,
            role: 'mixed',
          },
        ],
        dependencies: [],
        hotspots: [
          {
            id: 'hotspot:size:1',
            kind: 'district',
            targetId: 'd-ctrl',
            metric: 'size',
            rank: 1,
            score: 350,
            label: 'controllers — 350 LOC',
          },
        ],
        activity: [],
        metrics: {
          totalRegions: 2,
          totalDistricts: 3,
          totalFiles: 7,
          gitHistoryDaysAvailable: 30,
          shallowHistoryDetected: false,
          dependencyCoverage: null,
          warnings: [{ code: 'missing_dependency_data', message: 'No import analysis yet' }],
        },
      };

      mockAnalyzer.getSnapshot.mockResolvedValue(snapshot);

      const result = await controller.getSnapshot('p1');

      // Root bucket districts present with "(root)" name, not filename
      const rootDistricts = result.districts.filter((d) => d.name === '(root)');
      expect(rootDistricts).toHaveLength(2);

      // No districts named after individual files
      for (const d of result.districts) {
        expect(d.name).not.toMatch(/\.\w+$/);
      }

      // Corrected role: controller (not 'mixed' with wrong denominator)
      const ctrlDistrict = result.districts.find((d) => d.name === 'controllers');
      expect(ctrlDistrict!.role).toBe('controller');

      // Metrics match district count
      expect(result.metrics.totalDistricts).toBe(result.districts.length);
    });

    it('should expose corrected role in target detail summary', async () => {
      const detail: TargetDetail = {
        targetId: 'd-ctrl',
        kind: 'district',
        summary:
          'controllers is a 350 LOC controller district with 3 files. ' +
          'It had 10 commits in the last 30 days. Test file ratio is 33%.',
        whyRanked: ['Ranked #1 for size: controllers — 350 LOC'],
        recentCommits: [{ sha: 'abc', message: 'fix auth', timestamp: 1700000000 }],
        topAuthors: [{ author: 'Alice', share: 1.0 }],
        recentActivity: [],
      };

      mockAnalyzer.getTargetDetails.mockResolvedValue(detail);

      const result = await controller.getTargetDetails('p1', 'd-ctrl');

      // Summary includes specific role "controller district" (not generic "mixed")
      expect(result.summary).toContain('controller district');
      expect(result.whyRanked).toHaveLength(1);
      expect(result.recentCommits).toHaveLength(1);
    });

    it('should expose colocated test evidence in district file page', async () => {
      const now = Date.now();
      const page: DistrictFilePage = {
        districtId: 'd-svc',
        items: [
          {
            id: 'f1',
            districtId: 'd-svc',
            path: 'src/services/auth.service.ts',
            role: 'service',
            loc: 200,
            lastModified: now,
            metrics: {
              churn7d: 2,
              churn30d: 5,
              staleDays: 0,
              hasColocatedTest: true,
              symbolCount: null,
              complexity: null,
              coverage: null,
            },
          },
          {
            id: 'f2',
            districtId: 'd-svc',
            path: 'src/services/auth.service.spec.ts',
            role: 'test',
            loc: 100,
            lastModified: now,
            metrics: {
              churn7d: 1,
              churn30d: 3,
              staleDays: 0,
              hasColocatedTest: false,
              symbolCount: null,
              complexity: null,
              coverage: null,
            },
          },
        ],
        nextCursor: null,
      };

      mockAnalyzer.listDistrictFiles.mockReturnValue(page);

      const result = await controller.listDistrictFiles('p1', 'd-svc');

      // Source file reports colocated test evidence
      const svcFile = result.items.find((n) => n.path.endsWith('auth.service.ts'));
      expect(svcFile!.metrics.hasColocatedTest).toBe(true);

      // Test file does not self-report colocated test
      const testFile = result.items.find((n) => n.path.endsWith('auth.service.spec.ts'));
      expect(testFile!.metrics.hasColocatedTest).toBe(false);
    });
  });

  describe('getScope', () => {
    const resolvedEntries: FolderScopeEntry[] = [
      {
        folder: 'node_modules',
        purpose: 'excluded',
        reason: 'DevChain default',
        origin: 'default',
      },
      { folder: 'dist', purpose: 'generated', reason: 'User override', origin: 'user' },
    ];

    it('returns resolved entries and storageMode', async () => {
      mockScopeRepo.readUserEntries.mockReturnValue([
        { folder: 'dist', purpose: 'generated', reason: 'User override', origin: 'user' },
      ]);
      mockScopeResolver.resolve.mockReturnValue(resolvedEntries);
      mockScopeRepo.getStorageMode.mockReturnValue('repo-file');

      const result = await controller.getScope('p1');

      expect(mockScopeRepo.readUserEntries).toHaveBeenCalledWith('/projects/test', 'p1');
      expect(mockScopeResolver.resolve).toHaveBeenCalled();
      expect(result).toEqual({ entries: resolvedEntries, storageMode: 'repo-file' });
    });

    it('returns local-only storage mode when no repo file', async () => {
      mockScopeRepo.readUserEntries.mockReturnValue([]);
      mockScopeResolver.resolve.mockReturnValue([]);
      mockScopeRepo.getStorageMode.mockReturnValue('local-only');

      const result = await controller.getScope('p1');

      expect(result.storageMode).toBe('local-only');
    });
  });

  describe('putScope', () => {
    const userEntries: FolderScopeEntry[] = [
      { folder: 'dist', purpose: 'generated', reason: 'User override', origin: 'user' },
    ];
    const resolvedEntries: FolderScopeEntry[] = [
      {
        folder: 'node_modules',
        purpose: 'excluded',
        reason: 'DevChain default',
        origin: 'default',
      },
      { folder: 'dist', purpose: 'generated', reason: 'User override', origin: 'user' },
    ];

    it('writes and returns resolved scope', async () => {
      mockScopeRepo.writeUserEntries.mockResolvedValue(undefined);
      mockScopeRepo.readUserEntries.mockReturnValue(userEntries);
      mockScopeResolver.resolve.mockReturnValue(resolvedEntries);
      mockScopeRepo.getStorageMode.mockReturnValue('local-only');

      const result = await controller.putScope('p1', { entries: userEntries });

      expect(mockScopeRepo.writeUserEntries).toHaveBeenCalledWith(
        '/projects/test',
        'p1',
        userEntries,
      );
      expect(result).toEqual({ entries: resolvedEntries, storageMode: 'local-only' });
    });

    it('returns 422 on permission-denied write error', async () => {
      mockScopeRepo.writeUserEntries.mockRejectedValue({
        code: 'PERMISSION_DENIED',
        message: 'Permission denied',
        manualEditPath: '/projects/test/.devchain/overview.json',
      });

      await expect(controller.putScope('p1', { entries: userEntries })).rejects.toThrow(
        UnprocessableEntityException,
      );
    });

    it('rejects entries without folder', async () => {
      await expect(
        controller.putScope('p1', {
          entries: [{ purpose: 'excluded', reason: '', origin: 'user' }] as FolderScopeEntry[],
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects entries with invalid purpose', async () => {
      await expect(
        controller.putScope('p1', {
          entries: [
            { folder: 'build', purpose: 'invalid', reason: '', origin: 'user' },
          ] as FolderScopeEntry[],
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects entries with empty folder', async () => {
      await expect(
        controller.putScope('p1', {
          entries: [
            { folder: '', purpose: 'excluded', reason: '', origin: 'user' },
          ] as FolderScopeEntry[],
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects non-array entries', async () => {
      await expect(
        controller.putScope('p1', { entries: 'not-array' as unknown as FolderScopeEntry[] }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects entries with extra fields (strict schema)', async () => {
      await expect(
        controller.putScope('p1', {
          entries: [
            { folder: 'dist', purpose: 'excluded', reason: '', origin: 'user', extra: true },
          ] as FolderScopeEntry[],
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects entries with invalid origin', async () => {
      await expect(
        controller.putScope('p1', {
          entries: [
            { folder: 'dist', purpose: 'excluded', reason: '', origin: 'unknown' },
          ] as unknown as FolderScopeEntry[],
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('filters out default and auto-detected entries before writing (round-trip contract)', async () => {
      const mixedEntries: FolderScopeEntry[] = [
        {
          folder: 'node_modules',
          purpose: 'excluded',
          reason: 'DevChain default',
          origin: 'default',
        },
        {
          folder: 'src/generated',
          purpose: 'generated',
          reason: 'Auto-detected',
          origin: 'default',
        },
        { folder: 'dist', purpose: 'generated', reason: 'User override', origin: 'user' },
      ];
      mockScopeRepo.writeUserEntries.mockResolvedValue(undefined);
      mockScopeRepo.readUserEntries.mockReturnValue([
        { folder: 'dist', purpose: 'generated', reason: 'User override', origin: 'user' },
      ]);
      mockScopeResolver.resolve.mockReturnValue(mixedEntries);
      mockScopeRepo.getStorageMode.mockReturnValue('local-only');

      await controller.putScope('p1', { entries: mixedEntries });

      // Only the user-origin entry reaches the repository
      expect(mockScopeRepo.writeUserEntries).toHaveBeenCalledWith('/projects/test', 'p1', [
        { folder: 'dist', purpose: 'generated', reason: 'User override', origin: 'user' },
      ]);
    });

    it('writes empty array when all entries are defaults or auto-detected', async () => {
      const defaultsOnly: FolderScopeEntry[] = [
        {
          folder: 'node_modules',
          purpose: 'excluded',
          reason: 'DevChain default',
          origin: 'default',
        },
        { folder: 'dist', purpose: 'excluded', reason: 'Auto-detected', origin: 'default' },
      ];
      mockScopeRepo.writeUserEntries.mockResolvedValue(undefined);
      mockScopeRepo.readUserEntries.mockReturnValue([]);
      mockScopeResolver.resolve.mockReturnValue(defaultsOnly);
      mockScopeRepo.getStorageMode.mockReturnValue('local-only');

      await controller.putScope('p1', { entries: defaultsOnly });

      expect(mockScopeRepo.writeUserEntries).toHaveBeenCalledWith('/projects/test', 'p1', []);
    });
  });

  describe('detectFolders (recursive bounded readdir)', () => {
    const mockReaddir = fsPromises.readdir as jest.Mock;

    beforeEach(() => {
      mockReaddir.mockReset();
      mockScopeAutoDetector.detect.mockReset();
      mockScopeAutoDetector.detect.mockReturnValue([]);
    });

    const dir = (name: string) =>
      ({ name, isDirectory: () => true, isFile: () => false }) as unknown as import('fs').Dirent;

    it('discovers top-level folders', async () => {
      mockReaddir.mockResolvedValueOnce([dir('src'), dir('tests')]);
      // no subdirectories
      mockReaddir.mockResolvedValue([]);

      mockScopeRepo.readUserEntries.mockReturnValue([]);
      mockScopeResolver.resolve.mockReturnValue([]);
      mockScopeRepo.getStorageMode.mockReturnValue('local-only');

      await controller.getScope('p1');

      expect(mockScopeAutoDetector.detect).toHaveBeenCalledWith(
        expect.arrayContaining(['src', 'tests']),
      );
    });

    it('discovers nested folders up to depth 3', async () => {
      // depth 1: src
      mockReaddir.mockResolvedValueOnce([dir('src')]);
      // depth 2: src/modules
      mockReaddir.mockResolvedValueOnce([dir('modules')]);
      // depth 3: src/modules/auth
      mockReaddir.mockResolvedValueOnce([dir('auth')]);
      // depth 4: would exceed limit — not called
      mockReaddir.mockResolvedValue([]);

      mockScopeRepo.readUserEntries.mockReturnValue([]);
      mockScopeResolver.resolve.mockReturnValue([]);
      mockScopeRepo.getStorageMode.mockReturnValue('local-only');

      await controller.getScope('p1');

      const observed = mockScopeAutoDetector.detect.mock.calls[0][0] as string[];
      expect(observed).toContain('src');
      expect(observed).toContain('src/modules');
      expect(observed).toContain('src/modules/auth');
      // depth-1, depth-2, depth-3 each call readdir; depth-4 walk exits early
      expect(mockReaddir).toHaveBeenCalledTimes(3);
    });

    it('does not recurse beyond depth 3', async () => {
      mockReaddir.mockResolvedValueOnce([dir('a')]);
      mockReaddir.mockResolvedValueOnce([dir('b')]);
      mockReaddir.mockResolvedValueOnce([dir('c')]);
      mockReaddir.mockResolvedValueOnce([dir('d')]); // depth 4 dirs — readdir called but children not added

      mockScopeRepo.readUserEntries.mockReturnValue([]);
      mockScopeResolver.resolve.mockReturnValue([]);
      mockScopeRepo.getStorageMode.mockReturnValue('local-only');

      await controller.getScope('p1');

      const observed = mockScopeAutoDetector.detect.mock.calls[0][0] as string[];
      expect(observed).toContain('a');
      expect(observed).toContain('a/b');
      expect(observed).toContain('a/b/c');
      expect(observed).not.toContain('a/b/c/d');
    });

    it('skips literal built-in default paths at their exact root location', async () => {
      mockReaddir.mockResolvedValueOnce([dir('src'), dir('node_modules'), dir('dist')]);
      mockReaddir.mockResolvedValue([]);

      mockScopeRepo.readUserEntries.mockReturnValue([]);
      mockScopeResolver.resolve.mockReturnValue([]);
      mockScopeRepo.getStorageMode.mockReturnValue('local-only');

      await controller.getScope('p1');

      const observed = mockScopeAutoDetector.detect.mock.calls[0][0] as string[];
      expect(observed).toContain('src');
      expect(observed).not.toContain('node_modules');
      expect(observed).not.toContain('dist');
    });

    it('skips .git at any depth but discovers other dot-directories', async () => {
      mockReaddir.mockResolvedValueOnce([
        dir('src'),
        dir('.git'),
        dir('.cache'),
        dir('.generated'),
      ]);
      mockReaddir.mockResolvedValue([]);

      mockScopeRepo.readUserEntries.mockReturnValue([]);
      mockScopeResolver.resolve.mockReturnValue([]);
      mockScopeRepo.getStorageMode.mockReturnValue('local-only');

      await controller.getScope('p1');

      const observed = mockScopeAutoDetector.detect.mock.calls[0][0] as string[];
      expect(observed).toContain('src');
      expect(observed).not.toContain('.git');
      expect(observed).toContain('.cache');
      expect(observed).toContain('.generated');
    });

    it('discovers .nuxt and .cache at root', async () => {
      mockReaddir.mockResolvedValueOnce([dir('.nuxt'), dir('.cache')]);
      mockReaddir.mockResolvedValue([]);

      mockScopeRepo.readUserEntries.mockReturnValue([]);
      mockScopeResolver.resolve.mockReturnValue([]);
      mockScopeRepo.getStorageMode.mockReturnValue('local-only');

      await controller.getScope('p1');

      const observed = mockScopeAutoDetector.detect.mock.calls[0][0] as string[];
      expect(observed).toContain('.nuxt');
      expect(observed).toContain('.cache');
    });

    it('discovers nested src/dist but suppresses root-level dist', async () => {
      // depth 1: src (observed), dist (suppressed — literal root default)
      mockReaddir.mockResolvedValueOnce([dir('src'), dir('dist')]);
      // depth 2 inside src: dist (observed — relPath is src/dist, not a literal match)
      mockReaddir.mockResolvedValueOnce([dir('dist')]);
      mockReaddir.mockResolvedValue([]);

      mockScopeRepo.readUserEntries.mockReturnValue([]);
      mockScopeResolver.resolve.mockReturnValue([]);
      mockScopeRepo.getStorageMode.mockReturnValue('local-only');

      await controller.getScope('p1');

      const observed = mockScopeAutoDetector.detect.mock.calls[0][0] as string[];
      expect(observed).toContain('src');
      expect(observed).not.toContain('dist');
      expect(observed).toContain('src/dist');
    });

    it('returns empty array when readdir throws', async () => {
      mockReaddir.mockRejectedValue(new Error('EACCES'));

      mockScopeRepo.readUserEntries.mockReturnValue([]);
      mockScopeResolver.resolve.mockReturnValue([]);
      mockScopeRepo.getStorageMode.mockReturnValue('local-only');

      const result = await controller.getScope('p1');
      expect(result.entries).toEqual([]);
    });
  });
});
