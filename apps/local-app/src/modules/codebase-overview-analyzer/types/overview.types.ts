// ---------------------------------------------------------------------------
// Codebase Overview — Core type definitions
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

export interface CodebaseOverviewSnapshot {
  snapshotId: string;
  projectKey: string;
  name: string;
  regions: RegionNode[];
  districts: DistrictNode[];
  dependencies: DependencyEdge[];
  hotspots: HotspotEntry[];
  activity: ActivitySummary[];
  metrics: CodebaseOverviewMetrics;
  signals: DistrictSignals[];
  globalContributors: { authorName: string; commitCount7d: number; commitCount30d: number }[];
}

// ---------------------------------------------------------------------------
// Structural nodes
// ---------------------------------------------------------------------------

export interface RegionNode {
  id: string;
  path: string;
  name: string;
  totalFiles: number;
  totalLOC: number;
}

export type FileRole =
  | 'controller'
  | 'service'
  | 'model'
  | 'test'
  | 'config'
  | 'type'
  | 'utility'
  | 'view'
  | 'style'
  | 'script'
  | 'docs'
  | 'unknown';

export interface DistrictNode {
  id: string;
  regionId: string;
  path: string;
  name: string;
  totalFiles: number;
  totalLOC: number;
  churn7d: number;
  churn30d: number;
  inboundWeight: number;
  outboundWeight: number;
  couplingScore: number;
  testFileCount: number;
  testFileRatio: number | null;
  role: FileRole | 'mixed';
  complexityAvg: number | null;
  ownershipConcentration: number | null;
  testCoverageRate: number | null;
  blastRadius: number;
  primaryAuthorName: string | null;
  primaryAuthorShare: number | null;
  primaryAuthorRecentlyActive: boolean;
}

export interface DistrictSignals {
  districtId: string;
  name: string;
  path: string;
  regionId: string;
  regionName: string;
  files: number;
  sourceFileCount: number;
  supportFileCount: number;
  hasSourceFiles: boolean;
  loc: number;
  churn7d: number;
  churn30d: number;
  testCoverageRate: number | null;
  sourceCoverageMeasured: boolean;
  complexityAvg: number | null;
  inboundWeight: number;
  outboundWeight: number;
  blastRadius: number;
  couplingScore: number;
  ownershipHHI: number | null;
  ownershipMeasured: boolean;
  primaryAuthorName: string | null;
  primaryAuthorShare: number | null;
  primaryAuthorRecentlyActive: boolean;
  fileTypeBreakdown: { kind: 'extension'; counts: Record<string, number> };
}

