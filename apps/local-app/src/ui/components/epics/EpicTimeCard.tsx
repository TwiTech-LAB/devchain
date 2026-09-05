import { Clock } from 'lucide-react';
import type { EpicTimeDetailSummary } from '@/modules/epic-time/models/epic-time.models';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/ui/components/ui/card';
import { epicTimeTotalLabel, formatEpicTimeMinutes } from '@/ui/lib/epic-time';

export interface EpicTimeCardProps {
  /** Root Epics label the total as inclusive; children stay self-only. */
  isRoot: boolean;
  summary: EpicTimeDetailSummary | undefined;
  isLoading: boolean;
  isError: boolean;
}

function EpicTimeCardContent({ isRoot, summary, isLoading, isError }: EpicTimeCardProps) {
  if (isLoading) {
    return <p className="text-sm text-muted-foreground">Loading estimated time…</p>;
  }
  if (isError) {
    return <p className="text-sm text-muted-foreground">Estimated time is unavailable.</p>;
  }
  if (!summary || summary.items.length === 0) {
    return <p className="text-sm text-muted-foreground">No estimated time recorded yet.</p>;
  }
  // Direct time is separated out whenever the total contains indirect time
  // (sub-Epics or routed Related Epics); a child focal totals only itself and
  // shows no split.
  const showsDirect = summary.totalMinutes !== summary.directMinutes;
  return (
    <>
      <div className="space-y-2 text-sm">
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground">
            {epicTimeTotalLabel(isRoot, summary.includesRelatedTime)}
          </span>
          <span className="font-medium">{formatEpicTimeMinutes(summary.totalMinutes)}</span>
        </div>
        {showsDirect && (
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground">Direct</span>
            <span className="font-medium">{formatEpicTimeMinutes(summary.directMinutes)}</span>
          </div>
        )}
      </div>
      <div className="space-y-1.5">
        {summary.items.map((item) => {
          // Rows normally arrive hook-normalized; the team-name check keeps a
          // degraded team row on the direct label instead of rendering
          // "undefined".
          const isTeam = item.attributionSource === 'team' && Boolean(item.teamName);
          const label = isTeam
            ? `${item.activityDate} · ${item.agentName} · Team work: ${item.teamName}`
            : `${item.activityDate} · ${item.agentName}`;
          const sourceKey = isTeam ? `team-${item.teamId ?? ''}` : 'direct';
          return (
            <div
              key={`${item.activityDate}-${item.agentId}-${sourceKey}`}
              className="flex items-center justify-between gap-2 text-sm"
            >
              <span className="min-w-0 truncate text-muted-foreground">{label}</span>
              <span className="font-medium">{formatEpicTimeMinutes(item.minutes)}</span>
            </div>
          );
        })}
      </div>
    </>
  );
}

/**
 * Estimated agent time panel for the Epic detail page. Values are
 * estimates derived from meaningful agent activity, not a transcript
 * clock; every visible label keeps that framing.
 */
export function EpicTimeCard({ isRoot, summary, isLoading, isError }: EpicTimeCardProps) {
  return (
    <Card data-testid="epic-time-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Clock className="h-5 w-5" />
          Estimated agent time
        </CardTitle>
        <CardDescription>Automatic estimates from meaningful agent activity.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <EpicTimeCardContent
          isRoot={isRoot}
          summary={summary}
          isLoading={isLoading}
          isError={isError}
        />
      </CardContent>
    </Card>
  );
}
