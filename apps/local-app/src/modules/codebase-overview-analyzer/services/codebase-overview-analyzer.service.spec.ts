import { Test, TestingModule } from '@nestjs/testing';
import { CodebaseOverviewAnalyzerService } from './codebase-overview-analyzer.service';
import { IdentityResolverService } from './identity-resolver.service';
import { HotspotScoringService } from './hotspot-scoring.service';
import { DistrictSplittingService } from './district-splitting.service';
import { DependencyAggregationService } from './dependency-aggregation.service';
import { EvidenceQueryService } from './evidence-query.service';
import { LanguageAdapterRegistryService } from './language-adapter-registry.service';
import { ScopeResolverService } from './scope-resolver.service';
import { ScopeAutoDetectorService } from './scope-auto-detector.service';
import { OverviewScopeRepository } from '../repositories/overview-scope.repository';
import type { Stats } from 'fs';
import { existsSync } from 'fs';
import * as fsPromises from 'fs/promises';
import { execFile } from 'child_process';

jest.mock('../repositories/overview-scope.repository', () => ({
  OverviewScopeRepository: class MockOverviewScopeRepository {},
}));

jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  existsSync: jest.fn(),
}));

jest.mock('fs/promises', () => ({
  stat: jest.fn(),
  readdir: jest.fn(),
  readFile: jest.fn(),
}));

jest.mock('child_process', () => ({
  execFile: jest.fn(),
}));

const mockExistsSync = existsSync as jest.MockedFunction<typeof existsSync>;
const mockExecFile = execFile as unknown as jest.Mock;
const mockStat = fsPromises.stat as jest.MockedFunction<typeof fsPromises.stat>;
const mockReaddir = fsPromises.readdir as jest.MockedFunction<typeof fsPromises.readdir>;
const mockReadFile = fsPromises.readFile as unknown as jest.Mock;

type ExecFileCallback = (...args: unknown[]) => void;

function mockGitCall(stdout: string) {
  mockExecFile.mockImplementationOnce(
    (_cmd: string, _args: string[], _opts: unknown, cb?: ExecFileCallback) => {
      if (cb) {
        cb(null, { stdout, stderr: '' });
      }
      return { stdout, stderr: '' };
    },
  );
}

/** Mock the 3 churn map git log calls (1d, 7d, 30d) + daily churn + windowed authors (7d, 30d) + authorship with empty output. */
function mockEmptyChurn() {
  mockGitCall(''); // churn 1d
  mockGitCall(''); // churn 7d
  mockGitCall(''); // churn 30d
  mockGitCall(''); // daily churn
  mockGitCall(''); // windowed authors 7d
  mockGitCall(''); // windowed authors 30d
  mockGitCall(''); // getFileAuthorMap
}