export interface StructureNode {
  id: string;
  districtId: string;
  path: string;
  role: FileRole;
  loc: number;
  lastModified: number;
  metrics: {
    churn7d: number;
    churn30d: number;
    staleDays: number;
    hasColocatedTest: boolean;
    symbolCount: number | null;
    complexity: number | null;
    coverage: number | null;
  };
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface DependencyEdge {
  fromDistrictId: string;
  toDistrictId: string;
  weight: number;
  isCyclic: boolean;
}

// ---------------------------------------------------------------------------
// Hotspots
// ---------------------------------------------------------------------------

export type HotspotMetric =
  | 'size'
  | 'churn'
  | 'coupling'
  | 'tests'
  | 'staleness'
  | 'complexity'
  | 'ownership';

export interface HotspotEntry {
  id: string;
  kind: 'district' | 'file';
  targetId: string;
  /** Parent district ID for file-kind entries; undefined for district-kind entries. */
  districtId?: string;
  metric: HotspotMetric;
  rank: number;
  score: number;
  label: string;
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

export interface ActivitySummary {
  targetId: string;
  targetKind: 'district' | 'file';
  modifiedCount1d: number;
  modifiedCount7d: number;
  buildFailures7d: number | null;
  testFailures7d: number | null;
  latestTimestamp: number | null;
  dailyChurn?: Record<string, number>; // YYYY-MM-DD (author-local) -> file-touch count
  recentContributors7d: Array<{ authorName: string; commitCount: number }>;
  recentContributors30d: Array<{ authorName: string; commitCount: number }>;
}

// ---------------------------------------------------------------------------
// Metrics & warnings
// ---------------------------------------------------------------------------

export type AnalysisWarningCode =
  | 'shallow_git_history'
  | 'missing_dependency_data'
  | 'partial_test_detection'
  | 'loc_unavailable'
  | 'coverage_unmeasured'
  | 'coupling_unavailable'
  | 'daily_churn_unavailable'
  | 'windowed_authors_unavailable';

export interface AnalysisWarning {
  code: AnalysisWarningCode;
  message: string;
  data?: {
    counted?: number;
    skipped?: number;
    eligible?: number;
  };
}

export interface CodebaseOverviewMetrics {
  totalRegions: number;
  totalDistricts: number;
  totalFiles: number;
  gitHistoryDaysAvailable: number | null;
  shallowHistoryDetected: boolean;
  dependencyCoverage: number | null;
  warnings: AnalysisWarning[];
  excludedAuthorCount: number;
  scopeConfigHash: string;
}

// ---------------------------------------------------------------------------
// Detail queries
// ---------------------------------------------------------------------------

export interface CommitSummary {
  sha: string;
  message: string;
  timestamp: number;
}

export interface AuthorShare {
  author: string;
  share: number;
}

export interface TargetDetail {
  targetId: string;
  kind: 'district' | 'file';
  summary: string;
  whyRanked: string[];
  recentCommits: CommitSummary[];
  topAuthors: AuthorShare[];
  recentActivity: ActivitySummary[];
  topInbound?: Array<{ districtId: string; weight: number }>;
  topOutbound?: Array<{ districtId: string; weight: number }>;
  blastRadius?: Array<{ districtId: string; depth: number }>;
}

export interface DependencyExemplarEdge {
  fromFileId: string;
  toFileId: string;
  fromPath: string;
  toPath: string;
  weight: number;
}

export interface DependencyPairDetail {
  fromDistrictId: string;
  toDistrictId: string;
  weight: number;
  isCyclic: boolean;
  summary: string;
  exemplarFileEdges: DependencyExemplarEdge[];
}

export interface DistrictFilePage {
  districtId: string;
  items: StructureNode[];
  nextCursor: string | null;
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

export interface CodebaseOverviewDiff {
  added: string[];
  removed: string[];
  modified: string[];
  moved: Array<{ id: string; oldDistrictId: string; newDistrictId: string }>;
  hotspots?: HotspotEntry[];
  activity?: ActivitySummary[];
  requiresSnapshotRefresh?: boolean;
}

// ---------------------------------------------------------------------------
// Data source interface
// ---------------------------------------------------------------------------

export interface CodebaseOverviewDataSource {
  getSnapshot(): CodebaseOverviewSnapshot;
  onChange(callback: (diff: CodebaseOverviewDiff) => void): () => void;
  getTargetDetails(targetId: string): TargetDetail | null;
  getDependencyPairDetails(
    fromDistrictId: string,
    toDistrictId: string,
  ): DependencyPairDetail | null;
  listDistrictFiles(districtId: string, cursor?: string): DistrictFilePage | null;
}

// ---------------------------------------------------------------------------
// Language adapter (plugin model)
// ---------------------------------------------------------------------------

export interface LanguageAdapter {
  id: string;
  extensions: string[];
  classifyRole(filePath: string, content: string): FileRole | null;
  extractImports?(content: string): string[];
  countSymbols?(content: string): number;
  computeComplexity?(content: string): number;
  resolveImport?(
    specifier: string,
    importerPath: string,
    allPaths: ReadonlySet<string>,
  ): string | null;
  detectTestPair?(filePath: string, allPaths: Set<string>): string | null;
}
