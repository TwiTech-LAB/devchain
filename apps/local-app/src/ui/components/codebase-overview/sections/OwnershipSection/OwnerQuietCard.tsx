import { useMemo } from 'react';
import { UserX, HelpCircle } from 'lucide-react';
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

export interface OwnerQuietCardProps {
  signals: DistrictSignals[];
  onSelectDistrict: (id: string) => void;
}

export function OwnerQuietCard({ signals, onSelectDistrict }: OwnerQuietCardProps) {
  const rows = useMemo(() => {
    const filtered = signals.filter(
      (s) =>
        s.ownershipMeasured &&
        s.ownershipHHI !== null &&
        s.ownershipHHI > 0.7 &&
        s.primaryAuthorRecentlyActive === false,
    );

    if (filtered.length < MIN_POPULATION) return null;

    return [...filtered]
      .sort(
        (a, b) =>
          (b.ownershipHHI ?? 0) - (a.ownershipHHI ?? 0) || b.inboundWeight - a.inboundWeight,
      )
      .slice(0, TOP_N);
  }, [signals]);

  if (rows === null) return null;

  return (
    <TooltipProvider delayDuration={300}>
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <UserX className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              <CardTitle className="text-base">Owner-Quiet Districts</CardTitle>
              <Badge variant="secondary" className="text-xs">
                {rows.length}
              </Badge>
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="inline-flex items-center justify-center h-10 w-10 rounded-md text-muted-foreground hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label="About Owner-Quiet Districts"
                >
                  <HelpCircle className="h-4 w-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="left" className="max-w-xs">
                <p>
                  High-concentration districts where the primary author has no commits in the last
                  30 days. They may have left, switched focus, or be on leave.
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
                <span className="shrink-0 text-xs text-orange-600 dark:text-orange-400 whitespace-nowrap">
                  No commits in 30d
                </span>
                <div className="w-16 h-2 shrink-0">
                  <BarFill value={(s.ownershipHHI ?? 0) * 100} max={100} />
                </div>
                <span className="shrink-0 text-xs text-muted-foreground whitespace-nowrap">
                  Used by {s.inboundWeight}
                </span>
              </button>
            ))}
          </div>
        </CardContent>
      </Card>
    </TooltipProvider>
  );
}
