import { useMemo, useState } from 'react';
import { GitCommit, Flame, User, RefreshCw, HelpCircle } from 'lucide-react';
import type { CodebaseOverviewSnapshot, DistrictSignals } from '@devchain/codebase-overview';
import { Card, CardContent, CardHeader, CardTitle } from '@/ui/components/ui/card';
import { Badge } from '@/ui/components/ui/badge';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/ui/components/ui/tooltip';
import { cn } from '@/ui/lib/utils';
import { EmptyState } from '../../primitives';
import { percentile } from '../../lib/percentile';
import { useCyclePairs } from '../../lib/cycles';
import { PairDetailPanel } from '../ArchitectureSection/DependencyMatrix';

const MAX_ENTRIES = 5;

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface CalloutsProps {
  snapshot: CodebaseOverviewSnapshot;
  projectId: string;
  onSelectDistrict: (id: string) => void;
}

// ---------------------------------------------------------------------------
// Helper: build blast-radius P75 gate
// ---------------------------------------------------------------------------

function useBlastP75(signals: DistrictSignals[]): number | null {
  return useMemo(() => {
    const values = signals.map((s) => s.blastRadius).filter((v) => v > 0);
    if (values.length < 5) return null;
    return percentile(values, 75);
  }, [signals]);
}

// ---------------------------------------------------------------------------
// Callout 1 — Changed + Untested (always rendered)
// ---------------------------------------------------------------------------

function ChangedUntested({
  signals,
  onSelectDistrict,
}: {
  signals: DistrictSignals[];
  onSelectDistrict: (id: string) => void;
}) {
  const rows = useMemo(
    () =>
      signals
        .filter(
          (s) =>
            s.churn30d > 0 &&
            s.hasSourceFiles &&
            s.sourceCoverageMeasured &&
            s.testCoverageRate !== null &&
            s.testCoverageRate < 0.3,
        )
        .sort((a, b) => b.churn30d - a.churn30d || b.loc - a.loc)
        .slice(0, MAX_ENTRIES),
    [signals],
  );

  return (
    <CalloutCard
      title="Changed + Untested"
      icon={<GitCommit className="h-4 w-4 text-muted-foreground" aria-hidden />}
      count={rows.length}
      tooltip="Source files touched in the last 30 days that still lack test coverage (< 30%). Fix these first — they're actively moving without a safety net."
    >
      {rows.length === 0 ? (
        <EmptyState icon={GitCommit} headline="Nothing flagged here" />
      ) : (
        <DistrictList
          rows={rows}
          renderMetric={(s) => `${s.churn30d} touches`}
          onSelect={onSelectDistrict}
        />
      )}
    </CalloutCard>
  );
}

// ---------------------------------------------------------------------------
// Callout 2 — High-Blast + Untested (population-guarded)
// ---------------------------------------------------------------------------

function HighBlastUntested({
  signals,
  blastP75,
  onSelectDistrict,
}: {
  signals: DistrictSignals[];
  blastP75: number | null;
  onSelectDistrict: (id: string) => void;
}) {
  const rows = useMemo(() => {
    if (blastP75 === null) return null;
    return signals
      .filter(
        (s) =>
          s.blastRadius > blastP75 &&
          s.hasSourceFiles &&
          s.sourceCoverageMeasured &&
          s.testCoverageRate !== null &&
          s.testCoverageRate < 0.3,
      )
      .sort((a, b) => b.blastRadius - a.blastRadius || b.loc - a.loc)
      .slice(0, MAX_ENTRIES);
  }, [signals, blastP75]);

  if (rows === null) return null;

  return (
    <CalloutCard
      title="High-Blast + Untested"
      icon={<Flame className="h-4 w-4 text-muted-foreground" aria-hidden />}
      count={rows.length}
      tooltip="Untested code whose changes ripple through many downstream districts (above P75 blast radius). A bug here breaks a lot."
    >
      {rows.length === 0 ? (
        <EmptyState icon={Flame} headline="Nothing flagged here" />
      ) : (
        <DistrictList
          rows={rows}
          renderMetric={(s) => `Blast ${s.blastRadius}`}
          onSelect={onSelectDistrict}
        />
      )}
    </CalloutCard>
  );
}

// ---------------------------------------------------------------------------
// Callout 3 — Lone-Author + High-Blast (population-guarded)
// ---------------------------------------------------------------------------

