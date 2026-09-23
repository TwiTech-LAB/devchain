import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CalendarDays, Clock3, ExternalLink } from 'lucide-react';
import type {
  EpicTimeDailyTotal,
  EpicTimeDetailSummary,
  ExternalEstimatePendingDisposition,
  ExternalEstimateResolveOperationResponse,
} from '@/modules/epic-time/models/epic-time.models';
import {
  allocateDailyEstimateExport,
  type EpicTimeDailyExportAllocation,
} from '@/modules/epic-time/models/epic-time-daily-allocator';
import { canonicalizeEpicTimeZone } from '@/modules/epic-time/models/epic-time-local-day';
import {
  ExternalEstimateLogConfirmDialog,
  type ExternalEstimateLogConfirmation,
} from '@/ui/components/board/ExternalEstimateLogConfirmDialog';
import { EpicTimeContributorGroups } from '@/ui/components/board/EpicTimeContributorGroups';
import { Alert, AlertDescription, AlertTitle } from '@/ui/components/ui/alert';
import { Button } from '@/ui/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/components/ui/dialog';
import { Input } from '@/ui/components/ui/input';
import { Label } from '@/ui/components/ui/label';
import type { ExternalEstimateTimeLogController } from '@/ui/hooks/board/useExternalEstimateTimeLog';
import { epicTimeExportScopeLabel, formatEpicTimeMinutes } from '@/ui/lib/epic-time';
import { getErrorMessage } from '@/ui/lib/toast-helpers';

