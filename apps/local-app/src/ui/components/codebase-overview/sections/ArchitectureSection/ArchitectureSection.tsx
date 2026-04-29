import { useState } from 'react';
import { Network } from 'lucide-react';
import type { CodebaseOverviewSnapshot } from '@devchain/codebase-overview';
import { EmptyState } from '../../primitives';
import { CyclesCard } from './CyclesCard';
import { TopDependencyPairsCard } from './TopDependencyPairsCard';
import { BlastRadiusLeadersCard } from './BlastRadiusLeadersCard';
import { CouplingOutliersCard } from './CouplingOutliersCard';
import { DependencyMatrix, PairDetailPanel } from './DependencyMatrix';
import type { MatrixMode } from './DependencyMatrix';

export interface ArchitectureSectionProps {
  snapshot: CodebaseOverviewSnapshot;
  projectId: string;
  selectedDistrictId: string | null;
  onSelectDistrict: (id: string) => void;
}

export function ArchitectureSection({
  snapshot,
  projectId,
  selectedDistrictId,
  onSelectDistrict,
}: ArchitectureSectionProps) {
  const [selectedFromId, setSelectedFromId] = useState<string | null>(null);
  const [selectedToId, setSelectedToId] = useState<string | null>(null);
  const [matrixModeOverride, setMatrixModeOverride] = useState<MatrixMode | null>(null);

  function handleSelectPair(fromId: string, toId: string) {
    setSelectedFromId(fromId);
    setSelectedToId(toId);
  }

  function handleSelectTarget(id: string) {
    setSelectedFromId(null);
    setSelectedToId(null);
    onSelectDistrict(id);
  }

  const { signals, dependencies } = snapshot;
  const hasArchData =
    dependencies.length > 0 || signals.some((s) => s.blastRadius > 0 || s.couplingScore > 0);

  if (!hasArchData) {
    return (
      <div className="space-y-6">
        <SectionHeader />
        <EmptyState
          icon={Network}
          headline="No architecture data available"
          reason="Import analysis is required to populate dependency and coupling metrics. Check warnings above."
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <SectionHeader />
      <div className="grid gap-4 md:grid-cols-2">
        <CyclesCard snapshot={snapshot} onSelectPair={handleSelectPair} />
        <CouplingOutliersCard signals={signals} onSelectDistrict={onSelectDistrict} />
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <TopDependencyPairsCard snapshot={snapshot} onSelectPair={handleSelectPair} />
        <BlastRadiusLeadersCard signals={signals} onSelectDistrict={onSelectDistrict} />
      </div>
      <DependencyMatrix
        snapshot={snapshot}
        selectedTargetId={selectedDistrictId}
        onSelectTarget={handleSelectTarget}
        onSelectPair={handleSelectPair}
        modeOverride={matrixModeOverride}
        onModeChange={setMatrixModeOverride}
      />
      {selectedFromId && selectedToId && (
        <PairDetailPanel
          projectId={projectId}
          fromId={selectedFromId}
          toId={selectedToId}
          snapshot={snapshot}
          onClose={() => {
            setSelectedFromId(null);
            setSelectedToId(null);
          }}
        />
      )}
    </div>
  );
}

function SectionHeader() {
  return (
    <div>
      <h2 className="text-xl font-semibold tracking-tight">Architecture</h2>
      <p className="text-sm text-muted-foreground mt-1">Is the structure decaying?</p>
    </div>
  );
}
