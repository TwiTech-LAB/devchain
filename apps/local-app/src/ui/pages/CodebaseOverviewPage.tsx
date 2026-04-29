import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  FolderOpen,
  X,
  GitCommit,
  Users,
  Activity,
  Pin,
  ArrowLeftRight,
  Gauge,
  TrendingUp,
  ShieldCheck,
  Network,
  FolderTree,
  RefreshCw,
  AlertTriangle,
  Settings2,
} from 'lucide-react';
import type { CodebaseOverviewSnapshot, TargetDetail } from '@devchain/codebase-overview';
import { useSelectedProject } from '../hooks/useProjectSelection';
import { useSubNavSearchParam } from '../hooks/useSubNavSearchParam';
import { fetchJsonOrThrow } from '../lib/sessions';
import { cn } from '../lib/utils';
import { PageHeader } from '../components/shared/PageHeader';
import { EmptyState as PageEmptyState } from '../components/shared/EmptyState';
import { SubNavLayout } from '../components/shared/SubNavLayout';
import type { SubNavSection } from '../components/shared/SubNavLayout';
import { EmptyState, LoadingSkeleton } from '../components/codebase-overview/primitives';
import { WarningsBar } from '../components/codebase-overview/WarningsBar';
import {
  ArchitectureSection,
  StructureSection,
  TestabilitySection,
  SummarySection,
  OwnershipSection,
  ChangeSection,
  ScopeSection,
} from '../components/codebase-overview/sections';
import { Card, CardHeader, CardTitle, CardContent } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Separator } from '../components/ui/separator';
import { Skeleton } from '../components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../components/ui/tooltip';

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

function fetchSnapshot(projectId: string) {
  return fetchJsonOrThrow<CodebaseOverviewSnapshot>(`/api/projects/${projectId}/codebase-overview`);
}

function fetchTargetDetail(projectId: string, targetId: string) {
  return fetchJsonOrThrow<TargetDetail>(
    `/api/projects/${projectId}/codebase-overview/targets/${targetId}`,
  );
}

export const overviewQueryKeys = {
  snapshot: (projectId: string) => ['codebase-overview', projectId] as const,
  targetDetail: (projectId: string, targetId: string) =>
    ['codebase-overview', projectId, 'target', targetId] as const,
};

// ---------------------------------------------------------------------------
// Persisted preferences (Pattern A — project-scoped localStorage)
// ---------------------------------------------------------------------------

interface OverviewPreferences {
  matrixModeOverride: string | null;
  structureOpen: boolean;
  compareTargets: string[];
  searchQuery: string;
  selectedTargetId: string | null;
  lastSnapshotId: string | null;
}

const DEFAULT_OVERVIEW_PREFS: OverviewPreferences = {
  matrixModeOverride: null,
  structureOpen: false,
  compareTargets: [],
  searchQuery: '',
  selectedTargetId: null,
  lastSnapshotId: null,
};

const OVERVIEW_PREFS_KEY_PREFIX = 'devchain:codebase-overview:prefs:';

export function loadOverviewPrefs(projectId: string): OverviewPreferences {
  const stored = localStorage.getItem(`${OVERVIEW_PREFS_KEY_PREFIX}${projectId}`);
  if (stored) {
    try {
      const parsed = JSON.parse(stored);
      return {
        matrixModeOverride: parsed.matrixModeOverride ?? null,
        structureOpen: parsed.structureOpen ?? false,
        compareTargets: Array.isArray(parsed.compareTargets) ? parsed.compareTargets : [],
        searchQuery: typeof parsed.searchQuery === 'string' ? parsed.searchQuery : '',
        selectedTargetId:
          typeof parsed.selectedTargetId === 'string' ? parsed.selectedTargetId : null,
        lastSnapshotId: typeof parsed.lastSnapshotId === 'string' ? parsed.lastSnapshotId : null,
      };
    } catch {
      // Fall through to defaults
    }
  }
  return DEFAULT_OVERVIEW_PREFS;
}

export function saveOverviewPrefs(projectId: string, prefs: OverviewPreferences): void {
  try {
    localStorage.setItem(`${OVERVIEW_PREFS_KEY_PREFIX}${projectId}`, JSON.stringify(prefs));
  } catch {
    // Ignore storage errors
  }
}

// ---------------------------------------------------------------------------
// Shell: Section routing & types
// ---------------------------------------------------------------------------

const SECTION_KEYS = [
  'summary',
  'change',
  'testability',
  'architecture',
  'ownership',
  'structure',
  'scope',
] as const;
type SectionKey = (typeof SECTION_KEYS)[number];

