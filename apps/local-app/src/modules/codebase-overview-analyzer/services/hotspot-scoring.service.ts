import { Injectable } from '@nestjs/common';
import type {
  DistrictNode,
  FileRole,
  HotspotEntry,
  HotspotMetric,
  ActivitySummary,
} from '@devchain/codebase-overview';
import { classifyFileRole } from './district-splitting.service';
import type { FileAdapterEnrichment } from './language-adapter-registry.service';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface FileChurnData {
  path: string;
  loc: number;
  lastModified: number; // epoch ms (from fs.stat mtimeMs)
  churn1d: number;
  churn7d: number;
  churn30d: number;
  isTest: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TOP_N = 10;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_NAME_RE = /[.\-_](test|spec)\.[^/\\]+$/i;
const TEST_DIR_RE = /(^|[/\\])(__tests__|tests?)[/\\]/i;

export function isTestFile(filePath: string): boolean {
  return TEST_NAME_RE.test(filePath) || TEST_DIR_RE.test(filePath);
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class HotspotScoringService {
  /**
   * Fill district-level churn and test metrics from file-level data.
   * Mutates district nodes in place.
   */
  enrichDistrictMetrics(
    districts: DistrictNode[],
    districtFiles: ReadonlyMap<string, FileChurnData[]>,
  ): void {
    for (const district of districts) {
      const files = districtFiles.get(district.id) ?? [];

      let churn7d = 0;
      let churn30d = 0;
      let testFileCount = 0;
      const roleCounts = new Map<FileRole, number>();

      for (const f of files) {
        churn7d += f.churn7d;
        churn30d += f.churn30d;
        if (f.isTest) testFileCount++;
        const role = classifyFileRole(f.path);
        roleCounts.set(role, (roleCounts.get(role) ?? 0) + 1);
      }

      district.churn7d = churn7d;
      district.churn30d = churn30d;
      district.testFileCount = testFileCount;
      district.testFileRatio = files.length > 0 ? testFileCount / files.length : null;

      if (files.length > 0) {
        district.role = dominantRole(roleCounts);
      }
    }
  }

  /**
   * Enrich districts with adapter-derived metrics (complexity, test coverage rate).
   * Mutates district nodes in place.
   */
  enrichDistrictAdapterMetrics(
    districts: DistrictNode[],
    districtFiles: ReadonlyMap<string, FileChurnData[]>,
    enrichments: ReadonlyMap<string, FileAdapterEnrichment>,
  ): void {
    for (const district of districts) {
      const files = districtFiles.get(district.id) ?? [];
      if (files.length === 0) continue;

      // Complexity: average across files that have complexity data
      let complexitySum = 0;
      let complexityCount = 0;
      // Test coverage rate: fraction of adapter-measured source files with detected test pair
      let measuredSourceFiles = 0;
      let coveredFiles = 0;

      for (const f of files) {
        const enrichment = enrichments.get(f.path);
        if (enrichment?.complexity != null) {
          complexitySum += enrichment.complexity;
          complexityCount++;
        }
        if (!f.isTest && enrichment !== undefined) {
          measuredSourceFiles++;
          if (enrichment.testPair != null) coveredFiles++;
        }
      }

      district.complexityAvg =
        complexityCount > 0 ? Math.round((complexitySum / complexityCount) * 10) / 10 : null;
      district.testCoverageRate =
        measuredSourceFiles > 0
          ? Math.round((coveredFiles / measuredSourceFiles) * 100) / 100
          : null;
    }
  }

  /**
   * Enrich districts with ownership concentration from per-file author data.
   * Mutates district nodes in place.
   */
  enrichDistrictOwnership(
    districts: DistrictNode[],
    districtFiles: ReadonlyMap<string, FileChurnData[]>,
    fileAuthors: ReadonlyMap<string, Map<string, number>>,
  ): void {
    for (const district of districts) {
      const files = districtFiles.get(district.id) ?? [];
      if (files.length === 0) continue;

      // Aggregate author commit counts across all files in this district
      const authorCounts = new Map<string, number>();
      for (const f of files) {
        const authors = fileAuthors.get(f.path);
        if (!authors) continue;
        for (const [author, count] of authors) {
          authorCounts.set(author, (authorCounts.get(author) ?? 0) + count);
        }
      }

      if (authorCounts.size === 0) {
        district.ownershipConcentration = null;
        district.primaryAuthorName = null;
        district.primaryAuthorShare = null;
        continue;
      }

      // Herfindahl-Hirschman Index: sum of squared shares (0-1)
      const totalCommits = [...authorCounts.values()].reduce((a, b) => a + b, 0);
      let hhi = 0;
      let primaryAuthorName = '';
      let primaryAuthorMaxCount = 0;
      for (const [author, count] of authorCounts) {
        const share = count / totalCommits;
        hhi += share * share;
        if (count > primaryAuthorMaxCount) {
          primaryAuthorMaxCount = count;
          primaryAuthorName = author;
        }
      }

      district.ownershipConcentration = Math.round(hhi * 100) / 100;
      district.primaryAuthorName = primaryAuthorName;
      district.primaryAuthorShare = Math.round((primaryAuthorMaxCount / totalCommits) * 100) / 100;
    }
  }

  /**
   * Rank districts into hotspot entries across all active metrics.
   * Returns entries sorted by metric then rank.
   */
  rankHotspots(
    districts: ReadonlyArray<DistrictNode>,
    districtFiles: ReadonlyMap<string, FileChurnData[]>,
  ): HotspotEntry[] {
    if (districts.length === 0) return [];

    const entries: HotspotEntry[] = [];
    const nowMs = Date.now();

    // Size — largest districts by LOC (analysis corpus: excludes generated files)
    addRankedEntries(
      entries,
      districts,
      'size',
      (d) => (districtFiles.get(d.id) ?? []).reduce((s, f) => s + f.loc, 0),
      (d, score) => `${d.name} — ${score.toLocaleString()} LOC`,
    );

    // Churn — most modified districts by 30d commit count (analysis corpus via pre-enriched field)
    addRankedEntries(
      entries,
      districts,
      'churn',
      (d) => d.churn30d,
      (d, score) => `${d.name} — ${score} commits in 30d`,
    );

    // Test risk — districts with lowest test file ratio (analysis corpus via pre-enriched field)
    const districtsWithFiles = districts.filter((d) => d.totalFiles > 0);
    addRankedEntries(
      entries,
      districtsWithFiles,
      'tests',
      (d) => {
        const ratio = d.testFileRatio ?? 0;
        return Math.round((1 - ratio) * 100);
      },
      (d) => {
        const pct = d.testFileRatio != null ? Math.round(d.testFileRatio * 100) : 0;
        return `${d.name} — ${pct}% test files`;
      },
    );

    // Staleness — districts whose most-recent file modification is oldest
    const stalenessMap = new Map<string, number>();
    for (const district of districts) {
      const files = districtFiles.get(district.id) ?? [];
      if (files.length === 0) continue;
      const mostRecent = Math.max(...files.map((f) => f.lastModified));
      const staleDays = Math.max(0, Math.floor((nowMs - mostRecent) / (1000 * 86400)));
      stalenessMap.set(district.id, staleDays);
    }

    addRankedEntries(
      entries,
      districts,
      'staleness',
      (d) => stalenessMap.get(d.id) ?? 0,
      (d, score) => `${d.name} — last modified ${score}d ago`,
    );

    // Coupling — districts with highest coupling score (inbound + outbound)
    addRankedEntries(
      entries,
      districts,
      'coupling',
      (d) => d.couplingScore,
      (d, score) =>
        `${d.name} — coupling ${score} (${d.inboundWeight} in, ${d.outboundWeight} out)`,
    );

    // Complexity — districts with highest average complexity
    const complexDistricts = districts.filter((d) => d.complexityAvg != null);
    addRankedEntries(
      entries,
      complexDistricts,
      'complexity',
      (d) => d.complexityAvg!,
      (d, score) => `${d.name} — avg complexity ${score}`,
    );

    // Ownership — districts with highest ownership concentration (knowledge risk)
    const ownedDistricts = districts.filter((d) => d.ownershipConcentration != null);
    addRankedEntries(
      entries,
      ownedDistricts,
      'ownership',
      (d) => Math.round(d.ownershipConcentration! * 100),
      (d) => {
        const pct = Math.round(d.ownershipConcentration! * 100);
        return `${d.name} — ${pct}% ownership concentration`;
      },
    );

    return entries;
  }

  private static readonly CONTRIBUTORS_PER_DISTRICT = 5;

  /**
   * Compute activity summaries per district.
   */
  computeActivitySummaries(
    districts: ReadonlyArray<DistrictNode>,
    districtFiles: ReadonlyMap<string, FileChurnData[]>,
    dailyChurnFileMap?: ReadonlyMap<string, ReadonlyMap<string, number>> | null,
    windowedAuthor7d?: ReadonlyMap<string, ReadonlyMap<string, number>> | null,
    windowedAuthor30d?: ReadonlyMap<string, ReadonlyMap<string, number>> | null,
  ): ActivitySummary[] {
    return districts.map((district) => {
      const files = districtFiles.get(district.id) ?? [];

      let modifiedCount1d = 0;
      let modifiedCount7d = 0;
      let latestTimestamp: number | null = null;

      for (const f of files) {
        if (f.churn1d > 0) modifiedCount1d++;
        if (f.churn7d > 0) modifiedCount7d++;
        if (latestTimestamp == null || f.lastModified > latestTimestamp) {
          latestTimestamp = f.lastModified;
        }
      }

      const result: ActivitySummary = {
        targetId: district.id,
        targetKind: 'district' as const,
        modifiedCount1d,
        modifiedCount7d,
        buildFailures7d: null,
        testFailures7d: null,
        latestTimestamp: latestTimestamp != null ? Math.floor(latestTimestamp / 1000) : null,
        recentContributors7d: [],
        recentContributors30d: [],
      };

      if (dailyChurnFileMap) {
        const dailyChurn: Record<string, number> = {};
        for (const f of files) {
          const dateMap = dailyChurnFileMap.get(f.path);
          if (!dateMap) continue;
          for (const [dateStr, count] of dateMap) {
            dailyChurn[dateStr] = (dailyChurn[dateStr] ?? 0) + count;
          }
        }
        if (Object.keys(dailyChurn).length > 0) {
          result.dailyChurn = dailyChurn;
        }
      }

      if (windowedAuthor7d) {
        result.recentContributors7d = this.aggregateContributors(files, windowedAuthor7d);
      }
      if (windowedAuthor30d) {
        result.recentContributors30d = this.aggregateContributors(files, windowedAuthor30d);
      }

      return result;
    });
  }

  private aggregateContributors(
    files: ReadonlyArray<FileChurnData>,
    authorMap: ReadonlyMap<string, ReadonlyMap<string, number>>,
  ): Array<{ authorName: string; commitCount: number }> {
    const totals = new Map<string, number>();
    for (const f of files) {
      const fileAuthors = authorMap.get(f.path);
      if (!fileAuthors) continue;
      for (const [author, count] of fileAuthors) {
        totals.set(author, (totals.get(author) ?? 0) + count);
      }
    }
    return [...totals.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, HotspotScoringService.CONTRIBUTORS_PER_DISTRICT)
      .map(([authorName, commitCount]) => ({ authorName, commitCount }));
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function dominantRole(roleCounts: Map<FileRole, number>): FileRole | 'mixed' {
  let maxRole: FileRole | 'mixed' = 'mixed';
  let maxCount = 0;
  let knownCount = 0;
  for (const [role, count] of roleCounts) {
    if (role === 'unknown') continue;
    knownCount += count;
    if (count > maxCount) {
      maxCount = count;
      maxRole = role;
    }
  }
  if (knownCount === 0) return 'mixed';
  return maxCount > knownCount * 0.5 ? maxRole : 'mixed';
}

function addRankedEntries(
  entries: HotspotEntry[],
  districts: ReadonlyArray<DistrictNode>,
  metric: HotspotMetric,
  scoreFn: (d: DistrictNode) => number,
  labelFn: (d: DistrictNode, score: number) => string,
): void {
  const scored = districts
    .map((d) => ({ district: d, score: scoreFn(d) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  const count = Math.min(scored.length, TOP_N);
  for (let i = 0; i < count; i++) {
    const { district, score } = scored[i];
    entries.push({
      id: `hotspot:${metric}:${i + 1}`,
      kind: 'district',
      targetId: district.id,
      metric,
      rank: i + 1,
      score,
      label: labelFn(district, score),
    });
  }
}
