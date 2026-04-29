import { useMemo } from 'react';
import { TrendingUp } from 'lucide-react';
import type { CodebaseOverviewSnapshot } from '@devchain/codebase-overview';
import { Card, CardContent, CardHeader, CardTitle } from '@/ui/components/ui/card';
import { Badge } from '@/ui/components/ui/badge';
import { cn } from '@/ui/lib/utils';
import { Sparkline } from '../../primitives';

const MAX_ROWS = 5;

function buildSparklineValues(dailyChurn: Record<string, number> | undefined): number[] | null {
  if (!dailyChurn) return null;
  const today = new Date();
  const values: number[] = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    values.push(dailyChurn[key] ?? 0);
  }
  return values;
}

export interface AcceleratingCalloutProps {
  snapshot: CodebaseOverviewSnapshot;
  onSelectDistrict: (id: string) => void;
}

export function AcceleratingCallout({ snapshot, onSelectDistrict }: AcceleratingCalloutProps) {
  const rows = useMemo(() => {
    const activityMap = new Map(snapshot.activity.map((a) => [a.targetId, a.dailyChurn]));
    return snapshot.signals
      .filter((s) => s.churn7d > 0 && s.churn7d > s.churn30d / 4)
      .sort((a, b) => b.churn7d - a.churn7d || b.churn30d - a.churn30d)
      .slice(0, MAX_ROWS)
      .map((s) => ({
        districtId: s.districtId,
        name: s.name,
        churn7d: s.churn7d,
        churn30d: s.churn30d,
        sparkline: buildSparklineValues(activityMap.get(s.districtId)),
      }));
  }, [snapshot]);

  if (rows.length === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <TrendingUp className="h-4 w-4 text-muted-foreground" aria-hidden />
          <CardTitle className="text-base">Accelerating</CardTitle>
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
            {row.sparkline && row.sparkline.some((v) => v > 0) && (
              <Sparkline
                values={row.sparkline}
                decorative
                width={48}
                height={16}
                className="shrink-0"
              />
            )}
            <span className="shrink-0 text-xs text-muted-foreground whitespace-nowrap">
              {row.churn7d} in 7d
            </span>
          </button>
        ))}
      </CardContent>
    </Card>
  );
}
