import { Test, TestingModule } from '@nestjs/testing';
import type {
  DistrictNode,
  DependencyEdge,
  HotspotEntry,
  ActivitySummary,
} from '@devchain/codebase-overview';
import { EvidenceQueryService } from './evidence-query.service';
import type { FileChurnData } from './hotspot-scoring.service';
import type { FileAdapterEnrichment } from './language-adapter-registry.service';

function makeDistrict(
  overrides: Partial<DistrictNode> & { id: string; name: string },
): DistrictNode {
  return {
    regionId: 'region-1',
    path: overrides.name,
    totalFiles: 0,
    totalLOC: 0,
    churn7d: 0,
    churn30d: 0,
    inboundWeight: 0,
    outboundWeight: 0,
    couplingScore: 0,
    testFileCount: 0,
    testFileRatio: null,
    role: 'mixed',
    complexityAvg: null,
    ownershipConcentration: null,
    testCoverageRate: null,
    blastRadius: 0,
    ...overrides,
  };
}

function makeFile(overrides: Partial<FileChurnData> & { path: string }): FileChurnData {
  return {
    loc: 100,
    lastModified: Date.now(),
    churn1d: 0,
    churn7d: 0,
    churn30d: 0,
    isTest: false,
    ...overrides,
  };
}

describe('EvidenceQueryService', () => {
  let service: EvidenceQueryService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [EvidenceQueryService],
    }).compile();

    service = module.get(EvidenceQueryService);
  });

  // -------------------------------------------------------------------------
  // buildTargetDetail
  // -------------------------------------------------------------------------

  describe('buildTargetDetail', () => {
    it('should build a target detail with summary and hotspot reasons', () => {
      const district = makeDistrict({
        id: 'd1',
        name: 'controllers',
        totalLOC: 5000,
        totalFiles: 20,
        churn30d: 42,
        testFileRatio: 0.3,
        role: 'controller',
      });
      const hotspots: HotspotEntry[] = [
        {
          id: 'h1',
          kind: 'district',
          targetId: 'd1',
          metric: 'size',
          rank: 1,
          score: 5000,
          label: 'controllers — 5,000 LOC',
        },
        {
          id: 'h2',
          kind: 'district',
          targetId: 'd1',
          metric: 'churn',
          rank: 3,
          score: 42,
          label: 'controllers — 42 commits in 30d',
        },
      ];
      const activity: ActivitySummary[] = [
        {
          targetId: 'd1',
          targetKind: 'district',
          modifiedCount1d: 2,
          modifiedCount7d: 8,
          buildFailures7d: null,
          testFailures7d: null,
          latestTimestamp: 1700000000,
        },
      ];
      const commits = [{ sha: 'abc', message: 'fix bug', timestamp: 1700000000 }];
      const authors = [{ author: 'Alice', share: 0.6 }];

      const result = service.buildTargetDetail(district, hotspots, activity, [], commits, authors);

      expect(result.targetId).toBe('d1');
      expect(result.kind).toBe('district');
      expect(result.summary).toContain('controllers');
      expect(result.summary).toContain('5,000 LOC');
      expect(result.summary).toContain('controller district');
      expect(result.summary).toContain('42 commits');
      expect(result.summary).toContain('30%');
      expect(result.whyRanked).toHaveLength(2);
      expect(result.whyRanked[0]).toContain('#1');
      expect(result.whyRanked[0]).toContain('size');
      expect(result.whyRanked[1]).toContain('#3');
      expect(result.whyRanked[1]).toContain('churn');
      expect(result.recentCommits).toEqual(commits);
      expect(result.topAuthors).toEqual(authors);
      expect(result.recentActivity).toHaveLength(1);
    });

    it('should omit topInbound and topOutbound when no dependencies exist', () => {
      const district = makeDistrict({ id: 'd1', name: 'a', totalLOC: 100, totalFiles: 1 });

      const result = service.buildTargetDetail(district, [], [], [], [], []);

      expect(result.topInbound).toBeUndefined();
      expect(result.topOutbound).toBeUndefined();
    });

    it('should include topInbound and topOutbound when dependencies exist', () => {
      const district = makeDistrict({ id: 'd1', name: 'a', totalLOC: 100, totalFiles: 1 });
      const deps: DependencyEdge[] = [
        { fromDistrictId: 'd2', toDistrictId: 'd1', weight: 5, isCyclic: false },
        { fromDistrictId: 'd1', toDistrictId: 'd3', weight: 3, isCyclic: false },
      ];

      const result = service.buildTargetDetail(district, [], [], deps, [], []);

      expect(result.topInbound).toHaveLength(1);
      expect(result.topInbound![0].districtId).toBe('d2');
      expect(result.topInbound![0].weight).toBe(5);
      expect(result.topOutbound).toHaveLength(1);
      expect(result.topOutbound![0].districtId).toBe('d3');
    });

    it('should produce summary without role prefix when role is mixed', () => {
      const district = makeDistrict({
        id: 'd1',
        name: 'lib',
        totalLOC: 200,
        totalFiles: 5,
        role: 'mixed',
      });

      const result = service.buildTargetDetail(district, [], [], [], [], []);

      expect(result.summary).toContain('200 LOC district');
      expect(result.summary).not.toContain('mixed district');
    });

    it('should include coupling info in summary when coupling score is non-zero', () => {
      const district = makeDistrict({
        id: 'd1',
        name: 'api',
        totalLOC: 500,
        totalFiles: 10,
        inboundWeight: 8,
        outboundWeight: 3,
        couplingScore: 11,
      });

      const result = service.buildTargetDetail(district, [], [], [], [], []);

      expect(result.summary).toContain('Coupling score is 11');
      expect(result.summary).toContain('8 inbound');
      expect(result.summary).toContain('3 outbound');
    });

    it('should include blastRadius in result when provided and non-empty', () => {
      const district = makeDistrict({
        id: 'd1',
        name: 'core',
        totalLOC: 300,
        totalFiles: 5,
        blastRadius: 2,
      });
      const blastRadius = [
        { districtId: 'd2', depth: 1 },
        { districtId: 'd3', depth: 2 },
      ];

      const result = service.buildTargetDetail(district, [], [], [], [], [], blastRadius);

      expect(result.blastRadius).toEqual(blastRadius);
      expect(result.summary).toContain('Blast radius affects 2 other districts.');
    });

    it('should omit blastRadius when empty array is provided', () => {
      const district = makeDistrict({ id: 'd1', name: 'leaf', totalLOC: 100, totalFiles: 1 });

      const result = service.buildTargetDetail(district, [], [], [], [], [], []);

      expect(result.blastRadius).toBeUndefined();
    });

    it('should use singular "district" in blast radius summary when count is 1', () => {
      const district = makeDistrict({
        id: 'd1',
        name: 'shared',
        totalLOC: 200,
        totalFiles: 3,
        blastRadius: 1,
      });
      const blastRadius = [{ districtId: 'd2', depth: 1 }];

      const result = service.buildTargetDetail(district, [], [], [], [], [], blastRadius);

      expect(result.summary).toContain('Blast radius affects 1 other district.');
      expect(result.summary).not.toContain('districts.');
    });

    it('should include complexity in summary when complexityAvg is set', () => {
      const district = makeDistrict({
        id: 'd1',
        name: 'engine',
        totalLOC: 800,
        totalFiles: 15,
        complexityAvg: 4.2,
      });

      const result = service.buildTargetDetail(district, [], [], [], [], []);

      expect(result.summary).toContain('Average complexity is 4.2.');
    });

    it('should include ownership concentration in summary when set', () => {
      const district = makeDistrict({
        id: 'd1',
        name: 'legacy',
        totalLOC: 600,
        totalFiles: 8,
        ownershipConcentration: 0.75,
      });

      const result = service.buildTargetDetail(district, [], [], [], [], []);

      expect(result.summary).toContain('Ownership concentration is 75%.');
    });

    it('should include all enriched fields in summary when all are present', () => {
      const district = makeDistrict({
        id: 'd1',
        name: 'hub',
        totalLOC: 1000,
        totalFiles: 25,
        churn30d: 10,
        couplingScore: 5,
        inboundWeight: 3,
        outboundWeight: 2,
        complexityAvg: 6.1,
        ownershipConcentration: 0.42,
        blastRadius: 3,
      });

      const result = service.buildTargetDetail(district, [], [], [], [], []);

      expect(result.summary).toContain('Average complexity is 6.1.');
      expect(result.summary).toContain('Ownership concentration is 42%.');
      expect(result.summary).toContain('Blast radius affects 3 other districts.');
      expect(result.summary).toContain('Coupling score is 5');
      expect(result.summary).toContain('10 commits');
    });
  });

  // -------------------------------------------------------------------------
  // buildDependencyPairDetail
  // -------------------------------------------------------------------------

  describe('buildDependencyPairDetail', () => {
    it('should return detail with "no data" summary when no edge exists', () => {
      const result = service.buildDependencyPairDetail(
        'd1',
        'd2',
        [],
        'controllers',
        'services',
        [],
      );

      expect(result).not.toBeNull();
      expect(result!.weight).toBe(0);
      expect(result!.isCyclic).toBe(false);
      expect(result!.summary).toContain('No dependency data');
      expect(result!.summary).toContain('controllers');
      expect(result!.summary).toContain('services');
      expect(result!.exemplarFileEdges).toEqual([]);
    });

    it('should return detail with edge data when dependency exists', () => {
      const deps: DependencyEdge[] = [
        { fromDistrictId: 'd1', toDistrictId: 'd2', weight: 7, isCyclic: false },
      ];

      const result = service.buildDependencyPairDetail(
        'd1',
        'd2',
        deps,
        'controllers',
        'services',
        [],
      );

      expect(result!.weight).toBe(7);
      expect(result!.isCyclic).toBe(false);
      expect(result!.summary).toContain('controllers depends on services');
      expect(result!.summary).toContain('weight 7');
    });

    it('should note cyclic dependency in summary', () => {
      const deps: DependencyEdge[] = [
        { fromDistrictId: 'd1', toDistrictId: 'd2', weight: 4, isCyclic: true },
      ];

      const result = service.buildDependencyPairDetail('d1', 'd2', deps, 'api', 'core', []);

      expect(result!.isCyclic).toBe(true);
      expect(result!.summary).toContain('cyclic');
    });

    it('should include exemplar edges when provided', () => {
      const deps: DependencyEdge[] = [
        { fromDistrictId: 'd1', toDistrictId: 'd2', weight: 3, isCyclic: false },
      ];
      const exemplars = [
        {
          fromFileId: 'f1',
          toFileId: 'f2',
          fromPath: 'src/a/x.ts',
          toPath: 'src/b/y.ts',
          weight: 1,
        },
      ];

      const result = service.buildDependencyPairDetail('d1', 'd2', deps, 'a', 'b', exemplars);

      expect(result!.exemplarFileEdges).toHaveLength(1);
      expect(result!.exemplarFileEdges[0].fromPath).toBe('src/a/x.ts');
    });
  });

  // -------------------------------------------------------------------------
  // buildDistrictFilePage
  // -------------------------------------------------------------------------

  describe('buildDistrictFilePage', () => {
    it('should build a file page with StructureNode items', () => {
      const files = [
        makeFile({ path: 'src/app.ts', loc: 200, churn7d: 3, churn30d: 10 }),
        makeFile({ path: 'src/app.test.ts', loc: 50, churn7d: 1, churn30d: 4, isTest: true }),
      ];
      const fileIds = new Map([
        ['src/app.ts', 'uuid-1'],
        ['src/app.test.ts', 'uuid-2'],
      ]);
      const allPaths = new Set(files.map((f) => f.path));

      const result = service.buildDistrictFilePage('d1', files, fileIds, allPaths);

      expect(result.districtId).toBe('d1');
      expect(result.items).toHaveLength(2);
      expect(result.nextCursor).toBeNull();

      const appNode = result.items[0];
      expect(appNode.id).toBe('uuid-1');
      expect(appNode.districtId).toBe('d1');
      expect(appNode.path).toBe('src/app.ts');
      expect(appNode.role).toBe('unknown');
      expect(appNode.loc).toBe(200);
      expect(appNode.metrics.churn7d).toBe(3);
      expect(appNode.metrics.churn30d).toBe(10);
      expect(appNode.metrics.hasColocatedTest).toBe(true);
      expect(appNode.metrics.symbolCount).toBeNull();
      expect(appNode.metrics.complexity).toBeNull();
      expect(appNode.metrics.coverage).toBeNull();

      const testNode = result.items[1];
      expect(testNode.role).toBe('test');
      expect(testNode.metrics.hasColocatedTest).toBe(false);
    });

    it('should paginate with cursor', () => {
      const files = Array.from({ length: 60 }, (_, i) => makeFile({ path: `src/file${i}.ts` }));
      const fileIds = new Map(files.map((f) => [f.path, f.path]));
      const allPaths = new Set(files.map((f) => f.path));

      // First page
      const page1 = service.buildDistrictFilePage('d1', files, fileIds, allPaths);
      expect(page1.items).toHaveLength(50);
      expect(page1.nextCursor).toBe('50');

      // Second page
      const page2 = service.buildDistrictFilePage('d1', files, fileIds, allPaths, '50');
      expect(page2.items).toHaveLength(10);
      expect(page2.nextCursor).toBeNull();
    });

    it('should return empty items for empty files', () => {
      const result = service.buildDistrictFilePage('d1', [], new Map(), new Set());

      expect(result.items).toEqual([]);
      expect(result.nextCursor).toBeNull();
    });

    it('should compute staleDays from lastModified', () => {
      const nowMs = Date.now();
      const files = [makeFile({ path: 'src/old.ts', lastModified: nowMs - 30 * 86400000 })];
      const fileIds = new Map([['src/old.ts', 'uuid-1']]);

      const result = service.buildDistrictFilePage('d1', files, fileIds, new Set(['src/old.ts']));

      expect(result.items[0].metrics.staleDays).toBeGreaterThanOrEqual(29);
    });

    it('should detect colocated tests via naming convention', () => {
      const files = [
        makeFile({ path: 'src/utils.ts' }),
        makeFile({ path: 'src/utils.spec.ts', isTest: true }),
        makeFile({ path: 'src/orphan.ts' }),
      ];
      const fileIds = new Map(files.map((f) => [f.path, f.path]));
      const allPaths = new Set(files.map((f) => f.path));

      const result = service.buildDistrictFilePage('d1', files, fileIds, allPaths);

      expect(result.items[0].metrics.hasColocatedTest).toBe(true); // utils.ts
      expect(result.items[1].metrics.hasColocatedTest).toBe(false); // test file itself
      expect(result.items[2].metrics.hasColocatedTest).toBe(false); // orphan.ts
    });

    it('should classify file roles correctly', () => {
      const files = [
        makeFile({ path: 'src/user.service.ts' }),
        makeFile({ path: 'src/app.controller.ts' }),
        makeFile({ path: 'src/Button.tsx' }),
      ];
      const fileIds = new Map(files.map((f) => [f.path, f.path]));

      const result = service.buildDistrictFilePage('d1', files, fileIds, new Set());

      expect(result.items[0].role).toBe('service');
      expect(result.items[1].role).toBe('controller');
      expect(result.items[2].role).toBe('view');
    });

    it('should populate complexity and symbolCount from fileEnrichments', () => {
      const files = [makeFile({ path: 'src/engine.ts', loc: 300 })];
      const fileIds = new Map([['src/engine.ts', 'uuid-e']]);
      const enrichments: ReadonlyMap<string, FileAdapterEnrichment> = new Map([
        ['src/engine.ts', { role: 'service', symbolCount: 12, complexity: 8, testPair: null }],
      ]);

      const result = service.buildDistrictFilePage(
        'd1',
        files,
        fileIds,
        new Set(['src/engine.ts']),
        undefined,
        enrichments,
      );

      expect(result.items[0].metrics.complexity).toBe(8);
      expect(result.items[0].metrics.symbolCount).toBe(12);
    });

    it('should use adapter role over path-based classification when enrichment exists', () => {
      const files = [makeFile({ path: 'src/handler.ts' })];
      const fileIds = new Map([['src/handler.ts', 'uuid-h']]);
      const enrichments: ReadonlyMap<string, FileAdapterEnrichment> = new Map([
        ['src/handler.ts', { role: 'controller', symbolCount: 3, complexity: 2, testPair: null }],
      ]);

      const result = service.buildDistrictFilePage(
        'd1',
        files,
        fileIds,
        new Set(['src/handler.ts']),
        undefined,
        enrichments,
      );

      // Path-based would classify as 'unknown', but adapter says 'controller'
      expect(result.items[0].role).toBe('controller');
    });

    it('should set hasColocatedTest true when adapter testPair is set', () => {
      const files = [makeFile({ path: 'src/utils.ts' })];
      const fileIds = new Map([['src/utils.ts', 'uuid-u']]);
      const enrichments: ReadonlyMap<string, FileAdapterEnrichment> = new Map([
        [
          'src/utils.ts',
          { role: null, symbolCount: 5, complexity: 3, testPair: 'src/utils.spec.ts' },
        ],
      ]);

      const result = service.buildDistrictFilePage(
        'd1',
        files,
        fileIds,
        new Set(['src/utils.ts']),
        undefined,
        enrichments,
      );

      // Adapter detected test pair, even though the spec file isn't in allDistrictPaths
      expect(result.items[0].metrics.hasColocatedTest).toBe(true);
    });

    it('should fall back to path-based role when adapter role is null', () => {
      const files = [makeFile({ path: 'src/user.service.ts' })];
      const fileIds = new Map([['src/user.service.ts', 'uuid-s']]);
      const enrichments: ReadonlyMap<string, FileAdapterEnrichment> = new Map([
        ['src/user.service.ts', { role: null, symbolCount: 4, complexity: 2, testPair: null }],
      ]);

      const result = service.buildDistrictFilePage(
        'd1',
        files,
        fileIds,
        new Set(['src/user.service.ts']),
        undefined,
        enrichments,
      );

      // Adapter role is null, so path-based classification kicks in → 'service'
      expect(result.items[0].role).toBe('service');
    });
  });
});
