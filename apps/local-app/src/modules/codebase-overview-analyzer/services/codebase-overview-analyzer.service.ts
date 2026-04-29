import { Injectable } from '@nestjs/common';
import { execFile } from 'child_process';
import { createHash } from 'crypto';
import { promisify } from 'util';
import { type Dirent, existsSync } from 'fs';
import * as fs from 'fs/promises';
import { dirname, extname, join, normalize, relative, sep } from 'path';
import { isUnderAnyFolder } from '../utils/path-matcher';
import { MAX_FOLDER_DEPTH } from '../utils/constants';
import type {
  CodebaseOverviewSnapshot,
  CodebaseOverviewMetrics,
  RegionNode,
  DistrictNode,
  DistrictSignals,
  AnalysisWarning,
  TargetDetail,
  DependencyPairDetail,
  DistrictFilePage,
  CommitSummary,
  AuthorShare,
} from '@devchain/codebase-overview';
import { createLogger } from '../../../common/logging/logger';
import {
  IdentityResolverService,
  type GitRename,
  type PreviousIdentityState,
  type DistrictIdentityEntry,
} from './identity-resolver.service';
import { HotspotScoringService, isTestFile, type FileChurnData } from './hotspot-scoring.service';
import { DistrictSplittingService } from './district-splitting.service';
import { DependencyAggregationService, type FileEdge } from './dependency-aggregation.service';
import { EvidenceQueryService } from './evidence-query.service';
import {
  LanguageAdapterRegistryService,
  type FileAdapterEnrichment,
} from './language-adapter-registry.service';
import { ScopeResolverService } from './scope-resolver.service';
import { ScopeAutoDetectorService } from './scope-auto-detector.service';
import { OverviewScopeRepository } from '../repositories/overview-scope.repository';

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 10 * 1024 * 1024; // 10 MB
const MAX_ADAPTER_FILE_SIZE = 256 * 1024; // 256 KB — skip large/generated files
const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf899d15f0a75b9a7';
const ROOT_REGION_NAME = '(root)';
const RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'];

const logger = createLogger('CodebaseOverviewAnalyzer');

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface ScannedFile {
  path: string;
  loc: number;
  lastModified: number;
}

interface LocFallbackStats {
  counted: number;
  skipped: number;
  eligible: number;
}

interface RepoCapabilities {
  isGitRepo: boolean;
  isShallow: boolean;
  totalCommits: number;
  oldestCommitTimestamp: number | null;
  gitHistoryDays: number | null;
}

interface SegmentResult {
  regions: RegionNode[];
  districts: DistrictNode[];
  districtFileMap: Map<string, string[]>; // districtKey → file paths
}

interface AdapterAnalysisResult {
  fileEdges: FileEdge[];
  enrichments: Map<string, FileAdapterEnrichment>;
  adapterFileCount: number;
}

