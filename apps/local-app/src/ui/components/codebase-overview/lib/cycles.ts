import { useMemo } from 'react';
import type { DistrictSignals, DependencyEdge } from '@devchain/codebase-overview';

export interface CyclePair {
  fromId: string;
  toId: string;
  fromName: string;
  toName: string;
  weight: number;
}

export function useCyclePairs(
  signals: DistrictSignals[],
  dependencies: DependencyEdge[],
  limit?: number,
): CyclePair[] {
  return useMemo(() => {
    const edgeByPair = new Map(
      dependencies.map((e) => [`${e.fromDistrictId}:${e.toDistrictId}`, e]),
    );
    const seen = new Set<string>();
    const pairs: CyclePair[] = [];

    for (const edge of dependencies) {
      const reverseKey = `${edge.toDistrictId}:${edge.fromDistrictId}`;
      const pairKey = [edge.fromDistrictId, edge.toDistrictId].sort().join(':');
      const reverse = edgeByPair.get(reverseKey);
      if (reverse !== undefined && !seen.has(pairKey)) {
        seen.add(pairKey);
        const fromName =
          signals.find((s) => s.districtId === edge.fromDistrictId)?.name ?? edge.fromDistrictId;
        const toName =
          signals.find((s) => s.districtId === edge.toDistrictId)?.name ?? edge.toDistrictId;
        pairs.push({
          fromId: edge.fromDistrictId,
          toId: edge.toDistrictId,
          fromName,
          toName,
          weight: edge.weight + reverse.weight,
        });
      }
    }

    const sorted = pairs.sort((a, b) => b.weight - a.weight);
    return limit !== undefined ? sorted.slice(0, limit) : sorted;
  }, [signals, dependencies, limit]);
}