describe('CodebaseOverviewAnalyzerService', () => {
  let service: CodebaseOverviewAnalyzerService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IdentityResolverService,
        HotspotScoringService,
        DistrictSplittingService,
        DependencyAggregationService,
        EvidenceQueryService,
        LanguageAdapterRegistryService,
        ScopeResolverService,
        ScopeAutoDetectorService,
        {
          provide: OverviewScopeRepository,
          useValue: {
            readUserEntries: () => [],
            getStorageMode: () => 'local-only' as const,
          },
        },
        CodebaseOverviewAnalyzerService,
      ],
    }).compile();

    service = module.get(CodebaseOverviewAnalyzerService);

    // Default: readFile returns empty content (adapter analysis finds nothing)
    mockReadFile.mockResolvedValue('');
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  describe('detectCapabilities', () => {
    it('should detect non-git repository', async () => {
      mockExistsSync.mockReturnValue(false);

      const caps = await service.detectCapabilities('/some/path');

      expect(caps.isGitRepo).toBe(false);
      expect(caps.isShallow).toBe(false);
      expect(caps.totalCommits).toBe(0);
      expect(caps.gitHistoryDays).toBeNull();
    });

    it('should detect a normal git repository', async () => {
      mockExistsSync.mockReturnValue(true);

      // rev-parse --is-shallow-repository
      mockGitCall('false\n');
      // rev-list --count HEAD
      mockGitCall('150\n');
      // log --format=%at --reverse -1
      mockGitCall(`${Math.floor(Date.now() / 1000) - 86400 * 30}\n`);

      const caps = await service.detectCapabilities('/some/path');

      expect(caps.isGitRepo).toBe(true);
      expect(caps.isShallow).toBe(false);
      expect(caps.totalCommits).toBe(150);
      expect(caps.gitHistoryDays).toBeGreaterThanOrEqual(29);
    });

    it('should detect a shallow repository', async () => {
      mockExistsSync.mockReturnValue(true);

      mockGitCall('true\n');
      mockGitCall('10\n');
      mockGitCall(`${Math.floor(Date.now() / 1000) - 86400 * 5}\n`);

      const caps = await service.detectCapabilities('/some/path');

      expect(caps.isGitRepo).toBe(true);
      expect(caps.isShallow).toBe(true);
      expect(caps.totalCommits).toBe(10);
    });
  });

  describe('segmentFiles', () => {
    it('should create regions from top-level directories', () => {
      const files = [
        { path: 'apps/local-app/main.ts', loc: 50, lastModified: 1000 },
        { path: 'apps/local-app/app.ts', loc: 30, lastModified: 1000 },
        { path: 'packages/shared/index.ts', loc: 20, lastModified: 1000 },
      ];

      const { regions } = service.segmentFiles(files);

      expect(regions).toHaveLength(2);
      expect(regions.map((r) => r.name).sort()).toEqual(['apps', 'packages']);

      const appsRegion = regions.find((r) => r.name === 'apps')!;
      expect(appsRegion.totalFiles).toBe(2);
      expect(appsRegion.totalLOC).toBe(80);

      const packagesRegion = regions.find((r) => r.name === 'packages')!;
      expect(packagesRegion.totalFiles).toBe(1);
      expect(packagesRegion.totalLOC).toBe(20);
    });

    it('should create districts from second-level directories', () => {
      const files = [
        { path: 'src/controllers/user.ts', loc: 100, lastModified: 1000 },
        { path: 'src/controllers/auth.ts', loc: 50, lastModified: 1000 },
        { path: 'src/services/user.service.ts', loc: 200, lastModified: 1000 },
      ];

      const { districts } = service.segmentFiles(files);

      expect(districts).toHaveLength(2);
      const controllerDistrict = districts.find((d) => d.name === 'controllers')!;
      expect(controllerDistrict.totalFiles).toBe(2);
      expect(controllerDistrict.totalLOC).toBe(150);

      const serviceDistrict = districts.find((d) => d.name === 'services')!;
      expect(serviceDistrict.totalFiles).toBe(1);
      expect(serviceDistrict.totalLOC).toBe(200);
    });

    it('should handle root-level files', () => {
      const files = [
        { path: 'README.md', loc: 10, lastModified: 1000 },
        { path: 'package.json', loc: 30, lastModified: 1000 },
      ];

      const { regions, districts } = service.segmentFiles(files);

      expect(regions).toHaveLength(1);
      expect(regions[0].name).toBe('(root)');
      expect(regions[0].totalFiles).toBe(2);
      expect(regions[0].totalLOC).toBe(40);

      expect(districts).toHaveLength(1);
    });

    it('should group two-segment regional files into a root bucket district', () => {
      const files = [
        { path: 'src/index.ts', loc: 10, lastModified: 1000 },
        { path: 'src/main.ts', loc: 20, lastModified: 1000 },
      ];

      const { regions, districts, districtFileMap } = service.segmentFiles(files);

      expect(regions).toHaveLength(1);
      expect(regions[0].name).toBe('src');
      // Both files grouped into a single root bucket, not per-file pseudo-districts
      expect(districts).toHaveLength(1);
      expect(districts[0].name).toBe('(root)');
      expect(districts[0].totalFiles).toBe(2);
      expect(districts[0].totalLOC).toBe(30);
      expect(districts[0].path).toBe('src');
      expect(districtFileMap.get('src/(root)')!.sort()).toEqual(['src/index.ts', 'src/main.ts']);
    });

    it('should return districtFileMap with correct membership', () => {
      const files = [
        { path: 'src/controllers/user.ts', loc: 100, lastModified: 1000 },
        { path: 'src/controllers/auth.ts', loc: 50, lastModified: 1000 },
        { path: 'src/services/user.service.ts', loc: 200, lastModified: 1000 },
      ];

      const { districtFileMap } = service.segmentFiles(files);

      expect(districtFileMap.size).toBe(2);
      expect(districtFileMap.get('src/controllers')!.sort()).toEqual([
        'src/controllers/auth.ts',
        'src/controllers/user.ts',
      ]);
      expect(districtFileMap.get('src/services')).toEqual(['src/services/user.service.ts']);
    });

    it('should separate 2-segment root bucket from 3-segment district in same region', () => {
      const files = [
        { path: 'src/index.ts', loc: 10, lastModified: 1000 },
        { path: 'src/controllers/user.ts', loc: 100, lastModified: 1000 },
        { path: 'src/services/auth.ts', loc: 200, lastModified: 1000 },
      ];

      const { regions, districts, districtFileMap } = service.segmentFiles(files);

      expect(regions).toHaveLength(1);
      expect(regions[0].name).toBe('src');
      // 3 districts: (root) for index.ts, controllers, services
      expect(districts).toHaveLength(3);
      expect(districts.map((d) => d.name).sort()).toEqual(['(root)', 'controllers', 'services']);

      const rootDistrict = districts.find((d) => d.name === '(root)')!;
      expect(rootDistrict.totalFiles).toBe(1);
      expect(rootDistrict.path).toBe('src');
      expect(districtFileMap.get('src/(root)')).toEqual(['src/index.ts']);
    });

    it('should not create per-file pseudo-districts for regional files', () => {
      const files = [
        { path: 'lib/utils.ts', loc: 50, lastModified: 1000 },
        { path: 'lib/helpers.ts', loc: 30, lastModified: 1000 },
        { path: 'lib/core/engine.ts', loc: 200, lastModified: 1000 },
      ];

      const { districts } = service.segmentFiles(files);

      // 2 districts: (root) for 2-segment files, core for 3-segment file
      expect(districts).toHaveLength(2);
      // No district named after a filename
      expect(districts.find((d) => d.name === 'utils.ts')).toBeUndefined();
      expect(districts.find((d) => d.name === 'helpers.ts')).toBeUndefined();
      // Root bucket collects both 2-segment files
      const rootDistrict = districts.find((d) => d.name === '(root)')!;
      expect(rootDistrict.totalFiles).toBe(2);
      expect(rootDistrict.totalLOC).toBe(80);
    });

    it('should sort regions and districts by LOC descending', () => {
      const files = [
        { path: 'small/a/x.ts', loc: 10, lastModified: 1000 },
        { path: 'large/b/y.ts', loc: 500, lastModified: 1000 },
        { path: 'medium/c/z.ts', loc: 100, lastModified: 1000 },
      ];

      const { regions } = service.segmentFiles(files);

      expect(regions[0].name).toBe('large');
      expect(regions[1].name).toBe('medium');
      expect(regions[2].name).toBe('small');
    });
  });

  describe('getSnapshot', () => {
    it('should assemble a snapshot for a git repository', async () => {
      mockExistsSync.mockReturnValue(true);

      // detectCapabilities calls
      mockGitCall('false\n'); // is-shallow
      mockGitCall('50\n'); // rev-list count
      mockGitCall(`${Math.floor(Date.now() / 1000) - 86400 * 10}\n`); // oldest commit

      // scanFiles: git ls-files -z
      mockGitCall('src/main.ts\0src/app.ts\0README.md\0');

      // getLocMap: git diff --numstat
      mockGitCall('100\t0\tsrc/main.ts\n50\t0\tsrc/app.ts\n20\t0\tREADME.md\n');

      // fs.stat for each file
      mockStat.mockResolvedValue({ mtimeMs: Date.now() } as Stats);

      // getCurrentCommitSha: rev-parse HEAD
      mockGitCall('abc123\n');
      // churn maps (1d, 7d, 30d)
      mockEmptyChurn();

      const snapshot = await service.getSnapshot('/test/project', 'test-project');

      expect(snapshot.snapshotId).toBeTruthy();
      expect(snapshot.projectKey).toBe('/test/project');
      expect(snapshot.name).toBe('project');
      expect(snapshot.regions.length).toBeGreaterThan(0);
      expect(snapshot.districts.length).toBeGreaterThan(0);
      expect(snapshot.metrics.totalFiles).toBe(3);
      expect(snapshot.metrics.shallowHistoryDetected).toBe(false);
      expect(snapshot.dependencies).toEqual([]);
      // Hotspots populated with size and test-risk entries
      expect(snapshot.hotspots.length).toBeGreaterThan(0);
      for (const h of snapshot.hotspots) {
        expect(h.id).toBeTruthy();
        expect(h.kind).toBe('district');
        expect(h.rank).toBeGreaterThan(0);
      }
      // Activity summaries: one per district
      expect(snapshot.activity.length).toBe(snapshot.districts.length);

      // Verify IDs are UUIDs, not path-based
      for (const region of snapshot.regions) {
        expect(region.id).toMatch(/^[0-9a-f-]{36}$/);
      }
      for (const district of snapshot.districts) {
        expect(district.id).toMatch(/^[0-9a-f-]{36}$/);
        expect(district.regionId).toMatch(/^[0-9a-f-]{36}$/);
      }

      // Signals array: one entry per district, all required fields present
      expect(snapshot.signals).toHaveLength(snapshot.districts.length);
      for (const sig of snapshot.signals) {
        expect(sig.districtId).toMatch(/^[0-9a-f-]{36}$/);
        expect(typeof sig.name).toBe('string');
        expect(typeof sig.path).toBe('string');
        expect(typeof sig.regionId).toBe('string');
        expect(typeof sig.regionName).toBe('string');
        expect(typeof sig.files).toBe('number');
        expect(typeof sig.sourceFileCount).toBe('number');
        expect(typeof sig.supportFileCount).toBe('number');
        expect(typeof sig.hasSourceFiles).toBe('boolean');
        expect(typeof sig.loc).toBe('number');
        expect(sig.fileTypeBreakdown.kind).toBe('extension');
        expect(typeof sig.fileTypeBreakdown.counts).toBe('object');
      }

      // DistrictSignals.path must match DistrictNode.path for each district
      for (const sig of snapshot.signals) {
        const district = snapshot.districts.find((d) => d.id === sig.districtId)!;
        expect(sig.path).toBe(district.path);
      }

      // globalContributors defaulted to empty array in Phase 1
      expect(snapshot.globalContributors).toEqual([]);
    });

    it('should emit warnings for non-git repository', async () => {
      mockExistsSync.mockReturnValue(false);

      // Non-git fallback: listFsFiles uses readdir
      mockReaddir.mockResolvedValue([
        { name: 'index.ts', isFile: () => true, isDirectory: () => false },
        { name: 'node_modules', isFile: () => false, isDirectory: () => true },
      ] as never);

      mockStat.mockResolvedValue({ mtimeMs: Date.now() } as Stats);

      const snapshot = await service.getSnapshot('/test/no-git', 'test-project');

      expect(snapshot.metrics.shallowHistoryDetected).toBe(true);

      const warningCodes = snapshot.metrics.warnings.map((w) => w.code);
      expect(warningCodes).toContain('shallow_git_history');
      expect(warningCodes).toContain('missing_dependency_data');
    });

    it('should emit shallow history warning for shallow repos', async () => {
      mockExistsSync.mockReturnValue(true);

      mockGitCall('true\n'); // shallow
      mockGitCall('5\n'); // commits
      mockGitCall(`${Math.floor(Date.now() / 1000) - 86400}\n`); // oldest
      mockGitCall('\0'); // ls-files (empty)
      mockGitCall(''); // numstat (empty)
      mockGitCall('sha-shallow\n'); // rev-parse HEAD
      mockEmptyChurn();

      const snapshot = await service.getSnapshot('/test/shallow', 'test-project');

      expect(snapshot.metrics.shallowHistoryDetected).toBe(true);
      const shallowWarning = snapshot.metrics.warnings.find(
        (w) => w.code === 'shallow_git_history',
      );
      expect(shallowWarning).toBeDefined();
      expect(shallowWarning!.message).toContain('Shallow');
    });

    it('should always emit missing dependency data warning', async () => {
      mockExistsSync.mockReturnValue(true);

      mockGitCall('false\n');
      mockGitCall('100\n');
      mockGitCall(`${Math.floor(Date.now() / 1000) - 86400 * 30}\n`);
      mockGitCall('\0');
      mockGitCall('');
      mockGitCall('sha-dep\n'); // rev-parse HEAD
      mockEmptyChurn();

      const snapshot = await service.getSnapshot('/test/project', 'test-project');

      const depWarning = snapshot.metrics.warnings.find(
        (w) => w.code === 'missing_dependency_data',
      );
      expect(depWarning).toBeDefined();
    });

    it('should produce stable IDs across repeated snapshots', async () => {
      const setupGitMocks = () => {
        mockExistsSync.mockReturnValue(true);
        mockGitCall('false\n');
        mockGitCall('50\n');
        mockGitCall(`${Math.floor(Date.now() / 1000) - 86400 * 10}\n`);
        mockGitCall('src/main.ts\0src/app.ts\0');
        mockGitCall('100\t0\tsrc/main.ts\n50\t0\tsrc/app.ts\n');
        mockStat.mockResolvedValue({ mtimeMs: Date.now() } as Stats);
        mockGitCall('abc123\n'); // rev-parse HEAD
      };

      // First snapshot (no previous state → no rename detection)
      setupGitMocks();
      mockEmptyChurn();
      const first = await service.getSnapshot('/test/stable', 'test-project');

      // Second snapshot (has previous state → rename detection before churn)
      jest.resetAllMocks();
      setupGitMocks();
      mockGitCall('\n'); // detectGitRenames: no renames
      mockEmptyChurn();
      const second = await service.getSnapshot('/test/stable', 'test-project');

      // Region and district IDs must be identical
      expect(first.regions.map((r) => r.id).sort()).toEqual(second.regions.map((r) => r.id).sort());
      expect(first.districts.map((d) => d.id).sort()).toEqual(
        second.districts.map((d) => d.id).sort(),
      );
    });

    it('should preserve IDs when files are renamed between snapshots', async () => {
      // --- First snapshot: two files ---
      mockExistsSync.mockReturnValue(true);
      mockGitCall('false\n');
      mockGitCall('50\n');
      mockGitCall(`${Math.floor(Date.now() / 1000) - 86400 * 10}\n`);
      mockGitCall('src/controllers/old-name.ts\0src/services/svc.ts\0');
      mockGitCall('80\t0\tsrc/controllers/old-name.ts\n40\t0\tsrc/services/svc.ts\n');
      mockStat.mockResolvedValue({ mtimeMs: Date.now() } as Stats);
      mockGitCall('commit-1\n'); // rev-parse HEAD
      mockEmptyChurn();

      const first = await service.getSnapshot('/test/rename', 'test-project');

      const firstCtrlDistrict = first.districts.find((d) => d.name === 'controllers')!;
      const firstSvcDistrict = first.districts.find((d) => d.name === 'services')!;

      // --- Second snapshot: file renamed ---
      jest.resetAllMocks();
      mockExistsSync.mockReturnValue(true);
      mockGitCall('false\n');
      mockGitCall('51\n');
      mockGitCall(`${Math.floor(Date.now() / 1000) - 86400 * 10}\n`);
      mockGitCall('src/controllers/new-name.ts\0src/services/svc.ts\0');
      mockGitCall('80\t0\tsrc/controllers/new-name.ts\n40\t0\tsrc/services/svc.ts\n');
      mockStat.mockResolvedValue({ mtimeMs: Date.now() } as Stats);
      mockGitCall('commit-2\n'); // rev-parse HEAD
      // detectGitRenames: reports the rename
      mockGitCall('R100\tsrc/controllers/old-name.ts\tsrc/controllers/new-name.ts\n');
      mockEmptyChurn();

      const second = await service.getSnapshot('/test/rename', 'test-project');

      const secondCtrlDistrict = second.districts.find((d) => d.name === 'controllers')!;
      const secondSvcDistrict = second.districts.find((d) => d.name === 'services')!;

      // District IDs preserved (file renamed within same district → membership overlap still strong)
      expect(secondCtrlDistrict.id).toBe(firstCtrlDistrict.id);
      expect(secondSvcDistrict.id).toBe(firstSvcDistrict.id);
    });

    it('should handle file addition and deletion between snapshots', async () => {
      // --- First snapshot ---
      mockExistsSync.mockReturnValue(true);
      mockGitCall('false\n');
      mockGitCall('10\n');
      mockGitCall(`${Math.floor(Date.now() / 1000) - 86400 * 5}\n`);
      mockGitCall('src/a/file1.ts\0src/a/file2.ts\0');
      mockGitCall('50\t0\tsrc/a/file1.ts\n30\t0\tsrc/a/file2.ts\n');
      mockStat.mockResolvedValue({ mtimeMs: Date.now() } as Stats);
      mockGitCall('commit-a\n');
      mockEmptyChurn();

      const first = await service.getSnapshot('/test/add-del', 'test-project');
      const firstRegionId = first.regions[0].id;

      // --- Second snapshot: file2 deleted, file3 added ---
      jest.resetAllMocks();
      mockExistsSync.mockReturnValue(true);
      mockGitCall('false\n');
      mockGitCall('11\n');
      mockGitCall(`${Math.floor(Date.now() / 1000) - 86400 * 5}\n`);
      mockGitCall('src/a/file1.ts\0src/a/file3.ts\0');
      mockGitCall('50\t0\tsrc/a/file1.ts\n25\t0\tsrc/a/file3.ts\n');
      mockStat.mockResolvedValue({ mtimeMs: Date.now() } as Stats);
      mockGitCall('commit-b\n');
      mockGitCall('\n'); // no renames
      mockEmptyChurn();

      const second = await service.getSnapshot('/test/add-del', 'test-project');

      // Region ID preserved (same region name)
      expect(second.regions[0].id).toBe(firstRegionId);
      // District ID preserved (50% overlap: file1 persists out of 2 original)
      expect(second.districts[0].id).toBe(first.districts[0].id);
    });

    it('should produce UUID IDs for non-git repository snapshots', async () => {
      mockExistsSync.mockReturnValue(false);
      mockReaddir.mockResolvedValue([
        { name: 'app.ts', isFile: () => true, isDirectory: () => false },
      ] as never);
      mockStat.mockResolvedValue({ mtimeMs: Date.now() } as Stats);

      const snapshot = await service.getSnapshot('/test/no-git', 'test-project');

      // Even non-git repos get UUID IDs
      for (const region of snapshot.regions) {
        expect(region.id).toMatch(/^[0-9a-f-]{36}$/);
      }
      for (const district of snapshot.districts) {
        expect(district.id).toMatch(/^[0-9a-f-]{36}$/);
        expect(district.regionId).toMatch(/^[0-9a-f-]{36}$/);
      }
    });

    it('should link district regionId to the correct parent region', async () => {
      mockExistsSync.mockReturnValue(true);
      mockGitCall('false\n');
      mockGitCall('20\n');
      mockGitCall(`${Math.floor(Date.now() / 1000) - 86400 * 30}\n`);
      mockGitCall('apps/web/index.ts\0packages/core/lib.ts\0');
      mockGitCall('100\t0\tapps/web/index.ts\n50\t0\tpackages/core/lib.ts\n');
      mockStat.mockResolvedValue({ mtimeMs: Date.now() } as Stats);
      mockGitCall('sha-xref\n');
      mockEmptyChurn();

      const snapshot = await service.getSnapshot('/test/xref', 'test-project');

      // Build a region ID lookup
      const regionIdByName = new Map(snapshot.regions.map((r) => [r.name, r.id]));

      for (const district of snapshot.districts) {
        // District's regionId must match an actual region in the snapshot
        const matchingRegion = snapshot.regions.find((r) => r.id === district.regionId);
        expect(matchingRegion).toBeDefined();

        // District path prefix should match region name
        const expectedRegionName = district.path === '.' ? '(root)' : district.path.split('/')[0];
        expect(regionIdByName.get(expectedRegionName)).toBe(district.regionId);
      }
    });

    it('should compute correct totals in metrics', async () => {
      mockExistsSync.mockReturnValue(true);

      mockGitCall('false\n');
      mockGitCall('20\n');
      mockGitCall(`${Math.floor(Date.now() / 1000) - 86400 * 60}\n`);
      mockGitCall('apps/a/x.ts\0apps/b/y.ts\0packages/c/z.ts\0');
      mockGitCall('10\t0\tapps/a/x.ts\n20\t0\tapps/b/y.ts\n30\t0\tpackages/c/z.ts\n');

      mockStat.mockResolvedValue({ mtimeMs: Date.now() } as Stats);

      // rev-parse HEAD
      mockGitCall('sha-totals\n');
      mockEmptyChurn();

      const snapshot = await service.getSnapshot('/test/project', 'test-project');

      expect(snapshot.metrics.totalFiles).toBe(3);
      expect(snapshot.metrics.totalRegions).toBe(2);
      expect(snapshot.metrics.totalDistricts).toBe(3);
      expect(snapshot.metrics.gitHistoryDaysAvailable).toBeGreaterThanOrEqual(59);
    });

    it('should flow churn data into hotspot rankings', async () => {
      mockExistsSync.mockReturnValue(true);

      mockGitCall('false\n');
      mockGitCall('100\n');
      mockGitCall(`${Math.floor(Date.now() / 1000) - 86400 * 30}\n`);
      mockGitCall('src/hot/a.ts\0src/hot/b.ts\0src/cold/c.ts\0');
      mockGitCall('100\t0\tsrc/hot/a.ts\n200\t0\tsrc/hot/b.ts\n50\t0\tsrc/cold/c.ts\n');
      mockStat.mockResolvedValue({ mtimeMs: Date.now() } as Stats);
      mockGitCall('sha-churn\n');
      // Churn maps: 1d, 7d, 30d — hot files have high churn
      mockGitCall('src/hot/a.ts\nsrc/hot/b.ts\n'); // 1d
      mockGitCall('src/hot/a.ts\nsrc/hot/a.ts\nsrc/hot/b.ts\n'); // 7d
      mockGitCall('src/hot/a.ts\nsrc/hot/a.ts\nsrc/hot/a.ts\nsrc/hot/b.ts\nsrc/hot/b.ts\n'); // 30d
      mockGitCall(''); // daily churn
      mockGitCall(''); // windowed authors 7d
      mockGitCall(''); // windowed authors 30d
      mockGitCall(''); // getFileAuthorMap

      const snapshot = await service.getSnapshot('/test/churn-flow', 'test-project');

      const churnHotspots = snapshot.hotspots.filter((h) => h.metric === 'churn');
      expect(churnHotspots.length).toBeGreaterThan(0);
      // The hot district should be ranked first for churn
      const hotDistrict = snapshot.districts.find((d) => d.name === 'hot');
      expect(hotDistrict).toBeDefined();
      expect(hotDistrict!.churn30d).toBe(5);
      expect(churnHotspots[0].targetId).toBe(hotDistrict!.id);
    });
  });

  // -------------------------------------------------------------------------
  // LOC fallback
  // -------------------------------------------------------------------------

  describe('LOC fallback', () => {
    it('should use file-read fallback when numstat returns empty', async () => {
      mockExistsSync.mockReturnValue(true);
      mockGitCall('false\n');
      mockGitCall('50\n');
      mockGitCall(`${Math.floor(Date.now() / 1000) - 86400 * 10}\n`);
      mockGitCall('src/main.ts\0src/app.ts\0');

      // numstat returns empty → triggers fallback
      mockGitCall('');

      mockStat.mockResolvedValue({ mtimeMs: Date.now(), size: 100 } as Stats);

      // Fallback reads files to count lines (no encoding → Buffer)
      // Adapter analysis also calls readFile (with utf-8 → string)
      mockReadFile.mockImplementation(async (path: unknown, encoding?: unknown) => {
        const p = path as string;
        const content = p.endsWith('main.ts')
          ? 'line1\nline2\nline3\n'
          : p.endsWith('app.ts')
            ? 'hello\nworld\n'
            : '';
        return encoding ? content : Buffer.from(content);
      });

      mockGitCall('abc123\n');
      mockEmptyChurn();

      const snapshot = await service.getSnapshot('/test/fallback', 'test-project');

      // LOC should be populated from fallback
      expect(snapshot.metrics.totalFiles).toBe(2);
      const mainDistrict = snapshot.districts.find((d) =>
        snapshot.districts.length === 1 ? true : d.name === 'src' || d.name === '(root)',
      );
      expect(mainDistrict).toBeDefined();
      expect(mainDistrict!.totalLOC).toBeGreaterThan(0);

      // loc_unavailable warning should be emitted with data payload
      const locWarning = snapshot.metrics.warnings.find((w) => w.code === 'loc_unavailable');
      expect(locWarning).toBeDefined();
      expect(locWarning!.data).toBeDefined();
      expect(locWarning!.data!.counted).toBe(2);
      expect(locWarning!.data!.skipped).toBe(0);
      expect(locWarning!.data!.eligible).toBe(2);
    });

    it('should NOT emit loc_unavailable when numstat succeeds', async () => {
      mockExistsSync.mockReturnValue(true);
      mockGitCall('false\n');
      mockGitCall('50\n');
      mockGitCall(`${Math.floor(Date.now() / 1000) - 86400 * 10}\n`);
      mockGitCall('src/main.ts\0');
      mockGitCall('100\t0\tsrc/main.ts\n');
      mockStat.mockResolvedValue({ mtimeMs: Date.now() } as Stats);
      mockGitCall('abc123\n');
      mockEmptyChurn();

      const snapshot = await service.getSnapshot('/test/numstat-ok', 'test-project');

      const locWarning = snapshot.metrics.warnings.find((w) => w.code === 'loc_unavailable');
      expect(locWarning).toBeUndefined();
    });

    it('should skip binary and oversized files in fallback telemetry', async () => {
      mockExistsSync.mockReturnValue(true);
      mockGitCall('false\n');
      mockGitCall('50\n');
      mockGitCall(`${Math.floor(Date.now() / 1000) - 86400 * 10}\n`);
      mockGitCall('src/code.ts\0src/image.png\0src/huge.ts\0');

      // numstat empty → triggers fallback
      mockGitCall('');

      // stat: image.png normal size, huge.ts oversized (>256KB)
      mockStat.mockImplementation(async (path: unknown) => {
        const p = path as string;
        if (p.endsWith('huge.ts')) return { mtimeMs: Date.now(), size: 300 * 1024 } as Stats;
        return { mtimeMs: Date.now(), size: 100 } as Stats;
      });

      mockReadFile.mockImplementation(async (path: unknown, encoding?: unknown) => {
        const p = path as string;
        if (p.endsWith('image.png')) {
          const buf = Buffer.alloc(20);
          buf[0] = 0x89;
          buf[1] = 0x00; // null byte → binary detection
          return encoding ? '' : buf;
        }
        if (p.endsWith('code.ts')) {
          const content = 'const x = 1;\n';
          return encoding ? content : Buffer.from(content);
        }
        return encoding ? '' : Buffer.from('');
      });

      mockGitCall('abc123\n');
      mockEmptyChurn();

      const snapshot = await service.getSnapshot('/test/fallback-skip', 'test-project');

      const locWarning = snapshot.metrics.warnings.find((w) => w.code === 'loc_unavailable');
      expect(locWarning).toBeDefined();
      expect(locWarning!.data!.eligible).toBe(3);
      expect(locWarning!.data!.counted).toBe(1); // only code.ts
      expect(locWarning!.data!.skipped).toBe(2); // image.png (binary) + huge.ts (oversized)
    });
  });

  // -------------------------------------------------------------------------
  // Evidence queries (integration)
  // -------------------------------------------------------------------------

  describe('evidence queries', () => {
    async function setupSnapshotWithFiles() {
      mockExistsSync.mockReturnValue(true);
      mockGitCall('false\n');
      mockGitCall('50\n');
      mockGitCall(`${Math.floor(Date.now() / 1000) - 86400 * 30}\n`);
      mockGitCall('src/controllers/user.ts\0src/controllers/user.test.ts\0src/services/auth.ts\0');
      mockGitCall(
        '100\t0\tsrc/controllers/user.ts\n50\t0\tsrc/controllers/user.test.ts\n200\t0\tsrc/services/auth.ts\n',
      );
      mockStat.mockResolvedValue({ mtimeMs: Date.now() } as Stats);
      mockGitCall('sha-ev\n');
      mockEmptyChurn();

      return service.getSnapshot('/test/evidence', 'test-project');
    }

    it('should return null for getTargetDetails before any snapshot', async () => {
      const result = await service.getTargetDetails('/test/no-snapshot', 'fake-id');
      expect(result).toBeNull();
    });

    it('should return null for getTargetDetails with non-existent targetId', async () => {
      await setupSnapshotWithFiles();
      const result = await service.getTargetDetails('/test/evidence', 'non-existent-id');
      expect(result).toBeNull();
    });

    it('should return TargetDetail with summary and rankings after snapshot', async () => {
      const snapshot = await setupSnapshotWithFiles();
      const district = snapshot.districts[0];

      // Mock git calls for recentCommits and topAuthors
      mockGitCall('abc123\nfix user login\n1700000000\n'); // recentCommits
      mockGitCall('     5\tAlice\n     3\tBob\n'); // topAuthors

      const detail = await service.getTargetDetails('/test/evidence', district.id);

      expect(detail).not.toBeNull();
      expect(detail!.targetId).toBe(district.id);
      expect(detail!.kind).toBe('district');
      expect(detail!.summary).toContain(district.name);
      expect(detail!.summary).toContain('LOC');
      expect(detail!.recentCommits).toHaveLength(1);
      expect(detail!.recentCommits[0].sha).toBe('abc123');
      expect(detail!.topAuthors).toHaveLength(2);
      expect(detail!.topAuthors[0].author).toBe('Alice');
      expect(detail!.topAuthors[0].share).toBeCloseTo(0.63, 1);
    });

    it('should return DependencyPairDetail with no-data summary when no edges exist', async () => {
      const snapshot = await setupSnapshotWithFiles();
      const d1 = snapshot.districts[0];
      const d2 = snapshot.districts[1];

      const detail = service.getDependencyPairDetails('/test/evidence', d1.id, d2.id);

      expect(detail).not.toBeNull();
      expect(detail!.weight).toBe(0);
      expect(detail!.summary).toContain('No dependency data');
      expect(detail!.exemplarFileEdges).toEqual([]);
    });

    it('should return null for getDependencyPairDetails before any snapshot', () => {
      const result = service.getDependencyPairDetails('/test/no-snap', 'a', 'b');
      expect(result).toBeNull();
    });

    it('should return null for getDependencyPairDetails with invalid district IDs', async () => {
      await setupSnapshotWithFiles();
      const result = service.getDependencyPairDetails('/test/evidence', 'fake-a', 'fake-b');
      expect(result).toBeNull();
    });

    it('should return DistrictFilePage with correct StructureNodes', async () => {
      const snapshot = await setupSnapshotWithFiles();
      const district = snapshot.districts.find((d) => d.name === 'controllers');
      expect(district).toBeDefined();

      const page = service.listDistrictFiles('/test/evidence', district!.id);

      expect(page).not.toBeNull();
      expect(page!.districtId).toBe(district!.id);
      expect(page!.items.length).toBeGreaterThan(0);

      // Verify StructureNode properties
      const userFile = page!.items.find((n) => n.path === 'src/controllers/user.ts');
      expect(userFile).toBeDefined();
      expect(userFile!.role).toBe('controller');
      expect(userFile!.loc).toBe(100);
      expect(userFile!.metrics.hasColocatedTest).toBe(true);

      const testFile = page!.items.find((n) => n.path === 'src/controllers/user.test.ts');
      expect(testFile).toBeDefined();
      expect(testFile!.role).toBe('test');
      expect(testFile!.metrics.hasColocatedTest).toBe(false);
    });

    it('should return null for listDistrictFiles before any snapshot', () => {
      const result = service.listDistrictFiles('/test/no-snap', 'fake-id');
      expect(result).toBeNull();
    });

    it('should return null for listDistrictFiles with invalid districtId', async () => {
      await setupSnapshotWithFiles();
      const result = service.listDistrictFiles('/test/evidence', 'non-existent');
      expect(result).toBeNull();
    });

    it('should detect colocated tests within path-based split districts', async () => {
      mockExistsSync.mockReturnValue(true);
      mockGitCall('false\n');
      mockGitCall('50\n');
      mockGitCall(`${Math.floor(Date.now() / 1000) - 86400 * 30}\n`);

      // Build 42 files across two subdirectories to trigger splitting (>40 threshold).
      // Each subdirectory has both source and spec files colocated.
      const filePaths: string[] = [];
      const numstatLines: string[] = [];
      for (let i = 0; i < 21; i++) {
        const subdir = i < 11 ? 'auth' : 'users';
        const svc = `src/modules/${subdir}/svc${i}.service.ts`;
        const spec = `src/modules/${subdir}/svc${i}.service.spec.ts`;
        filePaths.push(svc, spec);
        numstatLines.push(`100\t0\t${svc}`, `50\t0\t${spec}`);
      }

      mockGitCall(filePaths.join('\0') + '\0');
      mockGitCall(numstatLines.join('\n') + '\n');
      mockStat.mockResolvedValue({ mtimeMs: Date.now() } as Stats);
      mockGitCall('sha-split\n');
      mockEmptyChurn();

      const snapshot = await service.getSnapshot('/test/split-colocated', 'test-project');

      // After path-based splitting, auth/ and users/ are separate sub-districts
      const authDistrict = snapshot.districts.find((d) => d.name.includes('auth'));
      const usersDistrict = snapshot.districts.find((d) => d.name.includes('users'));
      expect(authDistrict).toBeDefined();
      expect(usersDistrict).toBeDefined();
      expect(authDistrict!.id).not.toBe(usersDistrict!.id);

      // listDistrictFiles for the auth sub-district should detect colocated tests
      const page = service.listDistrictFiles('/test/split-colocated', authDistrict!.id);
      expect(page).not.toBeNull();

      const svc0 = page!.items.find((n) => n.path === 'src/modules/auth/svc0.service.ts');
      expect(svc0).toBeDefined();
      // Spec file is in the same sub-district → hasColocatedTest = true
      expect(svc0!.metrics.hasColocatedTest).toBe(true);
    });

    it('should produce evidence queries for non-git repos without errors', async () => {
      mockExistsSync.mockReturnValue(false);
      mockReaddir.mockResolvedValue([
        { name: 'app.ts', isFile: () => true, isDirectory: () => false },
      ] as never);
      mockStat.mockResolvedValue({ mtimeMs: Date.now() } as Stats);

      const snapshot = await service.getSnapshot('/test/no-git-evidence', 'test-project');
      const district = snapshot.districts[0];

      // No git calls needed for non-git evidence queries
      const detail = await service.getTargetDetails('/test/no-git-evidence', district.id);
      expect(detail).not.toBeNull();
      expect(detail!.recentCommits).toEqual([]);
      expect(detail!.topAuthors).toEqual([]);
      expect(detail!.summary).toContain('LOC');
    });
  });

  // -------------------------------------------------------------------------
  // Common repo layout fixtures (regression)
  // -------------------------------------------------------------------------

  describe('common repo layout fixtures', () => {
    it('should produce correct structure for a monorepo with root-level files', async () => {
      mockExistsSync.mockReturnValue(true);
      mockGitCall('false\n');
      mockGitCall('100\n');
      mockGitCall(`${Math.floor(Date.now() / 1000) - 86400 * 30}\n`);

      // Monorepo: apps/{web,api}, packages/shared, plus root-level config
      const files = [
        'apps/web/page.tsx',
        'apps/web/layout.tsx',
        'apps/web/page.spec.tsx',
        'apps/api/user.controller.ts',
        'apps/api/auth.controller.ts',
        'apps/api/auth.controller.spec.ts',
        'packages/shared/helper.utils.ts',
        'packages/shared/format.utils.ts',
        'tsconfig.json',
        'package.json',
      ];
      const locValues = [200, 150, 100, 300, 200, 100, 50, 30, 20, 40];
      const numstat = files.map((f, i) => `${locValues[i]}\t0\t${f}`).join('\n') + '\n';

      mockGitCall(files.join('\0') + '\0');
      mockGitCall(numstat);
      mockStat.mockResolvedValue({ mtimeMs: Date.now() } as Stats);
      mockGitCall('sha-monorepo\n');
      mockEmptyChurn();

      const snapshot = await service.getSnapshot('/test/monorepo', 'test-project');

      // --- Region verification ---
      const regionNames = snapshot.regions.map((r) => r.name).sort();
      expect(regionNames).toEqual(['(root)', 'apps', 'packages']);

      // --- District verification ---
      // No filename-based pseudo-districts (tsconfig.json, package.json)
      expect(snapshot.districts.find((d) => d.name === 'tsconfig.json')).toBeUndefined();
      expect(snapshot.districts.find((d) => d.name === 'package.json')).toBeUndefined();

      // Root-level files grouped into a (root) region/district
      const rootRegion = snapshot.regions.find((r) => r.name === '(root)');
      expect(rootRegion).toBeDefined();
      expect(rootRegion!.totalFiles).toBe(2);

      // Districts under apps: web, api
      const appsRegion = snapshot.regions.find((r) => r.name === 'apps')!;
      const appsDistricts = snapshot.districts.filter((d) => d.regionId === appsRegion.id);
      expect(appsDistricts.map((d) => d.name).sort()).toEqual(['api', 'web']);

      // --- Role verification (corrected denominator) ---
      const webDistrict = appsDistricts.find((d) => d.name === 'web')!;
      // web: page.tsx (view), layout.tsx (view), page.spec.tsx (test)
      // Known roles: view(2), test(1). 2/3 = 66.7% > 50% → view
      expect(webDistrict.role).toBe('view');

      const apiDistrict = appsDistricts.find((d) => d.name === 'api')!;
      // api: user.controller.ts (controller), auth.controller.ts (controller),
      //      auth.controller.spec.ts (test)
      // Known roles: controller(2), test(1). 2/3 = 66.7% > 50% → controller
      expect(apiDistrict.role).toBe('controller');

      // packages/shared: helper.utils.ts (utility), format.utils.ts (utility) → utility
      const pkgRegion = snapshot.regions.find((r) => r.name === 'packages')!;
      const sharedDistrict = snapshot.districts.find((d) => d.regionId === pkgRegion.id)!;
      expect(sharedDistrict.role).toBe('utility');

      // --- Metrics ---
      expect(snapshot.metrics.totalFiles).toBe(10);
      expect(snapshot.metrics.totalRegions).toBe(3);

      // --- Hotspot rankings target real districts, not pseudo-districts ---
      for (const h of snapshot.hotspots) {
        const targetDistrict = snapshot.districts.find((d) => d.id === h.targetId);
        expect(targetDistrict).toBeDefined();
        // No hotspot should target a filename-based district
        expect(targetDistrict!.name).not.toMatch(/\.\w+$/);
      }
    });

    it('should produce correct structure and evidence for a flat src/ project', async () => {
      mockExistsSync.mockReturnValue(true);
      mockGitCall('false\n');
      mockGitCall('80\n');
      mockGitCall(`${Math.floor(Date.now() / 1000) - 86400 * 15}\n`);

      // Flat src/ with mixed 2-segment and 3-segment paths
      const files = [
        'src/index.ts',
        'src/main.ts',
        'src/controllers/user.controller.ts',
        'src/controllers/auth.controller.ts',
        'src/controllers/user.controller.spec.ts',
        'src/services/auth.service.ts',
        'src/services/auth.service.spec.ts',
        'README.md',
      ];
      const numstatLines = [
        '10\t0\tsrc/index.ts',
        '20\t0\tsrc/main.ts',
        '150\t0\tsrc/controllers/user.controller.ts',
        '120\t0\tsrc/controllers/auth.controller.ts',
        '80\t0\tsrc/controllers/user.controller.spec.ts',
        '200\t0\tsrc/services/auth.service.ts',
        '100\t0\tsrc/services/auth.service.spec.ts',
        '15\t0\tREADME.md',
      ];

      mockGitCall(files.join('\0') + '\0');
      mockGitCall(numstatLines.join('\n') + '\n');
      mockStat.mockResolvedValue({ mtimeMs: Date.now() } as Stats);
      mockGitCall('sha-flat\n');
      mockEmptyChurn();

      const snapshot = await service.getSnapshot('/test/flat-src', 'test-project');

      // --- Region verification ---
      expect(snapshot.regions.map((r) => r.name).sort()).toEqual(['(root)', 'src']);

      // --- District verification ---
      // 2-segment files (src/index.ts, src/main.ts) → root bucket, not filename districts
      expect(snapshot.districts.find((d) => d.name === 'index.ts')).toBeUndefined();
      expect(snapshot.districts.find((d) => d.name === 'main.ts')).toBeUndefined();

      // src region should have 3 districts: (root), controllers, services
      const srcRegion = snapshot.regions.find((r) => r.name === 'src')!;
      const srcDistricts = snapshot.districts.filter((d) => d.regionId === srcRegion.id);
      expect(srcDistricts.map((d) => d.name).sort()).toEqual(['(root)', 'controllers', 'services']);

      // Root bucket has correct path and file count
      const srcRoot = srcDistricts.find((d) => d.name === '(root)')!;
      expect(srcRoot.totalFiles).toBe(2);
      expect(srcRoot.totalLOC).toBe(30);
      expect(srcRoot.path).toBe('src');

      // --- Role verification (corrected denominator) ---
      const ctrlDistrict = srcDistricts.find((d) => d.name === 'controllers')!;
      // controllers: user.controller.ts (controller), auth.controller.ts (controller),
      //              user.controller.spec.ts (test)
      // Known roles: controller(2), test(1). 2/3 > 50% → controller
      expect(ctrlDistrict.role).toBe('controller');

      // --- Evidence: colocated test detection ---
      const ctrlPage = service.listDistrictFiles('/test/flat-src', ctrlDistrict.id);
      expect(ctrlPage).not.toBeNull();

      const userCtrl = ctrlPage!.items.find((n) => n.path === 'src/controllers/user.controller.ts');
      expect(userCtrl).toBeDefined();
      expect(userCtrl!.role).toBe('controller');
      // user.controller.spec.ts exists → hasColocatedTest = true
      expect(userCtrl!.metrics.hasColocatedTest).toBe(true);

      const authCtrl = ctrlPage!.items.find((n) => n.path === 'src/controllers/auth.controller.ts');
      expect(authCtrl).toBeDefined();
      // No auth.controller.spec.ts in the project → hasColocatedTest = false
      expect(authCtrl!.metrics.hasColocatedTest).toBe(false);

      const userSpec = ctrlPage!.items.find(
        (n) => n.path === 'src/controllers/user.controller.spec.ts',
      );
      expect(userSpec).toBeDefined();
      expect(userSpec!.role).toBe('test');
      // Test files always report hasColocatedTest = false
      expect(userSpec!.metrics.hasColocatedTest).toBe(false);

      // --- Evidence: target detail summary includes corrected role ---
      mockGitCall('sha1\nfix login\n1700000000\n');
      mockGitCall('     3\tAlice\n');
      const detail = await service.getTargetDetails('/test/flat-src', ctrlDistrict.id);
      expect(detail).not.toBeNull();
      // Summary reflects corrected dominant role, not "mixed"
      expect(detail!.summary).toContain('controller district');

      // --- Metrics ---
      expect(snapshot.metrics.totalFiles).toBe(8);
    });
  });

  // -------------------------------------------------------------------------
  // Language adapter integration
  // -------------------------------------------------------------------------

  describe('language adapter integration', () => {
    it('should extract cross-district dependency edges from TS imports', async () => {
      mockExistsSync.mockReturnValue(true);
      mockGitCall('false\n');
      mockGitCall('50\n');
      mockGitCall(`${Math.floor(Date.now() / 1000) - 86400 * 30}\n`);
      mockGitCall(
        'src/controllers/user.controller.ts\0src/services/user.service.ts\0src/services/auth.service.ts\0',
      );
      mockGitCall(
        '100\t0\tsrc/controllers/user.controller.ts\n200\t0\tsrc/services/user.service.ts\n150\t0\tsrc/services/auth.service.ts\n',
      );
      mockStat.mockResolvedValue({ mtimeMs: Date.now(), size: 100 } as Stats);
      mockGitCall('sha-adapter\n');
      mockEmptyChurn();

      // Provide file contents with cross-district imports
      const fileContents = new Map<string, string>([
        [
          '/test/adapter-imports/src/controllers/user.controller.ts',
          `import { UserService } from '../services/user.service';\nimport { AuthService } from '../services/auth.service';\n@Controller('/users')\nexport class UserController {}`,
        ],
        [
          '/test/adapter-imports/src/services/user.service.ts',
          `@Injectable()\nexport class UserService {}\nexport function createUser() {}`,
        ],
        [
          '/test/adapter-imports/src/services/auth.service.ts',
          `import { UserService } from './user.service';\n@Injectable()\nexport class AuthService {}`,
        ],
      ]);
      mockReadFile.mockImplementation(async (path: unknown) => {
        return fileContents.get(path as string) ?? '';
      });

      const snapshot = await service.getSnapshot('/test/adapter-imports', 'test-project');

      // Cross-district dependencies should be populated
      expect(snapshot.dependencies.length).toBeGreaterThan(0);

      // controllers → services edge should exist
      const ctrlDistrict = snapshot.districts.find((d) => d.name === 'controllers')!;
      const svcDistrict = snapshot.districts.find((d) => d.name === 'services')!;
      const edge = snapshot.dependencies.find(
        (e) => e.fromDistrictId === ctrlDistrict.id && e.toDistrictId === svcDistrict.id,
      );
      expect(edge).toBeDefined();
      expect(edge!.weight).toBeGreaterThanOrEqual(2); // two imports from controller → services

      // Coupling scores should be enriched
      expect(ctrlDistrict.outboundWeight).toBeGreaterThan(0);
      expect(svcDistrict.inboundWeight).toBeGreaterThan(0);

      // Coupling hotspots should now populate (rankHotspots runs after enrichment)
      const couplingHotspots = snapshot.hotspots.filter((h) => h.metric === 'coupling');
      expect(couplingHotspots.length).toBeGreaterThan(0);

      // missing_dependency_data warning should NOT be emitted
      const depWarning = snapshot.metrics.warnings.find(
        (w) => w.code === 'missing_dependency_data',
      );
      expect(depWarning).toBeUndefined();
    });

    it('should populate symbolCount and adapter role in district file pages', async () => {
      mockExistsSync.mockReturnValue(true);
      mockGitCall('false\n');
      mockGitCall('50\n');
      mockGitCall(`${Math.floor(Date.now() / 1000) - 86400 * 30}\n`);
      mockGitCall('src/services/user.service.ts\0src/services/user.service.spec.ts\0');
      mockGitCall(
        '200\t0\tsrc/services/user.service.ts\n100\t0\tsrc/services/user.service.spec.ts\n',
      );
      mockStat.mockResolvedValue({ mtimeMs: Date.now(), size: 100 } as Stats);
      mockGitCall('sha-sym\n');
      mockEmptyChurn();

      const fileContents = new Map<string, string>([
        [
          '/test/adapter-symbols/src/services/user.service.ts',
          `@Injectable()\nexport class UserService {}\nexport function createUser() {}\nexport const USER_TOKEN = 'user';`,
        ],
        [
          '/test/adapter-symbols/src/services/user.service.spec.ts',
          `import { UserService } from './user.service';\ndescribe('UserService', () => { it('works', () => { expect(true).toBe(true); }); });`,
        ],
      ]);
      mockReadFile.mockImplementation(async (path: unknown) => {
        return fileContents.get(path as string) ?? '';
      });

      const snapshot = await service.getSnapshot('/test/adapter-symbols', 'test-project');
      const district = snapshot.districts.find((d) => d.name === 'services')!;
      const page = service.listDistrictFiles('/test/adapter-symbols', district.id);

      expect(page).not.toBeNull();

      const svcFile = page!.items.find((n) => n.path === 'src/services/user.service.ts');
      expect(svcFile).toBeDefined();
      // Adapter detects @Injectable → service role
      expect(svcFile!.role).toBe('service');
      // Adapter counted 3 exported symbols
      expect(svcFile!.metrics.symbolCount).toBe(3);

      const specFile = page!.items.find((n) => n.path === 'src/services/user.service.spec.ts');
      expect(specFile).toBeDefined();
      // Adapter detects describe/it/expect → test role
      expect(specFile!.role).toBe('test');
    });

    it('should populate complexityAvg and testCoverageRate on districts', async () => {
      mockExistsSync.mockReturnValue(true);
      mockGitCall('false\n');
      mockGitCall('50\n');
      mockGitCall(`${Math.floor(Date.now() / 1000) - 86400 * 30}\n`);
      mockGitCall('src/services/user.service.ts\0src/services/user.service.spec.ts\0');
      mockGitCall(
        '200\t0\tsrc/services/user.service.ts\n100\t0\tsrc/services/user.service.spec.ts\n',
      );
      mockStat.mockResolvedValue({ mtimeMs: Date.now(), size: 100 } as Stats);
      mockGitCall('sha-complexity\n');
      mockEmptyChurn();

      const fileContents = new Map<string, string>([
        [
          '/test/complexity/src/services/user.service.ts',
          `@Injectable()\nexport class UserService {\n  findUser(id: string) {\n    if (id) { return this.db.find(id); }\n    throw new Error('missing id');\n  }\n}`,
        ],
        [
          '/test/complexity/src/services/user.service.spec.ts',
          `describe('UserService', () => { it('works', () => { expect(true).toBe(true); }); });`,
        ],
      ]);
      mockReadFile.mockImplementation(async (path: unknown) => {
        return fileContents.get(path as string) ?? '';
      });

      const snapshot = await service.getSnapshot('/test/complexity', 'test-project');
      const district = snapshot.districts.find((d) => d.name === 'services')!;

      // complexityAvg should be populated (adapter computed complexity for the TS files)
      expect(district.complexityAvg).not.toBeNull();
      expect(district.complexityAvg).toBeGreaterThanOrEqual(1);

      // testCoverageRate: 1 source file (user.service.ts) has a test pair → 100%
      expect(district.testCoverageRate).not.toBeNull();
      expect(district.testCoverageRate).toBe(1);

      // Complexity hotspots should populate (rankHotspots now runs after adapter enrichment)
      const complexityHotspots = snapshot.hotspots.filter((h) => h.metric === 'complexity');
      expect(complexityHotspots.length).toBeGreaterThan(0);
    });

    it('should populate ownershipConcentration from git author data', async () => {
      mockExistsSync.mockReturnValue(true);
      mockGitCall('false\n');
      mockGitCall('50\n');
      mockGitCall(`${Math.floor(Date.now() / 1000) - 86400 * 30}\n`);
      mockGitCall('src/core/engine.ts\0src/core/utils.ts\0');
      mockGitCall('300\t0\tsrc/core/engine.ts\n100\t0\tsrc/core/utils.ts\n');
      mockStat.mockResolvedValue({ mtimeMs: Date.now(), size: 50 } as Stats);
      mockGitCall('sha-ownership\n');

      // Churn maps: 1d, 7d, 30d
      mockGitCall(''); // 1d
      mockGitCall(''); // 7d
      mockGitCall(''); // 30d
      mockGitCall(''); // daily churn
      mockGitCall(''); // windowed authors 7d
      mockGitCall(''); // windowed authors 30d

      // getFileAuthorMap: real git log format (blank line between author and files)
      mockGitCall(
        'Alice\n\nsrc/core/engine.ts\nsrc/core/engine.ts\nsrc/core/engine.ts\n\nAlice\n\nsrc/core/utils.ts\n',
      );

      const snapshot = await service.getSnapshot('/test/ownership', 'test-project');
      const district = snapshot.districts.find((d) => d.name === 'core')!;

      // Single author → HHI = 1.0
      expect(district.ownershipConcentration).not.toBeNull();
      expect(district.ownershipConcentration).toBeCloseTo(1.0, 1);
    });

    it('should set ownershipConcentration to null for non-git repos', async () => {
      mockExistsSync.mockReturnValue(false);
      mockReaddir.mockResolvedValue([
        { name: 'app.ts', isFile: () => true, isDirectory: () => false },
      ] as never);
      mockStat.mockResolvedValue({ mtimeMs: Date.now() } as Stats);

      const snapshot = await service.getSnapshot('/test/no-git-ownership', 'test-project');

      for (const district of snapshot.districts) {
        expect(district.ownershipConcentration).toBeNull();
      }
    });

    it('should set blastRadius on districts with cross-district imports', async () => {
      mockExistsSync.mockReturnValue(true);
      mockGitCall('false\n');
      mockGitCall('50\n');
      mockGitCall(`${Math.floor(Date.now() / 1000) - 86400 * 30}\n`);
      mockGitCall(
        'src/controllers/user.controller.ts\0src/services/user.service.ts\0src/services/auth.service.ts\0',
      );
      mockGitCall(
        '100\t0\tsrc/controllers/user.controller.ts\n200\t0\tsrc/services/user.service.ts\n150\t0\tsrc/services/auth.service.ts\n',
      );
      mockStat.mockResolvedValue({ mtimeMs: Date.now(), size: 100 } as Stats);
      mockGitCall('sha-blast\n');
      mockEmptyChurn();

      const fileContents = new Map<string, string>([
        [
          '/test/blast/src/controllers/user.controller.ts',
          `import { UserService } from '../services/user.service';\nexport class UserController {}`,
        ],
        ['/test/blast/src/services/user.service.ts', `export class UserService {}`],
        ['/test/blast/src/services/auth.service.ts', `export class AuthService {}`],
      ]);
      mockReadFile.mockImplementation(async (path: unknown) => {
        return fileContents.get(path as string) ?? '';
      });

      const snapshot = await service.getSnapshot('/test/blast', 'test-project');

      const svcDistrict = snapshot.districts.find((d) => d.name === 'services')!;
      // controllers imports services → services.blastRadius >= 1
      expect(svcDistrict.blastRadius).toBeGreaterThanOrEqual(1);
    });

    it('should include blastRadius in getTargetDetails for districts with dependents', async () => {
      mockExistsSync.mockReturnValue(true);
      mockGitCall('false\n');
      mockGitCall('50\n');
      mockGitCall(`${Math.floor(Date.now() / 1000) - 86400 * 30}\n`);
      mockGitCall('src/controllers/api.ts\0src/services/core.ts\0');
      mockGitCall('100\t0\tsrc/controllers/api.ts\n200\t0\tsrc/services/core.ts\n');
      mockStat.mockResolvedValue({ mtimeMs: Date.now(), size: 100 } as Stats);
      mockGitCall('sha-blast-detail\n');
      mockEmptyChurn();

      const fileContents = new Map<string, string>([
        [
          '/test/blast-detail/src/controllers/api.ts',
          `import { CoreService } from '../services/core';\nexport class ApiController {}`,
        ],
        ['/test/blast-detail/src/services/core.ts', `export class CoreService {}`],
      ]);
      mockReadFile.mockImplementation(async (path: unknown) => {
        return fileContents.get(path as string) ?? '';
      });

      const snapshot = await service.getSnapshot('/test/blast-detail', 'test-project');
      const svcDistrict = snapshot.districts.find((d) => d.name === 'services')!;

      // getTargetDetails for services district
      mockGitCall('sha1\nfix\n1700000000\n'); // recentCommits
      mockGitCall('     1\tAlice\n'); // topAuthors
      const detail = await service.getTargetDetails('/test/blast-detail', svcDistrict.id);

      expect(detail).not.toBeNull();
      expect(detail!.blastRadius).toBeDefined();
      expect(detail!.blastRadius!.length).toBeGreaterThanOrEqual(1);
      expect(detail!.summary).toContain('Blast radius affects');
    });

    it('should fall back gracefully when file reads fail', async () => {
      mockExistsSync.mockReturnValue(true);
      mockGitCall('false\n');
      mockGitCall('50\n');
      mockGitCall(`${Math.floor(Date.now() / 1000) - 86400 * 30}\n`);
      mockGitCall('src/main.ts\0');
      mockGitCall('100\t0\tsrc/main.ts\n');
      mockStat.mockResolvedValue({ mtimeMs: Date.now(), size: 100 } as Stats);
      mockGitCall('sha-fail\n');
      mockEmptyChurn();

      // readFile fails
      mockReadFile.mockRejectedValue(new Error('ENOENT'));

      const snapshot = await service.getSnapshot('/test/adapter-fail', 'test-project');

      // Snapshot should still be produced
      expect(snapshot.metrics.totalFiles).toBe(1);
      // Dependencies empty (no adapter data)
      expect(snapshot.dependencies).toEqual([]);
      // Warning emitted
      const depWarning = snapshot.metrics.warnings.find(
        (w) => w.code === 'missing_dependency_data',
      );
      expect(depWarning).toBeDefined();
    });

    it('should produce cross-district dependency edges from Python imports', async () => {
      mockExistsSync.mockReturnValue(true);
      mockGitCall('false\n');
      mockGitCall('50\n');
      mockGitCall(`${Math.floor(Date.now() / 1000) - 86400 * 30}\n`);
      mockGitCall(
        'src/api/views.py\0src/api/__init__.py\0src/models/user.py\0src/models/__init__.py\0',
      );
      mockGitCall(
        '80\t0\tsrc/api/views.py\n5\t0\tsrc/api/__init__.py\n60\t0\tsrc/models/user.py\n5\t0\tsrc/models/__init__.py\n',
      );
      mockStat.mockResolvedValue({ mtimeMs: Date.now(), size: 100 } as Stats);
      mockGitCall('sha-python-dep\n');
      mockEmptyChurn();

      const fileContents = new Map<string, string>([
        [
          '/test/py-deps/src/api/views.py',
          `from src.models.user import User\n\ndef get_users():\n    return User.objects.all()\n`,
        ],
        ['/test/py-deps/src/api/__init__.py', ''],
        ['/test/py-deps/src/models/user.py', `class User:\n    name: str\n`],
        ['/test/py-deps/src/models/__init__.py', ''],
      ]);
      mockReadFile.mockImplementation(async (path: unknown) => {
        return fileContents.get(path as string) ?? '';
      });

      const snapshot = await service.getSnapshot('/test/py-deps', 'test-project');

      // Python imports should produce cross-district dependency edges
      expect(snapshot.dependencies.length).toBeGreaterThanOrEqual(1);
      const apiDistrict = snapshot.districts.find((d) => d.name === 'api');
      const modelsDistrict = snapshot.districts.find((d) => d.name === 'models');
      expect(apiDistrict).toBeDefined();
      expect(modelsDistrict).toBeDefined();

      // api → models edge should exist
      const edge = snapshot.dependencies.find(
        (e) => e.fromDistrictId === apiDistrict!.id && e.toDistrictId === modelsDistrict!.id,
      );
      expect(edge).toBeDefined();
      expect(edge!.weight).toBeGreaterThanOrEqual(1);

      // models should have blast radius >= 1 (api depends on it)
      expect(modelsDistrict!.blastRadius).toBeGreaterThanOrEqual(1);
    });

    it('should produce blast radius from Python relative imports across districts', async () => {
      mockExistsSync.mockReturnValue(true);
      mockGitCall('false\n');
      mockGitCall('50\n');
      mockGitCall(`${Math.floor(Date.now() / 1000) - 86400 * 30}\n`);
      mockGitCall('src/handlers/main.py\0src/utils/helpers.py\0');
      mockGitCall('100\t0\tsrc/handlers/main.py\n50\t0\tsrc/utils/helpers.py\n');
      mockStat.mockResolvedValue({ mtimeMs: Date.now(), size: 100 } as Stats);
      mockGitCall('sha-py-relative\n');
      mockEmptyChurn();

      const fileContents = new Map<string, string>([
        [
          '/test/py-rel/src/handlers/main.py',
          `from ..utils.helpers import do_stuff\n\ndef handle():\n    do_stuff()\n`,
        ],
        ['/test/py-rel/src/utils/helpers.py', `def do_stuff():\n    pass\n`],
      ]);
      mockReadFile.mockImplementation(async (path: unknown) => {
        return fileContents.get(path as string) ?? '';
      });

      const snapshot = await service.getSnapshot('/test/py-rel', 'test-project');

      // Relative Python imports should produce dependency edges
      expect(snapshot.dependencies.length).toBeGreaterThanOrEqual(1);

      const utilsDistrict = snapshot.districts.find((d) => d.name === 'utils');
      expect(utilsDistrict).toBeDefined();
      expect(utilsDistrict!.blastRadius).toBeGreaterThanOrEqual(1);
    });

    it('should produce cross-district dependency edges from PHP imports', async () => {
      mockExistsSync.mockReturnValue(true);
      mockGitCall('false\n');
      mockGitCall('50\n');
      mockGitCall(`${Math.floor(Date.now() / 1000) - 86400 * 30}\n`);
      mockGitCall('src/controllers/UserController.php\0src/models/User.php\0');
      mockGitCall('80\t0\tsrc/controllers/UserController.php\n60\t0\tsrc/models/User.php\n');
      mockStat.mockResolvedValue({ mtimeMs: Date.now(), size: 100 } as Stats);
      mockGitCall('sha-php-dep\n');
      mockEmptyChurn();

      const fileContents = new Map<string, string>([
        [
          '/test/php-deps/src/controllers/UserController.php',
          `<?php\nrequire_once '../models/User.php';\nclass UserController extends Controller {}\n`,
        ],
        ['/test/php-deps/src/models/User.php', `<?php\nclass User extends Model {}\n`],
      ]);
      mockReadFile.mockImplementation(async (path: unknown) => {
        return fileContents.get(path as string) ?? '';
      });

      const snapshot = await service.getSnapshot('/test/php-deps', 'test-project');

      // PHP require_once should produce cross-district dependency edges
      expect(snapshot.dependencies.length).toBeGreaterThanOrEqual(1);
      const controllersDistrict = snapshot.districts.find((d) => d.name === 'controllers');
      const modelsDistrict = snapshot.districts.find((d) => d.name === 'models');
      expect(controllersDistrict).toBeDefined();
      expect(modelsDistrict).toBeDefined();

      // controllers → models edge should exist
      const edge = snapshot.dependencies.find(
        (e) =>
          e.fromDistrictId === controllersDistrict!.id && e.toDistrictId === modelsDistrict!.id,
      );
      expect(edge).toBeDefined();
      expect(edge!.weight).toBeGreaterThanOrEqual(1);

      // models should have blast radius >= 1 (controllers depends on it)
      expect(modelsDistrict!.blastRadius).toBeGreaterThanOrEqual(1);
    });

    it('should deduplicate file edges when two specifiers from one importer resolve to the same target', async () => {
      mockExistsSync.mockReturnValue(true);
      mockGitCall('false\n');
      mockGitCall('50\n');
      mockGitCall(`${Math.floor(Date.now() / 1000) - 86400 * 30}\n`);
      mockGitCall('src/api/client.ts\0src/utils/helpers.ts\0');
      mockGitCall('80\t0\tsrc/api/client.ts\n40\t0\tsrc/utils/helpers.ts\n');
      mockStat.mockResolvedValue({ mtimeMs: Date.now(), size: 100 } as Stats);
      mockGitCall('sha-dedup\n');
      mockEmptyChurn();

      // client.ts imports the same resolved file via two different specifiers:
      // '../utils/helpers' and '../utils/helpers.ts' both resolve to src/utils/helpers.ts
      const fileContents = new Map<string, string>([
        [
          '/test/dedup/src/api/client.ts',
          `import { foo } from '../utils/helpers';\nimport { bar } from '../utils/helpers.ts';\n`,
        ],
        ['/test/dedup/src/utils/helpers.ts', `export const foo = 1;\nexport const bar = 2;\n`],
      ]);
      mockReadFile.mockImplementation(async (path: unknown) => {
        return fileContents.get(path as string) ?? '';
      });

      const snapshot = await service.getSnapshot('/test/dedup', 'test-project');

      const apiDistrict = snapshot.districts.find((d) => d.name === 'api');
      const utilsDistrict = snapshot.districts.find((d) => d.name === 'utils');
      expect(apiDistrict).toBeDefined();
      expect(utilsDistrict).toBeDefined();

      // There must be exactly one api → utils edge (not two despite two specifiers)
      const edges = snapshot.dependencies.filter(
        (e) => e.fromDistrictId === apiDistrict!.id && e.toDistrictId === utilsDistrict!.id,
      );
      expect(edges).toHaveLength(1);
      expect(edges[0]!.weight).toBe(1);
    });

    it('should deduplicate Rust use specifiers resolving to the same file (end-to-end)', async () => {
      mockExistsSync.mockReturnValue(true);
      mockGitCall('false\n');
      mockGitCall('50\n');
      mockGitCall(`${Math.floor(Date.now() / 1000) - 86400 * 30}\n`);
      mockGitCall('src/handlers/gateway.rs\0src/auth/mod.rs\0');
      mockGitCall('80\t0\tsrc/handlers/gateway.rs\n50\t0\tsrc/auth/mod.rs\n');
      mockStat.mockResolvedValue({ mtimeMs: Date.now(), size: 100 } as Stats);
      mockGitCall('sha-rust-dedup\n');
      mockEmptyChurn();

      // gateway.rs uses two specifiers that both resolve to src/auth/mod.rs via crate:: suffix match:
      //   `use crate::auth;`         → crate::auth → suffix 'auth' → src/auth/mod.rs
      //   `use crate::auth::login;`  → crate::auth::login → suffix 'auth' fallback → src/auth/mod.rs
      // Analyzer dedup patch must produce ONE handlers → auth edge with weight === 1
      const fileContents = new Map<string, string>([
        [
          '/test/rust-dedup/src/handlers/gateway.rs',
          `use crate::auth;\nuse crate::auth::login;\n\npub fn handle() { auth::login(); }\n`,
        ],
        ['/test/rust-dedup/src/auth/mod.rs', `pub fn login() {}\n`],
      ]);
      mockReadFile.mockImplementation(async (path: unknown) => {
        return fileContents.get(path as string) ?? '';
      });

      const snapshot = await service.getSnapshot('/test/rust-dedup', 'test-project');

      const handlersDistrict = snapshot.districts.find((d) => d.name === 'handlers');
      const authDistrict = snapshot.districts.find((d) => d.name === 'auth');
      expect(handlersDistrict).toBeDefined();
      expect(authDistrict).toBeDefined();

      // Dedup patch: exactly ONE handlers → auth edge with weight === 1
      const edges = snapshot.dependencies.filter(
        (e) => e.fromDistrictId === handlersDistrict!.id && e.toDistrictId === authDistrict!.id,
      );
      expect(edges).toHaveLength(1);
      expect(edges[0]!.weight).toBe(1);
    });

    it('should parse multi-author ownership with real git log format', async () => {
      mockExistsSync.mockReturnValue(true);
      mockGitCall('false\n');
      mockGitCall('50\n');
      mockGitCall(`${Math.floor(Date.now() / 1000) - 86400 * 30}\n`);
      mockGitCall('src/core/engine.ts\0src/core/utils.ts\0');
      mockGitCall('300\t0\tsrc/core/engine.ts\n100\t0\tsrc/core/utils.ts\n');
      mockStat.mockResolvedValue({ mtimeMs: Date.now(), size: 50 } as Stats);
      mockGitCall('sha-multi-owner\n');

      // Churn maps: 1d, 7d, 30d
      mockGitCall(''); // 1d
      mockGitCall(''); // 7d
      mockGitCall(''); // 30d
      mockGitCall(''); // daily churn
      mockGitCall(''); // windowed authors 7d
      mockGitCall(''); // windowed authors 30d

      // Real git log --format=%aN --name-only format:
      // Each commit: author\n\nfile1\nfile2\n\n
      // Alice authored engine.ts 3 times, Bob authored it once → Alice 75%, Bob 25%
      // Alice also authored utils.ts once
      mockGitCall(
        [
          'Alice',
          '',
          'src/core/engine.ts',
          '',
          'Alice',
          '',
          'src/core/engine.ts',
          '',
          'Alice',
          '',
          'src/core/engine.ts',
          'src/core/utils.ts',
          '',
          'Bob',
          '',
          'src/core/engine.ts',
          '',
        ].join('\n'),
      );

      const snapshot = await service.getSnapshot('/test/multi-owner', 'test-project');
      const district = snapshot.districts.find((d) => d.name === 'core')!;

      // Mixed ownership → HHI < 1.0
      expect(district.ownershipConcentration).not.toBeNull();
      expect(district.ownershipConcentration!).toBeLessThan(1.0);
      // District-level aggregation: Alice = 4 commits, Bob = 1 commit, total = 5
      // HHI = (4/5)^2 + (1/5)^2 = 0.64 + 0.04 = 0.68
      expect(district.ownershipConcentration!).toBeCloseTo(0.68, 2);
    });

    it('should not misattribute first file as author in git log output', async () => {
      mockExistsSync.mockReturnValue(true);
      mockGitCall('false\n');
      mockGitCall('50\n');
      mockGitCall(`${Math.floor(Date.now() / 1000) - 86400 * 30}\n`);
      mockGitCall('src/core/main.ts\0src/core/helper.ts\0');
      mockGitCall('200\t0\tsrc/core/main.ts\n100\t0\tsrc/core/helper.ts\n');
      mockStat.mockResolvedValue({ mtimeMs: Date.now(), size: 50 } as Stats);
      mockGitCall('sha-no-misattrib\n');

      mockGitCall(''); // 1d
      mockGitCall(''); // 7d
      mockGitCall(''); // 30d
      mockGitCall(''); // daily churn
      mockGitCall(''); // windowed authors 7d
      mockGitCall(''); // windowed authors 30d

      // Real git log format with 2 commits, each with blank line separator
      // Without the fix, "src/core/main.ts" would be misinterpreted as an author
      mockGitCall(
        [
          'Alice',
          '',
          'src/core/main.ts',
          'src/core/helper.ts',
          '',
          'Bob',
          '',
          'src/core/main.ts',
          '',
        ].join('\n'),
      );

      const snapshot = await service.getSnapshot('/test/no-misattrib', 'test-project');
      const district = snapshot.districts.find((d) => d.name === 'core')!;

      expect(district.ownershipConcentration).not.toBeNull();
      // District-level aggregation: Alice = 2 commits, Bob = 1 commit, total = 3
      // HHI = (2/3)^2 + (1/3)^2 = 0.4444 + 0.1111 = 0.5556 → rounded 0.56
      expect(district.ownershipConcentration!).toBeCloseTo(0.56, 2);
    });

    it('should report null testCoverageRate and unmeasured signal for unsupported-language districts', async () => {
      mockExistsSync.mockReturnValue(true);
      mockGitCall('false\n');
      mockGitCall('50\n');
      mockGitCall(`${Math.floor(Date.now() / 1000) - 86400 * 30}\n`);
      // Swift files — no adapter supports them (unsupported language)
      mockGitCall('src/handlers/main.swift\0src/handlers/routes.swift\0');
      mockGitCall('200\t0\tsrc/handlers/main.swift\n100\t0\tsrc/handlers/routes.swift\n');
      mockStat.mockResolvedValue({ mtimeMs: Date.now(), size: 100 } as Stats);
      mockGitCall('sha-swift\n');
      mockEmptyChurn();

      const snapshot = await service.getSnapshot('/test/rs-only', 'test-project');

      const district = snapshot.districts.find((d) => d.name === 'handlers')!;
      expect(district).toBeDefined();
      expect(district.testCoverageRate).toBeNull();

      const signal = snapshot.signals.find((s) => s.districtId === district.id)!;
      expect(signal).toBeDefined();
      expect(signal.testCoverageRate).toBeNull();
      expect(signal.sourceCoverageMeasured).toBe(false);
      expect(signal.hasSourceFiles).toBe(true);

      // coverage_unmeasured warning should be emitted
      const covWarning = snapshot.metrics.warnings.find((w) => w.code === 'coverage_unmeasured');
      expect(covWarning).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // Daily churn pipeline
  // -------------------------------------------------------------------------

  describe('daily churn pipeline', () => {
    it('should parse multi-commit git log with COMMIT markers', async () => {
      mockExistsSync.mockReturnValue(true);
      mockGitCall('false\n');
      mockGitCall('50\n');
      mockGitCall(`${Math.floor(Date.now() / 1000) - 86400 * 30}\n`);
      mockGitCall('src/hot/a.ts\0src/hot/b.ts\0src/cold/c.ts\0');
      mockGitCall('100\t0\tsrc/hot/a.ts\n200\t0\tsrc/hot/b.ts\n50\t0\tsrc/cold/c.ts\n');
      mockStat.mockResolvedValue({ mtimeMs: Date.now() } as Stats);
      mockGitCall('sha-daily\n');

      // Churn maps: 1d, 7d, 30d
      mockGitCall(''); // 1d
      mockGitCall(''); // 7d
      mockGitCall(''); // 30d

      // Daily churn: 2 commits across 3 days
      mockGitCall(
        [
          'COMMIT abc123',
          '2026-04-20T10:00:00+02:00',
          'Alice',
          '',
          'src/hot/a.ts',
          'src/hot/b.ts',
          '',
          'COMMIT def456',
          '2026-04-21T14:30:00+02:00',
          'Bob',
          '',
          'src/hot/a.ts',
          'src/cold/c.ts',
          '',
        ].join('\n'),
      );

      mockGitCall(''); // windowed authors 7d
      mockGitCall(''); // windowed authors 30d
      mockGitCall(''); // getFileAuthorMap

      const snapshot = await service.getSnapshot('/test/daily-churn', 'test-project');

      const hotDistrict = snapshot.districts.find((d) => d.name === 'hot')!;
      const coldDistrict = snapshot.districts.find((d) => d.name === 'cold')!;
      expect(hotDistrict).toBeDefined();
      expect(coldDistrict).toBeDefined();

      const hotActivity = snapshot.activity.find((a) => a.targetId === hotDistrict.id)!;
      const coldActivity = snapshot.activity.find((a) => a.targetId === coldDistrict.id)!;

      // hot district: a.ts touched on 2026-04-20 and 2026-04-21, b.ts on 2026-04-20
      expect(hotActivity.dailyChurn).toBeDefined();
      expect(hotActivity.dailyChurn!['2026-04-20']).toBe(2); // a.ts + b.ts
      expect(hotActivity.dailyChurn!['2026-04-21']).toBe(1); // a.ts

      // cold district: c.ts touched on 2026-04-21
      expect(coldActivity.dailyChurn).toBeDefined();
      expect(coldActivity.dailyChurn!['2026-04-21']).toBe(1);
      expect(coldActivity.dailyChurn!['2026-04-20']).toBeUndefined();
    });

    it('should use argv without shell quotes (regression guard)', async () => {
      mockExistsSync.mockReturnValue(true);
      mockGitCall('false\n');
      mockGitCall('50\n');
      mockGitCall(`${Math.floor(Date.now() / 1000) - 86400 * 30}\n`);
      mockGitCall('src/a/x.ts\0');
      mockGitCall('50\t0\tsrc/a/x.ts\n');
      mockStat.mockResolvedValue({ mtimeMs: Date.now() } as Stats);
      mockGitCall('sha-argv\n');

      mockGitCall(''); // 1d
      mockGitCall(''); // 7d
      mockGitCall(''); // 30d

      // Daily churn output with COMMIT marker
      mockGitCall(
        ['COMMIT aaa111', '2026-04-22T09:00:00+01:00', 'Dev', '', 'src/a/x.ts', ''].join('\n'),
      );
      mockGitCall(''); // windowed authors 7d
      mockGitCall(''); // windowed authors 30d
      mockGitCall(''); // getFileAuthorMap

      await service.getSnapshot('/test/argv', 'test-project');

      // Find the daily churn execFile call (4th in Promise.all)
      const calls = mockExecFile.mock.calls;
      const dailyChurnCall = calls.find((call: unknown[]) => {
        const args = call[1] as string[];
        return (
          Array.isArray(args) &&
          args.some((a) => typeof a === 'string' && a.includes('--format=COMMIT'))
        );
      });
      expect(dailyChurnCall).toBeDefined();
      const args = (dailyChurnCall as unknown[])[1] as string[];
      // The format arg must NOT contain shell quotes
      const formatArg = args.find((a) => typeof a === 'string' && a.includes('COMMIT'));
      expect(formatArg).toBeDefined();
      expect(formatArg).not.toContain("'"); // no single quotes
      expect(formatArg).not.toContain('"'); // no double quotes
      expect(formatArg).toBe('--format=COMMIT %H%n%aI%n%aN');
    });

    it('should emit daily_churn_unavailable warning on empty git output', async () => {
      mockExistsSync.mockReturnValue(true);
      mockGitCall('false\n');
      mockGitCall('50\n');
      mockGitCall(`${Math.floor(Date.now() / 1000) - 86400 * 30}\n`);
      mockGitCall('src/a/x.ts\0');
      mockGitCall('50\t0\tsrc/a/x.ts\n');
      mockStat.mockResolvedValue({ mtimeMs: Date.now() } as Stats);
      mockGitCall('sha-empty-daily\n');

      mockGitCall(''); // 1d
      mockGitCall(''); // 7d
      mockGitCall(''); // 30d
      mockGitCall(''); // daily churn — empty → unavailable
      mockGitCall(''); // windowed authors 7d
      mockGitCall(''); // windowed authors 30d
      mockGitCall(''); // getFileAuthorMap

      const snapshot = await service.getSnapshot('/test/empty-daily', 'test-project');

      const warning = snapshot.metrics.warnings.find((w) => w.code === 'daily_churn_unavailable');
      expect(warning).toBeDefined();
      expect(warning!.message).toContain('Daily churn');
    });

    it('should NOT emit daily_churn_unavailable for non-git repos', async () => {
      mockExistsSync.mockReturnValue(false);
      mockReaddir.mockResolvedValue([
        { name: 'app.ts', isFile: () => true, isDirectory: () => false },
      ] as never);
      mockStat.mockResolvedValue({ mtimeMs: Date.now() } as Stats);

      const snapshot = await service.getSnapshot('/test/no-git-daily', 'test-project');

      const warning = snapshot.metrics.warnings.find((w) => w.code === 'daily_churn_unavailable');
      expect(warning).toBeUndefined();
    });

    it('should NOT emit warning when daily churn query succeeds with zero data', async () => {
      mockExistsSync.mockReturnValue(true);
      mockGitCall('false\n');
      mockGitCall('50\n');
      mockGitCall(`${Math.floor(Date.now() / 1000) - 86400 * 30}\n`);
      mockGitCall('src/a/x.ts\0');
      mockGitCall('50\t0\tsrc/a/x.ts\n');
      mockStat.mockResolvedValue({ mtimeMs: Date.now() } as Stats);
      mockGitCall('sha-quiet\n');

      mockGitCall(''); // 1d
      mockGitCall(''); // 7d
      mockGitCall(''); // 30d

      // Daily churn with a commit that has no files (query succeeded, no file touches)
      mockGitCall('COMMIT abc123\n2026-04-22T09:00:00+01:00\nNobody\n\n\n');
      mockGitCall(''); // windowed authors 7d
      mockGitCall(''); // windowed authors 30d
      mockGitCall(''); // getFileAuthorMap

      const snapshot = await service.getSnapshot('/test/quiet-daily', 'test-project');

      const warning = snapshot.metrics.warnings.find((w) => w.code === 'daily_churn_unavailable');
      expect(warning).toBeUndefined();
    });

    it('should count file touches not unique commits (matches getChurnMap semantics)', async () => {
      mockExistsSync.mockReturnValue(true);
      mockGitCall('false\n');
      mockGitCall('50\n');
      mockGitCall(`${Math.floor(Date.now() / 1000) - 86400 * 30}\n`);
      mockGitCall('src/a/x.ts\0');
      mockGitCall('50\t0\tsrc/a/x.ts\n');
      mockStat.mockResolvedValue({ mtimeMs: Date.now() } as Stats);
      mockGitCall('sha-touches\n');

      mockGitCall(''); // 1d
      mockGitCall(''); // 7d
      mockGitCall(''); // 30d

      // 2 commits, same file on same day — should count as 2 touches
      mockGitCall(
        [
          'COMMIT aaa',
          '2026-04-20T10:00:00+00:00',
          'Alice',
          '',
          'src/a/x.ts',
          '',
          'COMMIT bbb',
          '2026-04-20T14:00:00+00:00',
          'Bob',
          '',
          'src/a/x.ts',
          '',
        ].join('\n'),
      );
      mockGitCall(''); // windowed authors 7d
      mockGitCall(''); // windowed authors 30d
      mockGitCall(''); // getFileAuthorMap

      const snapshot = await service.getSnapshot('/test/touches', 'test-project');

      const district = snapshot.districts.find((d) => d.name === 'a')!;
      const activity = snapshot.activity.find((a) => a.targetId === district.id)!;

      expect(activity.dailyChurn).toBeDefined();
      // 2 touches on same file on same day
      expect(activity.dailyChurn!['2026-04-20']).toBe(2);
    });

    it('should emit daily_churn_unavailable when git log throws', async () => {
      mockExistsSync.mockReturnValue(true);
      mockGitCall('false\n');
      mockGitCall('50\n');
      mockGitCall(`${Math.floor(Date.now() / 1000) - 86400 * 30}\n`);
      mockGitCall('src/a/x.ts\0');
      mockGitCall('50\t0\tsrc/a/x.ts\n');
      mockStat.mockResolvedValue({ mtimeMs: Date.now() } as Stats);
      mockGitCall('sha-throw\n');

      mockGitCall(''); // 1d
      mockGitCall(''); // 7d
      mockGitCall(''); // 30d

      // Daily churn call throws
      mockExecFile.mockImplementationOnce(
        (_cmd: string, _args: string[], _opts: unknown, cb?: ExecFileCallback) => {
          if (cb) cb(new Error('git failed'), { stdout: '', stderr: 'fatal' });
          return undefined as never;
        },
      );
      mockGitCall(''); // windowed authors 7d
      mockGitCall(''); // windowed authors 30d
      mockGitCall(''); // getFileAuthorMap

      const snapshot = await service.getSnapshot('/test/daily-throw', 'test-project');

      const warning = snapshot.metrics.warnings.find((w) => w.code === 'daily_churn_unavailable');
      expect(warning).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // Windowed authors pipeline
  // -------------------------------------------------------------------------

  describe('windowed authors pipeline', () => {
    it('should populate per-district contributors from windowed author maps', async () => {
      mockExistsSync.mockReturnValue(true);
      mockGitCall('false\n');
      mockGitCall('50\n');
      mockGitCall(`${Math.floor(Date.now() / 1000) - 86400 * 30}\n`);
      mockGitCall('src/alpha/a.ts\0src/alpha/b.ts\0src/beta/c.ts\0');
      mockGitCall('100\t0\tsrc/alpha/a.ts\n50\t0\tsrc/alpha/b.ts\n80\t0\tsrc/beta/c.ts\n');
      mockStat.mockResolvedValue({ mtimeMs: Date.now() } as Stats);
      mockGitCall('sha-win-auth\n');

      mockGitCall(''); // 1d
      mockGitCall(''); // 7d
      mockGitCall(''); // 30d
      mockGitCall(''); // daily churn

      // Windowed authors 7d: Alice touched a.ts + b.ts; Bob touched c.ts
      mockGitCall(
        [
          'COMMIT aaa',
          '2026-04-20T10:00:00+00:00',
          'Alice',
          '',
          'src/alpha/a.ts',
          'src/alpha/b.ts',
          '',
        ].join('\n'),
      );
      // Windowed authors 30d: Alice touched a.ts 2x; Bob touched c.ts; Carol touched a.ts + b.ts
      mockGitCall(
        [
          'COMMIT bbb',
          '2026-04-01T10:00:00+00:00',
          'Alice',
          '',
          'src/alpha/a.ts',
          '',
          'COMMIT ccc',
          '2026-04-05T10:00:00+00:00',
          'Alice',
          '',
          'src/alpha/a.ts',
          '',
          'COMMIT ddd',
          '2026-04-10T10:00:00+00:00',
          'Bob',
          '',
          'src/beta/c.ts',
          '',
          'COMMIT eee',
          '2026-04-15T10:00:00+00:00',
          'Carol',
          '',
          'src/alpha/a.ts',
          'src/alpha/b.ts',
          '',
        ].join('\n'),
      );
      mockGitCall(''); // getFileAuthorMap

      const snapshot = await service.getSnapshot('/test/win-auth', 'test-project');

      const alphaDistrict = snapshot.districts.find((d) => d.name === 'alpha')!;
      const betaDistrict = snapshot.districts.find((d) => d.name === 'beta')!;

      const alphaActivity = snapshot.activity.find((a) => a.targetId === alphaDistrict.id)!;
      const betaActivity = snapshot.activity.find((a) => a.targetId === betaDistrict.id)!;

      // Alpha 7d: Alice has 2 touches (a.ts + b.ts)
      expect(alphaActivity.recentContributors7d).toHaveLength(1);
      expect(alphaActivity.recentContributors7d[0]).toEqual({
        authorName: 'Alice',
        commitCount: 2,
      });

      // Alpha 30d: Alice 2, Carol 2 — ranked by count desc
      expect(alphaActivity.recentContributors30d).toHaveLength(2);
      expect(alphaActivity.recentContributors30d[0].authorName).toBe('Alice');
      expect(alphaActivity.recentContributors30d[0].commitCount).toBe(2);
      expect(alphaActivity.recentContributors30d[1].authorName).toBe('Carol');
      expect(alphaActivity.recentContributors30d[1].commitCount).toBe(2);

      // Beta 30d: Bob 1
      expect(betaActivity.recentContributors30d).toHaveLength(1);
      expect(betaActivity.recentContributors30d[0]).toEqual({ authorName: 'Bob', commitCount: 1 });

      // Beta 7d: no commits in 7d window for beta — only Alice in alpha
      expect(betaActivity.recentContributors7d).toHaveLength(0);
    });

    it('should build globalContributors deduplicated across districts', async () => {
      mockExistsSync.mockReturnValue(true);
      mockGitCall('false\n');
      mockGitCall('50\n');
      mockGitCall(`${Math.floor(Date.now() / 1000) - 86400 * 30}\n`);
      mockGitCall('src/a/x.ts\0src/b/y.ts\0');
      mockGitCall('50\t0\tsrc/a/x.ts\n30\t0\tsrc/b/y.ts\n');
      mockStat.mockResolvedValue({ mtimeMs: Date.now() } as Stats);
      mockGitCall('sha-global\n');

      mockGitCall(''); // 1d
      mockGitCall(''); // 7d
      mockGitCall(''); // 30d
      mockGitCall(''); // daily churn

      // Windowed 7d: Alice touches x.ts
      mockGitCall(
        ['COMMIT aaa', '2026-04-20T10:00:00+00:00', 'Alice', '', 'src/a/x.ts', ''].join('\n'),
      );
      // Windowed 30d: Alice touches x.ts + y.ts; Bob touches y.ts
      mockGitCall(
        [
          'COMMIT bbb',
          '2026-04-01T10:00:00+00:00',
          'Alice',
          '',
          'src/a/x.ts',
          'src/b/y.ts',
          '',
          'COMMIT ccc',
          '2026-04-05T10:00:00+00:00',
          'Bob',
          '',
          'src/b/y.ts',
          '',
        ].join('\n'),
      );
      mockGitCall(''); // getFileAuthorMap

      const snapshot = await service.getSnapshot('/test/global-contrib', 'test-project');

      // Alice: 7d=1 (x.ts), 30d=2 (x.ts + y.ts)
      // Bob: 7d=0, 30d=1 (y.ts)
      expect(snapshot.globalContributors).toHaveLength(2);
      expect(snapshot.globalContributors[0].authorName).toBe('Alice');
      expect(snapshot.globalContributors[0].commitCount7d).toBe(1);
      expect(snapshot.globalContributors[0].commitCount30d).toBe(2);
      expect(snapshot.globalContributors[1].authorName).toBe('Bob');
      expect(snapshot.globalContributors[1].commitCount7d).toBe(0);
      expect(snapshot.globalContributors[1].commitCount30d).toBe(1);
    });

    it('should cap per-district contributors at 5 entries', async () => {
      mockExistsSync.mockReturnValue(true);
      mockGitCall('false\n');
      mockGitCall('50\n');
      mockGitCall(`${Math.floor(Date.now() / 1000) - 86400 * 30}\n`);
      mockGitCall('src/a/x.ts\0');
      mockGitCall('50\t0\tsrc/a/x.ts\n');
      mockStat.mockResolvedValue({ mtimeMs: Date.now() } as Stats);
      mockGitCall('sha-cap5\n');

      mockGitCall(''); // 1d
      mockGitCall(''); // 7d
      mockGitCall(''); // 30d
      mockGitCall(''); // daily churn
      mockGitCall(''); // windowed authors 7d

      // 30d: 7 authors touching the same file
      const commits30d = Array.from(
        { length: 7 },
        (_, i) => `COMMIT ${i}\n2026-04-01T10:00:00+00:00\nAuthor${i}\n\nsrc/a/x.ts\n`,
      ).join('\n');
      mockGitCall(commits30d);
      mockGitCall(''); // getFileAuthorMap

      const snapshot = await service.getSnapshot('/test/cap5', 'test-project');
      const district = snapshot.districts.find((d) => d.name === 'a')!;
      const activity = snapshot.activity.find((a) => a.targetId === district.id)!;

      expect(activity.recentContributors30d).toHaveLength(5);
    });

    it('should cap globalContributors at 20 entries', async () => {
      mockExistsSync.mockReturnValue(true);
      mockGitCall('false\n');
      mockGitCall('50\n');
      mockGitCall(`${Math.floor(Date.now() / 1000) - 86400 * 30}\n`);

      // 25 files in separate districts
      const filePaths = Array.from({ length: 25 }, (_, i) => `src/d${i}/f.ts`);
      const numstatLines = filePaths.map((p) => `10\t0\t${p}`);
      mockGitCall(filePaths.join('\0') + '\0');
      mockGitCall(numstatLines.join('\n') + '\n');
      mockStat.mockResolvedValue({ mtimeMs: Date.now() } as Stats);
      mockGitCall('sha-cap20\n');

      mockGitCall(''); // 1d
      mockGitCall(''); // 7d
      mockGitCall(''); // 30d
      mockGitCall(''); // daily churn
      mockGitCall(''); // windowed authors 7d

      const commits30d = Array.from(
        { length: 25 },
        (_, i) => `COMMIT ${i}\n2026-04-01T10:00:00+00:00\nAuthor${i}\n\nsrc/d${i}/f.ts\n`,
      ).join('\n');
      mockGitCall(commits30d);
      mockGitCall(''); // getFileAuthorMap

      const snapshot = await service.getSnapshot('/test/cap20', 'test-project');

      expect(snapshot.globalContributors).toHaveLength(20);
    });

    it('should emit windowed_authors_unavailable when either window fails', async () => {
      mockExistsSync.mockReturnValue(true);
      mockGitCall('false\n');
      mockGitCall('50\n');
      mockGitCall(`${Math.floor(Date.now() / 1000) - 86400 * 30}\n`);
      mockGitCall('src/a/x.ts\0');
      mockGitCall('50\t0\tsrc/a/x.ts\n');
      mockStat.mockResolvedValue({ mtimeMs: Date.now() } as Stats);
      mockGitCall('sha-fail-win\n');

      mockGitCall(''); // 1d
      mockGitCall(''); // 7d
      mockGitCall(''); // 30d
      mockGitCall(''); // daily churn

      // Windowed 7d: empty → null
      mockGitCall('');
      // Windowed 30d: succeeds
      mockGitCall(
        ['COMMIT aaa', '2026-04-01T10:00:00+00:00', 'Alice', '', 'src/a/x.ts', ''].join('\n'),
      );
      mockGitCall(''); // getFileAuthorMap

      const snapshot = await service.getSnapshot('/test/fail-win', 'test-project');

      const warning = snapshot.metrics.warnings.find(
        (w) => w.code === 'windowed_authors_unavailable',
      );
      expect(warning).toBeDefined();
    });

    it('should NOT emit warning when both windows succeed with zero contributors', async () => {
      mockExistsSync.mockReturnValue(true);
      mockGitCall('false\n');
      mockGitCall('50\n');
      mockGitCall(`${Math.floor(Date.now() / 1000) - 86400 * 30}\n`);
      mockGitCall('src/a/x.ts\0');
      mockGitCall('50\t0\tsrc/a/x.ts\n');
      mockStat.mockResolvedValue({ mtimeMs: Date.now() } as Stats);
      mockGitCall('sha-quiet-win\n');

      mockGitCall(''); // 1d
      mockGitCall(''); // 7d
      mockGitCall(''); // 30d
      mockGitCall(''); // daily churn

      // Both windows succeed but have commits with no files
      mockGitCall('COMMIT aaa\n2026-04-20T10:00:00+00:00\nNobody\n\n\n');
      mockGitCall('COMMIT bbb\n2026-04-01T10:00:00+00:00\nNobody\n\n\n');
      mockGitCall(''); // getFileAuthorMap

      const snapshot = await service.getSnapshot('/test/quiet-win', 'test-project');

      const warning = snapshot.metrics.warnings.find(
        (w) => w.code === 'windowed_authors_unavailable',
      );
      expect(warning).toBeUndefined();
    });

    it('should make two separate git log calls for 7d and 30d', async () => {
      mockExistsSync.mockReturnValue(true);
      mockGitCall('false\n');
      mockGitCall('50\n');
      mockGitCall(`${Math.floor(Date.now() / 1000) - 86400 * 30}\n`);
      mockGitCall('src/a/x.ts\0');
      mockGitCall('50\t0\tsrc/a/x.ts\n');
      mockStat.mockResolvedValue({ mtimeMs: Date.now() } as Stats);
      mockGitCall('sha-two-calls\n');

      mockGitCall(''); // 1d
      mockGitCall(''); // 7d
      mockGitCall(''); // 30d
      mockGitCall(''); // daily churn

      // Windowed 7d and 30d with COMMIT markers
      mockGitCall(
        ['COMMIT aaa', '2026-04-20T10:00:00+00:00', 'Alice', '', 'src/a/x.ts', ''].join('\n'),
      );
      mockGitCall(
        ['COMMIT bbb', '2026-04-01T10:00:00+00:00', 'Bob', '', 'src/a/x.ts', ''].join('\n'),
      );
      mockGitCall(''); // getFileAuthorMap

      await service.getSnapshot('/test/two-calls', 'test-project');

      // Verify that there are 2 separate calls with --since for windowed authors
      const calls = mockExecFile.mock.calls;
      const windowedCalls = calls.filter((call: unknown[]) => {
        const args = call[1] as string[];
        return (
          Array.isArray(args) &&
          args[0] === 'log' &&
          args.some(
            (a) => typeof a === 'string' && a.startsWith('--since=') && a.includes('days ago'),
          ) &&
          args.some((a) => typeof a === 'string' && a.includes('--format=COMMIT'))
        );
      });
      // 1 daily churn + 2 windowed authors = 3 calls with COMMIT format
      // The windowed ones should have --since=7 and --since=30
      expect(windowedCalls.length).toBeGreaterThanOrEqual(3);
      const sinceArgs = windowedCalls.map((call: unknown[]) => {
        const args = call[1] as string[];
        return args.find((a) => typeof a === 'string' && a.startsWith('--since='));
      });
      expect(sinceArgs.filter((a) => a?.includes('14 days')).length).toBe(1); // daily churn
      expect(sinceArgs.filter((a) => a?.includes('7 days')).length).toBe(1); // windowed 7d
      expect(sinceArgs.filter((a) => a?.includes('30 days')).length).toBe(1); // windowed 30d
    });
  });

  describe('owner-quiet detection (primaryAuthorRecentlyActive)', () => {
    // Shared setup helper: single district in src/core/ with Alice as primary author
    function mockBaseForOwnerQuiet() {
      mockExistsSync.mockReturnValue(true);
      mockGitCall('false\n'); // bare repo check
      mockGitCall('50\n'); // log count
      mockGitCall(`${Math.floor(Date.now() / 1000) - 86400 * 30}\n`); // earliest timestamp
      mockGitCall('src/core/engine.ts\0'); // tracked files
      mockGitCall('100\t0\tsrc/core/engine.ts\n'); // LOC
      mockStat.mockResolvedValue({ mtimeMs: Date.now(), size: 50 } as Stats);
      mockGitCall('sha-ownquiet\n'); // head SHA

      mockGitCall(''); // churn 1d
      mockGitCall(''); // churn 7d
      mockGitCall(''); // churn 30d
      mockGitCall(''); // daily churn
      mockGitCall(''); // windowed authors 7d
    }

    it('should set primaryAuthorRecentlyActive=true when primary author is in recent 30d contributors', async () => {
      mockBaseForOwnerQuiet();

      // Windowed 30d: Alice touched engine.ts → she IS the recent contributor
      mockGitCall(
        ['COMMIT aaa', '2026-04-20T10:00:00+00:00', 'Alice', '', 'src/core/engine.ts', ''].join(
          '\n',
        ),
      );
      // All-time authorship: Alice is primary author (3 touches)
      mockGitCall('Alice\n\nsrc/core/engine.ts\nsrc/core/engine.ts\nsrc/core/engine.ts\n');

      const snapshot = await service.getSnapshot('/test/owner-active', 'test-project');
      const district = snapshot.districts.find((d) => d.name === 'core')!;

      expect(district.primaryAuthorName).toBe('Alice');
      expect(district.primaryAuthorRecentlyActive).toBe(true);
      expect(snapshot.signals[0].primaryAuthorRecentlyActive).toBe(true);
    });

    it('should set primaryAuthorRecentlyActive=false when primary author is absent from 30d (owner-quiet)', async () => {
      mockBaseForOwnerQuiet();

      // Windowed 30d: Bob touched engine.ts — Alice is absent
      mockGitCall(
        ['COMMIT aaa', '2026-04-20T10:00:00+00:00', 'Bob', '', 'src/core/engine.ts', ''].join('\n'),
      );
      // All-time authorship: Alice is primary author (3 touches)
      mockGitCall('Alice\n\nsrc/core/engine.ts\nsrc/core/engine.ts\nsrc/core/engine.ts\n');

      const snapshot = await service.getSnapshot('/test/owner-quiet', 'test-project');
      const district = snapshot.districts.find((d) => d.name === 'core')!;

      expect(district.primaryAuthorName).toBe('Alice');
      expect(district.primaryAuthorRecentlyActive).toBe(false);
    });

    it('should default to false when primaryAuthorName is null (no ownership data)', async () => {
      mockExistsSync.mockReturnValue(false); // non-git → no ownership
      mockReaddir.mockResolvedValue([
        { name: 'app.ts', isFile: () => true, isDirectory: () => false },
      ] as never);
      mockStat.mockResolvedValue({ mtimeMs: Date.now() } as Stats);

      const snapshot = await service.getSnapshot('/test/owner-null', 'test-project');

      for (const district of snapshot.districts) {
        expect(district.primaryAuthorName).toBeNull();
        expect(district.primaryAuthorRecentlyActive).toBe(false);
      }
    });

    it('should default to false when windowed author query returns empty (failed/unavailable)', async () => {
      mockBaseForOwnerQuiet();

      mockGitCall(''); // windowed 30d: empty → no recent contributors
      // All-time: Alice is primary
      mockGitCall('Alice\n\nsrc/core/engine.ts\nsrc/core/engine.ts\nsrc/core/engine.ts\n');

      const snapshot = await service.getSnapshot('/test/owner-empty-window', 'test-project');
      const district = snapshot.districts.find((d) => d.name === 'core')!;

      expect(district.primaryAuthorName).toBe('Alice');
      expect(district.primaryAuthorRecentlyActive).toBe(false);
    });

    it('should use case-sensitive name match (different spellings → false)', async () => {
      mockBaseForOwnerQuiet();

      // Windowed 30d: "alice.smith" (email-style) — different from "Alice Smith"
      mockGitCall(
        [
          'COMMIT aaa',
          '2026-04-20T10:00:00+00:00',
          'alice.smith',
          '',
          'src/core/engine.ts',
          '',
        ].join('\n'),
      );
      // All-time: "Alice Smith" is primary author
      mockGitCall('Alice Smith\n\nsrc/core/engine.ts\nsrc/core/engine.ts\nsrc/core/engine.ts\n');

      const snapshot = await service.getSnapshot('/test/owner-spelling', 'test-project');
      const district = snapshot.districts.find((d) => d.name === 'core')!;

      expect(district.primaryAuthorName).toBe('Alice Smith');
      expect(district.primaryAuthorRecentlyActive).toBe(false);
    });
  });

  describe('scope pipeline integration (two-corpora split + excluded authors)', () => {
    let scopeResolver: ScopeResolverService;

    beforeEach(() => {
      scopeResolver = new ScopeResolverService();
    });

    function mockBaseGit() {
      mockExistsSync.mockReturnValue(true);
      mockGitCall('false\n'); // is-shallow
      mockGitCall('50\n'); // rev-list count
      mockGitCall(`${Math.floor(Date.now() / 1000) - 86400 * 30}\n`); // oldest commit
    }

    it('pre-walk excludes filter file list for git repos', async () => {
      mockBaseGit();
      // git ls-files returns files from excluded folders too
      mockGitCall('src/main.ts\0src/util.ts\0dist/bundle.js\0node_modules/pkg/index.js\0');
      mockGitCall(
        '100\t0\tsrc/main.ts\n50\t0\tsrc/util.ts\n300\t0\tdist/bundle.js\n200\t0\tnode_modules/pkg/index.js\n',
      );
      mockStat.mockResolvedValue({ mtimeMs: Date.now() } as Stats);
      mockGitCall('sha-exclude\n');
      mockEmptyChurn();

      const snapshot = await service.getSnapshot('/test/exclude-git', 'test-project');

      // dist and node_modules are excluded by built-in defaults
      const allPaths = snapshot.districts.flatMap((d) => {
        const sig = snapshot.signals.find((s) => s.districtId === d.id);
        return sig ? [sig.path] : [];
      });
      expect(allPaths.some((p) => p.startsWith('dist'))).toBe(false);
      expect(allPaths.some((p) => p.startsWith('node_modules'))).toBe(false);
      expect(snapshot.metrics.totalFiles).toBe(2);
    });

    it('pre-walk excludes filter file list for non-git repos', async () => {
      mockExistsSync.mockReturnValue(false);
      mockReaddir.mockImplementation(async (dirPath: unknown) => {
        const p = dirPath as string;
        if (p === '/test/exclude-fs') {
          return [
            { name: 'src', isFile: () => false, isDirectory: () => true },
            { name: 'dist', isFile: () => false, isDirectory: () => true },
            { name: 'node_modules', isFile: () => false, isDirectory: () => true },
          ] as never;
        }
        if (p.endsWith('/src')) {
          return [{ name: 'app.ts', isFile: () => true, isDirectory: () => false }] as never;
        }
        if (p.endsWith('/dist')) {
          return [{ name: 'out.js', isFile: () => true, isDirectory: () => false }] as never;
        }
        return [] as never;
      });
      mockStat.mockResolvedValue({ mtimeMs: Date.now() } as Stats);

      const snapshot = await service.getSnapshot('/test/exclude-fs', 'test-project');

      expect(snapshot.metrics.totalFiles).toBe(1);
      const regionNames = snapshot.regions.map((r) => r.name);
      expect(regionNames).not.toContain('dist');
      expect(regionNames).not.toContain('node_modules');
    });

    it('generated files excluded from analysis metrics (hotspot/complexity/coverage)', async () => {
      mockBaseGit();

      // Spy on scope resolver to add a generated folder
      jest.spyOn(scopeResolver, 'resolve').mockReturnValue([
        { folder: 'gen', purpose: 'generated', reason: 'test', origin: 'default' },
        { folder: 'node_modules', purpose: 'excluded', reason: 'test', origin: 'default' },
      ]);
      jest.spyOn(scopeResolver, 'getExcludedFolders').mockReturnValue(['node_modules']);
      jest.spyOn(scopeResolver, 'getGeneratedFolders').mockReturnValue(['gen']);
      // Replace the service's scope resolver
      (service as unknown as { scopeResolver: ScopeResolverService }).scopeResolver = scopeResolver;

      const files = ['src/core/app.ts', 'src/core/app.spec.ts', 'gen/types/generated.ts'];
      mockGitCall(files.join('\0') + '\0');
      mockGitCall(
        '200\t0\tsrc/core/app.ts\n50\t0\tsrc/core/app.spec.ts\n300\t0\tgen/types/generated.ts\n',
      );
      mockStat.mockResolvedValue({ mtimeMs: Date.now(), size: 100 } as Stats);
      mockGitCall('sha-gen\n');

      // Churn with activity in generated folder
      mockGitCall('gen/types/generated.ts\n'); // churn 1d
      mockGitCall('gen/types/generated.ts\nsrc/core/app.ts\n'); // churn 7d
      mockGitCall('gen/types/generated.ts\nsrc/core/app.ts\n'); // churn 30d
      mockGitCall(''); // daily churn
      mockGitCall(''); // windowed authors 7d
      mockGitCall(''); // windowed authors 30d
      mockGitCall(''); // getFileAuthorMap

      // Adapter: make generated.ts have high complexity
      const fileContents = new Map<string, string>([
        [
          '/test/gen-analysis/gen/types/generated.ts',
          `export type A = string;\nexport type B = number;\n`,
        ],
        [
          '/test/gen-analysis/src/core/app.ts',
          `import { A } from '../../gen/types/generated';\nexport class App {}\n`,
        ],
        [
          '/test/gen-analysis/src/core/app.spec.ts',
          `describe('App', () => { it('works', () => {}); });\n`,
        ],
      ]);
      mockReadFile.mockImplementation(async (path: unknown) => {
        return fileContents.get(path as string) ?? '';
      });

      const snapshot = await service.getSnapshot('/test/gen-analysis', 'test-project');

      // Generated district exists (gen/types)
      const genDistrict = snapshot.districts.find((d) => d.path.startsWith('gen'));
      expect(genDistrict).toBeDefined();

      // Generated district has null code-quality metrics (excluded from analysis corpus)
      expect(genDistrict!.complexityAvg).toBeNull();
      expect(genDistrict!.testCoverageRate).toBeNull();

      // Generated district NOT in hotspot rankings
      const hotspotTargets = snapshot.hotspots.map((h) => h.targetId);
      expect(hotspotTargets).not.toContain(genDistrict!.id);

      // Non-generated district IS in hotspot rankings
      const srcDistrict = snapshot.districts.find((d) => d.name === 'core')!;
      expect(hotspotTargets).toContain(srcDistrict.id);
    });

    it('generated files kept in attribution (ownership, churn, contributor metrics)', async () => {
      mockBaseGit();

      jest
        .spyOn(scopeResolver, 'resolve')
        .mockReturnValue([
          { folder: 'gen', purpose: 'generated', reason: 'test', origin: 'default' },
        ]);
      jest.spyOn(scopeResolver, 'getExcludedFolders').mockReturnValue([]);
      jest.spyOn(scopeResolver, 'getGeneratedFolders').mockReturnValue(['gen']);
      (service as unknown as { scopeResolver: ScopeResolverService }).scopeResolver = scopeResolver;

      const files = ['src/core/app.ts', 'gen/types/output.ts'];
      mockGitCall(files.join('\0') + '\0');
      mockGitCall('100\t0\tsrc/core/app.ts\n200\t0\tgen/types/output.ts\n');
      mockStat.mockResolvedValue({ mtimeMs: Date.now(), size: 100 } as Stats);
      mockGitCall('sha-attrib\n');

      mockGitCall(''); // churn 1d
      mockGitCall('gen/types/output.ts\n'); // churn 7d — generated file has churn
      mockGitCall('gen/types/output.ts\nsrc/core/app.ts\n'); // churn 30d
      mockGitCall(''); // daily churn
      // windowed authors 7d: GenBot only in gen/
      mockGitCall(
        ['COMMIT aaa', '2026-04-20T10:00:00+00:00', 'GenBot', '', 'gen/types/output.ts', ''].join(
          '\n',
        ),
      );
      // windowed authors 30d: GenBot in gen/, Dev in src/
      mockGitCall(
        [
          'COMMIT bbb',
          '2026-04-10T10:00:00+00:00',
          'GenBot',
          '',
          'gen/types/output.ts',
          '',
          'COMMIT ccc',
          '2026-04-11T10:00:00+00:00',
          'Dev',
          '',
          'src/core/app.ts',
          '',
        ].join('\n'),
      );
      // getFileAuthorMap
      mockGitCall('GenBot\n\ngen/types/output.ts\n\nDev\n\nsrc/core/app.ts\n');

      const snapshot = await service.getSnapshot('/test/gen-attrib', 'test-project');

      // Generated district exists with basic structural metrics
      const genDistrict = snapshot.districts.find((d) => d.path.startsWith('gen'))!;
      expect(genDistrict).toBeDefined();
      // analysis corpus excludes generated files → churn7d on DistrictNode is 0 by design
      expect(genDistrict.churn7d).toBe(0);
      expect(genDistrict.totalFiles).toBe(1);

      // GenBot appears in globalContributors (from generated folder, but via attribution corpus)
      const genBot = snapshot.globalContributors.find((c) => c.authorName === 'GenBot');
      expect(genBot).toBeDefined();
    });

    it('generated-only district has empty/neutral code-quality metrics but exists for attribution', async () => {
      mockBaseGit();

      jest
        .spyOn(scopeResolver, 'resolve')
        .mockReturnValue([
          { folder: 'codegen', purpose: 'generated', reason: 'test', origin: 'default' },
        ]);
      jest.spyOn(scopeResolver, 'getExcludedFolders').mockReturnValue([]);
      jest.spyOn(scopeResolver, 'getGeneratedFolders').mockReturnValue(['codegen']);
      (service as unknown as { scopeResolver: ScopeResolverService }).scopeResolver = scopeResolver;

      // Only generated files
      mockGitCall('codegen/models/user.ts\0codegen/models/post.ts\0');
      mockGitCall('100\t0\tcodegen/models/user.ts\n80\t0\tcodegen/models/post.ts\n');
      mockStat.mockResolvedValue({ mtimeMs: Date.now(), size: 50 } as Stats);
      mockGitCall('sha-genonly\n');
      mockEmptyChurn();

      const snapshot = await service.getSnapshot('/test/gen-only', 'test-project');

      expect(snapshot.districts.length).toBeGreaterThan(0);
      for (const d of snapshot.districts) {
        // Attribution: basic metrics present
        expect(d.totalFiles).toBeGreaterThan(0);
        expect(d.totalLOC).toBeGreaterThan(0);

        // Analysis: code-quality metrics empty/neutral
        expect(d.complexityAvg).toBeNull();
        expect(d.testCoverageRate).toBeNull();
      }

      // Hotspots empty (no analysis districts)
      expect(snapshot.hotspots.length).toBe(0);

      // Signals still emitted
      expect(snapshot.signals.length).toBe(snapshot.districts.length);
    });

    it('globalContributors excludes pure-excluded-folder authors', async () => {
      mockBaseGit();

      const files = ['src/core/app.ts', 'src/core/util.ts'];
      mockGitCall(files.join('\0') + '\0');
      mockGitCall('100\t0\tsrc/core/app.ts\n50\t0\tsrc/core/util.ts\n');
      mockStat.mockResolvedValue({ mtimeMs: Date.now() } as Stats);
      mockGitCall('sha-exauthor\n');

      mockGitCall(''); // churn 1d
      mockGitCall(''); // churn 7d
      mockGitCall(''); // churn 30d
      mockGitCall(''); // daily churn

      // windowed 7d: Dev touched src files
      mockGitCall(
        ['COMMIT aaa', '2026-04-20T10:00:00+00:00', 'Dev', '', 'src/core/app.ts', ''].join('\n'),
      );
      // windowed 30d: Dev in src, Bot ONLY in excluded dist/
      mockGitCall(
        [
          'COMMIT bbb',
          '2026-04-10T10:00:00+00:00',
          'Dev',
          '',
          'src/core/app.ts',
          '',
          'COMMIT ccc',
          '2026-04-11T10:00:00+00:00',
          'Bot',
          '',
          'dist/bundle.js',
          '',
        ].join('\n'),
      );
      // getFileAuthorMap: Bot only in dist/, Dev only in src/
      mockGitCall(
        'Dev\n\nsrc/core/app.ts\nsrc/core/util.ts\n\nBot\n\ndist/bundle.js\ndist/bundle.js\n',
      );

      const snapshot = await service.getSnapshot('/test/excluded-author', 'test-project');

      // Dev appears in globalContributors
      const dev = snapshot.globalContributors.find((c) => c.authorName === 'Dev');
      expect(dev).toBeDefined();

      // Bot does NOT appear (only touched excluded dist/ files)
      const bot = snapshot.globalContributors.find((c) => c.authorName === 'Bot');
      expect(bot).toBeUndefined();

      // excludedAuthorCount reflects the hidden author
      expect(snapshot.metrics.excludedAuthorCount).toBe(1);
    });

    it('mixed-commit authors (touch both excluded + non-excluded) still count in globalContributors', async () => {
      mockBaseGit();

      const files = ['src/core/main.ts'];
      mockGitCall(files.join('\0') + '\0');
      mockGitCall('100\t0\tsrc/core/main.ts\n');
      mockStat.mockResolvedValue({ mtimeMs: Date.now() } as Stats);
      mockGitCall('sha-mixed\n');

      mockGitCall(''); // churn 1d
      mockGitCall(''); // churn 7d
      mockGitCall(''); // churn 30d
      mockGitCall(''); // daily churn
      mockGitCall(''); // windowed 7d

      // windowed 30d: MixedDev touches both src/ and dist/
      mockGitCall(
        [
          'COMMIT aaa',
          '2026-04-10T10:00:00+00:00',
          'MixedDev',
          '',
          'src/core/main.ts',
          '',
          'COMMIT bbb',
          '2026-04-11T10:00:00+00:00',
          'MixedDev',
          '',
          'dist/out.js',
          '',
        ].join('\n'),
      );
      // getFileAuthorMap: MixedDev in both src/ and dist/
      mockGitCall('MixedDev\n\nsrc/core/main.ts\ndist/out.js\n');

      const snapshot = await service.getSnapshot('/test/mixed-author', 'test-project');

      // MixedDev still appears (touches non-excluded files too)
      const mixed = snapshot.globalContributors.find((c) => c.authorName === 'MixedDev');
      expect(mixed).toBeDefined();

      // Not counted as excluded-only
      expect(snapshot.metrics.excludedAuthorCount).toBe(0);
    });

    it('generated files stay in dependency graph (real imports still create edges)', async () => {
      mockBaseGit();

      jest
        .spyOn(scopeResolver, 'resolve')
        .mockReturnValue([
          { folder: 'gen', purpose: 'generated', reason: 'test', origin: 'default' },
        ]);
      jest.spyOn(scopeResolver, 'getExcludedFolders').mockReturnValue([]);
      jest.spyOn(scopeResolver, 'getGeneratedFolders').mockReturnValue(['gen']);
      (service as unknown as { scopeResolver: ScopeResolverService }).scopeResolver = scopeResolver;

      const files = ['src/core/app.ts', 'gen/types/models.ts'];
      mockGitCall(files.join('\0') + '\0');
      mockGitCall('100\t0\tsrc/core/app.ts\n200\t0\tgen/types/models.ts\n');
      mockStat.mockResolvedValue({ mtimeMs: Date.now(), size: 100 } as Stats);
      mockGitCall('sha-gendep\n');
      mockEmptyChurn();

      const fileContents = new Map<string, string>([
        [
          '/test/gen-dep/src/core/app.ts',
          `import { User } from '../../gen/types/models';\nexport class App {}`,
        ],
        ['/test/gen-dep/gen/types/models.ts', `export interface User { name: string; }\n`],
      ]);
      mockReadFile.mockImplementation(async (path: unknown) => {
        return fileContents.get(path as string) ?? '';
      });

      const snapshot = await service.getSnapshot('/test/gen-dep', 'test-project');

      // Dependency edge exists between src/core → gen/types
      expect(snapshot.dependencies.length).toBeGreaterThan(0);
      const srcDistrict = snapshot.districts.find((d) => d.name === 'core')!;
      const genDistrict = snapshot.districts.find((d) => d.path.startsWith('gen'))!;
      const edge = snapshot.dependencies.find(
        (dep) => dep.fromDistrictId === srcDistrict.id && dep.toDistrictId === genDistrict.id,
      );
      expect(edge).toBeDefined();
      expect(edge!.weight).toBeGreaterThanOrEqual(1);
    });

    it('scopeConfigHash changes when scope config changes', async () => {
      mockBaseGit();
      mockGitCall('src/app.ts\0');
      mockGitCall('10\t0\tsrc/app.ts\n');
      mockStat.mockResolvedValue({ mtimeMs: Date.now() } as Stats);
      mockGitCall('sha1\n');
      mockEmptyChurn();

      const snapshot1 = await service.getSnapshot('/test/hash1', 'test-project');
      const hash1 = snapshot1.metrics.scopeConfigHash;
      expect(hash1).toMatch(/^[0-9a-f]{8}$/);

      // Change scope config
      jest
        .spyOn(scopeResolver, 'resolve')
        .mockReturnValue([
          { folder: 'gen', purpose: 'generated', reason: 'custom', origin: 'user' },
        ]);
      jest.spyOn(scopeResolver, 'getExcludedFolders').mockReturnValue([]);
      jest.spyOn(scopeResolver, 'getGeneratedFolders').mockReturnValue(['gen']);
      (service as unknown as { scopeResolver: ScopeResolverService }).scopeResolver = scopeResolver;

      mockBaseGit();
      mockGitCall('src/app.ts\0');
      mockGitCall('10\t0\tsrc/app.ts\n');
      mockStat.mockResolvedValue({ mtimeMs: Date.now() } as Stats);
      mockGitCall('sha2\n');
      mockEmptyChurn();

      const snapshot2 = await service.getSnapshot('/test/hash2', 'test-project');
      const hash2 = snapshot2.metrics.scopeConfigHash;

      expect(hash2).toMatch(/^[0-9a-f]{8}$/);
      expect(hash1).not.toBe(hash2);
    });

    // ------------------------------------------------------------------
    // Nested-folder matcher integration tests
    // ------------------------------------------------------------------

    it('nested excluded entry "src/generated" filters git file list', async () => {
      mockBaseGit();

      jest
        .spyOn(scopeResolver, 'resolve')
        .mockReturnValue([
          { folder: 'src/generated', purpose: 'excluded', reason: 'test', origin: 'user' },
        ]);
      jest.spyOn(scopeResolver, 'getExcludedFolders').mockReturnValue(['src/generated']);
      jest.spyOn(scopeResolver, 'getGeneratedFolders').mockReturnValue([]);
      (service as unknown as { scopeResolver: ScopeResolverService }).scopeResolver = scopeResolver;

      // git ls-files returns both a real source file and a file deep inside src/generated
      mockGitCall('src/app.ts\0src/generated/model.ts\0src/generated/types/dto.ts\0');
      mockGitCall(
        '100\t0\tsrc/app.ts\n200\t0\tsrc/generated/model.ts\n50\t0\tsrc/generated/types/dto.ts\n',
      );
      mockStat.mockResolvedValue({ mtimeMs: Date.now() } as Stats);
      mockGitCall('sha-nested-git\n');
      mockEmptyChurn();

      const snapshot = await service.getSnapshot('/test/nested-git', 'test-project');

      // Only the real source file survives filtering
      expect(snapshot.metrics.totalFiles).toBe(1);
      // No district rooted at src/generated
      expect(snapshot.districts.some((d) => d.path.startsWith('src/generated'))).toBe(false);
    });

    it('nested excluded entry "src/generated" prunes non-git directory traversal', async () => {
      mockExistsSync.mockReturnValue(false);

      jest
        .spyOn(scopeResolver, 'resolve')
        .mockReturnValue([
          { folder: 'src/generated', purpose: 'excluded', reason: 'test', origin: 'user' },
        ]);
      jest.spyOn(scopeResolver, 'getExcludedFolders').mockReturnValue(['src/generated']);
      jest.spyOn(scopeResolver, 'getGeneratedFolders').mockReturnValue([]);
      (service as unknown as { scopeResolver: ScopeResolverService }).scopeResolver = scopeResolver;

      mockReaddir.mockImplementation(async (dirPath: unknown) => {
        const p = dirPath as string;
        if (p === '/test/nested-fs') {
          return [{ name: 'src', isFile: () => false, isDirectory: () => true }] as never;
        }
        if (p.endsWith('/src')) {
          return [
            { name: 'app.ts', isFile: () => true, isDirectory: () => false },
            { name: 'generated', isFile: () => false, isDirectory: () => true },
          ] as never;
        }
        if (p.endsWith('/generated')) {
          return [{ name: 'model.ts', isFile: () => true, isDirectory: () => false }] as never;
        }
        return [] as never;
      });
      mockStat.mockResolvedValue({ mtimeMs: Date.now() } as Stats);

      const snapshot = await service.getSnapshot('/test/nested-fs', 'test-project');

      // src/generated was pruned; only src/app.ts remains
      expect(snapshot.metrics.totalFiles).toBe(1);
      expect(snapshot.districts.some((d) => d.path.startsWith('src/generated'))).toBe(false);
    });

    it('nested generated entry "pkg/tests" excludes that district from analysis metrics', async () => {
      mockBaseGit();

      jest
        .spyOn(scopeResolver, 'resolve')
        .mockReturnValue([
          { folder: 'pkg/tests', purpose: 'generated', reason: 'test', origin: 'user' },
        ]);
      jest.spyOn(scopeResolver, 'getExcludedFolders').mockReturnValue([]);
      jest.spyOn(scopeResolver, 'getGeneratedFolders').mockReturnValue(['pkg/tests']);
      (service as unknown as { scopeResolver: ScopeResolverService }).scopeResolver = scopeResolver;

      mockGitCall('src/app.ts\0pkg/tests/suite.ts\0');
      mockGitCall('100\t0\tsrc/app.ts\n80\t0\tpkg/tests/suite.ts\n');
      mockStat.mockResolvedValue({ mtimeMs: Date.now() } as Stats);
      mockGitCall('sha-nested-gen\n');
      mockEmptyChurn();

      const snapshot = await service.getSnapshot('/test/nested-gen', 'test-project');

      // pkg/tests district exists (attribution corpus)
      const genDistrict = snapshot.districts.find((d) => d.path.startsWith('pkg'));
      expect(genDistrict).toBeDefined();

      // but its code-quality analysis metrics are null (excluded from analysisDistrictFilesById)
      expect(genDistrict!.complexityAvg).toBeNull();
      expect(genDistrict!.testCoverageRate).toBeNull();
    });

    it('nested excluded entry "vendor/third_party" contributes to excludedAuthorCount', async () => {
      mockBaseGit();

      jest
        .spyOn(scopeResolver, 'resolve')
        .mockReturnValue([
          { folder: 'vendor/third_party', purpose: 'excluded', reason: 'test', origin: 'user' },
        ]);
      jest.spyOn(scopeResolver, 'getExcludedFolders').mockReturnValue(['vendor/third_party']);
      jest.spyOn(scopeResolver, 'getGeneratedFolders').mockReturnValue([]);
      (service as unknown as { scopeResolver: ScopeResolverService }).scopeResolver = scopeResolver;

      // git ls-files: vendor/third_party is excluded from the file list
      mockGitCall('src/app.ts\0');
      mockGitCall('100\t0\tsrc/app.ts\n');
      mockStat.mockResolvedValue({ mtimeMs: Date.now() } as Stats);
      mockGitCall('sha-nested-vendor\n');

      mockGitCall(''); // churn 1d
      mockGitCall(''); // churn 7d
      mockGitCall(''); // churn 30d
      mockGitCall(''); // daily churn
      // windowed 7d: Dev in src/
      mockGitCall(
        ['COMMIT aaa', '2026-04-20T10:00:00+00:00', 'Dev', '', 'src/app.ts', ''].join('\n'),
      );
      // windowed 30d: Dev in src/, VendorBot only in vendor/third_party
      mockGitCall(
        [
          'COMMIT bbb',
          '2026-04-10T10:00:00+00:00',
          'Dev',
          '',
          'src/app.ts',
          '',
          'COMMIT ccc',
          '2026-04-11T10:00:00+00:00',
          'VendorBot',
          '',
          'vendor/third_party/lib.js',
          '',
        ].join('\n'),
      );

      // getFileAuthorMap: VendorBot only in vendor/third_party, Dev only in src/
      mockGitCall('Dev\n\nsrc/app.ts\n\nVendorBot\n\nvendor/third_party/lib.js\n');

      const snapshot = await service.getSnapshot('/test/nested-vendor', 'test-project');

      // Dev appears in globalContributors (touches non-excluded files)
      expect(snapshot.globalContributors.some((c) => c.authorName === 'Dev')).toBe(true);

      // VendorBot does not appear (only touches excluded nested folder)
      expect(snapshot.globalContributors.some((c) => c.authorName === 'VendorBot')).toBe(false);

      // excludedAuthorCount reflects VendorBot
      expect(snapshot.metrics.excludedAuthorCount).toBe(1);
    });

    it('mixed district hotspot size score derives from analysis LOC, not full attribution LOC', async () => {
      mockBaseGit();

      // src/services has 150 LOC source + 200 LOC generated — hotspot must rank at 150
      jest.spyOn(scopeResolver, 'resolve').mockReturnValue([
        {
          folder: 'src/services/generated',
          purpose: 'generated',
          reason: 'test',
          origin: 'user',
        },
      ]);
      jest.spyOn(scopeResolver, 'getExcludedFolders').mockReturnValue([]);
      jest.spyOn(scopeResolver, 'getGeneratedFolders').mockReturnValue(['src/services/generated']);
      (service as unknown as { scopeResolver: ScopeResolverService }).scopeResolver = scopeResolver;

      mockGitCall('src/services/foo.ts\0src/services/generated/model.ts\0');
      mockGitCall('150\t0\tsrc/services/foo.ts\n200\t0\tsrc/services/generated/model.ts\n');
      mockStat.mockResolvedValue({ mtimeMs: Date.now(), size: 100 } as Stats);
      mockGitCall('sha-hotspot\n');
      mockEmptyChurn();

      const snapshot = await service.getSnapshot('/test/hotspot-mixed', 'test-project');

      const sizeHotspot = snapshot.hotspots.find((h) => h.metric === 'size');
      expect(sizeHotspot).toBeDefined();
      // Score must be 150 (analysis LOC), not 350 (full LOC)
      expect(sizeHotspot!.score).toBe(150);
      expect(sizeHotspot!.label).toContain('150');
    });

    it('nested generated folder inside non-generated district excluded from analysis, kept in attribution', async () => {
      mockBaseGit();

      // src/services is non-generated; src/services/generated is a nested generated folder
      jest.spyOn(scopeResolver, 'resolve').mockReturnValue([
        {
          folder: 'src/services/generated',
          purpose: 'generated',
          reason: 'test',
          origin: 'user',
        },
      ]);
      jest.spyOn(scopeResolver, 'getExcludedFolders').mockReturnValue([]);
      jest.spyOn(scopeResolver, 'getGeneratedFolders').mockReturnValue(['src/services/generated']);
      (service as unknown as { scopeResolver: ScopeResolverService }).scopeResolver = scopeResolver;

      const files = ['src/services/foo.ts', 'src/services/generated/model.ts'];
      mockGitCall(files.join('\0') + '\0');
      mockGitCall('150\t0\tsrc/services/foo.ts\n200\t0\tsrc/services/generated/model.ts\n');
      mockStat.mockResolvedValue({ mtimeMs: Date.now(), size: 100 } as Stats);
      mockGitCall('sha-nested-gen\n');

      mockGitCall(''); // churn 1d
      mockGitCall(''); // churn 7d
      mockGitCall(''); // churn 30d
      mockGitCall(''); // daily churn

      // windowed 7d: Dev touched foo.ts; GenBot touched model.ts
      mockGitCall(
        [
          'COMMIT aaa',
          '2026-04-20T10:00:00+00:00',
          'Dev',
          '',
          'src/services/foo.ts',
          '',
          'COMMIT bbb',
          '2026-04-21T10:00:00+00:00',
          'GenBot',
          '',
          'src/services/generated/model.ts',
          '',
        ].join('\n'),
      );
      // windowed 30d: same
      mockGitCall(
        [
          'COMMIT ccc',
          '2026-04-10T10:00:00+00:00',
          'Dev',
          '',
          'src/services/foo.ts',
          '',
          'COMMIT ddd',
          '2026-04-11T10:00:00+00:00',
          'GenBot',
          '',
          'src/services/generated/model.ts',
          '',
        ].join('\n'),
      );
      // getFileAuthorMap
      mockGitCall('Dev\n\nsrc/services/foo.ts\n\nGenBot\n\nsrc/services/generated/model.ts\n');

      const snapshot = await service.getSnapshot('/test/nested-gen', 'test-project');

      // Both files land in the same district (src/services)
      const svcDistrict = snapshot.districts.find((d) => d.path === 'src/services');
      expect(svcDistrict).toBeDefined();

      // Attribution: district includes both files (total LOC = 150 + 200 = 350)
      expect(svcDistrict!.totalFiles).toBe(2);
      expect(svcDistrict!.totalLOC).toBe(350);

      // Analysis: district IS in hotspot rankings (foo.ts survives analysis)
      const hotspotTargets = snapshot.hotspots.map((h) => h.targetId);
      expect(hotspotTargets).toContain(svcDistrict!.id);

      // Attribution: GenBot appears in globalContributors (model.ts in attribution corpus)
      expect(snapshot.globalContributors.some((c) => c.authorName === 'GenBot')).toBe(true);
    });

    it('coverage_unmeasured: generated-only district produces no warning', async () => {
      mockBaseGit();

      jest
        .spyOn(scopeResolver, 'resolve')
        .mockReturnValue([
          { folder: 'src/generated', purpose: 'generated', reason: 'test', origin: 'user' },
        ]);
      jest.spyOn(scopeResolver, 'getExcludedFolders').mockReturnValue([]);
      jest.spyOn(scopeResolver, 'getGeneratedFolders').mockReturnValue(['src/generated']);
      (service as unknown as { scopeResolver: ScopeResolverService }).scopeResolver = scopeResolver;

      // Only file is in the generated folder; swift = unsupported → testCoverageRate null by design
      mockGitCall('src/generated/model.swift\0');
      mockGitCall('200\t0\tsrc/generated/model.swift\n');
      mockStat.mockResolvedValue({ mtimeMs: Date.now(), size: 100 } as Stats);
      mockGitCall('sha-gen-only\n');
      mockEmptyChurn();

      const snapshot = await service.getSnapshot('/test/gen-only', 'test-project');

      // analysisDistrictFilesById for the generated district is [] → no source files → no warning
      const covWarning = snapshot.metrics.warnings.find((w) => w.code === 'coverage_unmeasured');
      expect(covWarning).toBeUndefined();
    });

    it('coverage_unmeasured: mixed district with unmeasured source file produces warning', async () => {
      mockBaseGit();

      jest.spyOn(scopeResolver, 'resolve').mockReturnValue([
        {
          folder: 'src/services/generated',
          purpose: 'generated',
          reason: 'test',
          origin: 'user',
        },
      ]);
      jest.spyOn(scopeResolver, 'getExcludedFolders').mockReturnValue([]);
      jest.spyOn(scopeResolver, 'getGeneratedFolders').mockReturnValue(['src/services/generated']);
      (service as unknown as { scopeResolver: ScopeResolverService }).scopeResolver = scopeResolver;

      // foo.swift = source file, unsupported language → testCoverageRate null
      // model.ts  = under generated folder → excluded from analysis corpus
      mockGitCall('src/services/foo.swift\0src/services/generated/model.ts\0');
      mockGitCall('150\t0\tsrc/services/foo.swift\n200\t0\tsrc/services/generated/model.ts\n');
      mockStat.mockResolvedValue({ mtimeMs: Date.now(), size: 100 } as Stats);
      mockGitCall('sha-mixed-cov\n');
      mockEmptyChurn();

      const snapshot = await service.getSnapshot('/test/mixed-cov', 'test-project');

      // analysisDistrictFilesById for src/services has foo.swift (source, unmeasured) → warning fires
      const covWarning = snapshot.metrics.warnings.find((w) => w.code === 'coverage_unmeasured');
      expect(covWarning).toBeDefined();
    });
  });

  describe('extractObservedFolders', () => {
    type ScannedFileLike = { path: string; loc: number; lastModified: number };
    const call = (files: ScannedFileLike[]) =>
      (
        service as unknown as { extractObservedFolders(f: ScannedFileLike[]): string[] }
      ).extractObservedFolders(files);

    const f = (path: string): ScannedFileLike => ({ path, loc: 10, lastModified: 0 });

    it('emits nothing for root-level files', () => {
      expect(call([f('README.md'), f('index.ts')])).toEqual([]);
    });

    it('emits the top-level folder for a depth-1 file', () => {
      expect(call([f('src/index.ts')])).toEqual(['src']);
    });

    it('emits ancestor chain for a depth-3 file', () => {
      const result = call([f('src/modules/auth/auth.service.ts')]);
      expect(result).toContain('src');
      expect(result).toContain('src/modules');
      expect(result).toContain('src/modules/auth');
    });

    it('stops at MAX_FOLDER_DEPTH=3 for very deep files', () => {
      // depth-4 file: a/b/c/d/file.ts — should not emit a/b/c/d
      const result = call([f('a/b/c/d/file.ts')]);
      expect(result).toContain('a');
      expect(result).toContain('a/b');
      expect(result).toContain('a/b/c');
      expect(result).not.toContain('a/b/c/d');
    });

    it('deduplicates ancestors across multiple files', () => {
      const result = call([f('src/foo.ts'), f('src/bar.ts'), f('src/utils/helper.ts')]);
      expect(result.filter((p) => p === 'src')).toHaveLength(1);
      expect(result).toContain('src/utils');
    });

    it('handles backslash separators', () => {
      const result = call([f('src\\modules\\auth.ts')]);
      expect(result).toContain('src');
      expect(result).toContain('src/modules');
    });
  });
});
