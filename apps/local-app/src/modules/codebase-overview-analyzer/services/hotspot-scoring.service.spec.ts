import { Test, TestingModule } from '@nestjs/testing';
import type { DistrictNode } from '@devchain/codebase-overview';
import { HotspotScoringService, isTestFile, type FileChurnData } from './hotspot-scoring.service';
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
    primaryAuthorName: null,
    primaryAuthorShare: null,
    primaryAuthorRecentlyActive: false,
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

describe('HotspotScoringService', () => {
  let service: HotspotScoringService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [HotspotScoringService],
    }).compile();

    service = module.get(HotspotScoringService);
  });

  // -------------------------------------------------------------------------
  // isTestFile
  // -------------------------------------------------------------------------

  describe('isTestFile', () => {
    it.each([
      ['src/app.test.ts', true],
      ['src/app.spec.ts', true],
      ['src/app.test.js', true],
      ['src/app.spec.jsx', true],
      ['src/app_test.py', true],
      ['src/app-spec.rb', true],
      ['src/__tests__/app.ts', true],
      ['tests/unit/app.ts', true],
      ['test/app.ts', true],
      ['src/app.ts', false],
      ['src/testing-utils.ts', false],
      ['src/contest.ts', false],
      ['src/attestation.ts', false],
    ])('should classify %s as test=%s', (path, expected) => {
      expect(isTestFile(path)).toBe(expected);
    });
  });

  // -------------------------------------------------------------------------
  // enrichDistrictMetrics
  // -------------------------------------------------------------------------

  describe('enrichDistrictMetrics', () => {
    it('should populate churn and test metrics from file data', () => {
      const district = makeDistrict({ id: 'd1', name: 'controllers', totalFiles: 3 });
      const files = new Map([
        [
          'd1',
          [
            makeFile({ path: 'src/a.ts', churn7d: 2, churn30d: 5, isTest: false }),
            makeFile({ path: 'src/b.ts', churn7d: 1, churn30d: 3, isTest: false }),
            makeFile({ path: 'src/a.test.ts', churn7d: 0, churn30d: 1, isTest: true }),
          ],
        ],
      ]);

      service.enrichDistrictMetrics([district], files);

      expect(district.churn7d).toBe(3);
      expect(district.churn30d).toBe(9);
      expect(district.testFileCount).toBe(1);
      expect(district.testFileRatio).toBeCloseTo(1 / 3);
      // Only 1 known-role file (test), unknown files excluded from denominator → test
      expect(district.role).toBe('test');
    });

    it('should set role to test when majority of files are tests', () => {
      const district = makeDistrict({ id: 'd1', name: 'tests', totalFiles: 3 });
      const files = new Map([
        [
          'd1',
          [
            makeFile({ path: 'test/a.test.ts', isTest: true }),
            makeFile({ path: 'test/b.test.ts', isTest: true }),
            makeFile({ path: 'test/helpers.ts', isTest: false }),
          ],
        ],
      ]);

      service.enrichDistrictMetrics([district], files);

      expect(district.testFileCount).toBe(2);
      expect(district.testFileRatio).toBeCloseTo(2 / 3);
      expect(district.role).toBe('test');
    });

    it('should set role to service when majority of files are services', () => {
      const district = makeDistrict({ id: 'd1', name: 'services', totalFiles: 3 });
      const files = new Map([
        [
          'd1',
          [
            makeFile({ path: 'src/user.service.ts', isTest: false }),
            makeFile({ path: 'src/auth.service.ts', isTest: false }),
            makeFile({ path: 'src/constants.ts', isTest: false }),
          ],
        ],
      ]);

      service.enrichDistrictMetrics([district], files);

      expect(district.role).toBe('service');
    });

    it('should set role to mixed when no role dominates', () => {
      const district = makeDistrict({ id: 'd1', name: 'mixed', totalFiles: 4 });
      const files = new Map([
        [
          'd1',
          [
            makeFile({ path: 'src/app.service.ts', isTest: false }),
            makeFile({ path: 'src/app.controller.ts', isTest: false }),
            makeFile({ path: 'src/app.test.ts', isTest: true }),
            makeFile({ path: 'src/app.module.ts', isTest: false }),
          ],
        ],
      ]);

      service.enrichDistrictMetrics([district], files);

      expect(district.role).toBe('mixed');
    });

    it('should set dominant role based on known-role files, ignoring unknowns in denominator', () => {
      const district = makeDistrict({ id: 'd1', name: 'mostly-unknown', totalFiles: 10 });
      // 3 services + 7 unknown-role files (e.g., .json, .md, plain .ts without role suffix)
      const files = new Map([
        [
          'd1',
          [
            makeFile({ path: 'src/user.service.ts' }),
            makeFile({ path: 'src/auth.service.ts' }),
            makeFile({ path: 'src/cache.service.ts' }),
            makeFile({ path: 'src/data.json' }),
            makeFile({ path: 'src/readme.md' }),
            makeFile({ path: 'src/index.ts' }),
            makeFile({ path: 'src/main.ts' }),
            makeFile({ path: 'src/bootstrap.ts' }),
            makeFile({ path: 'src/env.ts' }),
            makeFile({ path: 'src/constants.ts' }),
          ],
        ],
      ]);

      service.enrichDistrictMetrics([district], files);

      // 3 services out of 3 known-role files = 100% → service, not mixed
      expect(district.role).toBe('service');
    });

    it('should set role to mixed when all files have unknown role', () => {
      const district = makeDistrict({ id: 'd1', name: 'unknown-only', totalFiles: 3 });
      const files = new Map([
        [
          'd1',
          [
            makeFile({ path: 'src/index.ts' }),
            makeFile({ path: 'src/main.ts' }),
            makeFile({ path: 'src/constants.ts' }),
          ],
        ],
      ]);

      service.enrichDistrictMetrics([district], files);

      expect(district.role).toBe('mixed');
    });

    it('should set testFileRatio to null when district has no files', () => {
      const district = makeDistrict({ id: 'd1', name: 'empty', totalFiles: 0 });
      const files = new Map<string, FileChurnData[]>();

      service.enrichDistrictMetrics([district], files);

      expect(district.testFileRatio).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // rankHotspots
  // -------------------------------------------------------------------------

  describe('rankHotspots', () => {
    it('should return empty array for empty districts', () => {
      expect(service.rankHotspots([], new Map())).toEqual([]);
    });

    it('should produce size hotspots ranked by LOC from districtFiles', () => {
      const districts = [
        makeDistrict({ id: 'd1', name: 'big' }),
        makeDistrict({ id: 'd2', name: 'medium' }),
        makeDistrict({ id: 'd3', name: 'small' }),
      ];
      const files = new Map([
        ['d1', [makeFile({ path: 'a.ts', loc: 5000 })]],
        ['d2', [makeFile({ path: 'b.ts', loc: 2000 })]],
        ['d3', [makeFile({ path: 'c.ts', loc: 500 })]],
      ]);

      const hotspots = service.rankHotspots(districts, files);
      const sizeEntries = hotspots.filter((h) => h.metric === 'size');

      expect(sizeEntries.length).toBe(3);
      expect(sizeEntries[0].targetId).toBe('d1');
      expect(sizeEntries[0].rank).toBe(1);
      expect(sizeEntries[0].score).toBe(5000);
      expect(sizeEntries[1].targetId).toBe('d2');
      expect(sizeEntries[1].rank).toBe(2);
      expect(sizeEntries[2].targetId).toBe('d3');
      expect(sizeEntries[2].rank).toBe(3);
    });

    it('should produce churn hotspots ranked by churn30d', () => {
      const districts = [
        makeDistrict({ id: 'd1', name: 'hot', churn30d: 50 }),
        makeDistrict({ id: 'd2', name: 'cold', churn30d: 0 }),
        makeDistrict({ id: 'd3', name: 'warm', churn30d: 10 }),
      ];
      const files = new Map<string, FileChurnData[]>();

      const hotspots = service.rankHotspots(districts, files);
      const churnEntries = hotspots.filter((h) => h.metric === 'churn');

      expect(churnEntries.length).toBe(2); // d2 excluded (score 0)
      expect(churnEntries[0].targetId).toBe('d1');
      expect(churnEntries[0].score).toBe(50);
      expect(churnEntries[1].targetId).toBe('d3');
    });

    it('should produce test risk hotspots ranked by missing test ratio', () => {
      const districts = [
        makeDistrict({ id: 'd1', name: 'untested', totalFiles: 5, testFileRatio: 0 }),
        makeDistrict({ id: 'd2', name: 'tested', totalFiles: 5, testFileRatio: 0.6 }),
        makeDistrict({ id: 'd3', name: 'partial', totalFiles: 5, testFileRatio: 0.2 }),
      ];
      const files = new Map<string, FileChurnData[]>();

      const hotspots = service.rankHotspots(districts, files);
      const testEntries = hotspots.filter((h) => h.metric === 'tests');

      expect(testEntries.length).toBe(3);
      // Highest risk first (100% = 0% tests)
      expect(testEntries[0].targetId).toBe('d1');
      expect(testEntries[0].score).toBe(100);
      // Then partial (80% risk = 20% tests)
      expect(testEntries[1].targetId).toBe('d3');
      expect(testEntries[1].score).toBe(80);
      // Then tested (40% risk = 60% tests)
      expect(testEntries[2].targetId).toBe('d2');
      expect(testEntries[2].score).toBe(40);
    });

    it('should produce staleness hotspots from file timestamps', () => {
      const nowMs = Date.now();
      const d1Files = [
        makeFile({ path: 'a.ts', lastModified: nowMs - 90 * 86400000 }), // 90 days old
      ];
      const d2Files = [
        makeFile({ path: 'b.ts', lastModified: nowMs - 5 * 86400000 }), // 5 days old
      ];

      const districts = [
        makeDistrict({ id: 'd1', name: 'stale', totalLOC: 1 }),
        makeDistrict({ id: 'd2', name: 'fresh', totalLOC: 1 }),
      ];
      const files = new Map([
        ['d1', d1Files],
        ['d2', d2Files],
      ]);

      const hotspots = service.rankHotspots(districts, files);
      const stalenessEntries = hotspots.filter((h) => h.metric === 'staleness');

      expect(stalenessEntries.length).toBe(2);
      expect(stalenessEntries[0].targetId).toBe('d1'); // staler first
      expect(stalenessEntries[0].score).toBeGreaterThanOrEqual(89);
      expect(stalenessEntries[1].targetId).toBe('d2');
      expect(stalenessEntries[1].score).toBeGreaterThanOrEqual(4);
    });

    it('should limit hotspots to top 10 per metric', () => {
      const districts = Array.from({ length: 15 }, (_, i) =>
        makeDistrict({ id: `d${i}`, name: `district-${i}` }),
      );
      const files = new Map(
        districts.map((d, i) => [d.id, [makeFile({ path: `${d.id}.ts`, loc: (15 - i) * 100 })]]),
      );

      const hotspots = service.rankHotspots(districts, files);
      const sizeEntries = hotspots.filter((h) => h.metric === 'size');

      expect(sizeEntries.length).toBe(10);
      expect(sizeEntries[0].rank).toBe(1);
      expect(sizeEntries[9].rank).toBe(10);
    });

    it('should not include coupling hotspots (dependency data unavailable)', () => {
      const districts = [makeDistrict({ id: 'd1', name: 'a', totalLOC: 100 })];
      const hotspots = service.rankHotspots(districts, new Map());

      expect(hotspots.filter((h) => h.metric === 'coupling')).toEqual([]);
    });

    it('should skip zero-score entries', () => {
      const districts = [makeDistrict({ id: 'd1', name: 'empty', totalLOC: 0, churn30d: 0 })];
      const hotspots = service.rankHotspots(districts, new Map());

      expect(hotspots.filter((h) => h.metric === 'size')).toEqual([]);
      expect(hotspots.filter((h) => h.metric === 'churn')).toEqual([]);
    });

    it('should produce deterministic rank ordering with explicit scores', () => {
      const districts = [
        makeDistrict({ id: 'd1', name: 'alpha', churn30d: 10 }),
        makeDistrict({ id: 'd2', name: 'beta', churn30d: 5 }),
        makeDistrict({ id: 'd3', name: 'gamma', churn30d: 20 }),
      ];
      const files = new Map([
        ['d1', [makeFile({ path: 'a.ts', loc: 300 })]],
        ['d2', [makeFile({ path: 'b.ts', loc: 500 })]],
        ['d3', [makeFile({ path: 'c.ts', loc: 100 })]],
      ]);

      const hotspots = service.rankHotspots(districts, files);

      // Size: beta (500) > alpha (300) > gamma (100)
      const sizeEntries = hotspots.filter((h) => h.metric === 'size');
      expect(sizeEntries.map((h) => h.targetId)).toEqual(['d2', 'd1', 'd3']);
      expect(sizeEntries.map((h) => h.rank)).toEqual([1, 2, 3]);

      // Churn: gamma (20) > alpha (10) > beta (5)
      const churnEntries = hotspots.filter((h) => h.metric === 'churn');
      expect(churnEntries.map((h) => h.targetId)).toEqual(['d3', 'd1', 'd2']);
      expect(churnEntries.map((h) => h.rank)).toEqual([1, 2, 3]);
    });

    it('should generate unique IDs per metric and rank', () => {
      const districts = [
        makeDistrict({ id: 'd1', name: 'a', totalLOC: 200, churn30d: 5 }),
        makeDistrict({ id: 'd2', name: 'b', totalLOC: 100, churn30d: 10 }),
      ];

      const hotspots = service.rankHotspots(districts, new Map());

      const ids = hotspots.map((h) => h.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);
      expect(ids.every((id) => id.startsWith('hotspot:'))).toBe(true);
    });

    it('should include labels with human-readable descriptions', () => {
      const districts = [
        makeDistrict({
          id: 'd1',
          name: 'controllers',
          totalFiles: 10,
          churn30d: 42,
          testFileRatio: 0.2,
        }),
      ];
      // 5 files totalling 5000 LOC; 1 isTest to produce testFileRatio=0.2 via pre-enriched field
      const files = new Map([
        [
          'd1',
          [
            makeFile({ path: 'a.ts', loc: 1000 }),
            makeFile({ path: 'b.ts', loc: 1000 }),
            makeFile({ path: 'c.ts', loc: 1000 }),
            makeFile({ path: 'd.ts', loc: 1000 }),
            makeFile({ path: 'e.ts', loc: 1000 }),
          ],
        ],
      ]);

      const hotspots = service.rankHotspots(districts, files);

      const sizeEntry = hotspots.find((h) => h.metric === 'size');
      expect(sizeEntry!.label).toContain('controllers');
      expect(sizeEntry!.label).toContain('5,000');
      expect(sizeEntry!.label).toContain('LOC');

      const churnEntry = hotspots.find((h) => h.metric === 'churn');
      expect(churnEntry!.label).toContain('42');
      expect(churnEntry!.label).toContain('30d');

      const testEntry = hotspots.find((h) => h.metric === 'tests');
      expect(testEntry!.label).toContain('20%');
    });

    it('should rank exactly 10 districts at the boundary', () => {
      const districts = Array.from({ length: 10 }, (_, i) =>
        makeDistrict({ id: `d${i}`, name: `d-${i}` }),
      );
      const files = new Map(
        districts.map((d, i) => [d.id, [makeFile({ path: `${d.id}.ts`, loc: (10 - i) * 100 })]]),
      );

      const hotspots = service.rankHotspots(districts, files);
      const sizeEntries = hotspots.filter((h) => h.metric === 'size');

      expect(sizeEntries.length).toBe(10);
      expect(sizeEntries[9].rank).toBe(10);
      expect(sizeEntries[9].targetId).toBe('d9');
    });

    it('should handle mixed partial data across metrics', () => {
      const nowMs = Date.now();
      const districts = [
        makeDistrict({
          id: 'd1',
          name: 'big-stale',
          churn30d: 0,
          totalFiles: 5,
          testFileRatio: 0.8,
        }),
        makeDistrict({
          id: 'd2',
          name: 'small-active',
          churn30d: 50,
          totalFiles: 5,
          testFileRatio: 0,
        }),
      ];
      const files = new Map([
        ['d1', [makeFile({ path: 'a.ts', loc: 5000, lastModified: nowMs - 90 * 86400000 })]],
        ['d2', [makeFile({ path: 'b.ts', loc: 100, lastModified: nowMs - 1 * 86400000 })]],
      ]);

      const hotspots = service.rankHotspots(districts, files);

      // d1 wins size, d2 wins churn, d2 wins test risk, d1 wins staleness
      const size = hotspots.filter((h) => h.metric === 'size');
      expect(size[0].targetId).toBe('d1');

      const churn = hotspots.filter((h) => h.metric === 'churn');
      expect(churn.length).toBe(1);
      expect(churn[0].targetId).toBe('d2');

      const tests = hotspots.filter((h) => h.metric === 'tests');
      expect(tests[0].targetId).toBe('d2'); // 100% risk (0% tests)

      const staleness = hotspots.filter((h) => h.metric === 'staleness');
      expect(staleness[0].targetId).toBe('d1'); // 90 days old
    });
  });

  // -------------------------------------------------------------------------
  // computeActivitySummaries
  // -------------------------------------------------------------------------

  describe('computeActivitySummaries', () => {
    it('should compute modified file counts from churn data', () => {
      const districts = [makeDistrict({ id: 'd1', name: 'active' })];
      const files = new Map([
        [
          'd1',
          [
            makeFile({ path: 'a.ts', churn1d: 2, churn7d: 5 }),
            makeFile({ path: 'b.ts', churn1d: 0, churn7d: 1 }),
            makeFile({ path: 'c.ts', churn1d: 0, churn7d: 0 }),
          ],
        ],
      ]);

      const summaries = service.computeActivitySummaries(districts, files);

      expect(summaries.length).toBe(1);
      expect(summaries[0].targetId).toBe('d1');
      expect(summaries[0].targetKind).toBe('district');
      expect(summaries[0].modifiedCount1d).toBe(1);
      expect(summaries[0].modifiedCount7d).toBe(2);
      expect(summaries[0].buildFailures7d).toBeNull();
      expect(summaries[0].testFailures7d).toBeNull();
    });

    it('should compute latestTimestamp from file lastModified', () => {
      const nowMs = Date.now();
      const districts = [makeDistrict({ id: 'd1', name: 'a' })];
      const files = new Map([
        [
          'd1',
          [
            makeFile({ path: 'a.ts', lastModified: nowMs - 86400000 }),
            makeFile({ path: 'b.ts', lastModified: nowMs }),
          ],
        ],
      ]);

      const summaries = service.computeActivitySummaries(districts, files);

      expect(summaries[0].latestTimestamp).toBe(Math.floor(nowMs / 1000));
    });

    it('should return null latestTimestamp when district has no files', () => {
      const districts = [makeDistrict({ id: 'd1', name: 'empty' })];
      const files = new Map<string, FileChurnData[]>();

      const summaries = service.computeActivitySummaries(districts, files);

      expect(summaries[0].latestTimestamp).toBeNull();
      expect(summaries[0].modifiedCount1d).toBe(0);
      expect(summaries[0].modifiedCount7d).toBe(0);
    });

    it('should produce one summary per district', () => {
      const districts = [
        makeDistrict({ id: 'd1', name: 'a' }),
        makeDistrict({ id: 'd2', name: 'b' }),
        makeDistrict({ id: 'd3', name: 'c' }),
      ];
      const files = new Map<string, FileChurnData[]>();

      const summaries = service.computeActivitySummaries(districts, files);

      expect(summaries.length).toBe(3);
      expect(summaries.map((s) => s.targetId)).toEqual(['d1', 'd2', 'd3']);
    });

    it('should count all files as modified when all have churn', () => {
      const districts = [makeDistrict({ id: 'd1', name: 'busy' })];
      const files = new Map([
        [
          'd1',
          [
            makeFile({ path: 'a.ts', churn1d: 1, churn7d: 3 }),
            makeFile({ path: 'b.ts', churn1d: 2, churn7d: 5 }),
            makeFile({ path: 'c.ts', churn1d: 1, churn7d: 1 }),
          ],
        ],
      ]);

      const summaries = service.computeActivitySummaries(districts, files);

      expect(summaries[0].modifiedCount1d).toBe(3);
      expect(summaries[0].modifiedCount7d).toBe(3);
    });

    it('should pick the most recent timestamp across all files', () => {
      const nowMs = Date.now();
      const districts = [makeDistrict({ id: 'd1', name: 'multi' })];
      const files = new Map([
        [
          'd1',
          [
            makeFile({ path: 'a.ts', lastModified: nowMs - 86400000 * 10 }),
            makeFile({ path: 'b.ts', lastModified: nowMs - 86400000 * 2 }),
            makeFile({ path: 'c.ts', lastModified: nowMs - 86400000 * 5 }),
          ],
        ],
      ]);

      const summaries = service.computeActivitySummaries(districts, files);

      // Should pick the most recent (2 days ago)
      const expected = Math.floor((nowMs - 86400000 * 2) / 1000);
      expect(summaries[0].latestTimestamp).toBe(expected);
    });

    it('should populate dailyChurn from daily churn file map', () => {
      const districts = [
        makeDistrict({ id: 'd1', name: 'alpha' }),
        makeDistrict({ id: 'd2', name: 'beta' }),
        makeDistrict({ id: 'd3', name: 'gamma' }),
      ];
      const files = new Map([
        ['d1', [makeFile({ path: 'a.ts' }), makeFile({ path: 'b.ts' })]],
        ['d2', [makeFile({ path: 'c.ts' })]],
        ['d3', [makeFile({ path: 'd.ts' })]],
      ]);

      const dailyChurnFileMap = new Map<string, ReadonlyMap<string, number>>([
        [
          'a.ts',
          new Map([
            ['2026-04-20', 3],
            ['2026-04-21', 1],
          ]),
        ],
        ['b.ts', new Map([['2026-04-20', 2]])],
        ['c.ts', new Map([['2026-04-22', 5]])],
        // d.ts has no daily churn data
      ]);

      const summaries = service.computeActivitySummaries(districts, files, dailyChurnFileMap);

      // d1: a.ts (3 + 1 on 20th/21st) + b.ts (2 on 20th) → 20th: 5, 21st: 1
      const d1 = summaries.find((s) => s.targetId === 'd1')!;
      expect(d1.dailyChurn).toBeDefined();
      expect(d1.dailyChurn!['2026-04-20']).toBe(5); // 3 + 2
      expect(d1.dailyChurn!['2026-04-21']).toBe(1);

      // d2: c.ts → 2026-04-22: 5
      const d2 = summaries.find((s) => s.targetId === 'd2')!;
      expect(d2.dailyChurn).toBeDefined();
      expect(d2.dailyChurn!['2026-04-22']).toBe(5);

      // d3: d.ts has no data → no dailyChurn
      const d3 = summaries.find((s) => s.targetId === 'd3')!;
      expect(d3.dailyChurn).toBeUndefined();
    });

    it('should not set dailyChurn when dailyChurnFileMap is null', () => {
      const districts = [makeDistrict({ id: 'd1', name: 'a' })];
      const files = new Map([['d1', [makeFile({ path: 'a.ts' })]]]);

      const summaries = service.computeActivitySummaries(districts, files, null);

      expect(summaries[0].dailyChurn).toBeUndefined();
    });

    it('should not set dailyChurn when dailyChurnFileMap is undefined', () => {
      const districts = [makeDistrict({ id: 'd1', name: 'a' })];
      const files = new Map([['d1', [makeFile({ path: 'a.ts' })]]]);

      const summaries = service.computeActivitySummaries(districts, files);

      expect(summaries[0].dailyChurn).toBeUndefined();
    });

    it('should skip days with zero touches in dailyChurn', () => {
      const districts = [makeDistrict({ id: 'd1', name: 'a' })];
      const files = new Map([['d1', [makeFile({ path: 'a.ts' })]]]);

      const dailyChurnFileMap = new Map<string, ReadonlyMap<string, number>>([
        ['a.ts', new Map([['2026-04-20', 1]])],
      ]);

      const summaries = service.computeActivitySummaries(districts, files, dailyChurnFileMap);

      expect(summaries[0].dailyChurn).toEqual({ '2026-04-20': 1 });
    });
  });

  // -------------------------------------------------------------------------
  // enrichDistrictAdapterMetrics
  // -------------------------------------------------------------------------

  describe('enrichDistrictAdapterMetrics', () => {
    it('should compute complexityAvg from adapter enrichments', () => {
      const districts = [makeDistrict({ id: 'd1', name: 'complex' })];
      const files = new Map([['d1', [makeFile({ path: 'a.ts' }), makeFile({ path: 'b.ts' })]]]);
      const enrichments = new Map([
        ['a.ts', { role: null, symbolCount: null, complexity: 10, testPair: null }],
        ['b.ts', { role: null, symbolCount: null, complexity: 20, testPair: null }],
      ]);

      service.enrichDistrictAdapterMetrics(districts, files, enrichments);

      expect(districts[0].complexityAvg).toBe(15);
    });

    it('should compute testCoverageRate from adapter test pairs', () => {
      const districts = [makeDistrict({ id: 'd1', name: 'tested' })];
      const files = new Map([
        [
          'd1',
          [
            makeFile({ path: 'a.ts', isTest: false }),
            makeFile({ path: 'b.ts', isTest: false }),
            makeFile({ path: 'a.test.ts', isTest: true }),
          ],
        ],
      ]);
      const enrichments = new Map([
        ['a.ts', { role: null, symbolCount: null, complexity: null, testPair: 'a.test.ts' }],
        ['b.ts', { role: null, symbolCount: null, complexity: null, testPair: null }],
        ['a.test.ts', { role: null, symbolCount: null, complexity: null, testPair: 'a.ts' }],
      ]);

      service.enrichDistrictAdapterMetrics(districts, files, enrichments);

      // 1 out of 2 source files has a test pair → 0.5
      expect(districts[0].testCoverageRate).toBe(0.5);
    });

    it('should return null complexityAvg when no files have complexity data', () => {
      const districts = [makeDistrict({ id: 'd1', name: 'none' })];
      const files = new Map([['d1', [makeFile({ path: 'a.md' })]]]);
      const enrichments = new Map();

      service.enrichDistrictAdapterMetrics(districts, files, enrichments);

      expect(districts[0].complexityAvg).toBeNull();
    });

    it('should return null testCoverageRate when district has only test files', () => {
      const districts = [makeDistrict({ id: 'd1', name: 'all-tests' })];
      const files = new Map([
        [
          'd1',
          [
            makeFile({ path: 'a.test.ts', isTest: true }),
            makeFile({ path: 'b.spec.ts', isTest: true }),
          ],
        ],
      ]);
      const enrichments = new Map([
        [
          'a.test.ts',
          { role: 'test' as const, symbolCount: null, complexity: null, testPair: null },
        ],
        [
          'b.spec.ts',
          { role: 'test' as const, symbolCount: null, complexity: null, testPair: null },
        ],
      ]);

      service.enrichDistrictAdapterMetrics(districts, files, enrichments);

      // No source files → testCoverageRate should be null
      expect(districts[0].testCoverageRate).toBeNull();
    });

    it('should return null testCoverageRate when source files have no adapter enrichment', () => {
      const districts = [makeDistrict({ id: 'd1', name: 'go-only' })];
      const files = new Map([
        ['d1', [makeFile({ path: 'main.go' }), makeFile({ path: 'handler.go' })]],
      ]);
      const enrichments = new Map<string, FileAdapterEnrichment>();

      service.enrichDistrictAdapterMetrics(districts, files, enrichments);

      expect(districts[0].testCoverageRate).toBeNull();
    });

    it('should compute testCoverageRate over adapter-measured files only', () => {
      const districts = [makeDistrict({ id: 'd1', name: 'mixed-lang' })];
      const files = new Map([
        [
          'd1',
          [
            makeFile({ path: 'svc.ts' }),
            makeFile({ path: 'svc2.ts' }),
            makeFile({ path: 'handler.go' }),
          ],
        ],
      ]);
      // Only TS files have adapter enrichment; Go file has none
      const enrichments = new Map<string, FileAdapterEnrichment>([
        ['svc.ts', { role: null, symbolCount: null, complexity: null, testPair: 'svc.spec.ts' }],
        ['svc2.ts', { role: null, symbolCount: null, complexity: null, testPair: null }],
      ]);

      service.enrichDistrictAdapterMetrics(districts, files, enrichments);

      // 1 enriched-with-test-pair / 2 enriched-source-files = 0.5 (not 1/3)
      expect(districts[0].testCoverageRate).toBe(0.5);
    });

    it('should skip districts with empty file list', () => {
      const districts = [
        makeDistrict({ id: 'd1', name: 'has-files' }),
        makeDistrict({ id: 'd2', name: 'no-files' }),
      ];
      const files = new Map([['d1', [makeFile({ path: 'a.ts' })]]]);
      const enrichments = new Map([
        ['a.ts', { role: null, symbolCount: null, complexity: 5, testPair: null }],
      ]);

      service.enrichDistrictAdapterMetrics(districts, files, enrichments);

      expect(districts[0].complexityAvg).toBe(5);
      expect(districts[1].complexityAvg).toBeNull();
    });

    it('should round complexityAvg to one decimal place', () => {
      const districts = [makeDistrict({ id: 'd1', name: 'round' })];
      const files = new Map([
        [
          'd1',
          [makeFile({ path: 'a.ts' }), makeFile({ path: 'b.ts' }), makeFile({ path: 'c.ts' })],
        ],
      ]);
      const enrichments = new Map([
        ['a.ts', { role: null, symbolCount: null, complexity: 7, testPair: null }],
        ['b.ts', { role: null, symbolCount: null, complexity: 3, testPair: null }],
        ['c.ts', { role: null, symbolCount: null, complexity: 5, testPair: null }],
      ]);

      service.enrichDistrictAdapterMetrics(districts, files, enrichments);

      // (7 + 3 + 5) / 3 = 5.0
      expect(districts[0].complexityAvg).toBe(5);
    });
  });

  // -------------------------------------------------------------------------
  // enrichDistrictOwnership
  // -------------------------------------------------------------------------

  describe('enrichDistrictOwnership', () => {
    it('should compute HHI = 1.0 for single-author district', () => {
      const districts = [makeDistrict({ id: 'd1', name: 'solo' })];
      const files = new Map([['d1', [makeFile({ path: 'a.ts' })]]]);
      const fileAuthors = new Map([['a.ts', new Map([['Alice', 10]])]]);

      service.enrichDistrictOwnership(districts, files, fileAuthors);

      expect(districts[0].ownershipConcentration).toBe(1.0);
      expect(districts[0].primaryAuthorName).toBe('Alice');
      expect(districts[0].primaryAuthorShare).toBe(1.0);
    });

    it('should compute lower HHI for evenly distributed authors', () => {
      const districts = [makeDistrict({ id: 'd1', name: 'shared' })];
      const files = new Map([['d1', [makeFile({ path: 'a.ts' }), makeFile({ path: 'b.ts' })]]]);
      const fileAuthors = new Map([
        [
          'a.ts',
          new Map([
            ['Alice', 5],
            ['Bob', 5],
          ]),
        ],
        [
          'b.ts',
          new Map([
            ['Alice', 5],
            ['Bob', 5],
          ]),
        ],
      ]);

      service.enrichDistrictOwnership(districts, files, fileAuthors);

      // Each author has 50% share → HHI = 0.25 + 0.25 = 0.5
      expect(districts[0].ownershipConcentration).toBe(0.5);
      // Alice and Bob are tied; either is acceptable as primary author
      expect(['Alice', 'Bob']).toContain(districts[0].primaryAuthorName);
      expect(districts[0].primaryAuthorShare).toBe(0.5);
    });

    it('should return null when no author data exists', () => {
      const districts = [makeDistrict({ id: 'd1', name: 'unknown' })];
      const files = new Map([['d1', [makeFile({ path: 'a.ts' })]]]);
      const fileAuthors = new Map();

      service.enrichDistrictOwnership(districts, files, fileAuthors);

      expect(districts[0].ownershipConcentration).toBeNull();
      expect(districts[0].primaryAuthorName).toBeNull();
      expect(districts[0].primaryAuthorShare).toBeNull();
    });

    it('should compute HHI for unequal author distribution', () => {
      const districts = [makeDistrict({ id: 'd1', name: 'unequal' })];
      const files = new Map([['d1', [makeFile({ path: 'a.ts' })]]]);
      // Alice: 7 commits, Bob: 3 commits → shares 0.7, 0.3
      // HHI = 0.7^2 + 0.3^2 = 0.49 + 0.09 = 0.58
      const fileAuthors = new Map([
        [
          'a.ts',
          new Map([
            ['Alice', 7],
            ['Bob', 3],
          ]),
        ],
      ]);

      service.enrichDistrictOwnership(districts, files, fileAuthors);

      expect(districts[0].ownershipConcentration).toBeCloseTo(0.58, 1);
      expect(districts[0].primaryAuthorName).toBe('Alice');
      expect(districts[0].primaryAuthorShare).toBe(0.7);
    });

    it('should handle district with partial author data across files', () => {
      const districts = [makeDistrict({ id: 'd1', name: 'partial' })];
      const files = new Map([
        [
          'd1',
          [makeFile({ path: 'a.ts' }), makeFile({ path: 'b.ts' }), makeFile({ path: 'c.ts' })],
        ],
      ]);
      // Only a.ts and b.ts have author data; c.ts does not
      const fileAuthors = new Map([
        ['a.ts', new Map([['Alice', 5]])],
        ['b.ts', new Map([['Alice', 5]])],
      ]);

      service.enrichDistrictOwnership(districts, files, fileAuthors);

      // Only Alice → HHI = 1.0 (only files with data are considered)
      expect(districts[0].ownershipConcentration).not.toBeNull();
      expect(districts[0].ownershipConcentration).toBe(1.0);
    });
  });

  // -------------------------------------------------------------------------
  // rankHotspots (new metrics)
  // -------------------------------------------------------------------------

  describe('rankHotspots (enriched metrics)', () => {
    it('should include coupling hotspot entries when couplingScore > 0', () => {
      const districts = [
        makeDistrict({
          id: 'd1',
          name: 'coupled',
          totalLOC: 100,
          totalFiles: 5,
          couplingScore: 10,
          inboundWeight: 6,
          outboundWeight: 4,
        }),
        makeDistrict({
          id: 'd2',
          name: 'decoupled',
          totalLOC: 200,
          totalFiles: 3,
          couplingScore: 0,
        }),
      ];
      const files = new Map([
        ['d1', [makeFile({ path: 'a.ts' })]],
        ['d2', [makeFile({ path: 'b.ts' })]],
      ]);

      const hotspots = service.rankHotspots(districts, files);

      const couplingEntries = hotspots.filter((h) => h.metric === 'coupling');
      expect(couplingEntries.length).toBe(1);
      expect(couplingEntries[0].targetId).toBe('d1');
    });

    it('should include complexity hotspot entries when complexityAvg is set', () => {
      const districts = [
        makeDistrict({
          id: 'd1',
          name: 'complex',
          totalLOC: 100,
          totalFiles: 5,
          complexityAvg: 25,
        }),
        makeDistrict({ id: 'd2', name: 'simple', totalLOC: 200, totalFiles: 3, complexityAvg: 3 }),
      ];
      const files = new Map([
        ['d1', [makeFile({ path: 'a.ts' })]],
        ['d2', [makeFile({ path: 'b.ts' })]],
      ]);

      const hotspots = service.rankHotspots(districts, files);

      const complexityEntries = hotspots.filter((h) => h.metric === 'complexity');
      expect(complexityEntries.length).toBe(2);
      expect(complexityEntries[0].targetId).toBe('d1');
    });

    it('should include ownership hotspot entries when ownershipConcentration is set', () => {
      const districts = [
        makeDistrict({
          id: 'd1',
          name: 'monopoly',
          totalLOC: 100,
          totalFiles: 5,
          ownershipConcentration: 1.0,
        }),
        makeDistrict({
          id: 'd2',
          name: 'shared',
          totalLOC: 200,
          totalFiles: 3,
          ownershipConcentration: 0.3,
        }),
      ];
      const files = new Map([
        ['d1', [makeFile({ path: 'a.ts' })]],
        ['d2', [makeFile({ path: 'b.ts' })]],
      ]);

      const hotspots = service.rankHotspots(districts, files);

      const ownershipEntries = hotspots.filter((h) => h.metric === 'ownership');
      expect(ownershipEntries.length).toBe(2);
      expect(ownershipEntries[0].targetId).toBe('d1');
    });

    it('should produce complexity label with district name and avg score', () => {
      const districts = [
        makeDistrict({
          id: 'd1',
          name: 'engine',
          totalLOC: 500,
          totalFiles: 10,
          complexityAvg: 12.5,
        }),
      ];

      const hotspots = service.rankHotspots(districts, new Map());
      const complexityEntry = hotspots.find((h) => h.metric === 'complexity');

      expect(complexityEntry).toBeDefined();
      expect(complexityEntry!.label).toContain('engine');
      expect(complexityEntry!.label).toContain('12.5');
    });

    it('should produce ownership label with percentage', () => {
      const districts = [
        makeDistrict({
          id: 'd1',
          name: 'legacy',
          totalLOC: 300,
          totalFiles: 8,
          ownershipConcentration: 0.85,
        }),
      ];

      const hotspots = service.rankHotspots(districts, new Map());
      const ownershipEntry = hotspots.find((h) => h.metric === 'ownership');

      expect(ownershipEntry).toBeDefined();
      expect(ownershipEntry!.label).toContain('legacy');
      expect(ownershipEntry!.label).toContain('85%');
    });

    it('should produce coupling label with district name and weight', () => {
      const districts = [
        makeDistrict({
          id: 'd1',
          name: 'hub',
          totalLOC: 400,
          totalFiles: 12,
          couplingScore: 15,
          inboundWeight: 10,
          outboundWeight: 5,
        }),
      ];

      const hotspots = service.rankHotspots(districts, new Map());
      const couplingEntry = hotspots.find((h) => h.metric === 'coupling');

      expect(couplingEntry).toBeDefined();
      expect(couplingEntry!.label).toContain('hub');
      expect(couplingEntry!.score).toBe(15);
    });
  });
});
