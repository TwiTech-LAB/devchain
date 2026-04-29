import { useMemo } from 'react';
import { Link2, HelpCircle } from 'lucide-react';
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
import { percentile } from '../../lib/percentile';

const TOP_N = 15;
const MIN_POPULATION = 5;

export interface CouplingOutliersCardProps {
  signals: DistrictSignals[];
  onSelectDistrict: (id: string) => void;
}

export function CouplingOutliersCard({ signals, onSelectDistrict }: CouplingOutliersCardProps) {
  const rows = useMemo(() => {
    const eligible = signals.filter((s) => s.couplingScore > 0);
    if (eligible.length === 0) return null;

    const scores = eligible.map((s) => s.couplingScore);
    const p75 = percentile(scores, 75);
    const filtered = eligible.filter((s) => s.couplingScore > p75);

    if (filtered.length < MIN_POPULATION) return null;

    return [...filtered]
      .sort((a, b) => b.couplingScore - a.couplingScore || b.inboundWeight - a.inboundWeight)
      .slice(0, TOP_N);
  }, [signals]);

  if (rows === null) return null;

  const maxCoupling = rows[0]?.couplingScore ?? 1;

  return (
    <TooltipProvider delayDuration={300}>
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Link2 className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              <CardTitle className="text-base">Coupling Outliers</CardTitle>
              <Badge variant="secondary" className="text-xs">
                {rows.length}
              </Badge>
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="inline-flex h-10 w-10 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label="About Coupling Outliers"
                >
                  <HelpCircle className="h-4 w-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="left" className="max-w-xs">
                <p>
                  Districts with coupling scores above the 75th percentile — disproportionately
                  interconnected with other districts.
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
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  {s.couplingScore.toFixed(1)}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground whitespace-nowrap">
                  in {s.inboundWeight} / out {s.outboundWeight}
                </span>
                <div className="w-16 h-2 shrink-0">
                  <BarFill value={s.couplingScore} max={maxCoupling} />
                </div>
              </button>
            ))}
          </div>
        </CardContent>
      </Card>
    </TooltipProvider>
  );
}
