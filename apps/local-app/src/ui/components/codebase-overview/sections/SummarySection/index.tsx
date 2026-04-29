import { LayoutDashboard } from 'lucide-react';
import type { CodebaseOverviewSnapshot } from '@devchain/codebase-overview';
import { EmptyState } from '../../primitives';
import { Callouts } from './Callouts';
import { PressureTable } from './PressureTable';

export interface SummarySectionProps {
  snapshot: CodebaseOverviewSnapshot;
  projectId: string;
  selectedDistrictId: string | null;
  onSelectDistrict: (id: string) => void;
}

export function SummarySection({
  snapshot,
  projectId,
  selectedDistrictId,
  onSelectDistrict,
}: SummarySectionProps) {
  if (snapshot.signals.length === 0) {
    return (
      <EmptyState
        icon={LayoutDashboard}
        headline="No signal data available"
        reason="Run a fresh analysis to populate summary callouts."
      />
    );
  }

  return (
    <div className="space-y-6">
      <SectionHeader />
      <Callouts snapshot={snapshot} projectId={projectId} onSelectDistrict={onSelectDistrict} />
      <PressureTable
        signals={snapshot.signals}
        selectedDistrictId={selectedDistrictId}
        onSelectDistrict={onSelectDistrict}
      />
    </div>
  );
}

function SectionHeader() {
  return (
    <div>
      <h2 className="text-xl font-semibold tracking-tight">Summary</h2>
      <p className="text-sm text-muted-foreground mt-1">
        Where risk signals intersect — the most urgent districts to review
      </p>
    </div>
  );
}
