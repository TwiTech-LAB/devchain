import { Injectable } from '@nestjs/common';
import type { DistrictNode, FileRole } from '@devchain/codebase-overview';
import { basename } from 'path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_DISTRICT_FILES = 40;
const MAX_DISTRICT_PERCENTAGE = 0.15;
const MIN_GROUP_SIZE = 2;
const MAX_SPLIT_DEPTH = 6;

// ---------------------------------------------------------------------------
// File role classification
// ---------------------------------------------------------------------------

const ROLE_PATTERNS: ReadonlyArray<{ pattern: RegExp; role: FileRole }> = [
  // Test files (highest priority)
  { pattern: /[.\-_](test|spec)\.[^/\\]+$/i, role: 'test' },
  { pattern: /(^|[/\\])(__tests__|tests?)[/\\]/i, role: 'test' },

  // Style files
  { pattern: /\.(css|scss|sass|less|styl)$/i, role: 'style' },
  { pattern: /\.styled\.[^/\\]+$/i, role: 'style' },

  // Documentation
  { pattern: /\.(md|txt|rst|adoc)$/i, role: 'docs' },

  // Type definitions
  { pattern: /\.d\.ts$/i, role: 'type' },
  { pattern: /(^|[/\\])(types?|interfaces?)[/\\]/i, role: 'type' },

  // Config files
  { pattern: /[.\-_]config\.[^/\\]+$/i, role: 'config' },
  { pattern: /\.env(\.|$)/i, role: 'config' },
  { pattern: /(^|[/\\])config[/\\]/i, role: 'config' },

  // Shell scripts
  { pattern: /\.(sh|bash|ps1|bat|cmd)$/i, role: 'script' },
  { pattern: /(^|[/\\])(scripts?|bin)[/\\]/i, role: 'script' },

  // Controllers (name-based)
  { pattern: /[.\-_]controller\.[^/\\]+$/i, role: 'controller' },
  { pattern: /(^|[/\\])controllers?[/\\]/i, role: 'controller' },

  // Services (name-based)
  { pattern: /[.\-_]service\.[^/\\]+$/i, role: 'service' },
  { pattern: /(^|[/\\])services?[/\\]/i, role: 'service' },

  // Models (name-based)
  { pattern: /[.\-_](model|entity|schema)\.[^/\\]+$/i, role: 'model' },
  { pattern: /(^|[/\\])(models?|entities|schemas?)[/\\]/i, role: 'model' },

  // Utilities (name-based)
  { pattern: /[.\-_](util|utils|helper|helpers)\.[^/\\]+$/i, role: 'utility' },
  { pattern: /(^|[/\\])(utils?|helpers?|lib)[/\\]/i, role: 'utility' },

  // Views (extension-based, checked last so test.tsx → test, not view)
  { pattern: /\.(tsx|jsx|vue|svelte)$/i, role: 'view' },
];

