import { Injectable } from '@nestjs/common';
import { extname } from 'path';
import type {
  DistrictNode,
  DependencyEdge,
  HotspotEntry,
  ActivitySummary,
  TargetDetail,
  DependencyPairDetail,
  DependencyExemplarEdge,
  DistrictFilePage,
  StructureNode,
  CommitSummary,
  AuthorShare,
} from '@devchain/codebase-overview';
import { classifyFileRole } from './district-splitting.service';
import { isTestFile, type FileChurnData } from './hotspot-scoring.service';
import type { FileAdapterEnrichment } from './language-adapter-registry.service';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FILES_PAGE_SIZE = 50;
const TOP_DEPENDENCY_LIMIT = 5;

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class EvidenceQueryService {
  /**
   * Build a TargetDetail for a district, including template-based summary
   * and hotspot ranking reasons.
   */
  buildTargetDetail(
    district: DistrictNode,
    hotspots: ReadonlyArray<HotspotEntry>,
    activity: ReadonlyArray<ActivitySummary>,
    dependencies: ReadonlyArray<DependencyEdge>,
    recentCommits: CommitSummary[],
    topAuthors: AuthorShare[],
    blastRadius?: Array<{ districtId: string; depth: number }>,
  ): TargetDetail {
    const summary = buildDistrictSummary(district);
    const whyRanked = buildWhyRanked(district.id, hotspots);
    const districtActivity = activity.filter((a) => a.targetId === district.id);

    const topInbound = buildTopDependencies(district.id, dependencies, 'inbound');
    const topOutbound = buildTopDependencies(district.id, dependencies, 'outbound');

    return {
      targetId: district.id,
      kind: 'district',
      summary,
      whyRanked,
      recentCommits,
      topAuthors,
      recentActivity: districtActivity,
      ...(topInbound.length > 0 ? { topInbound } : {}),
      ...(topOutbound.length > 0 ? { topOutbound } : {}),
      ...(blastRadius && blastRadius.length > 0 ? { blastRadius } : {}),
    };
  }

  /**
   * Build a DependencyPairDetail for a district pair.
   * Returns null if no dependency edge exists between the pair.
   */
  buildDependencyPairDetail(
    fromDistrictId: string,
    toDistrictId: string,
    dependencies: ReadonlyArray<DependencyEdge>,
    fromName: string,
    toName: string,
    exemplarEdges: DependencyExemplarEdge[],
  ): DependencyPairDetail | null {
    const edge = dependencies.find(
      (e) => e.fromDistrictId === fromDistrictId && e.toDistrictId === toDistrictId,
    );

    if (!edge) {
      return {
        fromDistrictId,
        toDistrictId,
        weight: 0,
        isCyclic: false,
        summary: `No dependency data is currently available between ${fromName} and ${toName}.`,
        exemplarFileEdges: [],
      };
    }

    return {
      fromDistrictId,
      toDistrictId,
      weight: edge.weight,
      isCyclic: edge.isCyclic,
      summary: buildPairSummary(fromName, toName, edge),
      exemplarFileEdges: exemplarEdges,
    };
  }

  /**
   * Build a paginated file listing for a district.
   */
  buildDistrictFilePage(
    districtId: string,
    files: ReadonlyArray<FileChurnData>,
    fileIds: ReadonlyMap<string, string>,
    allDistrictPaths: ReadonlySet<string>,
    cursor?: string,
    fileEnrichments?: ReadonlyMap<string, FileAdapterEnrichment>,
  ): DistrictFilePage {
    const offset = cursor ? parseInt(cursor, 10) || 0 : 0;
    const nowMs = Date.now();

    const items: StructureNode[] = [];
    const end = Math.min(offset + FILES_PAGE_SIZE, files.length);

    for (let i = offset; i < end; i++) {
      const f = files[i];
      const fileId = fileIds.get(f.path) ?? f.path;
      const staleDays = Math.max(0, Math.floor((nowMs - f.lastModified) / (1000 * 86400)));
      const enrichment = fileEnrichments?.get(f.path);

      // Use adapter role if available, otherwise fall back to path-based
      const role = enrichment?.role ?? classifyFileRole(f.path);

      // Use adapter test pair if available, otherwise fall back to manual check.
      // Test files themselves never report hasColocatedTest = true (same as path-based fallback).
      const colocatedTest = isTestFile(f.path)
        ? false
        : enrichment?.testPair != null
          ? true
          : hasColocatedTest(f.path, allDistrictPaths);

      items.push({
        id: fileId,
        districtId,
        path: f.path,
        role,
        loc: f.loc,
        lastModified: f.lastModified,
        metrics: {
          churn7d: f.churn7d,
          churn30d: f.churn30d,
          staleDays,
          hasColocatedTest: colocatedTest,
          symbolCount: enrichment?.symbolCount ?? null,
          complexity: enrichment?.complexity ?? null,
          coverage: null,
        },
      });
    }

    return {
      districtId,
      items,
      nextCursor: end < files.length ? String(end) : null,
    };
  }
}

