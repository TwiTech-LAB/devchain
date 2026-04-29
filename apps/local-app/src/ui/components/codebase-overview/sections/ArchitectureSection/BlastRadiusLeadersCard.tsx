import { useMemo } from 'react';
import { Zap, HelpCircle } from 'lucide-react';
import type { DistrictSignals } from '@devchain/codebase-overview';
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

const TOP_N = 15;
const MIN_POPULATION = 5;

export interface BlastRadiusLeadersCardProps {
  signals: DistrictSignals[];
  onSelectDistrict: (id: string) => void;
}

export function BlastRadiusLeadersCard({ signals, onSelectDistrict }: BlastRadiusLeadersCardProps) {
  const rows = useMemo(() => {
    const filtered = signals.filter((s) => s.blastRadius > 0);
    if (filtered.length < MIN_POPULATION) return null;

    return [...filtered]
      .sort((a, b) => b.blastRadius - a.blastRadius || b.inboundWeight - a.inboundWeight)
      .slice(0, TOP_N);
  }, [signals]);

  if (rows === null) return null;

  const maxBlast = rows[0]?.blastRadius ?? 1;

  return (
    <TooltipProvider delayDuration={300}>
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Zap className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              <CardTitle className="text-base">Blast Radius Leaders</CardTitle>
              <Badge variant="secondary" className="text-xs">
                {rows.length}
              </Badge>
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="inline-flex h-10 w-10 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label="About Blast Radius Leaders"
                >
                  <HelpCircle className="h-4 w-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="left" className="max-w-xs">
                <p>
                  Districts with the largest transitive impact. Changes here ripple through the most
                  consumers.
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
                  'flex w-full items-center gap-3 rounded-md px-2 min-h-10 text-sm transition-colors text-left',
                  'hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                )}
              >
                <span className="min-w-0 flex-1 truncate font-medium">{s.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground whitespace-nowrap">
                  {s.blastRadius} transitive
                </span>
                <span className="shrink-0 text-xs text-muted-foreground whitespace-nowrap">
                  {s.inboundWeight} direct
                </span>
                <div className="w-16 h-2 shrink-0">
                  <BarFill value={s.blastRadius} max={maxBlast} />
                </div>
              </button>
            ))}
          </div>
        </CardContent>
      </Card>
    </TooltipProvider>
  );
}
