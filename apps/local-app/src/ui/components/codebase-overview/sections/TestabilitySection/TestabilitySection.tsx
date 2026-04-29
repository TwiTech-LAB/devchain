import { useMemo } from 'react';
import { ShieldCheck, Link2, GitCommitHorizontal, Brain, HelpCircle } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type {
  CodebaseOverviewSnapshot,
  DistrictSignals,
  DependencyEdge,
} from '@devchain/codebase-overview';
import { Card, CardContent, CardHeader, CardTitle } from '@/ui/components/ui/card';
import { Badge } from '@/ui/components/ui/badge';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/ui/components/ui/tooltip';
import { cn } from '@/ui/lib/utils';
import { BarFill, EmptyState } from '../../primitives';
import { percentile } from '../../lib/percentile';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TestabilitySectionProps {
  snapshot: CodebaseOverviewSnapshot;
  onSelectDistrict: (id: string) => void;
}

interface CardConfig {
  key: string;
  title: string;
  icon: LucideIcon;
  tooltip: string;
  filter: (eligible: DistrictSignals[], deps: DependencyEdge[]) => DistrictSignals[];
  sort: (a: DistrictSignals, b: DistrictSignals) => number;
  renderMetric: (s: DistrictSignals) => string;
  minPopulation: number;
}

// ---------------------------------------------------------------------------
// Card configurations
// ---------------------------------------------------------------------------

const CARD_CONFIGS: CardConfig[] = [
  {
    key: 'critical',
    title: 'Untested Critical',
    icon: Link2,
    tooltip: 'Untested code that many districts depend on. Top 15 by inbound dependency count.',
    filter: (eligible, deps) => {
      if (deps.length === 0) return [];
      const inboundValues = eligible.map((s) => s.inboundWeight).filter((v) => v > 0);
      if (inboundValues.length === 0) return [];
      const p75 = percentile(inboundValues, 75);
      return eligible.filter((s) => s.inboundWeight > p75);
    },
    sort: (a, b) => b.inboundWeight - a.inboundWeight || b.loc - a.loc,
    renderMetric: (s) => `Used by ${s.inboundWeight} districts`,
    minPopulation: 5,
  },
  {
    key: 'changed',
    title: 'Untested Changed',
    icon: GitCommitHorizontal,
    tooltip: 'Untested code with recent churn. Top 15 by 30-day file touches.',
    filter: (eligible) => eligible.filter((s) => s.churn30d > 0),
    sort: (a, b) => b.churn30d - a.churn30d || b.loc - a.loc,
    renderMetric: (s) => `${s.churn30d} file touches in 30d`,
    minPopulation: 5,
  },
  {
    key: 'complex',
    title: 'Untested Complex',
    icon: Brain,
    tooltip: 'Untested code with above-average complexity. Top 15 by complexity score.',
    filter: (eligible) => {
      const complexityValues = eligible
        .map((s) => s.complexityAvg)
        .filter((v): v is number => v !== null && v > 0);
      if (complexityValues.length === 0) return [];
      const p75 = percentile(complexityValues, 75);
      return eligible.filter((s) => s.complexityAvg !== null && s.complexityAvg > p75);
    },
    sort: (a, b) => (b.complexityAvg ?? 0) - (a.complexityAvg ?? 0) || b.loc - a.loc,
    renderMetric: (s) => `Complexity ${(s.complexityAvg ?? 0).toFixed(1)}`,
    minPopulation: 5,
  },
];

const TOP_N = 15;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function TestabilitySection({ snapshot, onSelectDistrict }: TestabilitySectionProps) {
  const { signals, dependencies } = snapshot;

  const eligible = useMemo(
    () =>
      signals.filter(
        (s) =>
          s.hasSourceFiles &&
          s.sourceCoverageMeasured &&
          s.testCoverageRate !== null &&
          s.testCoverageRate < 0.3,
      ),
    [signals],
  );

  if (eligible.length === 0) {
    return (
      <div className="space-y-6">
        <SectionHeader />
        <EmptyState
          icon={ShieldCheck}
          headline="No untested source code"
          reason="Either coverage is healthy or measurement is unavailable for this repo. Check warnings above."
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <SectionHeader />
      <TooltipProvider delayDuration={300}>
        <div className="space-y-4">
          {CARD_CONFIGS.map((config) => (
            <UntestedCard
              key={config.key}
              config={config}
              eligible={eligible}
              dependencies={dependencies}
              onSelectDistrict={onSelectDistrict}
            />
          ))}
        </div>
      </TooltipProvider>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section header
// ---------------------------------------------------------------------------

function SectionHeader() {
  return (
    <div>
      <h2 className="text-xl font-semibold tracking-tight">Testability</h2>
      <p className="text-sm text-muted-foreground mt-1">
        Where untested code intersects with risk signals
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// UntestedCard (shared across all three card types)
// ---------------------------------------------------------------------------

function UntestedCard({
  config,
  eligible,
  dependencies,
  onSelectDistrict,
}: {
  config: CardConfig;
  eligible: DistrictSignals[];
  dependencies: DependencyEdge[];
  onSelectDistrict: (id: string) => void;
}) {
  const rows = useMemo(() => {
    const filtered = config.filter(eligible, dependencies);
    if (filtered.length < config.minPopulation) return null;
    return [...filtered].sort(config.sort).slice(0, TOP_N);
  }, [config, eligible, dependencies]);

  if (rows === null) return null;

  const Icon = config.icon;
  const maxCoverage = 0.3;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Icon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            <CardTitle className="text-base">{config.title}</CardTitle>
            <Badge variant="secondary" className="text-xs">
              {rows.length}
            </Badge>
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground"
                aria-label={`About ${config.title}`}
              >
                <HelpCircle className="h-4 w-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="left" className="max-w-xs">
              <p>{config.tooltip}</p>
            </TooltipContent>
          </Tooltip>
        </div>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">No matches in this view</p>
        ) : (
          <div className="space-y-1">
            {rows.map((s) => (
              <button
                key={s.districtId}
                type="button"
                onClick={() => onSelectDistrict(s.districtId)}
                className={cn(
                  'flex w-full items-center gap-3 rounded-md px-2 py-2 text-sm transition-colors text-left',
                  'hover:bg-muted/50',
                )}
              >
                <span className="min-w-0 flex-1 truncate font-medium">{s.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground whitespace-nowrap">
                  {config.renderMetric(s)}
                </span>
                <div className="w-16 h-2 shrink-0">
                  <BarFill
                    value={s.testCoverageRate}
                    max={maxCoverage}
                    className="bg-orange-500/40"
                  />
                </div>
                <span className="shrink-0 w-10 text-right text-xs tabular-nums text-muted-foreground">
                  {Math.round((s.testCoverageRate ?? 0) * 100)}%
                </span>
              </button>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
