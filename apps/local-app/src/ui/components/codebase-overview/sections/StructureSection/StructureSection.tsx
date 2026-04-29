import { useMemo } from 'react';
import { FolderTree, Settings2 } from 'lucide-react';
import type { CodebaseOverviewSnapshot, DistrictSignals } from '@devchain/codebase-overview';
import { EmptyState } from '../../primitives';
import { Button } from '@/ui/components/ui/button';
import { RegionTreeNode } from './RegionTreeNode';

export interface StructureSectionProps {
  snapshot: CodebaseOverviewSnapshot;
  onSelectDistrict: (id: string) => void;
  onNavigateToScope?: () => void;
}

export function StructureSection({
  snapshot,
  onSelectDistrict,
  onNavigateToScope,
}: StructureSectionProps) {
  const { signals, regions } = snapshot;

  const districtsByRegion = useMemo(() => {
    const map = new Map<string, DistrictSignals[]>();
    for (const s of signals) {
      const list = map.get(s.regionId) ?? [];
      list.push(s);
      map.set(s.regionId, list);
    }
    return map;
  }, [signals]);

  const totalFiles = useMemo(() => signals.reduce((sum, s) => sum + s.files, 0), [signals]);
  const totalLoc = useMemo(() => signals.reduce((sum, s) => sum + s.loc, 0), [signals]);

  const topRegionId = useMemo(() => {
    let maxFiles = -1;
    let topId = '';
    for (const r of regions) {
      if (r.totalFiles > maxFiles) {
        maxFiles = r.totalFiles;
        topId = r.id;
      }
    }
    return topId;
  }, [regions]);

  if (signals.length === 0) {
    return (
      <div className="space-y-6">
        <SectionHeader onNavigateToScope={onNavigateToScope} />
        <EmptyState
          icon={FolderTree}
          headline="No districts analyzed"
          reason="Check warnings above or refresh."
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <SectionHeader onNavigateToScope={onNavigateToScope} />
      <p className="text-sm text-muted-foreground">
        {regions.length} region{regions.length !== 1 ? 's' : ''} · {signals.length} district
        {signals.length !== 1 ? 's' : ''} · {totalFiles.toLocaleString()} files ·{' '}
        {totalLoc.toLocaleString()} LOC
      </p>
      <div className="space-y-2">
        {regions.map((region) => (
          <RegionTreeNode
            key={region.id}
            region={region}
            districts={districtsByRegion.get(region.id) ?? []}
            defaultExpanded={region.id === topRegionId}
            onSelectDistrict={onSelectDistrict}
          />
        ))}
      </div>
    </div>
  );
}

function SectionHeader({ onNavigateToScope }: { onNavigateToScope?: () => void }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">Structure</h2>
        <p className="text-sm text-muted-foreground mt-1">What's in this repo?</p>
      </div>
      {onNavigateToScope && (
        <Button
          variant="ghost"
          size="sm"
          onClick={onNavigateToScope}
          className="shrink-0 min-h-[40px] gap-1.5 text-muted-foreground hover:text-foreground"
          aria-label="Configure scope"
        >
          <Settings2 className="h-4 w-4" aria-hidden="true" />
          Configure scope →
        </Button>
      )}
    </div>
  );
}
