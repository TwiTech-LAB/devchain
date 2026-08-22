import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Badge } from '@/ui/components/ui/badge';
import { Button } from '@/ui/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/ui/components/ui/card';
import { Skeleton } from '@/ui/components/ui/skeleton';
import { EmptyState } from '@/ui/components/shared/EmptyState';
import { cn } from '@/ui/lib/utils';
import type { ExternalWorkAreaCardModel } from '@/ui/hooks/board/useExternalMyWorkLanding';

// All remote text renders as bounded plain text: React escapes content and the
// line-clamps cap vertical growth, so provider strings can never overflow layout
// or inject markup.
export interface ExternalWorkAreaCardGridProps {
  cards: ExternalWorkAreaCardModel[];
  onSelect: (card: ExternalWorkAreaCardModel) => void;
}

export function ExternalWorkAreaCardGrid({ cards, onSelect }: ExternalWorkAreaCardGridProps) {
  if (cards.length === 0) {
    return <EmptyState title="No matching work areas" description="Try adjusting your search" />;
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {cards.map((card) => (
        <ExternalWorkAreaCard key={card.key} card={card} onSelect={onSelect} />
      ))}
    </div>
  );
}

interface ExternalWorkAreaCardProps {
  card: ExternalWorkAreaCardModel;
  onSelect: (card: ExternalWorkAreaCardModel) => void;
}

function ExternalWorkAreaCard({ card, onSelect }: ExternalWorkAreaCardProps) {
  return (
    <Card className="overflow-hidden py-0 transition-colors hover:border-primary">
      <Button
        variant="ghost"
        className="h-full w-full flex-col items-stretch gap-0 rounded-none p-0 text-left"
        onClick={() => onSelect(card)}
      >
        <CardHeader className="w-full space-y-1 pb-3">
          <div className="flex w-full items-start justify-between gap-2">
            <CardTitle className="line-clamp-1 text-base" title={card.name}>
              {card.name}
            </CardTitle>
            <RefreshStateBadge state={card.refreshState} />
          </div>
          <p className="line-clamp-1 text-xs text-muted-foreground" title={card.locationLabel}>
            {card.locationLabel}
          </p>
        </CardHeader>
        <CardContent className="w-full space-y-2 pb-4">
          {card.description ? (
            <p className="line-clamp-2 text-sm text-muted-foreground">{card.description}</p>
          ) : null}
          <p className="line-clamp-2 text-xs text-muted-foreground" title={card.workflowSummary}>
            {card.kindLabel} · {card.workflowSummary}
          </p>
          <p className="text-sm font-medium">
            {card.assignedTaskCount} assigned{card.assignedTaskCount === 1 ? ' task' : ' tasks'}
          </p>
        </CardContent>
      </Button>
    </Card>
  );
}

function RefreshStateBadge({ state }: { state: ExternalWorkAreaCardModel['refreshState'] }) {
  if (state === 'error') {
    return (
      <Badge variant="destructive" className="shrink-0 gap-1">
        <AlertTriangle className="h-3 w-3" aria-hidden="true" />
        Refresh failed
      </Badge>
    );
  }
  if (state === 'stale') {
    return (
      <Badge
        variant="outline"
        className="shrink-0 gap-1 border-amber-500/40 bg-amber-500/10 text-amber-600"
      >
        <RefreshCw className="h-3 w-3" aria-hidden="true" />
        Stale
      </Badge>
    );
  }
  return null;
}

export function ExternalWorkAreaCardGridSkeleton() {
  return (
    <div className={cn('grid gap-4 sm:grid-cols-2 xl:grid-cols-3')}>
      {Array.from({ length: 6 }).map((_, index) => (
        <Card key={index}>
          <CardHeader className="pb-3">
            <Skeleton className="h-5 w-2/3" />
            <Skeleton className="mt-2 h-3 w-1/2" />
          </CardHeader>
          <CardContent className="space-y-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-3 w-3/4" />
            <Skeleton className="h-4 w-24" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
