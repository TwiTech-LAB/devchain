import { RefreshCw, HelpCircle } from 'lucide-react';
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
import { useCyclePairs } from '../../lib/cycles';

const TOP_N = 10;

export interface CyclesCardProps {
  snapshot: CodebaseOverviewSnapshot;
  onSelectPair: (fromId: string, toId: string) => void;
}

export function CyclesCard({ snapshot, onSelectPair }: CyclesCardProps) {
  const pairs = useCyclePairs(snapshot.signals, snapshot.dependencies, TOP_N);

  if (pairs.length === 0) return null;

  return (
    <TooltipProvider delayDuration={300}>
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <RefreshCw className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              <CardTitle className="text-base">Dependency Cycles</CardTitle>
              <Badge variant="secondary" className="text-xs">
                {pairs.length} cycle{pairs.length !== 1 ? 's' : ''}
              </Badge>
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="inline-flex h-10 w-10 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label="About Dependency Cycles"
                >
                  <HelpCircle className="h-4 w-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="left" className="max-w-xs">
                <p>
                  Pairs of districts that depend on each other in both directions. Sorted by
                  combined edge weight.
                </p>
              </TooltipContent>
            </Tooltip>
          </div>
        </CardHeader>
        <CardContent>
          <div className="space-y-1">
            {pairs.map((p) => (
              <button
                key={`${p.fromId}:${p.toId}`}
                type="button"
                onClick={() => onSelectPair(p.fromId, p.toId)}
                className={cn(
                  'flex w-full items-center gap-3 rounded-md px-2 min-h-10 text-sm transition-colors text-left',
                  'hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                )}
              >
                <span className="min-w-0 flex-1 truncate font-medium">
                  {p.fromName} ↔ {p.toName}
                </span>
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  weight {p.weight}
                </span>
              </button>
            ))}
          </div>
        </CardContent>
      </Card>
    </TooltipProvider>
  );
}
