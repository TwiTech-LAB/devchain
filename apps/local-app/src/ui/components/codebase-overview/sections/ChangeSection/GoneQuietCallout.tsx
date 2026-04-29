import { useMemo } from 'react';
import { BellOff } from 'lucide-react';
import type { DistrictSignals } from '@devchain/codebase-overview';
import { Card, CardContent, CardHeader, CardTitle } from '@/ui/components/ui/card';
import { Badge } from '@/ui/components/ui/badge';
import { cn } from '@/ui/lib/utils';

const MAX_ROWS = 5;

export interface GoneQuietCalloutProps {
  signals: DistrictSignals[];
  onSelectDistrict: (id: string) => void;
}

export function GoneQuietCallout({ signals, onSelectDistrict }: GoneQuietCalloutProps) {
  const rows = useMemo(
    () =>
      signals
        .filter((s) => s.churn30d > 5 && s.churn7d === 0)
        .sort((a, b) => b.churn30d - a.churn30d || b.loc - a.loc)
        .slice(0, MAX_ROWS),
    [signals],
  );

  if (rows.length === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <BellOff className="h-4 w-4 text-muted-foreground" aria-hidden />
          <CardTitle className="text-base">Gone Quiet</CardTitle>
          <Badge variant="secondary" className="text-xs">
            {rows.length}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-1">
        {rows.map((row) => (
          <button
            key={row.districtId}
            type="button"
            onClick={() => onSelectDistrict(row.districtId)}
            className={cn(
              'flex w-full min-h-10 items-center gap-2 rounded-md px-2 py-2 text-sm text-left transition-colors',
              'hover:bg-muted/50',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            )}
          >
            <span className="min-w-0 flex-1 truncate font-medium">{row.name}</span>
            <span className="shrink-0 text-xs text-muted-foreground whitespace-nowrap">
              {row.churn30d} in 30d, 0 in 7d
            </span>
          </button>
        ))}
      </CardContent>
    </Card>
  );
}
