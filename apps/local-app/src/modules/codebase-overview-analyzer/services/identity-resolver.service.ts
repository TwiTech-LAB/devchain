// NOTE: The first scan after path-based district aggregation lands (Phase 1.1) will produce
// all-new district UUIDs because file groupings change entirely. This is expected one-time
// identity churn, not a bug. The UI clears stale localStorage prefs (compareTargets,
// selectedTargetId) on snapshot load — see CodebaseOverviewPage.tsx migration effects.
import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface GitRename {
  oldPath: string;
  newPath: string;
  similarity: number; // 0–100
}

export interface PreviousIdentityState {
  commitSha: string | null;
  files: ReadonlyMap<string, string>; // path → stableId
  districts: ReadonlyMap<string, DistrictIdentityEntry>;
  regions: ReadonlyMap<string, string>; // regionName → stableId
}

export interface DistrictIdentityEntry {
  id: string;
  memberFileIds: ReadonlySet<string>;
}

export interface DistrictCandidate {
  key: string;
  memberFileIds: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DISTRICT_OVERLAP_THRESHOLD = 0.5;

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class IdentityResolverService {
  /**
   * Resolve file paths to stable IDs.
   *
   * Resolution order (per plan Section 13.1):
   *  1. exact path match to a previously known active file
   *  2. explicit VCS rename/move detection
   *  3. assign a new ID (content similarity deferred to enrichment)
   */
  resolveFileIds(
    currentPaths: string[],
    previous: PreviousIdentityState | null,
    gitRenames: GitRename[],
  ): Map<string, string> {
    const result = new Map<string, string>();
    const prevFiles = previous?.files ?? new Map<string, string>();

    // Build rename lookup: newPath → oldPath
    const renameMap = new Map<string, string>();
    for (const r of gitRenames) {
      renameMap.set(r.newPath, r.oldPath);
    }

    for (const path of currentPaths) {
      // 1. Exact path match
      const exactId = prevFiles.get(path);
      if (exactId) {
        result.set(path, exactId);
        continue;
      }

      // 2. Git rename/move detection
      const oldPath = renameMap.get(path);
      if (oldPath) {
        const renamedId = prevFiles.get(oldPath);
        if (renamedId) {
          result.set(path, renamedId);
          continue;
        }
      }

      // 3. New ID
      result.set(path, randomUUID());
    }

    return result;
  }

  /**
   * Resolve district keys to stable IDs.
   *
   * Resolution order (per plan Section 13.2):
   *  1. exact key match with >= 50 % membership overlap
   *  2. membership-based match across all previous districts (for renames)
   *  3. assign a new ID
   */
  resolveDistrictIds(
    currentDistricts: DistrictCandidate[],
    previous: PreviousIdentityState | null,
  ): Map<string, string> {
    const result = new Map<string, string>();
    const prevDistricts = previous?.districts ?? new Map<string, DistrictIdentityEntry>();
    const matchedPrevious = new Set<string>();

    for (const district of currentDistricts) {
      const currentMemberSet = new Set(district.memberFileIds);

      // 1. Exact key match with majority membership overlap
      const exactMatch = prevDistricts.get(district.key);
      if (exactMatch) {
        const overlap = computeOverlap(exactMatch.memberFileIds, currentMemberSet);
        if (overlap >= DISTRICT_OVERLAP_THRESHOLD) {
          result.set(district.key, exactMatch.id);
          matchedPrevious.add(district.key);
          continue;
        }
      }

      // 2. Membership-based match (for renames / moves)
      let bestMatch: { key: string; id: string; ratio: number } | null = null;
      for (const [prevKey, prevData] of prevDistricts) {
        if (matchedPrevious.has(prevKey)) continue;
        const overlap = computeOverlap(prevData.memberFileIds, currentMemberSet);
        if (overlap >= DISTRICT_OVERLAP_THRESHOLD && (!bestMatch || overlap > bestMatch.ratio)) {
          bestMatch = { key: prevKey, id: prevData.id, ratio: overlap };
        }
      }

      if (bestMatch) {
        result.set(district.key, bestMatch.id);
        matchedPrevious.add(bestMatch.key);
        continue;
      }

      // 3. New ID
      result.set(district.key, randomUUID());
    }

    return result;
  }

  /**
   * Resolve region names to stable IDs.
   * Regions are identified by name; no membership heuristic is needed.
   */
  resolveRegionIds(
    currentRegionNames: string[],
    previous: PreviousIdentityState | null,
  ): Map<string, string> {
    const result = new Map<string, string>();
    const prevRegions = previous?.regions ?? new Map<string, string>();

    for (const name of currentRegionNames) {
      const prevId = prevRegions.get(name);
      result.set(name, prevId ?? randomUUID());
    }

    return result;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute Jaccard-style overlap: intersection / max(|A|, |B|).
 * Returns 1 when both sets are empty.
 */
function computeOverlap(previousMembers: ReadonlySet<string>, currentMembers: Set<string>): number {
  if (previousMembers.size === 0 && currentMembers.size === 0) return 1;
  if (previousMembers.size === 0 || currentMembers.size === 0) return 0;

  let intersectionCount = 0;
  for (const id of previousMembers) {
    if (currentMembers.has(id)) intersectionCount++;
  }

  return intersectionCount / Math.max(previousMembers.size, currentMembers.size);
}
