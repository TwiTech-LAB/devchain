import { Injectable } from '@nestjs/common';
import type { DependencyEdge, DistrictNode } from '@devchain/codebase-overview';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface FileEdge {
  fromPath: string;
  toPath: string;
  weight?: number;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class DependencyAggregationService {
  /**
   * Aggregate file-level import edges into district-level dependency edges.
   * Skips self-dependencies (edges within the same district).
   * Detects cyclic pairs (A→B and B→A both exist).
   */
  aggregateDistrictDependencies(
    fileEdges: ReadonlyArray<FileEdge>,
    fileToDistrictId: ReadonlyMap<string, string>,
  ): DependencyEdge[] {
    if (fileEdges.length === 0) return [];

    const edgeMap = new Map<string, { fromId: string; toId: string; weight: number }>();

    for (const edge of fileEdges) {
      const fromDistrictId = fileToDistrictId.get(edge.fromPath);
      const toDistrictId = fileToDistrictId.get(edge.toPath);
      if (!fromDistrictId || !toDistrictId) continue;
      if (fromDistrictId === toDistrictId) continue;

      const key = `${fromDistrictId}\0${toDistrictId}`;
      const existing = edgeMap.get(key);
      if (existing) {
        existing.weight += edge.weight ?? 1;
      } else {
        edgeMap.set(key, {
          fromId: fromDistrictId,
          toId: toDistrictId,
          weight: edge.weight ?? 1,
        });
      }
    }

    const edges: DependencyEdge[] = [];
    for (const [, data] of edgeMap) {
      const reverseKey = `${data.toId}\0${data.fromId}`;
      edges.push({
        fromDistrictId: data.fromId,
        toDistrictId: data.toId,
        weight: data.weight,
        isCyclic: edgeMap.has(reverseKey),
      });
    }

    return edges.sort((a, b) => b.weight - a.weight);
  }

  /**
   * Compute blast radius for each district via BFS over the dependency graph.
   * Blast radius = number of districts that transitively depend on this district
   * (i.e., if this district's API changes, how many others are affected).
   * Mutates districts in place and returns the detailed blast radius map.
   */
  computeBlastRadius(
    districts: DistrictNode[],
    edges: ReadonlyArray<DependencyEdge>,
  ): Map<string, Array<{ districtId: string; depth: number }>> {
    const result = new Map<string, Array<{ districtId: string; depth: number }>>();
    if (edges.length === 0) return result;

    // Build adjacency: importedByMap[X] = set of districts that import from X
    const importedByMap = new Map<string, Set<string>>();
    for (const edge of edges) {
      let dependents = importedByMap.get(edge.toDistrictId);
      if (!dependents) {
        dependents = new Set<string>();
        importedByMap.set(edge.toDistrictId, dependents);
      }
      dependents.add(edge.fromDistrictId);
    }

    // BFS from each district to find transitive dependents
    for (const district of districts) {
      const visited = new Set<string>();
      const queue: Array<{ id: string; depth: number }> = [];
      const blastEntries: Array<{ districtId: string; depth: number }> = [];

      // Seed with direct dependents
      const directDeps = importedByMap.get(district.id);
      if (!directDeps || directDeps.size === 0) {
        district.blastRadius = 0;
        continue;
      }

      for (const depId of directDeps) {
        queue.push({ id: depId, depth: 1 });
        visited.add(depId);
      }

      while (queue.length > 0) {
        const { id, depth } = queue.shift()!;
        blastEntries.push({ districtId: id, depth });

        const transitive = importedByMap.get(id);
        if (transitive) {
          for (const tid of transitive) {
            if (tid !== district.id && !visited.has(tid)) {
              visited.add(tid);
              queue.push({ id: tid, depth: depth + 1 });
            }
          }
        }
      }

      district.blastRadius = blastEntries.length;
      if (blastEntries.length > 0) {
        result.set(
          district.id,
          blastEntries.sort((a, b) => a.depth - b.depth),
        );
      }
    }

    return result;
  }

  /**
   * Enrich districts with inbound/outbound weights and coupling score
   * derived from the aggregated dependency edges.
   * Mutates districts in place.
   */
  enrichDistrictWeights(districts: DistrictNode[], edges: ReadonlyArray<DependencyEdge>): void {
    if (edges.length === 0) return;

    const inbound = new Map<string, number>();
    const outbound = new Map<string, number>();

    for (const edge of edges) {
      outbound.set(edge.fromDistrictId, (outbound.get(edge.fromDistrictId) ?? 0) + edge.weight);
      inbound.set(edge.toDistrictId, (inbound.get(edge.toDistrictId) ?? 0) + edge.weight);
    }

    for (const district of districts) {
      district.inboundWeight = inbound.get(district.id) ?? 0;
      district.outboundWeight = outbound.get(district.id) ?? 0;
      district.couplingScore = district.inboundWeight + district.outboundWeight;
    }
  }
}
