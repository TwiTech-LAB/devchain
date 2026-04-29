import { Users } from 'lucide-react';
import type { CodebaseOverviewSnapshot } from '@devchain/codebase-overview';
import { EmptyState } from '../../primitives';
import { BusFactorCard } from './BusFactorCard';
import { LoneAuthorCard } from './LoneAuthorCard';
import { TopContributorsByDistrictCard } from './TopContributorsByDistrictCard';
import { OwnerQuietCard } from './OwnerQuietCard';

export interface OwnershipSectionProps {
  snapshot: CodebaseOverviewSnapshot;
  onSelectDistrict: (id: string) => void;
}

export function OwnershipSection({ snapshot, onSelectDistrict }: OwnershipSectionProps) {
  const { signals, dependencies } = snapshot;

  const busFactor = (
    <BusFactorCard
      signals={signals}
      dependencies={dependencies}
      onSelectDistrict={onSelectDistrict}
    />
  );
  const loneAuthor = <LoneAuthorCard signals={signals} onSelectDistrict={onSelectDistrict} />;
  const ownerQuiet = <OwnerQuietCard signals={signals} onSelectDistrict={onSelectDistrict} />;
  const topContribs = (
    <TopContributorsByDistrictCard snapshot={snapshot} onSelectDistrict={onSelectDistrict} />
  );

  const hasOwnershipData =
    signals.some((s) => s.ownershipMeasured) || snapshot.globalContributors.length > 0;

  if (!hasOwnershipData) {
    return (
      <div className="space-y-6">
        <SectionHeader />
        <EmptyState
          icon={Users}
          headline="No ownership data available"
          reason="Ownership analysis requires git history with author information. Check warnings above."
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <SectionHeader />
      <div className="grid gap-4 md:grid-cols-2">
        {busFactor}
        {loneAuthor}
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {ownerQuiet}
        {topContribs}
      </div>
    </div>
  );
}

function SectionHeader() {
  return (
    <div>
      <h2 className="text-xl font-semibold tracking-tight">Ownership</h2>
      <p className="text-sm text-muted-foreground mt-1">Who knows what?</p>
    </div>
  );
}
