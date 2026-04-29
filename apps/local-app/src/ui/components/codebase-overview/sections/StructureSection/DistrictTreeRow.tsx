import type { DistrictSignals } from '@devchain/codebase-overview';
import { cn } from '@/ui/lib/utils';

function topThreeExtensions(breakdown: {
  kind: 'extension';
  counts: Record<string, number>;
}): Array<{ ext: string; count: number }> {
  return Object.entries(breakdown.counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([ext, count]) => ({ ext, count }));
}

export interface DistrictTreeRowProps {
  signal: DistrictSignals;
  onSelectDistrict: (id: string) => void;
}

export function DistrictTreeRow({ signal, onSelectDistrict }: DistrictTreeRowProps) {
  const extensions = topThreeExtensions(signal.fileTypeBreakdown);

  return (
    <button
      type="button"
      onClick={() => onSelectDistrict(signal.districtId)}
      className={cn(
        'flex w-full items-center gap-3 rounded-md px-3 min-h-10 text-sm transition-colors text-left',
        'hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      )}
    >
      <span className="min-w-0 flex-1 truncate font-mono text-xs">{signal.name}</span>
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
        {signal.files} files
      </span>
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
        {signal.loc.toLocaleString()} LOC
      </span>
      {extensions.length > 0 && (
        <span className="shrink-0 text-xs text-muted-foreground whitespace-nowrap">
          {extensions.map((e) => `${e.ext} (${e.count})`).join(' · ')}
        </span>
      )}
    </button>
  );
}
