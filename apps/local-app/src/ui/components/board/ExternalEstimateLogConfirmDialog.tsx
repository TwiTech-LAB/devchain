import { ChevronRight, Clock3, Info } from 'lucide-react';
import type { EpicTimeDailyTotal } from '@/modules/epic-time/models/epic-time.models';
import { Button } from '@/ui/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/ui/components/ui/collapsible';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/components/ui/dialog';
import { formatEpicTimeMinutes } from '@/ui/lib/epic-time';

const MAX_ENTRIES_PER_REQUEST = 10;
const activityDateFormatter = new Intl.DateTimeFormat('en', {
  timeZone: 'UTC',
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

export interface ExternalEstimateConfirmationRow {
  activityDate: string;
  capturedMinutes: number;
  newMinutes: number;
  entryCount: number;
}

export interface ExternalEstimateLogConfirmation {
  currentEstimateMinutes: number;
  loggedMinutes: number;
  deltaMinutes: number;
  revision: number;
  timeZone: string;
  remoteScopeKey: string;
  scopeLabel: string;
  dailySnapshot: EpicTimeDailyTotal[];
  rows: ExternalEstimateConfirmationRow[];
  totalChunkCount: number;
}

interface ExternalEstimateLogConfirmDialogProps {
  confirmation: ExternalEstimateLogConfirmation | null;
  loading: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (confirmation: ExternalEstimateLogConfirmation) => void;
}

function formatActivityDate(activityDate: string): string {
  return activityDateFormatter.format(new Date(`${activityDate}T00:00:00.000Z`));
}

function ActivityDateRow({ row }: { row: ExternalEstimateConfirmationRow }) {
  return (
    <li className="grid gap-1 rounded-lg border bg-background/40 p-3 text-sm sm:grid-cols-[1.1fr_1.2fr_1fr_auto] sm:items-center sm:gap-0 sm:p-0">
      <span className="font-medium sm:p-3">{formatActivityDate(row.activityDate)}</span>
      <span className="text-muted-foreground sm:border-l sm:p-3">
        {formatEpicTimeMinutes(row.capturedMinutes)} date total
      </span>
      <span className="font-semibold tabular-nums text-primary sm:border-l sm:p-3">
        +{formatEpicTimeMinutes(row.newMinutes)}
      </span>
      <span className="text-muted-foreground sm:border-l sm:p-3">
        {row.entryCount} {row.entryCount === 1 ? 'entry' : 'entries'}
      </span>
    </li>
  );
}

export function ExternalEstimateLogConfirmDialog({
  confirmation,
  loading,
  onOpenChange,
  onConfirm,
}: ExternalEstimateLogConfirmDialogProps) {
  const rowsWithNewTime = confirmation?.rows.filter((row) => row.newMinutes > 0) ?? [];
  const rowsWithoutNewTime = confirmation?.rows.filter((row) => row.newMinutes === 0) ?? [];
  const deltaLabel = formatEpicTimeMinutes(confirmation?.deltaMinutes ?? 0);

  return (
    <Dialog open={confirmation !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] max-w-4xl gap-0 overflow-y-auto p-0">
        <DialogHeader className="px-6 pb-5 pt-6 text-left sm:px-8 sm:pt-8">
          <div className="flex items-start gap-4 pr-8">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
              <Clock3 className="h-6 w-6" aria-hidden="true" />
            </div>
            <div className="space-y-1.5">
              <DialogTitle className="text-2xl">Log {deltaLabel} of new time?</DialogTitle>
              <DialogDescription className="text-base">
                Only unlogged time will be added. Existing entries will not change.
              </DialogDescription>
              {confirmation ? (
                <p className="text-xs text-muted-foreground">Scope: {confirmation.scopeLabel}</p>
              ) : null}
            </div>
          </div>
        </DialogHeader>

        {confirmation ? (
          <div className="space-y-5 px-6 pb-6 sm:px-8">
            <dl className="grid overflow-hidden rounded-lg border bg-muted/10 sm:grid-cols-3 sm:divide-x">
              <div className="border-b p-4 text-center sm:border-b-0">
                <dt className="text-sm text-muted-foreground">Current total</dt>
                <dd className="mt-1 text-2xl font-semibold tabular-nums">
                  {formatEpicTimeMinutes(confirmation.currentEstimateMinutes)}
                </dd>
              </div>
              <div className="border-b p-4 text-center sm:border-b-0">
                <dt className="text-sm text-muted-foreground">Already logged</dt>
                <dd className="mt-1 text-2xl font-semibold tabular-nums">
                  {formatEpicTimeMinutes(confirmation.loggedMinutes)}
                </dd>
              </div>
              <div className="bg-primary/10 p-4 text-center">
                <dt className="text-sm text-primary">To log now</dt>
                <dd className="mt-1 text-2xl font-semibold tabular-nums text-primary">
                  {deltaLabel}
                </dd>
              </div>
            </dl>

            <section className="space-y-3" aria-labelledby="estimate-dates-heading">
              <h3 id="estimate-dates-heading" className="text-base font-semibold">
                New time by activity date
              </h3>
              <ul className="space-y-2">
                {rowsWithNewTime.map((row) => (
                  <ActivityDateRow key={row.activityDate} row={row} />
                ))}
              </ul>

              {rowsWithoutNewTime.length > 0 ? (
                <Collapsible>
                  <CollapsibleTrigger className="group flex w-full items-center gap-3 rounded-lg border bg-muted/20 px-4 py-3 text-left text-sm transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
                    <ChevronRight
                      className="h-4 w-4 shrink-0 transition-transform group-data-[state=open]:rotate-90"
                      aria-hidden="true"
                    />
                    <span>
                      {rowsWithoutNewTime.length}{' '}
                      {rowsWithoutNewTime.length === 1 ? 'date has' : 'dates have'} no new time
                    </span>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <ul className="space-y-1 px-4 py-2 text-sm text-muted-foreground">
                      {rowsWithoutNewTime.map((row) => (
                        <li key={row.activityDate} className="flex justify-between gap-3">
                          <span>{formatActivityDate(row.activityDate)}</span>
                          <span className="tabular-nums">
                            {formatEpicTimeMinutes(row.capturedMinutes)} date total
                          </span>
                        </li>
                      ))}
                    </ul>
                  </CollapsibleContent>
                </Collapsible>
              ) : null}
            </section>

            <div className="flex gap-3 rounded-lg border border-primary/30 bg-primary/5 p-4 text-sm text-muted-foreground">
              <Info className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
              <p>
                Entries start at the beginning of each local activity date because exact clock times
                are not reconstructed.
              </p>
            </div>

            {confirmation.totalChunkCount > MAX_ENTRIES_PER_REQUEST ? (
              <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-muted-foreground">
                This action writes the oldest {MAX_ENTRIES_PER_REQUEST} entries and leaves the
                remaining {confirmation.totalChunkCount - MAX_ENTRIES_PER_REQUEST} unlogged for a
                later action. One busy date can consume all {MAX_ENTRIES_PER_REQUEST} entries.
              </p>
            ) : null}
          </div>
        ) : null}

        <DialogFooter className="border-t px-6 py-5 sm:px-8">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              if (!confirmation) return;
              onConfirm(confirmation);
              onOpenChange(false);
            }}
            disabled={loading || confirmation === null}
          >
            {loading ? 'Logging…' : `Log ${deltaLabel}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
