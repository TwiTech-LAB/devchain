import { useMemo } from 'react';
import { UserCheck, HelpCircle } from 'lucide-react';
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

const TOP_N = 15;

export interface LoneAuthorCardProps {
  signals: DistrictSignals[];
  onSelectDistrict: (id: string) => void;
}

export function LoneAuthorCard({ signals, onSelectDistrict }: LoneAuthorCardProps) {
  const rows = useMemo(() => {
    const filtered = signals.filter(
      (s) =>
        s.primaryAuthorName !== null && s.primaryAuthorShare !== null && s.primaryAuthorShare > 0.8,
    );
    if (filtered.length === 0) return null;

    return [...filtered]
      .sort((a, b) => (b.primaryAuthorShare ?? 0) - (a.primaryAuthorShare ?? 0) || b.loc - a.loc)
      .slice(0, TOP_N);
  }, [signals]);

  if (rows === null) return null;

  return (
    <TooltipProvider delayDuration={300}>
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <UserCheck className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              <CardTitle className="text-base">Lone-Author Districts</CardTitle>
              <Badge variant="secondary" className="text-xs">
                {rows.length}
              </Badge>
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="inline-flex items-center justify-center h-10 w-10 rounded-md text-muted-foreground hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label="About Lone-Author Districts"
                >
                  <HelpCircle className="h-4 w-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="left" className="max-w-xs">
                <p>
                  Districts where a single author wrote more than 80% of commits. Often legitimate
                  but worth surfacing for knowledge-sharing awareness.
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
                  {s.primaryAuthorName}
                </span>
                <span className="shrink-0 text-xs tabular-nums font-medium">
                  {Math.round((s.primaryAuthorShare ?? 0) * 100)}%
                </span>
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                  {s.loc.toLocaleString()} LOC
                </span>
              </button>
            ))}
          </div>
        </CardContent>
      </Card>
    </TooltipProvider>
  );
}