const MAX_ENTRIES_PER_REQUEST = 10;
const activityDateFormatter = new Intl.DateTimeFormat('en', {
  timeZone: 'UTC',
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

/** Stale-capture class of create rejections: the capture predates the ledger
 * or the live estimate, and only a fresh capture can continue. */
const RECAPTURE_REASONS = new Set([
  'estimate_snapshot_stale',
  'estimate_snapshot_ahead',
  'estimate_up_to_date',
]);

interface ExternalEstimateTimePanelProps {
  /**
   * Linked focal Epic. Keys the contributor list so relinking the same
   * remote task resets group expansion without an effect.
   */
  focalEpicId: string;
  summary: EpicTimeDetailSummary;
  estimateLog: ExternalEstimateTimeLogController;
  remoteScopeKey: string;
  sourceUrl: string | null;
  writeBlocked: boolean;
  onAnnounce: (message: string) => void;
  /** Refetches the detail query and checkpoint for one-click recapture. */
  onRecapture: () => void;
  /**
   * Mounted canonical zone owned by the detail query. Preview
   * canonicalization, the captured confirmation, and every request input use
   * this exact value; the browser zone is never re-read here, so a
   * mid-session zone change cannot split the snapshot across two zones.
   */
  timeZone: string;
}

function parseLoggedMinutes(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const minutes = Number(value);
  return Number.isSafeInteger(minutes) ? minutes : null;
}

function formatActivityDate(activityDate: string): string {
  return activityDateFormatter.format(new Date(`${activityDate}T00:00:00.000Z`));
}

/** Groups detail items by activity date; the captured POST snapshot. */
function groupItemsByDate(summary: EpicTimeDetailSummary): EpicTimeDailyTotal[] {
  const minutesByDate = new Map<string, number>();
  for (const item of summary.items) {
    minutesByDate.set(
      item.activityDate,
      (minutesByDate.get(item.activityDate) ?? 0) + item.minutes,
    );
  }
  return [...minutesByDate.entries()]
    .map(([activityDate, minutes]) => ({ activityDate, minutes }))
    .sort((left, right) => left.activityDate.localeCompare(right.activityDate));
}

function createErrorReason(error: unknown): string | null {
  const details = (error as { payload?: { details?: { reason?: unknown } } } | null)?.payload
    ?.details;
  return typeof details?.reason === 'string' ? details.reason : null;
}

function createAnnouncement(
  result: NonNullable<ExternalEstimateTimeLogController['create']['data']>,
): string {
  const counts = `${result.entriesLogged} ${
    result.entriesLogged === 1 ? 'entry' : 'entries'
  } (${formatEpicTimeMinutes(result.minutesLogged)})`;
  switch (result.outcome) {
    case 'logged':
      return result.hasMore
        ? `Oldest ${counts} logged. More dated estimate time remains unlogged.`
        : `New DevChain estimate time logged: ${counts}.`;
    case 'partially_logged':
      return `Confirmed entries were saved (${counts}); later entries were not sent.`;
    default:
      return 'The estimate submission is unconfirmed.';
  }
}

function pendingExplanation(
  disposition: ExternalEstimatePendingDisposition,
  canVerify: boolean,
  pendingDate: string | null,
  pendingMinutes: number,
): string {
  const dated = pendingDate
    ? ` The unconfirmed entry covers ${pendingMinutes}m on ${pendingDate}.`
    : '';
  switch (disposition) {
    case 'busy':
      return 'The estimate submission is still running. Time writes remain locked until it settles.';
    case 'outcome_unknown':
      return (
        'The provider was contacted, but DevChain cannot confirm whether the estimate entry was created.' +
        dated +
        (canVerify
          ? ' Verify it or record the outcome below.'
          : ' Open the entry in the source and check it, then record the outcome with Mark logged or Mark not logged.')
      );
    case 'finishing':
      return 'A saved resolution is being applied. It is safe to reload; DevChain will finish it exactly once.';
    default:
      return (
        'The estimate result is unavailable after restart or connection replacement. Open the entry in the source and check it, then record the outcome with Mark logged or Mark not logged.' +
        dated
      );
  }
}

function pendingTitle(disposition: ExternalEstimatePendingDisposition): string {
  switch (disposition) {
    case 'busy':
      return 'Estimate submission in progress';
    case 'finishing':
      return 'Finishing estimate resolution';
    default:
      return 'Estimate submission needs review';
  }
}

function resolutionAnnouncement(
  outcome: ExternalEstimateResolveOperationResponse['outcome'],
): string {
  switch (outcome) {
    case 'logged':
      return 'Estimate operation marked logged.';
    case 'not_logged':
      return 'Estimate operation marked not logged.';
    default:
      return 'Estimate operation still needs review.';
  }
}

export function ExternalEstimateTimePanel({
  focalEpicId,
  summary,
  estimateLog,
  remoteScopeKey,
  sourceUrl,
  writeBlocked,
  onAnnounce,
  onRecapture,
  timeZone,
}: ExternalEstimateTimePanelProps) {
  const [confirmation, setConfirmation] = useState<ExternalEstimateLogConfirmation | null>(null);
  const [assignDialogOpen, setAssignDialogOpen] = useState(false);
  const [setDialogOpen, setSetDialogOpen] = useState(false);
  const [loggedInput, setLoggedInput] = useState('');
  const [loggedInputError, setLoggedInputError] = useState<string | null>(null);
  const [restoreSetFocus, setRestoreSetFocus] = useState(false);
  const setTriggerRef = useRef<HTMLButtonElement | null>(null);
  const state = estimateLog.state;
  const legacyCheckpoint = estimateLog.legacyCheckpoint;
  const currentMinutes = summary.totalMinutes;
  const loggedMinutes = state?.loggedMinutes ?? 0;
  const deltaMinutes = Math.max(0, currentMinutes - loggedMinutes);
  const pending = state?.pending ?? null;
  const capturedDailyTotals = useMemo(() => groupItemsByDate(summary), [summary]);

  // The preview rides the same shared allocator the server uses, so the
  // confirmation shows exactly the entries the captured POST would write.
  // Canonicalization stays on the detail query's mounted zone.
  const preview: EpicTimeDailyExportAllocation | null = useMemo(() => {
    // Unassigned legacy history gates every export projection: no preview,
    // no derived delta, and no Review & log until ownership is recovered.
    if (!state || legacyCheckpoint !== null) return null;
    const canonicalZone = canonicalizeEpicTimeZone(timeZone);
    if (!canonicalZone) return null;
    return allocateDailyEstimateExport({
      liveByDate: capturedDailyTotals,
      capturedByDate: capturedDailyTotals,
      ledgerByDate: state.days.map((day) => ({
        activityDate: day.activityDate,
        minutes: day.loggedMinutes,
      })),
      unallocatedCreditMinutes: state.unallocatedLoggedMinutes,
      storedCanonicalTimeZone: state.aggregationTimeZone,
      currentCanonicalTimeZone: canonicalZone,
    });
    // Identity-stable inputs keep the capture immutable between checkpoint
    // or detail changes; TanStack structural sharing avoids recompute noise.
  }, [capturedDailyTotals, legacyCheckpoint, state, timeZone]);
  const rebaselineRequired =
    preview !== null &&
    (preview.status === 'real_shrink' || preview.status === 'zone_rebind_required');
  const nextProviderChunks =
    preview?.status === 'ok' ? preview.entryChunks.slice(0, MAX_ENTRIES_PER_REQUEST) : [];
  const nextProviderDates = [...new Set(nextProviderChunks.map((chunk) => chunk.activityDate))];
  const nextProviderDateLabel =
    nextProviderDates.length === 1
      ? formatActivityDate(nextProviderDates[0]!)
      : `${nextProviderDates.length} activity dates`;

  useEffect(() => {
    if (estimateLog.create.isSuccess && estimateLog.create.data) {
      onAnnounce(createAnnouncement(estimateLog.create.data));
    }
  }, [estimateLog.create.data, estimateLog.create.isSuccess, onAnnounce]);

  // A rejected capture is stale against the ledger or the live estimate:
  // one click refetches both and drops the outdated confirmation. This path
  // never suggests the destructive Set-logged rebaseline.
  const createFailureReason = estimateLog.create.isError
    ? createErrorReason(estimateLog.create.error)
    : null;
  const createRejectedStale =
    createFailureReason !== null && RECAPTURE_REASONS.has(createFailureReason);
  useEffect(() => {
    if (createRejectedStale) {
      setConfirmation(null);
    }
  }, [createRejectedStale]);

  useEffect(() => {
    if (estimateLog.setLogged.isSuccess) {
      setSetDialogOpen(false);
      setRestoreSetFocus(true);
      onAnnounce('Logged estimate updated in DevChain.');
    }
  }, [estimateLog.setLogged.isSuccess, onAnnounce]);

  useEffect(() => {
    if (!setDialogOpen && restoreSetFocus) {
      setTriggerRef.current?.focus();
      setRestoreSetFocus(false);
    }
  }, [restoreSetFocus, setDialogOpen]);

  useEffect(() => {
    if (estimateLog.resolve.isSuccess && estimateLog.resolve.data) {
      onAnnounce(resolutionAnnouncement(estimateLog.resolve.data.outcome));
    }
  }, [estimateLog.resolve.data, estimateLog.resolve.isSuccess, onAnnounce]);

  useEffect(() => {
    if (estimateLog.assignLegacy.isSuccess) {
      setAssignDialogOpen(false);
      onAnnounce('Previous logged time assigned to this project.');
    }
  }, [estimateLog.assignLegacy.isSuccess, onAnnounce]);

  const openAssignDialog = () => {
    if (legacyCheckpoint === null || estimateLog.mutationPending) return;
    estimateLog.assignLegacy.reset();
    setAssignDialogOpen(true);
  };

  const openConfirmation = () => {
    if (!state || !preview || preview.status !== 'ok' || writeBlocked) return;
    const deltaMinutesByDate = new Map(
      preview.datedDeltas.map((delta) => [delta.activityDate, delta.minutes]),
    );
    const entryCountByDate = new Map<string, number>();
    for (const chunk of preview.entryChunks) {
      entryCountByDate.set(chunk.activityDate, (entryCountByDate.get(chunk.activityDate) ?? 0) + 1);
    }
    setConfirmation({
      currentEstimateMinutes: currentMinutes,
      loggedMinutes,
      deltaMinutes,
      revision: state.revision,
      timeZone,
      remoteScopeKey,
      scopeLabel: summary.isRoot
        ? epicTimeExportScopeLabel(summary.isRoot, summary.includesRelatedTime)
        : (summary.taskItems[0]?.epicTitle ?? 'Task total'),
      dailySnapshot: capturedDailyTotals,
      rows: capturedDailyTotals.map((day) => ({
        activityDate: day.activityDate,
        capturedMinutes: day.minutes,
        newMinutes: deltaMinutesByDate.get(day.activityDate) ?? 0,
        entryCount: entryCountByDate.get(day.activityDate) ?? 0,
      })),
      totalChunkCount: preview.entryChunks.length,
    });
  };

  const openSetDialog = () => {
    if (
      !state ||
      legacyCheckpoint !== null ||
      state.pending !== null ||
      estimateLog.mutationPending
    )
      return;
    setLoggedInput(String(state.initialized ? state.loggedMinutes : currentMinutes));
    setLoggedInputError(null);
    estimateLog.setLogged.reset();
    setSetDialogOpen(true);
  };

  const submitSetLogged = () => {
    if (!state || estimateLog.setLogged.isPending) return;
    const minutes = parseLoggedMinutes(loggedInput);
    if (minutes === null) {
      setLoggedInputError('Enter a nonnegative whole number of minutes.');
      return;
    }
    setLoggedInputError(null);
    estimateLog.setLoggedMinutes(minutes, state.revision, timeZone);
  };

  let estimateAction: ReactNode;
  if (legacyCheckpoint !== null) {
    // Ordinary reconciliation and Review & log stay suppressed while
    // previous-history ownership is unresolved.
    estimateAction = null;
  } else if (rebaselineRequired) {
    estimateAction = (
      <p className="text-xs text-destructive" role="alert">
        The dated ledger no longer matches this estimate. Use Reconcile logged time to rebuild the
        dated baseline before logging new time.
      </p>
    );
  } else if (loggedMinutes > currentMinutes) {
    estimateAction = (
      <p className="text-xs text-muted-foreground">
        Logged time is above the current estimate. New unlogged estimate remains 0m.
      </p>
    );
  } else if (deltaMinutes === 0) {
    estimateAction = <p className="text-sm font-medium">Estimate is up to date.</p>;
  } else {
    estimateAction = (
      <Button type="button" size="sm" onClick={openConfirmation} disabled={writeBlocked}>
        Review &amp; log {formatEpicTimeMinutes(deltaMinutes)}
      </Button>
    );
  }

  return (
    <section
      className="space-y-3 rounded-md border bg-muted/30 p-3"
      aria-labelledby="devchain-time-estimate-heading"
    >
      <div className="space-y-1">
        <h4 id="devchain-time-estimate-heading" className="text-sm font-semibold">
          DevChain estimated time tracked
        </h4>
        <p className="text-xs text-muted-foreground">
          DevChain derives the current estimate from agent activity and logs only new minutes.
          Figures count this project&rsquo;s contribution; the provider total includes every
          contributor.
        </p>
      </div>

      {estimateLog.query.isLoading ? (
        <p className="text-sm text-muted-foreground" role="status">
          Loading estimate checkpoint…
        </p>
      ) : null}
      {estimateLog.query.isError ? (
        <p className="text-sm text-destructive" role="alert">
          The estimate checkpoint is unavailable. Time writes are locked until it reloads.
        </p>
      ) : null}

      {state ? (
        <>
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
            <div className="min-w-0 space-y-4">
              <dl className="grid overflow-hidden rounded-md border bg-background/40 text-sm sm:grid-cols-3 sm:divide-x">
                <div className="border-b p-3 sm:border-b-0">
                  <dt className="text-xs text-muted-foreground">Current estimate</dt>
                  <dd className="mt-1 text-lg font-semibold tabular-nums">
                    {formatEpicTimeMinutes(currentMinutes)}
                  </dd>
                </div>
                <div className="border-b p-3 sm:border-b-0">
                  <dt className="text-xs text-muted-foreground">Logged by this project</dt>
                  <dd className="mt-1 text-lg font-semibold tabular-nums">
                    {formatEpicTimeMinutes(loggedMinutes)}
                  </dd>
                </div>
                {legacyCheckpoint !== null ? (
                  <div className="bg-muted p-3">
                    <dt className="text-xs text-muted-foreground">Previous logged time</dt>
                    <dd className="mt-1 text-lg font-semibold tabular-nums">
                      {formatEpicTimeMinutes(legacyCheckpoint.loggedMinutes)}
                    </dd>
                  </div>
                ) : (
                  <div className="bg-primary/10 p-3">
                    <dt className="text-xs text-primary">Ready to log</dt>
                    <dd className="mt-1 text-lg font-semibold tabular-nums">
                      {formatEpicTimeMinutes(deltaMinutes)}
                    </dd>
                  </div>
                )}
              </dl>

              <div className="space-y-2">
                <div className="flex items-end justify-between gap-3">
                  <h5 className="text-sm font-semibold">Included work</h5>
                  <span className="text-xs text-muted-foreground">Captured</span>
                </div>
                <EpicTimeContributorGroups
                  key={focalEpicId}
                  taskItems={summary.taskItems}
                  focalEpicId={focalEpicId}
                />
              </div>
            </div>

            <div className="space-y-4 rounded-md border border-primary/70 bg-background/40 p-4">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <CalendarDays className="h-4 w-4 text-primary" aria-hidden="true" />
                <h5>
                  {legacyCheckpoint !== null ? 'Previous logged time' : 'Next provider update'}
                </h5>
              </div>
              {legacyCheckpoint !== null ? (
                <>
                  <p className="text-2xl font-semibold tabular-nums">
                    {formatEpicTimeMinutes(legacyCheckpoint.loggedMinutes)}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    Logged time from before this project was linked is waiting for an owner.
                  </p>
                  {legacyCheckpoint.hasPendingOperation ? (
                    <p className="text-xs text-muted-foreground">
                      It includes an unresolved estimate submission. After assigning, use Verify,
                      Mark logged, or Mark not logged to settle it.
                    </p>
                  ) : null}
                  <p className="text-xs text-muted-foreground">
                    Export and reconciliation stay locked until this project takes ownership.
                  </p>
                  <Button
                    type="button"
                    size="sm"
                    onClick={openAssignDialog}
                    disabled={estimateLog.mutationPending}
                  >
                    Assign previous logged time to this project
                  </Button>
                </>
              ) : nextProviderChunks.length > 0 ? (
                <>
                  <p className="text-2xl font-semibold tabular-nums">
                    {formatEpicTimeMinutes(deltaMinutes)}
                  </p>
                  <p className="flex items-center gap-2 text-sm text-muted-foreground">
                    <CalendarDays className="h-4 w-4 text-primary" aria-hidden="true" />
                    <span>
                      {nextProviderChunks.length}{' '}
                      {nextProviderChunks.length === 1 ? 'entry' : 'entries'} ·{' '}
                      {nextProviderDateLabel}
                    </span>
                  </p>
                  <div className="space-y-1 border-y border-dashed py-4 text-sm text-muted-foreground">
                    <p className="flex items-center gap-2">
                      <Clock3 className="h-4 w-4 text-primary" aria-hidden="true" />
                      Starts at the beginning of the local activity date
                    </p>
                    <p className="pl-6 text-xs">Exact clock time is not reconstructed.</p>
                  </div>
                </>
              ) : null}
              <div className="grid gap-2">
                {legacyCheckpoint === null && rebaselineRequired ? (
                  <Button
                    ref={setTriggerRef}
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={openSetDialog}
                    disabled={writeBlocked}
                  >
                    Reconcile logged time
                  </Button>
                ) : null}
                {estimateAction}
              </div>
            </div>
          </div>

          {estimateLog.create.isError ? (
            <div className="space-y-2" role="alert">
              <p className="text-xs text-destructive">
                {getErrorMessage(
                  estimateLog.create.error,
                  'The new estimate time could not be logged.',
                )}
              </p>
              {createRejectedStale ? (
                <div>
                  <p className="text-xs text-muted-foreground">
                    The estimate changed after this confirmation was opened. Recapture the current
                    estimate to continue.
                  </p>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      estimateLog.create.reset();
                      onRecapture();
                    }}
                  >
                    Recapture estimate
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}

          {pending ? (
            <Alert variant="destructive">
              <AlertTitle>{pendingTitle(state.pendingDisposition)}</AlertTitle>
              <AlertDescription>
                <p>
                  {pendingExplanation(
                    state.pendingDisposition,
                    state.canVerify,
                    pending.activityDate,
                    pending.deltaMinutes,
                  )}
                </p>
                {pending.resolution ? (
                  <p className="mt-2 text-xs">
                    Saved choice:{' '}
                    {pending.resolution === 'logged' ? 'Mark logged' : 'Mark not logged'}.
                  </p>
                ) : null}
                <div className="mt-2 flex flex-wrap gap-2">
                  {state.canVerify ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        estimateLog.resolveOperation(pending.operationId, 'verify', state.revision)
                      }
                      disabled={estimateLog.resolve.isPending}
                    >
                      {estimateLog.resolve.isPending ? 'Verifying…' : 'Verify'}
                    </Button>
                  ) : null}
                  {sourceUrl ? (
                    <Button asChild size="sm" variant="outline">
                      <a href={sourceUrl} target="_blank" rel="noreferrer">
                        Open in source{' '}
                        <ExternalLink className="ml-1 h-3.5 w-3.5" aria-hidden="true" />
                      </a>
                    </Button>
                  ) : null}
                  {state.pendingDisposition === 'outcome_unknown' ||
                  state.pendingDisposition === 'manual_review' ? (
                    <>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          estimateLog.resolveOperation(
                            pending.operationId,
                            'logged',
                            state.revision,
                          )
                        }
                        disabled={estimateLog.resolve.isPending}
                      >
                        Mark logged
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          estimateLog.resolveOperation(
                            pending.operationId,
                            'not_logged',
                            state.revision,
                          )
                        }
                        disabled={estimateLog.resolve.isPending}
                      >
                        Mark not logged
                      </Button>
                    </>
                  ) : null}
                </div>
                {estimateLog.resolve.isError ? (
                  <p role="alert" className="mt-2 text-xs">
                    {getErrorMessage(
                      estimateLog.resolve.error,
                      'The estimate operation could not be resolved.',
                    )}
                  </p>
                ) : null}
              </AlertDescription>
            </Alert>
          ) : null}
        </>
      ) : null}

      <ExternalEstimateLogConfirmDialog
        confirmation={confirmation}
        onOpenChange={(open) => {
          if (!open) setConfirmation(null);
        }}
        loading={estimateLog.create.isPending}
        onConfirm={(confirmed) => {
          estimateLog.submitCreate({
            estimateTotalMinutes: confirmed.currentEstimateMinutes,
            expectedRevision: confirmed.revision,
            timeZone: confirmed.timeZone,
            remoteScopeKey: confirmed.remoteScopeKey,
            dailySnapshot: confirmed.dailySnapshot,
          });
        }}
      />

      <Dialog
        open={setDialogOpen}
        onOpenChange={(open) => {
          if (!open && estimateLog.setLogged.isPending) return;
          setSetDialogOpen(open);
        }}
      >
        <DialogContent
          className="max-w-md"
          showCloseButton={!estimateLog.setLogged.isPending}
          onEscapeKeyDown={(event) => {
            if (estimateLog.setLogged.isPending) event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (estimateLog.setLogged.isPending) event.preventDefault();
          }}
          onInteractOutside={(event) => {
            if (estimateLog.setLogged.isPending) event.preventDefault();
          }}
        >
          <DialogHeader>
            <DialogTitle>Reconcile logged time</DialogTitle>
            <DialogDescription>
              Use this recovery action when the saved logged total no longer matches the current
              estimate. It sends no provider request. The dated baseline rebuilds by allocating this
              value to the current activity dates oldest-first; already-written provider entries
              keep their historical placement and are never moved. Lowering the value can submit
              duplicate remote time on a later action.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="external-estimate-logged-minutes">Logged minutes to recognize</Label>
            <Input
              id="external-estimate-logged-minutes"
              type="number"
              inputMode="numeric"
              min={0}
              step={1}
              value={loggedInput}
              onChange={(event) => {
                setLoggedInput(event.target.value);
                if (loggedInputError) setLoggedInputError(null);
              }}
              aria-invalid={loggedInputError !== null}
              aria-describedby={
                loggedInputError ? 'external-estimate-logged-minutes-error' : undefined
              }
              disabled={estimateLog.setLogged.isPending}
            />
            {loggedInputError ? (
              <p
                id="external-estimate-logged-minutes-error"
                role="alert"
                className="text-xs text-destructive"
              >
                {loggedInputError}
              </p>
            ) : null}
            {estimateLog.setLogged.isError ? (
              <p role="alert" className="text-xs text-destructive">
                {getErrorMessage(
                  estimateLog.setLogged.error,
                  'The logged estimate could not be updated.',
                )}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setSetDialogOpen(false)}
              disabled={estimateLog.setLogged.isPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={submitSetLogged}
              disabled={estimateLog.setLogged.isPending}
            >
              {estimateLog.setLogged.isPending ? 'Saving…' : 'Save reconciliation'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={assignDialogOpen}
        onOpenChange={(open) => {
          if (!open && estimateLog.assignLegacy.isPending) return;
          setAssignDialogOpen(open);
        }}
      >
        <DialogContent
          className="max-w-md"
          showCloseButton={!estimateLog.assignLegacy.isPending}
          onEscapeKeyDown={(event) => {
            if (estimateLog.assignLegacy.isPending) event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (estimateLog.assignLegacy.isPending) event.preventDefault();
          }}
          onInteractOutside={(event) => {
            if (estimateLog.assignLegacy.isPending) event.preventDefault();
          }}
        >
          <DialogHeader>
            <DialogTitle>Assign previous logged time</DialogTitle>
            <DialogDescription>
              This assigns the previous logged time
              {legacyCheckpoint
                ? ` (${formatEpicTimeMinutes(legacyCheckpoint.loggedMinutes)})`
                : ''}
              to this project as its own contribution. It sends no request to the provider and keeps
              every stored date. An unresolved estimate submission is preserved: use Verify, Mark
              logged, or Mark not logged afterwards to settle it. Other projects are not affected.
            </DialogDescription>
          </DialogHeader>
          {estimateLog.assignLegacy.isError ? (
            <p role="alert" className="text-xs text-destructive">
              {getErrorMessage(
                estimateLog.assignLegacy.error,
                'The previous logged time could not be assigned.',
              )}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setAssignDialogOpen(false)}
              disabled={estimateLog.assignLegacy.isPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => estimateLog.submitAssignLegacy()}
              disabled={estimateLog.assignLegacy.isPending || legacyCheckpoint === null}
            >
              {estimateLog.assignLegacy.isPending ? 'Assigning…' : 'Assign to this project'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
