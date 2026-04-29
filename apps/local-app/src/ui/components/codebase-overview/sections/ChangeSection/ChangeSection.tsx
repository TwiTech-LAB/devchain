import { useMemo } from 'react';
import { TrendingUp } from 'lucide-react';
import type { CodebaseOverviewSnapshot } from '@devchain/codebase-overview';
import { EmptyState } from '../../primitives';
import { AcceleratingCallout } from './AcceleratingCallout';
import { GoneQuietCallout } from './GoneQuietCallout';
import { TopContributorsCard } from './TopContributorsCard';
import { Heatmap } from './Heatmap';

export interface ChangeSectionProps {
  snapshot: CodebaseOverviewSnapshot;
  onSelectDistrict: (id: string) => void;
}

export function ChangeSection({ snapshot, onSelectDistrict }: ChangeSectionProps) {
  const heatmapHidden = snapshot.metrics.warnings.some((w) => w.code === 'daily_churn_unavailable');

  const acceleratingCount = useMemo(
    () => snapshot.signals.filter((s) => s.churn7d > 0 && s.churn7d > s.churn30d / 4).length,
    [snapshot.signals],
  );

  const quietCount = useMemo(
    () => snapshot.signals.filter((s) => s.churn30d > 5 && s.churn7d === 0).length,
    [snapshot.signals],
  );

  const allHidden =
    heatmapHidden &&
    acceleratingCount === 0 &&
    quietCount === 0 &&
    snapshot.globalContributors.length === 0;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">Change</h2>
        <p className="mt-1 text-sm text-muted-foreground">What&apos;s happening this week?</p>
      </div>

      {allHidden ? (
        <EmptyState
          icon={TrendingUp}
          headline="No change data available"
          reason="Daily churn data is unavailable. Run a fresh analysis to populate this section."
        />
      ) : (
        <div className="space-y-6">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <AcceleratingCallout snapshot={snapshot} onSelectDistrict={onSelectDistrict} />
            <GoneQuietCallout signals={snapshot.signals} onSelectDistrict={onSelectDistrict} />
          </div>
          <TopContributorsCard snapshot={snapshot} />
          <Heatmap snapshot={snapshot} onSelectDistrict={onSelectDistrict} />
        </div>
      )}
    </div>
  );
}
