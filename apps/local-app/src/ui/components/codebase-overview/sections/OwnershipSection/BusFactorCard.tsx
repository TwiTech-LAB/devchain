import { useMemo } from 'react';
import { AlertTriangle, HelpCircle } from 'lucide-react';
import type { DistrictSignals, DependencyEdge } from '@devchain/codebase-overview';
import { Card, CardContent, CardHeader, CardTitle } from '@/ui/components/ui/card';
import { Badge } from '@/ui/components/ui/badge';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/ui/components/ui/tooltip';
import { cn } from '@/ui/lib/utils';
import { BarFill } from '../../primitives';
import { percentile } from '../../lib/percentile';

const TOP_N = 15;
const MIN_POPULATION = 5;

export interface BusFactorCardProps {
  signals: DistrictSignals[];
  dependencies: DependencyEdge[];
  onSelectDistrict: (id: string) => void;
}

export function BusFactorCard({ signals, dependencies, onSelectDistrict }: BusFactorCardProps) {
  const rows = useMemo(() => {
    if (dependencies.length === 0) return null;

    const eligible = signals.filter(
      (s) => s.ownershipMeasured && s.ownershipHHI !== null && s.ownershipHHI > 0.7,
    );

    const inboundValues = eligible.map((s) => s.inboundWeight).filter((v) => v > 0);
    if (inboundValues.length === 0) return null;

    const median = percentile(inboundValues, 50);
    const filtered = eligible.filter((s) => s.inboundWeight > median);

    if (filtered.length < MIN_POPULATION) return null;

    return [...filtered]
      .sort(
        (a, b) =>
          (b.ownershipHHI ?? 0) - (a.ownershipHHI ?? 0) || b.inboundWeight - a.inboundWeight,
      )
      .slice(0, TOP_N);
  }, [signals, dependencies]);

  if (rows === null) return null;

  return (
    <TooltipProvider delayDuration={300}>
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              <CardTitle className="text-base">Bus Factor Risk</CardTitle>
              <Badge variant="secondary" className="text-xs">
                {rows.length}
              </Badge>
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="inline-flex items-center justify-center h-10 w-10 rounded-md text-muted-foreground hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label="About Bus Factor Risk"
                >
                  <HelpCircle className="h-4 w-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="left" className="max-w-xs">
                <p>
                  Districts with high ownership concentration (&gt;70% HHI) that other districts
                  depend on. A single point of failure if the primary author leaves.
                </p>
              </TooltipContent>
            </Tooltip>
          </div>
        </CardHeader>
        <CardContent>
          <div className="space-y-1">
            {rows.map((s) => (
              <button
                key={s.districtId}
                type="button"
                onClick={() => onSelectDistrict(s.districtId)}
                className={cn(
                  'flex w-full min-h-10 items-center gap-3 rounded-md px-2 py-2 text-sm transition-colors text-left',
                  'hover:bg-muted/50',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                )}
              >
                <span className="min-w-0 flex-1 truncate font-medium">{s.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground whitespace-nowrap">
                  {s.primaryAuthorName ?? 'Unknown'}
                </span>
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  {Math.round((s.primaryAuthorShare ?? 0) * 100)}%
                </span>
                <span className="shrink-0 text-xs text-muted-foreground whitespace-nowrap">
                  Used by {s.inboundWeight}
                </span>
                <div className="w-16 h-2 shrink-0">
                  <BarFill value={(s.ownershipHHI ?? 0) * 100} max={100} />
                </div>
              </button>
            ))}
          </div>
        </CardContent>
      </Card>
    </TooltipProvider>
  );
}