export type OverviewSectionProps = {
  snapshot: CodebaseOverviewSnapshot;
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function CodebaseOverviewPage() {
  const { selectedProjectId } = useSelectedProject();
  const queryClient = useQueryClient();

  const [activeSection, setActiveSection] = useSubNavSearchParam(
    [...SECTION_KEYS],
    'summary',
    'section',
  );

  // Shell-level shared state for district detail panel and comparator
  const [selectedDistrictId, setSelectedDistrictId] = useState<string | null>(null);
  const [compareTargets, setCompareTargets] = useState<string[]>([]);

  useEffect(() => {
    setSelectedDistrictId(null);
    setCompareTargets([]);
  }, [selectedProjectId]);

  function handleToggleCompare(targetId: string) {
    setCompareTargets((prev) =>
      prev.includes(targetId)
        ? prev.filter((id) => id !== targetId)
        : prev.length < 4
          ? [...prev, targetId]
          : prev,
    );
  }

  const {
    data: snapshot,
    isPending,
    isError,
    isFetching,
  } = useQuery({
    queryKey: overviewQueryKeys.snapshot(selectedProjectId ?? ''),
    queryFn: () => fetchSnapshot(selectedProjectId!),
    enabled: !!selectedProjectId,
    staleTime: Infinity,
    gcTime: 1000 * 60 * 30,
  });

  if (!selectedProjectId) {
    return (
      <div className="flex flex-col h-full">
        <PageHeader title="Overview" description="Project issue radar" className="mb-6" />
        <PageEmptyState
          icon={FolderOpen}
          title="No project selected"
          description="Select a project from the sidebar to view its codebase overview."
        />
      </div>
    );
  }

  const renderSectionContent = (element: React.ReactNode) => {
    if (isPending) {
      return (
        <div className="space-y-4 p-6">
          <LoadingSkeleton variant="card" />
          <LoadingSkeleton variant="card" />
          <LoadingSkeleton variant="card" />
        </div>
      );
    }
    if (isError || !snapshot) {
      return (
        <div className="p-6">
          <EmptyState
            icon={AlertTriangle}
            headline="Couldn't load overview"
            reason="Try refresh; if persistent, see logs."
          />
        </div>
      );
    }
    return <div className="p-6">{element}</div>;
  };

  const sharedPanels = snapshot ? (
    <>
      {selectedDistrictId && (
        <HotspotDetailPanel
          projectId={selectedProjectId}
          targetId={selectedDistrictId}
          snapshot={snapshot}
          onClose={() => setSelectedDistrictId(null)}
          compareTargets={compareTargets}
          onToggleCompare={handleToggleCompare}
        />
      )}
      {compareTargets.length >= 2 && (
        <ComparePanel
          snapshot={snapshot}
          targetIds={compareTargets}
          onRemove={(id) => setCompareTargets((prev) => prev.filter((t) => t !== id))}
          onClear={() => setCompareTargets([])}
        />
      )}
    </>
  ) : null;

  const sections: SubNavSection<SectionKey>[] = [
    {
      key: 'summary',
      label: 'Summary',
      icon: Gauge,
      render: () =>
        renderSectionContent(
          snapshot ? (
            <div className="space-y-4">
              <SummarySection
                snapshot={snapshot}
                projectId={selectedProjectId}
                selectedDistrictId={selectedDistrictId}
                onSelectDistrict={setSelectedDistrictId}
              />
              {sharedPanels}
            </div>
          ) : null,
        ),
    },
    {
      key: 'change',
      label: 'Change',
      icon: TrendingUp,
      render: () =>
        renderSectionContent(
          snapshot ? (
            <>
              <ChangeSection snapshot={snapshot} onSelectDistrict={setSelectedDistrictId} />
              {sharedPanels}
            </>
          ) : null,
        ),
    },
    {
      key: 'testability',
      label: 'Testability',
      icon: ShieldCheck,
      render: () =>
        renderSectionContent(
          snapshot ? (
            <>
              <TestabilitySection snapshot={snapshot} onSelectDistrict={setSelectedDistrictId} />
              {sharedPanels}
            </>
          ) : null,
        ),
    },
    {
      key: 'architecture',
      label: 'Architecture',
      icon: Network,
      render: () =>
        renderSectionContent(
          snapshot ? (
            <div className="space-y-4">
              <ArchitectureSection
                snapshot={snapshot}
                projectId={selectedProjectId}
                selectedDistrictId={selectedDistrictId}
                onSelectDistrict={setSelectedDistrictId}
              />
              {sharedPanels}
            </div>
          ) : null,
        ),
    },
    {
      key: 'ownership',
      label: 'Ownership',
      icon: Users,
      render: () =>
        renderSectionContent(
          snapshot ? (
            <>
              <OwnershipSection snapshot={snapshot} onSelectDistrict={setSelectedDistrictId} />
              {sharedPanels}
            </>
          ) : null,
        ),
    },
    {
      key: 'structure',
      label: 'Structure',
      icon: FolderTree,
      render: () =>
        renderSectionContent(
          snapshot ? (
            <>
              <StructureSection
                snapshot={snapshot}
                onSelectDistrict={setSelectedDistrictId}
                onNavigateToScope={() => setActiveSection('scope')}
              />
              {sharedPanels}
            </>
          ) : null,
        ),
    },
    {
      key: 'scope',
      label: 'Scope',
      icon: Settings2,
      render: () => (
        <div className="p-6">
          <ScopeSection projectId={selectedProjectId} />
        </div>
      ),
    },
  ];

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="Overview"
        description="Project issue radar"
        actions={
          <Button
            variant="ghost"
            size="icon"
            onClick={() =>
              queryClient.invalidateQueries({
                queryKey: overviewQueryKeys.snapshot(selectedProjectId),
              })
            }
            aria-label="Refresh overview"
          >
            <RefreshCw className={cn('h-4 w-4', isFetching && 'animate-spin')} />
          </Button>
        }
        className="mb-6"
      />
      {snapshot && (
        <WarningsBar
          warnings={snapshot.metrics.warnings}
          excludedAuthorCount={snapshot.metrics.excludedAuthorCount}
          onNavigateToScope={() => setActiveSection('scope')}
        />
      )}
      <SubNavLayout<SectionKey>
        sections={sections}
        activeKey={activeSection}
        onSelect={setActiveSection}
        ariaLabel="Overview navigation"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// HotspotDetailPanel
// ---------------------------------------------------------------------------

export function HotspotDetailPanel({
  projectId,
  targetId,
  snapshot,
  onClose,
  compareTargets,
  onToggleCompare,
}: {
  projectId: string;
  targetId: string;
  snapshot: CodebaseOverviewSnapshot;
  onClose: () => void;
  compareTargets: string[];
  onToggleCompare: (targetId: string) => void;
}) {
  const isPinned = compareTargets.includes(targetId);
  const canPin = isPinned || compareTargets.length < 4;
  const { data: detail, isLoading: detailLoading } = useQuery({
    queryKey: overviewQueryKeys.targetDetail(projectId, targetId),
    queryFn: () => fetchTargetDetail(projectId, targetId),
  });

  const district = snapshot.districts.find((d) => d.id === targetId);
  const displayName = district?.name ?? targetId;

  if (detailLoading) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <Skeleton className="h-6 w-48" />
            <Button variant="ghost" size="icon" onClick={onClose}>
              <X className="h-4 w-4" />
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!detail) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-lg">{displayName}</CardTitle>
            <Button variant="ghost" size="icon" onClick={onClose}>
              <X className="h-4 w-4" />
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">No detail available for this target.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CardTitle className="text-lg">{displayName}</CardTitle>
            <Badge variant="outline" className="text-xs">
              {detail.kind}
            </Badge>
          </div>
          <div className="flex items-center gap-1">
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant={isPinned ? 'secondary' : 'ghost'}
                    size="icon"
                    onClick={() => onToggleCompare(targetId)}
                    disabled={!canPin}
                    aria-label={isPinned ? 'Unpin from compare' : 'Pin to compare'}
                  >
                    <Pin className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">
                  <p>{isPinned ? 'Unpin from compare' : 'Pin to compare'}</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <Button variant="ghost" size="icon" onClick={onClose}>
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm">{detail.summary}</p>

        {detail.whyRanked.length > 0 && (
          <div>
            <h4 className="text-sm font-medium mb-1">Why it ranked</h4>
            <ul className="space-y-1">
              {detail.whyRanked.map((reason, i) => (
                <li key={i} className="text-sm text-muted-foreground">
                  {reason}
                </li>
              ))}
            </ul>
          </div>
        )}

        {(detail.recentCommits.length > 0 || detail.topAuthors.length > 0) && <Separator />}

        <div className="grid gap-4 md:grid-cols-2">
          {detail.recentCommits.length > 0 && (
            <div>
              <div className="flex items-center gap-1.5 mb-2">
                <GitCommit className="h-3.5 w-3.5 text-muted-foreground" />
                <h4 className="text-sm font-medium">Recent commits</h4>
              </div>
              <ul className="space-y-1">
                {detail.recentCommits.map((c) => (
                  <li key={c.sha} className="text-sm text-muted-foreground truncate">
                    <span className="font-mono text-xs">{c.sha.slice(0, 7)}</span> {c.message}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {detail.topAuthors.length > 0 && (
            <div>
              <div className="flex items-center gap-1.5 mb-2">
                <Users className="h-3.5 w-3.5 text-muted-foreground" />
                <h4 className="text-sm font-medium">Top authors</h4>
              </div>
              <ul className="space-y-1">
                {detail.topAuthors.map((a) => (
                  <li key={a.author} className="text-sm text-muted-foreground flex justify-between">
                    <span>{a.author}</span>
                    <span>{Math.round(a.share * 100)}%</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        {detail.recentActivity.length > 0 && (
          <>
            <Separator />
            <div>
              <div className="flex items-center gap-1.5 mb-2">
                <Activity className="h-3.5 w-3.5 text-muted-foreground" />
                <h4 className="text-sm font-medium">Recent activity</h4>
              </div>
              <div className="grid gap-2 text-sm text-muted-foreground sm:grid-cols-2">
                {detail.recentActivity.map((a) => (
                  <div key={a.targetId} className="flex gap-4">
                    <span>Modified today: {a.modifiedCount1d}</span>
                    <span>This week: {a.modifiedCount7d}</span>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// ComparePanel
// ---------------------------------------------------------------------------

const COMPARE_METRICS: Array<{
  key: string;
  label: string;
  getValue: (d: CodebaseOverviewSnapshot['districts'][0]) => number | string;
  format: (v: number | string) => string;
}> = [
  {
    key: 'totalLOC',
    label: 'Lines of code',
    getValue: (d) => d.totalLOC,
    format: (v) => Number(v).toLocaleString(),
  },
  {
    key: 'totalFiles',
    label: 'Files',
    getValue: (d) => d.totalFiles,
    format: (v) => String(v),
  },
  {
    key: 'churn30d',
    label: 'Churn (30d)',
    getValue: (d) => d.churn30d,
    format: (v) => `${v} commits`,
  },
  {
    key: 'testFileRatio',
    label: 'Test ratio',
    getValue: (d) => (d.testFileRatio !== null ? Math.round(d.testFileRatio * 100) : 0),
    format: (v) => `${v}%`,
  },
  {
    key: 'couplingScore',
    label: 'Coupling',
    getValue: (d) => d.couplingScore,
    format: (v) => String(v),
  },
  {
    key: 'role',
    label: 'Role',
    getValue: (d) => d.role,
    format: (v) => String(v),
  },
];

export function ComparePanel({
  snapshot,
  targetIds,
  onRemove,
  onClear,
}: {
  snapshot: CodebaseOverviewSnapshot;
  targetIds: string[];
  onRemove: (id: string) => void;
  onClear: () => void;
}) {
  const districts = targetIds
    .map((id) => snapshot.districts.find((d) => d.id === id))
    .filter(Boolean) as CodebaseOverviewSnapshot['districts'];

  if (districts.length < 2) return null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ArrowLeftRight className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            <CardTitle className="text-base">Compare</CardTitle>
            <Badge variant="secondary" className="text-xs">
              {districts.length} districts
            </Badge>
          </div>
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={onClear}>
            Clear all
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <table className="w-full text-sm" role="table" aria-label="District comparison">
            <thead>
              <tr className="border-b">
                <th className="text-left p-2 font-medium text-muted-foreground">Metric</th>
                {districts.map((d) => (
                  <th key={d.id} className="text-right p-2 font-medium">
                    <div className="flex items-center justify-end gap-1">
                      <span className="truncate max-w-[120px]">{d.name}</span>
                      <button
                        type="button"
                        onClick={() => onRemove(d.id)}
                        className="text-muted-foreground hover:text-foreground shrink-0"
                        aria-label={`Remove ${d.name} from compare`}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {COMPARE_METRICS.map((metric) => {
                const values = districts.map((d) => metric.getValue(d));
                const numericValues = values.map((v) => (typeof v === 'number' ? v : null));
                const maxVal =
                  numericValues.filter((v) => v !== null).length > 0
                    ? Math.max(...(numericValues.filter((v) => v !== null) as number[]))
                    : null;
                return (
                  <tr key={metric.key} className="border-b last:border-b-0">
                    <td className="p-2 text-muted-foreground">{metric.label}</td>
                    {values.map((val, i) => (
                      <td key={districts[i]!.id} className="p-2 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <span
                            className={cn(
                              typeof val === 'number' &&
                                maxVal !== null &&
                                maxVal > 0 &&
                                val === maxVal &&
                                'font-medium text-primary',
                            )}
                          >
                            {metric.format(val)}
                          </span>
                          {typeof val === 'number' && maxVal !== null && maxVal > 0 && (
                            <div className="w-12 h-1.5 bg-muted rounded-full overflow-hidden">
                              <div
                                className="h-full bg-primary/60 rounded-full"
                                style={{
                                  width: `${(val / maxVal) * 100}%`,
                                }}
                              />
                            </div>
                          )}
                        </div>
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