interface ProjectQueryState {
  snapshot: CodebaseOverviewSnapshot;
  districtFilesById: Map<string, FileChurnData[]>;
  fileIds: Map<string, string>;
  allFilePaths: Set<string>; // all file paths across all districts (for cross-district colocated test lookup)
  fileEnrichments: Map<string, FileAdapterEnrichment>;
  blastRadiusMap: Map<string, Array<{ districtId: string; depth: number }>>;
  fileEdges: FileEdge[];
  isGitRepo: boolean;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class CodebaseOverviewAnalyzerService {
  private readonly identityStore = new Map<string, PreviousIdentityState>();
  private readonly queryStore = new Map<string, ProjectQueryState>();

  constructor(
    private readonly identityResolver: IdentityResolverService,
    private readonly hotspotScoring: HotspotScoringService,
    private readonly districtSplitting: DistrictSplittingService,
    private readonly dependencyAggregation: DependencyAggregationService,
    private readonly evidenceQuery: EvidenceQueryService,
    private readonly adapterRegistry: LanguageAdapterRegistryService,
    private readonly scopeResolver: ScopeResolverService,
    private readonly scopeAutoDetector: ScopeAutoDetectorService,
    private readonly scopeRepository: OverviewScopeRepository,
  ) {}
  /**
   * Scan a repository and assemble a snapshot with regions, districts,
   * basic metrics, and partial-analysis warnings.
   */
  async getSnapshot(projectPath: string, projectId: string): Promise<CodebaseOverviewSnapshot> {
    const capabilities = await this.detectCapabilities(projectPath);

    // --- Scope resolution (3-source merge) ---
    // Phase 1: resolve with user entries + built-in defaults only (to get pre-walk exclusions)
    const userEntries = this.scopeRepository.readUserEntries(projectPath, projectId);
    const preResolvedScope = this.scopeResolver.resolve(userEntries);
    const preExcludedFolders = this.scopeResolver.getExcludedFolders(preResolvedScope);

    // Scan files (applies pre-walk exclusions)
    const { files, locFallbackStats } = await this.scanFiles(
      projectPath,
      capabilities,
      preExcludedFolders,
    );

    // Phase 2: extract observed top-level folders from scanned files for auto-detection
    const observedFolders = this.extractObservedFolders(files);
    const autoDetected = this.scopeAutoDetector.detect(observedFolders);
    const resolvedScope = this.scopeResolver.resolve(userEntries, autoDetected);
    const excludedFolders = this.scopeResolver.getExcludedFolders(resolvedScope);
    const generatedFolders = this.scopeResolver.getGeneratedFolders(resolvedScope);
    const scopeConfigHash = createHash('sha256')
      .update(JSON.stringify(resolvedScope))
      .digest('hex')
      .slice(0, 8);

    // Re-filter if auto-detection added new excluded folders beyond built-in defaults
    const extraExcluded = excludedFolders.filter((f) => !preExcludedFolders.includes(f));
    let filteredFiles = files;
    if (extraExcluded.length > 0) {
      filteredFiles = files.filter((f) => !isUnderAnyFolder(f.path, extraExcluded));
    }
    const segmented = this.segmentFiles(filteredFiles);
    const regions = segmented.regions;

    // --- District splitting ---
    const locMap = new Map(filteredFiles.map((f) => [f.path, f.loc]));
    const { districts, districtFileMap } = this.districtSplitting.splitOversizedDistricts(
      segmented.districts,
      segmented.districtFileMap,
      locMap,
      filteredFiles.length,
    );

    // --- Identity resolution ---
    const previousState = this.identityStore.get(projectPath) ?? null;
    const commitSha = capabilities.isGitRepo ? await this.getCurrentCommitSha(projectPath) : null;
    const gitRenames = capabilities.isGitRepo
      ? await this.detectGitRenames(projectPath, previousState?.commitSha ?? null)
      : [];

    // Resolve stable file IDs
    const fileIds = this.identityResolver.resolveFileIds(
      filteredFiles.map((f) => f.path),
      previousState,
      gitRenames,
    );

    // Resolve stable region IDs
    const regionIds = this.identityResolver.resolveRegionIds(
      regions.map((r) => r.name),
      previousState,
    );

    // Build district candidates with member file IDs
    const districtCandidates = [...districtFileMap.entries()].map(([key, paths]) => ({
      key,
      memberFileIds: paths.map((p) => fileIds.get(p)!),
    }));

    // Resolve stable district IDs
    const districtIds = this.identityResolver.resolveDistrictIds(districtCandidates, previousState);

    // Apply resolved IDs
    for (const region of regions) {
      region.id = regionIds.get(region.name)!;
    }
    for (const district of districts) {
      // district.id is initially "district:{regionName}/{districtName}"
      const districtKey = district.id.slice('district:'.length);
      const resolvedId = districtIds.get(districtKey);
      if (resolvedId) district.id = resolvedId;
      const regionName = districtKey.split('/')[0];
      district.regionId = regionIds.get(regionName)!;
    }

    // Persist identity state for next resolution
    this.storeIdentityState(
      projectPath,
      commitSha,
      fileIds,
      regionIds,
      districtIds,
      districtFileMap,
    );

    // --- Churn extraction ---
    const [churn1d, churn7d, churn30d, dailyChurnFileMap] = capabilities.isGitRepo
      ? await Promise.all([
          this.getChurnMap(projectPath, 1),
          this.getChurnMap(projectPath, 7),
          this.getChurnMap(projectPath, 30),
          this.getDailyChurnMap(projectPath, 14),
        ])
      : [
          new Map<string, number>(),
          new Map<string, number>(),
          new Map<string, number>(),
          null as Map<string, Map<string, number>> | null,
        ];

    // --- Build enriched file data per district (keyed by resolved ID) ---
    const fileByPath = new Map(filteredFiles.map((f) => [f.path, f]));
    const districtFilesById = new Map<string, FileChurnData[]>();

    for (const [districtKey, filePaths] of districtFileMap) {
      const districtId = districtIds.get(districtKey);
      if (!districtId) continue;
      const enriched: FileChurnData[] = filePaths.map((p) => {
        const file = fileByPath.get(p);
        return {
          path: p,
          loc: file?.loc ?? 0,
          lastModified: file?.lastModified ?? Date.now(),
          churn1d: churn1d.get(p) ?? 0,
          churn7d: churn7d.get(p) ?? 0,
          churn30d: churn30d.get(p) ?? 0,
          isTest: isTestFile(p),
        };
      });
      districtFilesById.set(districtId, enriched);
    }

    // --- Two-corpora split ---
    // analysisDistrictFilesById: excludes generated files (code-quality metrics)
    // districtFilesById (full): attribution (ownership, contributors, churn)
    const analysisDistrictFilesById = new Map<string, FileChurnData[]>();
    for (const [districtId, dFiles] of districtFilesById) {
      const filtered = dFiles.filter((f) => !isUnderAnyFolder(f.path, generatedFolders));
      analysisDistrictFilesById.set(districtId, filtered);
    }
    const analysisDistricts = districts.filter((d) => {
      const files = analysisDistrictFilesById.get(d.id);
      return Array.isArray(files) && files.length > 0;
    });

    // --- Hotspot scoring (pre-ranking enrichment) ---
    // analysis corpus: churn/testFileRatio on DistrictNode exclude generated files
    this.hotspotScoring.enrichDistrictMetrics(districts, analysisDistrictFilesById);

    // --- Windowed author extraction ---
    const [windowedAuthor7d, windowedAuthor30d] = capabilities.isGitRepo
      ? await Promise.all([
          this.getWindowedAuthorMap(projectPath, 7),
          this.getWindowedAuthorMap(projectPath, 30),
        ])
      : [null as Map<string, Map<string, number>> | null, null];

    const activity = this.hotspotScoring.computeActivitySummaries(
      districts,
      districtFilesById,
      dailyChurnFileMap,
      windowedAuthor7d,
      windowedAuthor30d,
    );

    // --- Global contributors (deduplicated across districts) ---
    const globalContributors = this.buildGlobalContributors(
      districts,
      districtFilesById,
      windowedAuthor7d,
      windowedAuthor30d,
    );

    // --- Language adapter analysis ---
    const allFilePaths = new Set<string>();
    for (const dFiles of districtFilesById.values()) {
      for (const f of dFiles) allFilePaths.add(f.path);
    }
    const adapterResult = await this.analyzeWithAdapters(projectPath, allFilePaths);

    // --- Adapter-derived district metrics (complexity, test coverage rate) ---
    // Uses analysisDistrictFilesById: generated districts get null complexity/coverage
    this.hotspotScoring.enrichDistrictAdapterMetrics(
      districts,
      analysisDistrictFilesById,
      adapterResult.enrichments,
    );

    // --- Ownership concentration ---
    const fileAuthors = capabilities.isGitRepo
      ? await this.getFileAuthorMap(projectPath)
      : new Map<string, Map<string, number>>();
    this.hotspotScoring.enrichDistrictOwnership(districts, districtFilesById, fileAuthors);

    // --- Dependency aggregation ---
    const fileToDistrictId = new Map<string, string>();
    for (const [districtId, dFiles] of districtFilesById) {
      for (const f of dFiles) {
        fileToDistrictId.set(f.path, districtId);
      }
    }
    const dependencies = this.dependencyAggregation.aggregateDistrictDependencies(
      adapterResult.fileEdges,
      fileToDistrictId,
    );
    this.dependencyAggregation.enrichDistrictWeights(districts, dependencies);
    const blastRadiusMap = this.dependencyAggregation.computeBlastRadius(districts, dependencies);

    // --- Hotspot ranking (after all enrichment passes) ---
    // Uses analysis corpus: generated districts excluded from ranking
    const hotspots = this.hotspotScoring.rankHotspots(analysisDistricts, analysisDistrictFilesById);

    const hasImportData = adapterResult.fileEdges.length > 0;
    const warnings = this.buildWarnings(
      capabilities,
      hasImportData,
      adapterResult.adapterFileCount,
      locFallbackStats,
    );

    const hasUnmeasuredCoverage = districts.some((d) => {
      const dFiles = analysisDistrictFilesById.get(d.id) ?? [];
      return dFiles.some((f) => !f.isTest) && d.testCoverageRate === null;
    });
    if (hasUnmeasuredCoverage) {
      warnings.push({
        code: 'coverage_unmeasured',
        message:
          'Some districts contain source files but no supported language adapter could measure test coverage.',
      });
    }

    if (capabilities.isGitRepo && dailyChurnFileMap === null) {
      warnings.push({
        code: 'daily_churn_unavailable',
        message:
          'Daily churn data could not be retrieved. The per-day change heatmap will be unavailable.',
      });
    }

    if (capabilities.isGitRepo && (windowedAuthor7d === null || windowedAuthor30d === null)) {
      warnings.push({
        code: 'windowed_authors_unavailable',
        message:
          'Windowed author data could not be retrieved. Contributor rankings will be incomplete.',
      });
    }

    const excludedAuthorCount = this.computeExcludedAuthorCount(
      fileAuthors,
      excludedFolders,
      globalContributors,
    );
    const metrics = this.computeMetrics(
      filteredFiles,
      regions,
      districts,
      capabilities,
      warnings,
      excludedAuthorCount,
      scopeConfigHash,
    );

    // --- Owner-quiet detection: cross-reference primary author vs 30d contributors ---
    const activityByDistrictId = new Map(activity.map((a) => [a.targetId, a]));
    for (const district of districts) {
      if (district.primaryAuthorName == null) {
        district.primaryAuthorRecentlyActive = false;
        continue;
      }
      const act = activityByDistrictId.get(district.id);
      const recentNames = new Set(act?.recentContributors30d.map((c) => c.authorName) ?? []);
      district.primaryAuthorRecentlyActive = recentNames.has(district.primaryAuthorName);
    }

    // --- Build district signals projection ---
    const regionById = new Map(regions.map((r) => [r.id, r]));
    const signals: DistrictSignals[] = districts.map((district) => {
      const dFiles = districtFilesById.get(district.id) ?? [];
      const extCounts: Record<string, number> = {};
      let sourceFileCount = 0;
      let supportFileCount = 0;
      for (const f of dFiles) {
        const ext = extname(f.path) || '(no ext)';
        extCounts[ext] = (extCounts[ext] ?? 0) + 1;
        if (f.isTest) {
          supportFileCount++;
        } else {
          sourceFileCount++;
        }
      }
      return {
        districtId: district.id,
        name: district.name,
        path: district.path,
        regionId: district.regionId,
        regionName: regionById.get(district.regionId)?.name ?? '',
        files: district.totalFiles,
        sourceFileCount,
        supportFileCount,
        hasSourceFiles: sourceFileCount > 0,
        loc: district.totalLOC,
        churn7d: district.churn7d,
        churn30d: district.churn30d,
        testCoverageRate: district.testCoverageRate,
        sourceCoverageMeasured: district.testCoverageRate !== null,
        complexityAvg: district.complexityAvg,
        inboundWeight: district.inboundWeight,
        outboundWeight: district.outboundWeight,
        blastRadius: district.blastRadius,
        couplingScore: district.couplingScore,
        ownershipHHI: district.ownershipConcentration,
        ownershipMeasured: district.ownershipConcentration !== null,
        primaryAuthorName: district.primaryAuthorName,
        primaryAuthorShare: district.primaryAuthorShare,
        primaryAuthorRecentlyActive: district.primaryAuthorRecentlyActive,
        fileTypeBreakdown: { kind: 'extension', counts: extCounts },
      };
    });

    const snapshot: CodebaseOverviewSnapshot = {
      snapshotId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      projectKey: projectPath,
      name: projectPath.split(sep).pop() || projectPath,
      regions,
      districts,
      dependencies,
      hotspots,
      activity,
      metrics,
      signals,
      globalContributors,
    };

    // Store state for evidence queries
    this.queryStore.set(projectPath, {
      snapshot,
      districtFilesById,
      fileIds,
      allFilePaths,
      fileEnrichments: adapterResult.enrichments,
      blastRadiusMap,
      fileEdges: adapterResult.fileEdges,
      isGitRepo: capabilities.isGitRepo,
    });

    return snapshot;
  }

  // -------------------------------------------------------------------------
  // Evidence queries
  // -------------------------------------------------------------------------

  async getTargetDetails(projectPath: string, targetId: string): Promise<TargetDetail | null> {
    const state = this.queryStore.get(projectPath);
    if (!state) return null;

    const district = state.snapshot.districts.find((d) => d.id === targetId);
    if (!district) return null;

    const filePaths = state.districtFilesById.get(targetId)?.map((f) => f.path) ?? [];
    const recentCommits = state.isGitRepo
      ? await this.getRecentCommits(projectPath, filePaths)
      : [];
    const topAuthors = state.isGitRepo ? await this.getTopAuthors(projectPath, filePaths) : [];

    const blastRadius = state.blastRadiusMap.get(targetId);

    return this.evidenceQuery.buildTargetDetail(
      district,
      state.snapshot.hotspots,
      state.snapshot.activity,
      state.snapshot.dependencies,
      recentCommits,
      topAuthors,
      blastRadius,
    );
  }

  getDependencyPairDetails(
    projectPath: string,
    fromDistrictId: string,
    toDistrictId: string,
  ): DependencyPairDetail | null {
    const state = this.queryStore.get(projectPath);
    if (!state) return null;

    const fromDistrict = state.snapshot.districts.find((d) => d.id === fromDistrictId);
    const toDistrict = state.snapshot.districts.find((d) => d.id === toDistrictId);
    if (!fromDistrict || !toDistrict) return null;

    // Build exemplar file edges from the stored file-level import data
    const exemplars = this.buildExemplarEdges(
      fromDistrictId,
      toDistrictId,
      state.fileEdges,
      state.districtFilesById,
      state.fileIds,
    );

    return this.evidenceQuery.buildDependencyPairDetail(
      fromDistrictId,
      toDistrictId,
      state.snapshot.dependencies,
      fromDistrict.name,
      toDistrict.name,
      exemplars,
    );
  }

  listDistrictFiles(
    projectPath: string,
    districtId: string,
    cursor?: string,
  ): DistrictFilePage | null {
    const state = this.queryStore.get(projectPath);
    if (!state) return null;

    const files = state.districtFilesById.get(districtId);
    if (!files) return null;

    // Use all project file paths for colocated-test lookup so tests in
    // sibling split districts are still discoverable.
    return this.evidenceQuery.buildDistrictFilePage(
      districtId,
      files,
      state.fileIds,
      state.allFilePaths,
      cursor,
      state.fileEnrichments,
    );
  }

  // -------------------------------------------------------------------------
  // Git helpers
  // -------------------------------------------------------------------------

  private async execGit(
    projectPath: string,
    args: string[],
    options?: { allowNonZero?: boolean },
  ): Promise<string> {
    try {
      const { stdout } = await execFileAsync('git', args, {
        cwd: projectPath,
        maxBuffer: MAX_BUFFER,
      });
      return stdout;
    } catch (err: unknown) {
      if (options?.allowNonZero && isExecError(err) && err.stdout != null) {
        return err.stdout;
      }
      throw err;
    }
  }

  private async getRecentCommits(
    projectPath: string,
    filePaths: string[],
    limit = 10,
  ): Promise<CommitSummary[]> {
    if (filePaths.length === 0) return [];
    try {
      const out = await this.execGit(projectPath, [
        'log',
        `--format=%H%n%s%n%at`,
        `-n`,
        String(limit),
        '--',
        ...filePaths,
      ]);
      const lines = out.split('\n').filter((l) => l.length > 0);
      const commits: CommitSummary[] = [];
      for (let i = 0; i + 2 < lines.length; i += 3) {
        const ts = parseInt(lines[i + 2], 10);
        commits.push({
          sha: lines[i],
          message: lines[i + 1],
          timestamp: isNaN(ts) ? 0 : ts,
        });
      }
      return commits;
    } catch {
      return [];
    }
  }

  private async getTopAuthors(
    projectPath: string,
    filePaths: string[],
    limit = 5,
  ): Promise<AuthorShare[]> {
    if (filePaths.length === 0) return [];
    try {
      const out = await this.execGit(projectPath, ['shortlog', '-sn', 'HEAD', '--', ...filePaths]);
      const entries: Array<{ author: string; count: number }> = [];
      for (const line of out.split('\n')) {
        const match = line.match(/^\s*(\d+)\s+(.+)$/);
        if (match) {
          entries.push({ author: match[2].trim(), count: parseInt(match[1], 10) });
        }
      }
      const total = entries.reduce((sum, e) => sum + e.count, 0);
      if (total === 0) return [];
      return entries.slice(0, limit).map((e) => ({
        author: e.author,
        share: Math.round((e.count / total) * 100) / 100,
      }));
    } catch {
      return [];
    }
  }

  /**
   * Build exemplar file edges for a specific district pair from stored file-level import data.
   * Returns the top edges by weight (deduped) for display in dependency pair detail.
   */
  private buildExemplarEdges(
    fromDistrictId: string,
    toDistrictId: string,
    fileEdges: ReadonlyArray<FileEdge>,
    districtFilesById: ReadonlyMap<string, FileChurnData[]>,
    fileIds: ReadonlyMap<string, string>,
    limit = 10,
  ): DependencyPairDetail['exemplarFileEdges'] {
    const fromFiles = new Set((districtFilesById.get(fromDistrictId) ?? []).map((f) => f.path));
    const toFiles = new Set((districtFilesById.get(toDistrictId) ?? []).map((f) => f.path));

    const edgeMap = new Map<string, { fromPath: string; toPath: string; weight: number }>();
    for (const edge of fileEdges) {
      if (!fromFiles.has(edge.fromPath) || !toFiles.has(edge.toPath)) continue;
      const key = `${edge.fromPath}\0${edge.toPath}`;
      const existing = edgeMap.get(key);
      if (existing) {
        existing.weight += edge.weight ?? 1;
      } else {
        edgeMap.set(key, {
          fromPath: edge.fromPath,
          toPath: edge.toPath,
          weight: edge.weight ?? 1,
        });
      }
    }

    return [...edgeMap.values()]
      .sort((a, b) => b.weight - a.weight)
      .slice(0, limit)
      .map((e) => ({
        fromFileId: fileIds.get(e.fromPath) ?? e.fromPath,
        toFileId: fileIds.get(e.toPath) ?? e.toPath,
        fromPath: e.fromPath,
        toPath: e.toPath,
        weight: e.weight,
      }));
  }

  /**
   * Get per-file author commit counts in a single git log pass.
   * Returns Map<filePath, Map<author, commitCount>>.
   */
  async getFileAuthorMap(projectPath: string): Promise<Map<string, Map<string, number>>> {
    const result = new Map<string, Map<string, number>>();
    try {
      // Real output format per commit:
      //   <author name>\n\n<file1>\n<file2>\n...\n\n
      // Blank line separates author from files, and commits from each other.
      const out = await this.execGit(projectPath, ['log', '--format=%aN', '--name-only', 'HEAD']);

      let currentAuthor: string | null = null;
      let seenFiles = false;
      for (const line of out.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) {
          // Blank line: if we've seen files, this is a commit boundary
          if (seenFiles) {
            currentAuthor = null;
            seenFiles = false;
          }
          // Otherwise it's the blank line between author and file list — skip
          continue;
        }
        if (currentAuthor === null) {
          currentAuthor = trimmed;
          continue;
        }
        // trimmed is a file path
        seenFiles = true;
        let authorMap = result.get(trimmed);
        if (!authorMap) {
          authorMap = new Map<string, number>();
          result.set(trimmed, authorMap);
        }
        authorMap.set(currentAuthor, (authorMap.get(currentAuthor) ?? 0) + 1);
      }
    } catch {
      // Author data unavailable — map stays empty
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // Capability detection
  // -------------------------------------------------------------------------

  async detectCapabilities(projectPath: string): Promise<RepoCapabilities> {
    const gitDir = join(projectPath, '.git');
    const isGitRepo = existsSync(gitDir);
    if (!isGitRepo) {
      return {
        isGitRepo: false,
        isShallow: false,
        totalCommits: 0,
        oldestCommitTimestamp: null,
        gitHistoryDays: null,
      };
    }

    let isShallow = false;
    try {
      const out = await this.execGit(projectPath, ['rev-parse', '--is-shallow-repository']);
      isShallow = out.trim() === 'true';
    } catch {
      // If rev-parse fails, assume not shallow
    }

    let totalCommits = 0;
    let oldestCommitTimestamp: number | null = null;
    try {
      const countOut = await this.execGit(projectPath, ['rev-list', '--count', 'HEAD']);
      totalCommits = parseInt(countOut.trim(), 10) || 0;

      if (totalCommits > 0) {
        const oldestOut = await this.execGit(projectPath, [
          'log',
          '--format=%at',
          '--reverse',
          '-1',
        ]);
        const ts = parseInt(oldestOut.trim(), 10);
        if (!isNaN(ts)) {
          oldestCommitTimestamp = ts;
        }
      }
    } catch {
      // Git log may fail on empty repos
    }

    const gitHistoryDays =
      oldestCommitTimestamp != null
        ? Math.floor((Date.now() / 1000 - oldestCommitTimestamp) / 86400)
        : null;

    return {
      isGitRepo,
      isShallow,
      totalCommits,
      oldestCommitTimestamp,
      gitHistoryDays,
    };
  }

  private extractObservedFolders(files: ScannedFile[]): string[] {
    const seen = new Set<string>();
    for (const file of files) {
      const segments = file.path.split(/[/\\]/);
      const limit = Math.min(segments.length - 1, MAX_FOLDER_DEPTH);
      for (let d = 1; d <= limit; d++) {
        seen.add(segments.slice(0, d).join('/'));
      }
    }
    return [...seen];
  }

  // -------------------------------------------------------------------------
  // Scanner
  // -------------------------------------------------------------------------

  private async scanFiles(
    projectPath: string,
    capabilities: RepoCapabilities,
    excludedFolders: string[] = [],
  ): Promise<{ files: ScannedFile[]; locFallbackStats?: LocFallbackStats }> {
    let filePaths: string[];

    if (capabilities.isGitRepo) {
      filePaths = await this.listGitFiles(projectPath);
    } else {
      filePaths = await this.listFsFiles(projectPath, projectPath, 10, new Set(excludedFolders));
    }

    if (excludedFolders.length > 0) {
      filePaths = filePaths.filter((p) => !isUnderAnyFolder(p, excludedFolders));
    }

    let locMap: Map<string, number>;
    let locFallbackStats: LocFallbackStats | undefined;

    if (capabilities.isGitRepo) {
      locMap = await this.getLocMap(projectPath);
      if (locMap.size === 0 && filePaths.length > 0) {
        const fallback = await this.computeFallbackLineCounts(projectPath, filePaths);
        locMap = fallback.map;
        locFallbackStats = {
          counted: fallback.counted,
          skipped: fallback.skipped,
          eligible: fallback.eligible,
        };
      }
    } else {
      locMap = new Map<string, number>();
    }

    const files: ScannedFile[] = [];

    for (const filePath of filePaths) {
      const absPath = join(projectPath, filePath);
      let lastModified = Date.now();
      try {
        const stat = await fs.stat(absPath);
        lastModified = stat.mtimeMs;
      } catch {
        continue;
      }

      const loc = locMap.get(filePath) ?? 0;

      files.push({ path: filePath, loc, lastModified });
    }

    return { files, locFallbackStats };
  }

  private async listGitFiles(projectPath: string): Promise<string[]> {
    try {
      const out = await this.execGit(projectPath, ['ls-files', '-z']);
      return out.split('\0').filter((p) => p.length > 0);
    } catch (err) {
      logger.warn({ err }, 'Failed to list git files, falling back to fs scan');
      return this.listFsFiles(projectPath, projectPath);
    }
  }

  private async listFsFiles(
    rootPath: string,
    currentPath: string,
    maxDepth = 10,
    excludedFolders = new Set<string>(),
  ): Promise<string[]> {
    if (maxDepth <= 0) return [];

    const result: string[] = [];
    let entries: Dirent[];
    try {
      entries = await fs.readdir(currentPath, { withFileTypes: true, encoding: 'utf-8' });
    } catch {
      return result;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const relDir = join(relative(rootPath, currentPath), entry.name);
        if (isUnderAnyFolder(relDir, excludedFolders)) continue;
      }

      const fullPath = join(currentPath, entry.name);

      if (entry.isFile()) {
        result.push(relative(rootPath, fullPath));
      } else if (entry.isDirectory()) {
        const sub = await this.listFsFiles(rootPath, fullPath, maxDepth - 1, excludedFolders);
        result.push(...sub);
      }
    }

    return result;
  }

  private async getLocMap(projectPath: string): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    try {
      const out = await this.execGit(projectPath, ['diff', '--numstat', EMPTY_TREE_SHA, 'HEAD'], {
        allowNonZero: true,
      });
      for (const line of out.split('\n')) {
        if (!line) continue;
        const parts = line.split('\t');
        if (parts.length < 3) continue;
        const added = parseInt(parts[0], 10);
        const filePath = parts[2];
        if (!isNaN(added) && filePath) {
          map.set(filePath, added);
        }
      }
    } catch {
      // LOC unavailable — will fall back to 0
    }
    return map;
  }

