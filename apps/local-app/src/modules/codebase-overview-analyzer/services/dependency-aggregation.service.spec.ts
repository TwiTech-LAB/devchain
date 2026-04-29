import { Test, TestingModule } from '@nestjs/testing';
import { DependencyAggregationService, type FileEdge } from './dependency-aggregation.service';
import type { DistrictNode } from '@devchain/codebase-overview';

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

describe('DependencyAggregationService', () => {
  let service: DependencyAggregationService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [DependencyAggregationService],
    }).compile();

    service = module.get(DependencyAggregationService);
  });

  describe('aggregateDistrictDependencies', () => {
    it('should return empty array for empty file edges', () => {
      const edges = service.aggregateDistrictDependencies([], new Map());
      expect(edges).toEqual([]);
    });

    it('should aggregate file edges into district edges', () => {
      const fileEdges: FileEdge[] = [
        { fromPath: 'src/a/f1.ts', toPath: 'src/b/f2.ts' },
        { fromPath: 'src/a/f3.ts', toPath: 'src/b/f4.ts' },
      ];
      const fileToDistrict = new Map([
        ['src/a/f1.ts', 'd1'],
        ['src/a/f3.ts', 'd1'],
        ['src/b/f2.ts', 'd2'],
        ['src/b/f4.ts', 'd2'],
      ]);

      const edges = service.aggregateDistrictDependencies(fileEdges, fileToDistrict);

      expect(edges).toHaveLength(1);
      expect(edges[0].fromDistrictId).toBe('d1');
      expect(edges[0].toDistrictId).toBe('d2');
      expect(edges[0].weight).toBe(2);
      expect(edges[0].isCyclic).toBe(false);
    });

    it('should skip self-dependencies within the same district', () => {
      const fileEdges: FileEdge[] = [{ fromPath: 'src/a/f1.ts', toPath: 'src/a/f2.ts' }];
      const fileToDistrict = new Map([
        ['src/a/f1.ts', 'd1'],
        ['src/a/f2.ts', 'd1'],
      ]);

      const edges = service.aggregateDistrictDependencies(fileEdges, fileToDistrict);
      expect(edges).toEqual([]);
    });

    it('should detect cyclic dependencies', () => {
      const fileEdges: FileEdge[] = [
        { fromPath: 'src/a/f1.ts', toPath: 'src/b/f2.ts' },
        { fromPath: 'src/b/f3.ts', toPath: 'src/a/f4.ts' },
      ];
      const fileToDistrict = new Map([
        ['src/a/f1.ts', 'd1'],
        ['src/a/f4.ts', 'd1'],
        ['src/b/f2.ts', 'd2'],
        ['src/b/f3.ts', 'd2'],
      ]);

      const edges = service.aggregateDistrictDependencies(fileEdges, fileToDistrict);

      expect(edges).toHaveLength(2);
      expect(edges.every((e) => e.isCyclic)).toBe(true);
    });

    it('should skip edges with unmapped files', () => {
      const fileEdges: FileEdge[] = [{ fromPath: 'unknown/f1.ts', toPath: 'src/b/f2.ts' }];
      const fileToDistrict = new Map([['src/b/f2.ts', 'd2']]);

      const edges = service.aggregateDistrictDependencies(fileEdges, fileToDistrict);
      expect(edges).toEqual([]);
    });

    it('should sort edges by weight descending', () => {
      const fileEdges: FileEdge[] = [
        { fromPath: 'src/a/f1.ts', toPath: 'src/b/f2.ts', weight: 1 },
        { fromPath: 'src/c/f3.ts', toPath: 'src/d/f4.ts', weight: 10 },
      ];
      const fileToDistrict = new Map([
        ['src/a/f1.ts', 'd1'],
        ['src/b/f2.ts', 'd2'],
        ['src/c/f3.ts', 'd3'],
        ['src/d/f4.ts', 'd4'],
      ]);

      const edges = service.aggregateDistrictDependencies(fileEdges, fileToDistrict);

      expect(edges[0].weight).toBe(10);
      expect(edges[1].weight).toBe(1);
    });

    it('should use custom weight when provided', () => {
      const fileEdges: FileEdge[] = [{ fromPath: 'src/a/f1.ts', toPath: 'src/b/f2.ts', weight: 5 }];
      const fileToDistrict = new Map([
        ['src/a/f1.ts', 'd1'],
        ['src/b/f2.ts', 'd2'],
      ]);

      const edges = service.aggregateDistrictDependencies(fileEdges, fileToDistrict);
      expect(edges[0].weight).toBe(5);
    });
  });

  describe('enrichDistrictWeights', () => {
    it('should not modify districts when edges are empty', () => {
      const districts = [makeDistrict({ id: 'd1', name: 'a' })];
      service.enrichDistrictWeights(districts, []);

      expect(districts[0].inboundWeight).toBe(0);
      expect(districts[0].outboundWeight).toBe(0);
      expect(districts[0].couplingScore).toBe(0);
    });

    it('should compute inbound and outbound weights from edges', () => {
      const districts = [
        makeDistrict({ id: 'd1', name: 'a' }),
        makeDistrict({ id: 'd2', name: 'b' }),
        makeDistrict({ id: 'd3', name: 'c' }),
      ];
      const edges = [
        { fromDistrictId: 'd1', toDistrictId: 'd2', weight: 5, isCyclic: false },
        { fromDistrictId: 'd1', toDistrictId: 'd3', weight: 3, isCyclic: false },
        { fromDistrictId: 'd3', toDistrictId: 'd2', weight: 2, isCyclic: false },
      ];

      service.enrichDistrictWeights(districts, edges);

      // d1: outbound 8, inbound 0
      expect(districts[0].outboundWeight).toBe(8);
      expect(districts[0].inboundWeight).toBe(0);
      expect(districts[0].couplingScore).toBe(8);

      // d2: outbound 0, inbound 7
      expect(districts[1].outboundWeight).toBe(0);
      expect(districts[1].inboundWeight).toBe(7);
      expect(districts[1].couplingScore).toBe(7);

      // d3: outbound 2, inbound 3
      expect(districts[2].outboundWeight).toBe(2);
      expect(districts[2].inboundWeight).toBe(3);
      expect(districts[2].couplingScore).toBe(5);
    });

    it('should leave districts without any edges at zero coupling', () => {
      const districts = [
        makeDistrict({ id: 'd1', name: 'a' }),
        makeDistrict({ id: 'd2', name: 'b' }),
        makeDistrict({ id: 'd-isolated', name: 'isolated' }),
      ];
      const edges = [{ fromDistrictId: 'd1', toDistrictId: 'd2', weight: 4, isCyclic: false }];

      service.enrichDistrictWeights(districts, edges);

      expect(districts[2].inboundWeight).toBe(0);
      expect(districts[2].outboundWeight).toBe(0);
      expect(districts[2].couplingScore).toBe(0);
    });

    it('should compute explicit coupling weights for fixture data', () => {
      const districts = [
        makeDistrict({ id: 'api', name: 'api' }),
        makeDistrict({ id: 'core', name: 'core' }),
        makeDistrict({ id: 'db', name: 'db' }),
      ];
      // api→core: 10, core→db: 6, api→db: 2
      const edges = [
        { fromDistrictId: 'api', toDistrictId: 'core', weight: 10, isCyclic: false },
        { fromDistrictId: 'core', toDistrictId: 'db', weight: 6, isCyclic: false },
        { fromDistrictId: 'api', toDistrictId: 'db', weight: 2, isCyclic: false },
      ];

      service.enrichDistrictWeights(districts, edges);

      // api: outbound=12, inbound=0, coupling=12
      expect(districts[0].outboundWeight).toBe(12);
      expect(districts[0].inboundWeight).toBe(0);
      expect(districts[0].couplingScore).toBe(12);

      // core: outbound=6, inbound=10, coupling=16
      expect(districts[1].outboundWeight).toBe(6);
      expect(districts[1].inboundWeight).toBe(10);
      expect(districts[1].couplingScore).toBe(16);

      // db: outbound=0, inbound=8, coupling=8
      expect(districts[2].outboundWeight).toBe(0);
      expect(districts[2].inboundWeight).toBe(8);
      expect(districts[2].couplingScore).toBe(8);
    });
  });

  describe('aggregateDistrictDependencies – edge cases', () => {
    it('should accumulate weight from multiple file edges between same district pair', () => {
      const fileEdges: FileEdge[] = [
        { fromPath: 'src/a/f1.ts', toPath: 'src/b/f2.ts', weight: 3 },
        { fromPath: 'src/a/f3.ts', toPath: 'src/b/f4.ts', weight: 7 },
        { fromPath: 'src/a/f5.ts', toPath: 'src/b/f6.ts' }, // default weight 1
      ];
      const fileToDistrict = new Map([
        ['src/a/f1.ts', 'd1'],
        ['src/a/f3.ts', 'd1'],
        ['src/a/f5.ts', 'd1'],
        ['src/b/f2.ts', 'd2'],
        ['src/b/f4.ts', 'd2'],
        ['src/b/f6.ts', 'd2'],
      ]);

      const edges = service.aggregateDistrictDependencies(fileEdges, fileToDistrict);

      expect(edges).toHaveLength(1);
      expect(edges[0].weight).toBe(11); // 3 + 7 + 1
    });

    it('should produce mixed cyclic and non-cyclic pairs in same result', () => {
      const fileEdges: FileEdge[] = [
        // d1↔d2 is cyclic
        { fromPath: 'src/a/f1.ts', toPath: 'src/b/f2.ts' },
        { fromPath: 'src/b/f3.ts', toPath: 'src/a/f4.ts' },
        // d1→d3 is one-way (not cyclic)
        { fromPath: 'src/a/f5.ts', toPath: 'src/c/f6.ts' },
      ];
      const fileToDistrict = new Map([
        ['src/a/f1.ts', 'd1'],
        ['src/a/f4.ts', 'd1'],
        ['src/a/f5.ts', 'd1'],
        ['src/b/f2.ts', 'd2'],
        ['src/b/f3.ts', 'd2'],
        ['src/c/f6.ts', 'd3'],
      ]);

      const edges = service.aggregateDistrictDependencies(fileEdges, fileToDistrict);

      expect(edges).toHaveLength(3);

      const d1d2 = edges.find((e) => e.fromDistrictId === 'd1' && e.toDistrictId === 'd2');
      const d2d1 = edges.find((e) => e.fromDistrictId === 'd2' && e.toDistrictId === 'd1');
      const d1d3 = edges.find((e) => e.fromDistrictId === 'd1' && e.toDistrictId === 'd3');

      expect(d1d2!.isCyclic).toBe(true);
      expect(d2d1!.isCyclic).toBe(true);
      expect(d1d3!.isCyclic).toBe(false);
    });

    it('should handle many-to-many district relationships', () => {
      // 4 districts with cross-edges: d1→d2, d1→d3, d2→d4, d3→d4
      const fileEdges: FileEdge[] = [
        { fromPath: 'a/x.ts', toPath: 'b/x.ts', weight: 2 },
        { fromPath: 'a/y.ts', toPath: 'c/x.ts', weight: 3 },
        { fromPath: 'b/y.ts', toPath: 'd/x.ts', weight: 4 },
        { fromPath: 'c/y.ts', toPath: 'd/y.ts', weight: 5 },
      ];
      const fileToDistrict = new Map([
        ['a/x.ts', 'd1'],
        ['a/y.ts', 'd1'],
        ['b/x.ts', 'd2'],
        ['b/y.ts', 'd2'],
        ['c/x.ts', 'd3'],
        ['c/y.ts', 'd3'],
        ['d/x.ts', 'd4'],
        ['d/y.ts', 'd4'],
      ]);

      const edges = service.aggregateDistrictDependencies(fileEdges, fileToDistrict);

      expect(edges).toHaveLength(4);
      // Sorted by weight descending: d3→d4(5), d2→d4(4), d1→d3(3), d1→d2(2)
      expect(edges[0].weight).toBe(5);
      expect(edges[0].fromDistrictId).toBe('d3');
      expect(edges[1].weight).toBe(4);
      expect(edges[1].fromDistrictId).toBe('d2');
      expect(edges[2].weight).toBe(3);
      expect(edges[2].fromDistrictId).toBe('d1');
      expect(edges[2].toDistrictId).toBe('d3');
      expect(edges[3].weight).toBe(2);
      expect(edges[3].fromDistrictId).toBe('d1');
      expect(edges[3].toDistrictId).toBe('d2');
      // None are cyclic
      expect(edges.every((e) => !e.isCyclic)).toBe(true);
    });
  });

  describe('computeBlastRadius', () => {
    it('should return empty map and leave blastRadius 0 when edges are empty', () => {
      const districts = [makeDistrict({ id: 'd1', name: 'a' })];
      const result = service.computeBlastRadius(districts, []);

      expect(result.size).toBe(0);
      expect(districts[0].blastRadius).toBe(0);
    });

    it('should compute direct dependents (depth 1)', () => {
      // d1 → d2 means d1 imports d2, so d2's blast radius includes d1
      const districts = [
        makeDistrict({ id: 'd1', name: 'a' }),
        makeDistrict({ id: 'd2', name: 'b' }),
      ];
      const edges = [{ fromDistrictId: 'd1', toDistrictId: 'd2', weight: 3, isCyclic: false }];

      const result = service.computeBlastRadius(districts, edges);

      // d2 is imported by d1, so d2 blastRadius = 1
      expect(districts[1].blastRadius).toBe(1);
      expect(result.get('d2')).toEqual([{ districtId: 'd1', depth: 1 }]);

      // d1 is not imported by anyone
      expect(districts[0].blastRadius).toBe(0);
      expect(result.has('d1')).toBe(false);
    });

    it('should compute transitive blast radius for linear chain A→B→C', () => {
      // A imports B, B imports C → C's blast radius is 2 (B at depth 1, A at depth 2)
      const districts = [
        makeDistrict({ id: 'a', name: 'a' }),
        makeDistrict({ id: 'b', name: 'b' }),
        makeDistrict({ id: 'c', name: 'c' }),
      ];
      const edges = [
        { fromDistrictId: 'a', toDistrictId: 'b', weight: 1, isCyclic: false },
        { fromDistrictId: 'b', toDistrictId: 'c', weight: 1, isCyclic: false },
      ];

      const result = service.computeBlastRadius(districts, edges);

      // C is imported by B (depth 1), and transitively by A (depth 2)
      expect(districts[2].blastRadius).toBe(2);
      const cEntries = result.get('c')!;
      expect(cEntries).toHaveLength(2);
      expect(cEntries[0]).toEqual({ districtId: 'b', depth: 1 });
      expect(cEntries[1]).toEqual({ districtId: 'a', depth: 2 });

      // B is imported by A (depth 1)
      expect(districts[1].blastRadius).toBe(1);

      // A is not imported by anyone
      expect(districts[0].blastRadius).toBe(0);
    });

    it('should handle diamond dependencies', () => {
      // A→B, A→C, B→D, C→D — D has blast radius 3 (B@1, C@1, A@2)
      const districts = [
        makeDistrict({ id: 'a', name: 'a' }),
        makeDistrict({ id: 'b', name: 'b' }),
        makeDistrict({ id: 'c', name: 'c' }),
        makeDistrict({ id: 'd', name: 'd' }),
      ];
      const edges = [
        { fromDistrictId: 'a', toDistrictId: 'b', weight: 1, isCyclic: false },
        { fromDistrictId: 'a', toDistrictId: 'c', weight: 1, isCyclic: false },
        { fromDistrictId: 'b', toDistrictId: 'd', weight: 1, isCyclic: false },
        { fromDistrictId: 'c', toDistrictId: 'd', weight: 1, isCyclic: false },
      ];

      const result = service.computeBlastRadius(districts, edges);

      // D is imported by B and C (depth 1), and A transitively (depth 2)
      expect(districts[3].blastRadius).toBe(3);
      const dEntries = result.get('d')!;
      expect(dEntries).toHaveLength(3);
      // Sorted by depth
      expect(dEntries.filter((e) => e.depth === 1)).toHaveLength(2);
      expect(dEntries.filter((e) => e.depth === 2)).toHaveLength(1);
      expect(dEntries.find((e) => e.depth === 2)!.districtId).toBe('a');
    });

    it('should leave isolated districts with blastRadius 0', () => {
      const districts = [
        makeDistrict({ id: 'd1', name: 'a' }),
        makeDistrict({ id: 'd2', name: 'b' }),
        makeDistrict({ id: 'd-isolated', name: 'isolated' }),
      ];
      const edges = [{ fromDistrictId: 'd1', toDistrictId: 'd2', weight: 1, isCyclic: false }];

      service.computeBlastRadius(districts, edges);

      expect(districts[2].blastRadius).toBe(0);
    });

    it('should not revisit districts in cyclic graphs', () => {
      // A↔B cyclic — should not loop infinitely
      const districts = [
        makeDistrict({ id: 'a', name: 'a' }),
        makeDistrict({ id: 'b', name: 'b' }),
      ];
      const edges = [
        { fromDistrictId: 'a', toDistrictId: 'b', weight: 1, isCyclic: true },
        { fromDistrictId: 'b', toDistrictId: 'a', weight: 1, isCyclic: true },
      ];

      const result = service.computeBlastRadius(districts, edges);

      // Each is imported by the other, blast radius = 1
      expect(districts[0].blastRadius).toBe(1);
      expect(districts[1].blastRadius).toBe(1);
      expect(result.get('a')).toEqual([{ districtId: 'b', depth: 1 }]);
      expect(result.get('b')).toEqual([{ districtId: 'a', depth: 1 }]);
    });

    it('should handle fan-in pattern with 3+ direct importers', () => {
      // D, E, F all import C → C's blast radius = 3
      const districts = [
        makeDistrict({ id: 'c', name: 'shared' }),
        makeDistrict({ id: 'd', name: 'd' }),
        makeDistrict({ id: 'e', name: 'e' }),
        makeDistrict({ id: 'f', name: 'f' }),
      ];
      const edges = [
        { fromDistrictId: 'd', toDistrictId: 'c', weight: 1, isCyclic: false },
        { fromDistrictId: 'e', toDistrictId: 'c', weight: 1, isCyclic: false },
        { fromDistrictId: 'f', toDistrictId: 'c', weight: 1, isCyclic: false },
      ];

      const result = service.computeBlastRadius(districts, edges);

      expect(districts[0].blastRadius).toBe(3);
      const cEntries = result.get('c')!;
      expect(cEntries).toHaveLength(3);
      expect(cEntries.every((e) => e.depth === 1)).toBe(true);
    });

    it('should not loop in a 3-node cycle', () => {
      // A→B→C→A — triangular cycle
      const districts = [
        makeDistrict({ id: 'a', name: 'a' }),
        makeDistrict({ id: 'b', name: 'b' }),
        makeDistrict({ id: 'c', name: 'c' }),
      ];
      const edges = [
        { fromDistrictId: 'a', toDistrictId: 'b', weight: 1, isCyclic: true },
        { fromDistrictId: 'b', toDistrictId: 'c', weight: 1, isCyclic: true },
        { fromDistrictId: 'c', toDistrictId: 'a', weight: 1, isCyclic: true },
      ];

      const result = service.computeBlastRadius(districts, edges);

      // Each district is transitively dependent on by the other two
      expect(districts[0].blastRadius).toBe(2);
      expect(districts[1].blastRadius).toBe(2);
      expect(districts[2].blastRadius).toBe(2);

      // Verify depths: direct at 1, transitive at 2
      const aEntries = result.get('a')!;
      expect(aEntries).toHaveLength(2);
      expect(aEntries.find((e) => e.depth === 1)).toBeDefined();
      expect(aEntries.find((e) => e.depth === 2)).toBeDefined();
    });
  });
});