function LoneAuthorHighBlast({
  signals,
  blastP75,
  onSelectDistrict,
}: {
  signals: DistrictSignals[];
  blastP75: number | null;
  onSelectDistrict: (id: string) => void;
}) {
  const rows = useMemo(() => {
    if (blastP75 === null) return null;
    const ownershipMeasured = signals.filter((s) => s.ownershipMeasured);
    if (ownershipMeasured.length === 0) return null;
    return ownershipMeasured
      .filter((s) => s.ownershipHHI !== null && s.ownershipHHI > 0.7 && s.blastRadius > blastP75)
      .sort(
        (a, b) => (b.ownershipHHI ?? 0) - (a.ownershipHHI ?? 0) || b.blastRadius - a.blastRadius,
      )
      .slice(0, MAX_ENTRIES);
  }, [signals, blastP75]);

  if (rows === null) return null;

  return (
    <CalloutCard
      title="Lone-Author + High-Blast"
      icon={<User className="h-4 w-4 text-muted-foreground" aria-hidden />}
      count={rows.length}
      tooltip="High-impact code (above P75 blast radius) where one author owns > 70% of contributions. Bus-factor risk meets blast radius."
    >
      {rows.length === 0 ? (
        <EmptyState icon={User} headline="Nothing flagged here" />
      ) : (
        <DistrictList
          rows={rows}
          renderMetric={(s) => `HHI ${((s.ownershipHHI ?? 0) * 100).toFixed(0)}%`}
          onSelect={onSelectDistrict}
        />
      )}
    </CalloutCard>
  );
}

// ---------------------------------------------------------------------------
// Callout 4 — Active Cycles
// ---------------------------------------------------------------------------

function ActiveCycles({
  snapshot,
  projectId,
}: {
  snapshot: CodebaseOverviewSnapshot;
  projectId: string;
}) {
  const [selectedPair, setSelectedPair] = useState<{ fromId: string; toId: string } | null>(null);
  const pairs = useCyclePairs(snapshot.signals, snapshot.dependencies, 3);

  if (pairs.length === 0) return null;

  return (
    <>
      <CalloutCard
        title="Active Cycles"
        icon={<RefreshCw className="h-4 w-4 text-muted-foreground" aria-hidden />}
        count={pairs.length}
        tooltip="Bidirectional dependencies — A imports B and B imports A. These create tight coupling and slow down refactoring."
      >
        <div className="space-y-1">
          {pairs.map((pair) => (
            <button
              key={`${pair.fromId}:${pair.toId}`}
              type="button"
              onClick={() => setSelectedPair({ fromId: pair.fromId, toId: pair.toId })}
              className={cn(
                'flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm transition-colors text-left',
                'hover:bg-muted/50',
                selectedPair?.fromId === pair.fromId &&
                  selectedPair?.toId === pair.toId &&
                  'bg-accent',
              )}
            >
              <span className="min-w-0 flex-1 truncate font-medium">
                {pair.fromName}
                <span className="mx-1 text-muted-foreground">⇄</span>
                {pair.toName}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground whitespace-nowrap">
                {pair.weight} edges
              </span>
            </button>
          ))}
        </div>
      </CalloutCard>
      {selectedPair && (
        <PairDetailPanel
          projectId={projectId}
          fromId={selectedPair.fromId}
          toId={selectedPair.toId}
          snapshot={snapshot}
          onClose={() => setSelectedPair(null)}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

function CalloutCard({
  title,
  icon,
  count,
  tooltip,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  count: number;
  tooltip: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {icon}
            <CardTitle className="text-base">{title}</CardTitle>
            <Badge variant="secondary" className="text-xs">
              {count}
            </Badge>
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground"
                aria-label={`About ${title}`}
              >
                <HelpCircle className="h-4 w-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="left" className="max-w-xs">
              <p>{tooltip}</p>
            </TooltipContent>
          </Tooltip>
        </div>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function DistrictList({
  rows,
  renderMetric,
  onSelect,
}: {
  rows: DistrictSignals[];
  renderMetric: (s: DistrictSignals) => string;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="space-y-1">
      {rows.map((s) => (
        <button
          key={s.districtId}
          type="button"
          onClick={() => onSelect(s.districtId)}
          className={cn(
            'flex w-full items-center gap-3 rounded-md px-2 py-2 text-sm transition-colors text-left',
            'hover:bg-muted/50',
          )}
        >
          <span className="min-w-0 flex-1 truncate font-medium">{s.name}</span>
          <span className="shrink-0 text-xs text-muted-foreground whitespace-nowrap">
            {renderMetric(s)}
          </span>
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Callouts — composed grid
// ---------------------------------------------------------------------------

export function Callouts({ snapshot, projectId, onSelectDistrict }: CalloutsProps) {
  const { signals } = snapshot;
  const blastP75 = useBlastP75(signals);

  return (
    <TooltipProvider delayDuration={300}>
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 items-start">
        <ChangedUntested signals={signals} onSelectDistrict={onSelectDistrict} />
        <HighBlastUntested
          signals={signals}
          blastP75={blastP75}
          onSelectDistrict={onSelectDistrict}
        />
        <LoneAuthorHighBlast
          signals={signals}
          blastP75={blastP75}
          onSelectDistrict={onSelectDistrict}
        />
        <ActiveCycles snapshot={snapshot} projectId={projectId} />
      </div>
    </TooltipProvider>
  );
}
