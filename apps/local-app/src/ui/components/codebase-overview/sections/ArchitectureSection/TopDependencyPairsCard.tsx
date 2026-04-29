import { useMemo } from 'react';
import { ArrowRightLeft, RefreshCw, HelpCircle } from 'lucide-react';
import type { CodebaseOverviewSnapshot } from '@devchain/codebase-overview';
import { Card, CardContent, CardHeader, CardTitle } from '@/ui/components/ui/card';
import { Badge } from '@/ui/components/ui/badge';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/ui/components/ui/tooltip';
import { cn } from '@/ui/lib/utils';

const TOP_N = 20;

export interface TopDependencyPairsCardProps {
  snapshot: CodebaseOverviewSnapshot;
  onSelectPair: (fromId: string, toId: string) => void;
}

export function TopDependencyPairsCard({ snapshot, onSelectPair }: TopDependencyPairsCardProps) {
  const rows = useMemo(() => {
    if (snapshot.dependencies.length === 0) return null;

    const districtNameMap = new Map(snapshot.districts.map((d) => [d.id, d.name]));

    return [...snapshot.dependencies]
      .sort(
        (a, b) =>
          b.weight - a.weight ||
          a.fromDistrictId.localeCompare(b.fromDistrictId) ||
          a.toDistrictId.localeCompare(b.toDistrictId),
      )
      .slice(0, TOP_N)
      .map((e) => ({
        fromId: e.fromDistrictId,
        toId: e.toDistrictId,
        fromName: districtNameMap.get(e.fromDistrictId) ?? e.fromDistrictId,
        toName: districtNameMap.get(e.toDistrictId) ?? e.toDistrictId,
        weight: e.weight,
        isCyclic: e.isCyclic,
      }));
  }, [snapshot]);

  if (rows === null) return null;

  return (
    <TooltipProvider delayDuration={300}>
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <ArrowRightLeft className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              <CardTitle className="text-base">Top Dependency Pairs</CardTitle>
              <Badge variant="secondary" className="text-xs">
                {rows.length}
              </Badge>
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="inline-flex h-10 w-10 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label="About Top Dependency Pairs"
                >
                  <HelpCircle className="h-4 w-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="left" className="max-w-xs">
                <p>
                  The heaviest cross-district dependency edges. Higher weight means more import
                  references.
                </p>
              </TooltipContent>
            </Tooltip>
          </div>
        </CardHeader>
        <CardContent>
          <div className="space-y-1">
            {rows.map((r) => (
              <button
                key={`${r.fromId}:${r.toId}`}
                type="button"
                onClick={() => onSelectPair(r.fromId, r.toId)}
                className={cn(
                  'flex w-full items-center gap-3 rounded-md px-2 min-h-10 text-sm transition-colors text-left',
                  'hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                )}
              >
                <span className="min-w-0 flex-1 truncate font-medium">
                  {r.fromName} → {r.toName}
                </span>
                {r.isCyclic && (
                  <RefreshCw
                    className="h-3 w-3 shrink-0 text-muted-foreground"
                    aria-label="Cyclic"
                  />
                )}
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  weight {r.weight}
                </span>
              </button>
            ))}
          </div>
        </CardContent>
      </Card>
    </TooltipProvider>
  );
}
