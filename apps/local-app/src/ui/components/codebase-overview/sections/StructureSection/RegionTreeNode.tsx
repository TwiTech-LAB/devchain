import { useCallback, useState } from 'react';
import { ChevronRight, FolderOpen } from 'lucide-react';
import type { RegionNode, DistrictSignals } from '@devchain/codebase-overview';
import { cn } from '@/ui/lib/utils';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/ui/components/ui/collapsible';
import { DistrictTreeRow } from './DistrictTreeRow';

const STORAGE_PREFIX = 'overview.structure.expanded.';

export interface RegionTreeNodeProps {
  region: RegionNode;
  districts: DistrictSignals[];
  defaultExpanded: boolean;
  onSelectDistrict: (id: string) => void;
}

export function RegionTreeNode({
  region,
  districts,
  defaultExpanded,
  onSelectDistrict,
}: RegionTreeNodeProps) {
  const [open, setOpen] = useState(() => {
    const stored = localStorage.getItem(`${STORAGE_PREFIX}${region.id}`);
    if (stored !== null) return stored === 'true';
    return defaultExpanded;
  });

  const handleOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      localStorage.setItem(`${STORAGE_PREFIX}${region.id}`, String(next));
    },
    [region.id],
  );

  const sorted = [...districts].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <Collapsible open={open} onOpenChange={handleOpenChange}>
      <CollapsibleTrigger
        className={cn(
          'flex w-full items-center gap-2 rounded-md px-3 min-h-10 text-sm font-medium transition-colors',
          'hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        )}
      >
        <ChevronRight
          className={cn(
            'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-90',
          )}
        />
        <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-left">{region.name}</span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {districts.length} district{districts.length !== 1 ? 's' : ''} · {region.totalFiles} files
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="ml-6 border-l pl-1 py-1 space-y-0.5">
          {sorted.map((signal) => (
            <DistrictTreeRow
              key={signal.districtId}
              signal={signal}
              onSelectDistrict={onSelectDistrict}
            />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