// ---------------------------------------------------------------------------
// Template helpers
// ---------------------------------------------------------------------------

function buildDistrictSummary(district: DistrictNode): string {
  const parts: string[] = [];

  const rolePart = district.role === 'mixed' ? '' : ` ${district.role}`;
  parts.push(
    `${district.name} is a ${district.totalLOC.toLocaleString()} LOC${rolePart} district with ${district.totalFiles} files.`,
  );

  if (district.churn30d > 0) {
    parts.push(`It had ${district.churn30d} commits in the last 30 days.`);
  }

  if (district.testFileRatio != null) {
    const pct = Math.round(district.testFileRatio * 100);
    parts.push(`Test file ratio is ${pct}%.`);
  }

  if (district.couplingScore > 0) {
    parts.push(
      `Coupling score is ${district.couplingScore} (${district.inboundWeight} inbound, ${district.outboundWeight} outbound).`,
    );
  }

  if (district.complexityAvg != null) {
    parts.push(`Average complexity is ${district.complexityAvg}.`);
  }

  if (district.ownershipConcentration != null) {
    const pct = Math.round(district.ownershipConcentration * 100);
    parts.push(`Ownership concentration is ${pct}%.`);
  }

  if (district.blastRadius > 0) {
    parts.push(
      `Blast radius affects ${district.blastRadius} other district${district.blastRadius === 1 ? '' : 's'}.`,
    );
  }

  return parts.join(' ');
}

function buildWhyRanked(targetId: string, hotspots: ReadonlyArray<HotspotEntry>): string[] {
  return hotspots
    .filter((h) => h.targetId === targetId)
    .sort((a, b) => a.rank - b.rank)
    .map((h) => `Ranked #${h.rank} for ${h.metric}: ${h.label}`);
}

function buildPairSummary(fromName: string, toName: string, edge: DependencyEdge): string {
  const parts: string[] = [];
  parts.push(`${fromName} depends on ${toName} with weight ${edge.weight}.`);
  if (edge.isCyclic) {
    parts.push('This is a cyclic dependency.');
  }
  return parts.join(' ');
}

function buildTopDependencies(
  districtId: string,
  dependencies: ReadonlyArray<DependencyEdge>,
  direction: 'inbound' | 'outbound',
): Array<{ districtId: string; weight: number }> {
  const filtered =
    direction === 'inbound'
      ? dependencies.filter((e) => e.toDistrictId === districtId)
      : dependencies.filter((e) => e.fromDistrictId === districtId);

  return filtered
    .sort((a, b) => b.weight - a.weight)
    .slice(0, TOP_DEPENDENCY_LIMIT)
    .map((e) => ({
      districtId: direction === 'inbound' ? e.fromDistrictId : e.toDistrictId,
      weight: e.weight,
    }));
}

function hasColocatedTest(filePath: string, allPaths: ReadonlySet<string>): boolean {
  if (isTestFile(filePath)) return false;

  const ext = extname(filePath);
  const base = filePath.slice(0, -ext.length);

  return (
    allPaths.has(`${base}.test${ext}`) ||
    allPaths.has(`${base}.spec${ext}`) ||
    allPaths.has(`${base}_test${ext}`) ||
    allPaths.has(`${base}-spec${ext}`)
  );
}