  private async computeFallbackLineCounts(
    projectPath: string,
    filePaths: string[],
  ): Promise<{ map: Map<string, number>; counted: number; skipped: number; eligible: number }> {
    const map = new Map<string, number>();
    const eligible = filePaths.length;
    let skipped = 0;
    const CONCURRENCY = 16;

    for (let i = 0; i < filePaths.length; i += CONCURRENCY) {
      const batch = filePaths.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (filePath): Promise<{ path: string; loc: number } | null> => {
          try {
            const absPath = join(projectPath, filePath);
            const stat = await fs.stat(absPath);
            if (stat.size > MAX_ADAPTER_FILE_SIZE) return null;

            const buf = await fs.readFile(absPath);
            const checkLen = Math.min(buf.length, 8192);
            for (let j = 0; j < checkLen; j++) {
              if (buf[j] <= 0x08) return null;
            }

            let lines = 0;
            for (let j = 0; j < buf.length; j++) {
              if (buf[j] === 0x0a) lines++;
            }
            if (buf.length > 0 && buf[buf.length - 1] !== 0x0a) lines++;

            return { path: filePath, loc: lines };
          } catch {
            return null;
          }
        }),
      );

      for (const r of results) {
        if (r === null) {
          skipped++;
        } else {
          map.set(r.path, r.loc);
        }
      }
    }

    return { map, counted: eligible - skipped, skipped, eligible };
  }

  private async getChurnMap(projectPath: string, sinceDays: number): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    try {
      const out = await this.execGit(projectPath, [
        'log',
        `--since=${sinceDays} days ago`,
        '--name-only',
        '--format=',
        'HEAD',
      ]);
      for (const line of out.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        map.set(trimmed, (map.get(trimmed) ?? 0) + 1);
      }
    } catch {
      // Churn unavailable — map stays empty
    }
    return map;
  }

  /**
   * Get per-file, per-day touch counts from recent git history.
   * Returns null when data is unavailable (empty/failed query).
   * Returns a (possibly empty) map on success — empty means quiet repo.
   */
  private async getDailyChurnMap(
    projectPath: string,
    days: number,
  ): Promise<Map<string /* filePath */, Map<string /* YYYY-MM-DD */, number>> | null> {
    try {
      const out = await this.execGit(projectPath, [
        'log',
        `--since=${days} days ago`,
        '--format=COMMIT %H%n%aI%n%aN',
        '--name-only',
        'HEAD',
      ]);

      if (!out.trim()) return null;

      const map = new Map<string, Map<string, number>>();
      const lines = out.split('\n');
      let i = 0;

      while (i < lines.length) {
        const line = lines[i]!;
        if (line.startsWith('COMMIT ')) {
          const aI = (lines[i + 1] ?? '').trim();
          const dateStr = aI.slice(0, 10); // author-local YYYY-MM-DD
          i += 3; // skip COMMIT, aI, aN

          // Skip blank separator between header and file list
          while (i < lines.length && lines[i]?.trim() === '') i++;

          // Read file names until blank line or next COMMIT marker
          while (i < lines.length && lines[i]?.trim() !== '' && !lines[i]!.startsWith('COMMIT ')) {
            const filePath = lines[i]!.trim();
            if (filePath) {
              let dateMap = map.get(filePath);
              if (!dateMap) {
                dateMap = new Map<string, number>();
                map.set(filePath, dateMap);
              }
              dateMap.set(dateStr, (dateMap.get(dateStr) ?? 0) + 1);
            }
            i++;
          }
        } else {
          i++;
        }
      }

      return map;
    } catch {
      return null;
    }
  }

  /**
   * Get per-file, per-author touch counts within a time window.
   * Returns null when data is unavailable (empty/failed query).
   * Returns a (possibly empty) map on success.
   */
  private async getWindowedAuthorMap(
    projectPath: string,
    days: number,
  ): Promise<Map<string /* filePath */, Map<string /* authorName */, number>> | null> {
    try {
      const out = await this.execGit(projectPath, [
        'log',
        `--since=${days} days ago`,
        '--format=COMMIT %H%n%aI%n%aN',
        '--name-only',
        'HEAD',
      ]);

      if (!out.trim()) return null;

      const map = new Map<string, Map<string, number>>();
      const lines = out.split('\n');
      let i = 0;

      while (i < lines.length) {
        const line = lines[i]!;
        if (line.startsWith('COMMIT ')) {
          // Skip aI line
          i += 2; // skip COMMIT, aI
          const authorName = (lines[i] ?? '').trim();
          i++; // past aN

          // Skip blank separator
          while (i < lines.length && lines[i]?.trim() === '') i++;

          // Read file names
          while (i < lines.length && lines[i]?.trim() !== '' && !lines[i]!.startsWith('COMMIT ')) {
            const filePath = lines[i]!.trim();
            if (filePath) {
              let authorMap = map.get(filePath);
              if (!authorMap) {
                authorMap = new Map<string, number>();
                map.set(filePath, authorMap);
              }
              authorMap.set(authorName, (authorMap.get(authorName) ?? 0) + 1);
            }
            i++;
          }
        } else {
          i++;
        }
      }

      return map;
    } catch {
      return null;
    }
  }

  private static readonly GLOBAL_CONTRIBUTORS_CAP = 20;

  private buildGlobalContributors(
    districts: ReadonlyArray<DistrictNode>,
    districtFiles: ReadonlyMap<string, FileChurnData[]>,
    windowedAuthor7d: ReadonlyMap<string, ReadonlyMap<string, number>> | null,
    windowedAuthor30d: ReadonlyMap<string, ReadonlyMap<string, number>> | null,
  ): Array<{ authorName: string; commitCount7d: number; commitCount30d: number }> {
    if (!windowedAuthor7d && !windowedAuthor30d) return [];

    const author7dTotals = new Map<string, number>();
    const author30dTotals = new Map<string, number>();

    for (const district of districts) {
      const files = districtFiles.get(district.id) ?? [];
      for (const f of files) {
        if (windowedAuthor7d) {
          const fileAuthors = windowedAuthor7d.get(f.path);
          if (fileAuthors) {
            for (const [author, count] of fileAuthors) {
              author7dTotals.set(author, (author7dTotals.get(author) ?? 0) + count);
            }
          }
        }
        if (windowedAuthor30d) {
          const fileAuthors = windowedAuthor30d.get(f.path);
          if (fileAuthors) {
            for (const [author, count] of fileAuthors) {
              author30dTotals.set(author, (author30dTotals.get(author) ?? 0) + count);
            }
          }
        }
      }
    }

    const allAuthors = new Set([...author7dTotals.keys(), ...author30dTotals.keys()]);
    const result: Array<{ authorName: string; commitCount7d: number; commitCount30d: number }> = [];

    for (const author of allAuthors) {
      result.push({
        authorName: author,
        commitCount7d: author7dTotals.get(author) ?? 0,
        commitCount30d: author30dTotals.get(author) ?? 0,
      });
    }

    return result
      .sort((a, b) => b.commitCount30d - a.commitCount30d)
      .slice(0, CodebaseOverviewAnalyzerService.GLOBAL_CONTRIBUTORS_CAP);
  }

  private computeExcludedAuthorCount(
    fileAuthors: ReadonlyMap<string, ReadonlyMap<string, number>>,
    excludedFolders: string[],
    globalContributors: ReadonlyArray<{ authorName: string }>,
  ): number {
    if (excludedFolders.length === 0) return 0;

    const authorsInExcluded = new Set<string>();
    const authorsInNonExcluded = new Set<string>();

    for (const [filePath, authorMap] of fileAuthors) {
      const isExcluded = isUnderAnyFolder(filePath, excludedFolders);
      for (const author of authorMap.keys()) {
        if (isExcluded) {
          authorsInExcluded.add(author);
        } else {
          authorsInNonExcluded.add(author);
        }
      }
    }

    const globalNames = new Set(globalContributors.map((c) => c.authorName));
    let count = 0;
    for (const author of authorsInExcluded) {
      if (!authorsInNonExcluded.has(author) && !globalNames.has(author)) {
        count++;
      }
    }
    return count;
  }

  // -------------------------------------------------------------------------
  // Segmentation
  // -------------------------------------------------------------------------

  segmentFiles(files: ScannedFile[]): SegmentResult {
    // Group files by region (first path segment) and district (second segment)
    const regionMap = new Map<
      string,
      { files: ScannedFile[]; districtMap: Map<string, ScannedFile[]> }
    >();

    for (const file of files) {
      const segments = file.path.split(/[/\\]/);
      const regionName = segments.length > 1 ? segments[0] : ROOT_REGION_NAME;
      const districtName = segments.length > 2 ? segments[1] : ROOT_REGION_NAME;

      if (!regionMap.has(regionName)) {
        regionMap.set(regionName, { files: [], districtMap: new Map() });
      }
      const region = regionMap.get(regionName)!;
      region.files.push(file);

      const districtKey = `${regionName}/${districtName}`;
      if (!region.districtMap.has(districtKey)) {
        region.districtMap.set(districtKey, []);
      }
      region.districtMap.get(districtKey)!.push(file);
    }

    const regions: RegionNode[] = [];
    const districts: DistrictNode[] = [];
    const districtFileMap = new Map<string, string[]>();

    for (const [regionName, regionData] of regionMap) {
      const regionId = `region:${regionName}`;
      const totalFiles = regionData.files.length;
      const totalLOC = regionData.files.reduce((sum, f) => sum + f.loc, 0);
      const regionPath = regionName === ROOT_REGION_NAME ? '.' : regionName;

      regions.push({
        id: regionId,
        path: regionPath,
        name: regionName,
        totalFiles,
        totalLOC,
      });

      for (const [districtKey, districtFiles] of regionData.districtMap) {
        const districtName = districtKey.split('/')[1] || districtKey;
        const districtId = `district:${districtKey}`;
        const dTotalFiles = districtFiles.length;
        const dTotalLOC = districtFiles.reduce((sum, f) => sum + f.loc, 0);
        const districtPath =
          regionName === ROOT_REGION_NAME
            ? '.'
            : districtName === ROOT_REGION_NAME
              ? regionName
              : `${regionName}/${districtName}`;

        districts.push({
          id: districtId,
          regionId,
          path: districtPath,
          name: districtName,
          totalFiles: dTotalFiles,
          totalLOC: dTotalLOC,
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

        districtFileMap.set(
          districtKey,
          districtFiles.map((f) => f.path),
        );
      }
    }

    // Sort regions and districts by totalLOC descending for stable ordering
    regions.sort((a, b) => b.totalLOC - a.totalLOC);
    districts.sort((a, b) => b.totalLOC - a.totalLOC);

    return { regions, districts, districtFileMap };
  }

  // -------------------------------------------------------------------------
  // Identity helpers
  // -------------------------------------------------------------------------

  private async getCurrentCommitSha(projectPath: string): Promise<string | null> {
    try {
      const out = await this.execGit(projectPath, ['rev-parse', 'HEAD']);
      return out.trim() || null;
    } catch {
      return null;
    }
  }

  private async detectGitRenames(
    projectPath: string,
    previousCommitSha: string | null,
  ): Promise<GitRename[]> {
    if (!previousCommitSha) return [];

    try {
      const out = await this.execGit(
        projectPath,
        ['diff', '--name-status', '-M', previousCommitSha, 'HEAD'],
        { allowNonZero: true },
      );

      const renames: GitRename[] = [];
      for (const line of out.split('\n')) {
        if (!line.startsWith('R')) continue;
        const parts = line.split('\t');
        if (parts.length < 3) continue;
        const similarity = parseInt(parts[0].slice(1), 10);
        renames.push({
          oldPath: parts[1],
          newPath: parts[2],
          similarity: isNaN(similarity) ? 100 : similarity,
        });
      }

      return renames;
    } catch {
      return [];
    }
  }

  private storeIdentityState(
    projectPath: string,
    commitSha: string | null,
    fileIds: Map<string, string>,
    regionIds: Map<string, string>,
    districtIds: Map<string, string>,
    districtFileMap: Map<string, string[]>,
  ): void {
    const districts = new Map<string, DistrictIdentityEntry>();
    for (const [key, id] of districtIds) {
      const filePaths = districtFileMap.get(key) ?? [];
      const memberFileIds = new Set(filePaths.map((p) => fileIds.get(p)!).filter(Boolean));
      districts.set(key, { id, memberFileIds });
    }

    this.identityStore.set(projectPath, {
      commitSha,
      files: new Map(fileIds),
      districts,
      regions: new Map(regionIds),
    });
  }

  // -------------------------------------------------------------------------
  // Warnings
  // -------------------------------------------------------------------------

  private buildWarnings(
    capabilities: RepoCapabilities,
    hasImportData: boolean,
    adapterFileCount: number,
    locFallbackStats?: LocFallbackStats,
  ): AnalysisWarning[] {
    const warnings: AnalysisWarning[] = [];

    if (!capabilities.isGitRepo) {
      warnings.push({
        code: 'shallow_git_history',
        message: 'No git repository detected. Churn and staleness signals are unavailable.',
      });
    } else if (capabilities.isShallow) {
      warnings.push({
        code: 'shallow_git_history',
        message: 'Shallow git history detected. Churn and staleness signals may be incomplete.',
      });
    }

    if (locFallbackStats) {
      warnings.push({
        code: 'loc_unavailable',
        message: `LOC computed via file-read fallback (${locFallbackStats.counted} files counted, ${locFallbackStats.skipped} skipped).`,
        data: locFallbackStats,
      });
    }

    if (!hasImportData) {
      if (adapterFileCount === 0) {
        warnings.push({
          code: 'missing_dependency_data',
          message:
            'No supported source files found for import analysis. Coupling scores are empty.',
        });
      } else {
        warnings.push({
          code: 'missing_dependency_data',
          message:
            'Import analysis found no cross-district dependencies. Coupling scores are empty.',
        });
      }
    }

    return warnings;
  }

  // -------------------------------------------------------------------------
  // Language adapter analysis
  // -------------------------------------------------------------------------

  private async analyzeWithAdapters(
    projectPath: string,
    allFilePaths: ReadonlySet<string>,
  ): Promise<AdapterAnalysisResult> {
    const enrichments = new Map<string, FileAdapterEnrichment>();
    const fileEdges: FileEdge[] = [];
    let adapterFileCount = 0;

    // Filter files that have a matching adapter
    const adapterFiles: string[] = [];
    for (const filePath of allFilePaths) {
      if (this.adapterRegistry.getAdapter(filePath)) {
        adapterFiles.push(filePath);
      }
    }
    adapterFileCount = adapterFiles.length;

    if (adapterFiles.length === 0) {
      return { fileEdges, enrichments, adapterFileCount };
    }

    // Read file contents in batches and extract adapter data
    const BATCH_SIZE = 100;
    for (let i = 0; i < adapterFiles.length; i += BATCH_SIZE) {
      const batch = adapterFiles.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map(async (filePath) => {
          const absPath = join(projectPath, filePath);
          const stat = await fs.stat(absPath);
          if (stat.size > MAX_ADAPTER_FILE_SIZE) return null;
          const content = await fs.readFile(absPath, 'utf-8');
          return { filePath, content };
        }),
      );

      for (const result of results) {
        if (result.status !== 'fulfilled' || !result.value) continue;
        const { filePath, content } = result.value;

        // Classify role
        const role = this.adapterRegistry.classifyRole(filePath, content);

        // Count symbols
        const symbolCount = this.adapterRegistry.countSymbols(filePath, content);

        // Compute complexity
        const complexity = this.adapterRegistry.computeComplexity(filePath, content);

        // Detect test pair
        const testPair = this.adapterRegistry.detectTestPair(filePath, allFilePaths as Set<string>);

        enrichments.set(filePath, { role, symbolCount, complexity, testPair });

        // Extract imports and resolve to file edges (per-importer dedupe)
        const specifiers = this.adapterRegistry.extractImports(filePath, content);
        if (specifiers) {
          const resolvedTargets = new Set<string>();
          for (const specifier of specifiers) {
            const resolved =
              this.adapterRegistry.resolveImport(filePath, specifier, allFilePaths) ??
              resolveImportSpecifier(specifier, filePath, allFilePaths);
            if (resolved) {
              resolvedTargets.add(resolved);
            }
          }
          for (const toPath of resolvedTargets) {
            fileEdges.push({ fromPath: filePath, toPath });
          }
        }
      }
    }

    logger.info(
      { adapterFiles: adapterFileCount, enriched: enrichments.size, edges: fileEdges.length },
      'Language adapter analysis complete',
    );

    return { fileEdges, enrichments, adapterFileCount };
  }

  // -------------------------------------------------------------------------
  // Metrics
  // -------------------------------------------------------------------------

  private computeMetrics(
    files: ScannedFile[],
    regions: RegionNode[],
    districts: DistrictNode[],
    capabilities: RepoCapabilities,
    warnings: AnalysisWarning[],
    excludedAuthorCount: number,
    scopeConfigHash: string,
  ): CodebaseOverviewMetrics {
    return {
      totalRegions: regions.length,
      totalDistricts: districts.length,
      totalFiles: files.length,
      gitHistoryDaysAvailable: capabilities.gitHistoryDays,
      shallowHistoryDetected: capabilities.isShallow || !capabilities.isGitRepo,
      dependencyCoverage: null,
      warnings,
      excludedAuthorCount,
      scopeConfigHash,
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isExecError(
  err: unknown,
): err is Error & { stdout: string; stderr: string; code: number } {
  return err instanceof Error && 'stdout' in err;
}

/**
 * Resolve a relative import specifier to a file path within the project.
 * Returns null for package imports or unresolvable specifiers.
 */
function resolveImportSpecifier(
  specifier: string,
  importerPath: string,
  allPaths: ReadonlySet<string>,
): string | null {
  // Only resolve relative imports
  if (!specifier.startsWith('.')) return null;

  const importerDir = dirname(importerPath);
  const resolved = normalize(join(importerDir, specifier));

  // Direct match (specifier includes extension)
  if (allPaths.has(resolved)) return resolved;

  // If specifier has an extension, also try swapping it
  const existingExt = extname(resolved);
  if (existingExt) {
    const withoutExt = resolved.slice(0, -existingExt.length);
    for (const ext of RESOLVE_EXTENSIONS) {
      if (allPaths.has(withoutExt + ext)) return withoutExt + ext;
    }
  }

  // Try appending extensions
  for (const ext of RESOLVE_EXTENSIONS) {
    if (allPaths.has(resolved + ext)) return resolved + ext;
  }

  // Try index files
  for (const ext of RESOLVE_EXTENSIONS) {
    const indexPath = join(resolved, 'index' + ext);
    if (allPaths.has(indexPath)) return indexPath;
  }

  return null;
}