export function classifyFileRole(filePath: string): FileRole {
  for (const { pattern, role } of ROLE_PATTERNS) {
    if (pattern.test(filePath)) return role;
  }
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class DistrictSplittingService {
  /**
   * Split oversized districts deterministically.
   *
   * Trigger: >40 files or >15% of total repo files.
   * Strategy: path-based recursive splitting → alphabetical chunks at max depth.
   */
  splitOversizedDistricts(
    districts: DistrictNode[],
    districtFileMap: Map<string, string[]>,
    locMap: ReadonlyMap<string, number>,
    totalFileCount: number,
  ): { districts: DistrictNode[]; districtFileMap: Map<string, string[]> } {
    const result: DistrictNode[] = [];
    const resultMap = new Map<string, string[]>();

    for (const district of districts) {
      const districtKey = district.id.slice('district:'.length);
      const filePaths = districtFileMap.get(districtKey) ?? [];

      const isOversized =
        filePaths.length > MAX_DISTRICT_FILES ||
        (totalFileCount > 0 && filePaths.length > totalFileCount * MAX_DISTRICT_PERCENTAGE);

      if (!isOversized || filePaths.length < MIN_GROUP_SIZE * 2) {
        result.push(district);
        resultMap.set(districtKey, filePaths);
        continue;
      }

      const splits = trySplit(filePaths, districtKey);

      for (const [suffix, paths] of splits) {
        const subKey = `${districtKey}:${suffix}`;
        const subLOC = paths.reduce((sum, p) => sum + (locMap.get(p) ?? 0), 0);

        result.push({
          id: `district:${subKey}`,
          regionId: district.regionId,
          path: longestCommonPathPrefix(paths) || district.path,
          name: `${districtKey}/${suffix}`,
          totalFiles: paths.length,
          totalLOC: subLOC,
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
        });

        resultMap.set(subKey, paths);
      }
    }

    result.sort((a, b) => b.totalLOC - a.totalLOC);

    return { districts: result, districtFileMap: resultMap };
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function longestCommonPathPrefix(paths: string[]): string {
  if (paths.length === 0) return '';
  const dirPaths = paths.map((p) => {
    const segments = p.split('/');
    return segments.slice(0, -1);
  });
  const minLen = Math.min(...dirPaths.map((s) => s.length));
  let commonLen = 0;
  for (let i = 0; i < minLen; i++) {
    if (dirPaths.every((s) => s[i] === dirPaths[0][i])) {
      commonLen = i + 1;
    } else {
      break;
    }
  }
  return dirPaths[0].slice(0, commonLen).join('/');
}

function nextPathSegment(filePath: string, baseDepth: number): string | null {
  const segments = filePath.split('/');
  if (baseDepth >= segments.length - 1) return null;
  return segments[baseDepth];
}

function trySplit(filePaths: string[], districtKey: string): Map<string, string[]> {
  const baseDepth = districtKey.split('/').length;
  return splitByPath(filePaths, baseDepth);
}

function splitByPath(filePaths: string[], depth: number): Map<string, string[]> {
  if (depth >= MAX_SPLIT_DEPTH) {
    return chunkAlphabetically(filePaths);
  }

  const directFiles: string[] = [];
  const subDirGroups = new Map<string, string[]>();

  for (const p of filePaths) {
    const segment = nextPathSegment(p, depth);
    if (segment === null) {
      directFiles.push(p);
    } else {
      if (!subDirGroups.has(segment)) subDirGroups.set(segment, []);
      subDirGroups.get(segment)!.push(p);
    }
  }

  if (subDirGroups.size === 0) {
    return chunkAlphabetically(filePaths);
  }

  if (subDirGroups.size === 1 && directFiles.length === 0) {
    const [segment, paths] = [...subDirGroups.entries()][0];
    const subResult = splitByPath(paths, depth + 1);
    const result = new Map<string, string[]>();
    for (const [suffix, subPaths] of subResult) {
      result.set(`${segment}/${suffix}`, subPaths);
    }
    return result;
  }

  const result = new Map<string, string[]>();

  if (directFiles.length > 0) {
    if (directFiles.length > MAX_DISTRICT_FILES) {
      const chunks = chunkAlphabetically(directFiles);
      for (const [label, paths] of chunks) {
        result.set(`(files:${label})`, paths);
      }
    } else {
      result.set('(files)', directFiles);
    }
  }

  for (const [segment, paths] of subDirGroups) {
    if (paths.length > MAX_DISTRICT_FILES) {
      const subResult = splitByPath(paths, depth + 1);
      for (const [suffix, subPaths] of subResult) {
        result.set(`${segment}/${suffix}`, subPaths);
      }
    } else {
      result.set(segment, paths);
    }
  }

  return result;
}

function chunkAlphabetically(filePaths: string[]): Map<string, string[]> {
  const sorted = [...filePaths].sort((a, b) => basename(a).localeCompare(basename(b)));
  const result = new Map<string, string[]>();

  for (let i = 0; i < sorted.length; i += MAX_DISTRICT_FILES) {
    const chunk = sorted.slice(i, Math.min(i + MAX_DISTRICT_FILES, sorted.length));
    const firstChar = basename(chunk[0])[0]?.toLowerCase() ?? '?';
    const lastChar = basename(chunk[chunk.length - 1])[0]?.toLowerCase() ?? '?';
    let label = firstChar === lastChar ? firstChar : `${firstChar}–${lastChar}`;

    const baseLabel = label;
    let attempt = 1;
    while (result.has(label)) {
      attempt++;
      label = `${baseLabel}${attempt}`;
    }

    result.set(label, chunk);
  }

  return result;
}
