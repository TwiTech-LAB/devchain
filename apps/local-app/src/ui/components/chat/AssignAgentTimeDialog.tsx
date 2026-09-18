import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Loader2, Search } from 'lucide-react';
import { Button } from '@/ui/components/ui/button';
import { Input } from '@/ui/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/components/ui/dialog';
import { useDebouncedValue } from '@/ui/hooks/useEpicRelations';
import { useFetchFactory } from '@/ui/hooks/useFetchFactory';
import { formatEpicTimeMinutes } from '@/ui/lib/epic-time';
import { cn } from '@/ui/lib/utils';

const SEARCH_DEBOUNCE_MS = 300;
const RECENT_EPICS_LIMIT = 20;
const SEARCH_PLACEHOLDER = 'Search by title, DevChain ID, Jira key, or ClickUp ID.';
const AUTOMATIC_ATTRIBUTION_HINT =
  'DevChain assigns time automatically when it can. Use this dialog for time that remains unassigned.';

/** The exact frozen confirmation this dialog assigns: captured once at open. */
export interface AssignAgentTimeTarget {
  agentId: string;
  agentName: string;
  capturedAt: string;
  snapshotToken: string;
  durationMs: number;
  minutes: number;
  segmentCount: number;
  oldestActivityAt: string;
  newestActivityAt: string;
}

interface EpicRowDto {
  id: string;
  title: string;
  statusId: string;
}

interface StatusDto {
  id: string;
  label: string;
  color: string | null;
}

export interface AssignAgentTimeDialogProps {
  open: boolean;
  projectId: string | null;
  /** Frozen at open; later polls never replace it while the dialog is open. */
  target: AssignAgentTimeTarget | null;
  onCancel: () => void;
  /** Carries the frozen target and the chosen Epic for announcement + focus. */
  onSuccess: (target: AssignAgentTimeTarget, epic: { id: string; title: string }) => void;
  /** Discard path: the frozen balance was reset; the caller closes the dialog. */
  onReset: (target: AssignAgentTimeTarget) => void;
}

function shortDevChainId(id: string): string {
  return id.length <= 8 ? id : id.slice(0, 8);
}

export function AssignAgentTimeDialog({
  open,
  projectId,
  target,
  onCancel,
  onSuccess,
  onReset,
}: AssignAgentTimeDialogProps) {
  const apiFetch = useFetchFactory();
  const [search, setSearch] = useState('');
  const [selectedEpicId, setSelectedEpicId] = useState<string | null>(null);
  /** Which mutation owns the shared in-flight guard; null when idle. */
  const [pendingAction, setPendingAction] = useState<'assign' | 'reset' | null>(null);
  const [staleNotice, setStaleNotice] = useState(false);
  /** The 409 refresh found nothing left to assign; resubmission is blocked. */
  const [depleted, setDepleted] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // Frozen confirmation: initialized from the captured target, replaced only
  // by an explicit post-409 refresh — never by background polls.
  const [frozen, setFrozen] = useState<AssignAgentTimeTarget | null>(target);
  const frozenIdentity = target ? `${target.agentId}\u0000${target.capturedAt}` : null;
  const lastIdentityRef = useRef<string | null>(null);
  // One guard spans Log and Reset, including the awaited 409 snapshot
  // refresh, so the two writes can never overlap or double-submit.
  const submitting = pendingAction !== null;

  useEffect(() => {
    if (lastIdentityRef.current !== frozenIdentity) {
      lastIdentityRef.current = frozenIdentity;
      setFrozen(target);
      setSelectedEpicId(null);
      setStaleNotice(false);
      setDepleted(false);
      setErrorMessage(null);
      setPendingAction(null);
      setSearch('');
    }
  }, [frozenIdentity, target]);

  const debouncedSearch = useDebouncedValue(search, SEARCH_DEBOUNCE_MS);
  const trimmedSearch = open ? debouncedSearch.trim() : '';

  const epicsQuery = useQuery({
    queryKey: ['assign-agent-time-epics', projectId ?? '', trimmedSearch],
    queryFn: async ({ signal }): Promise<EpicRowDto[]> => {
      const params = new URLSearchParams({
        limit: String(RECENT_EPICS_LIMIT),
        type: 'active',
      });
      if (trimmedSearch) {
        params.set('q', trimmedSearch);
      }
      const response = await apiFetch(
        `/api/epics?projectId=${encodeURIComponent(projectId as string)}&${params.toString()}`,
        { signal },
      );
      if (!response.ok) throw new Error('Epics could not be loaded.');
      const payload = (await response.json()) as { items?: unknown };
      const rows: EpicRowDto[] = [];
      for (const entry of Array.isArray(payload.items) ? payload.items : []) {
        const record = entry as Record<string, unknown>;
        if (
          typeof record.id === 'string' &&
          typeof record.title === 'string' &&
          typeof record.statusId === 'string'
        ) {
          rows.push({
            id: record.id,
            title: record.title,
            statusId: record.statusId,
          });
        }
      }
      return rows;
    },
    enabled: open && projectId !== null,
  });

  const statusesQuery = useQuery({
    queryKey: ['assign-agent-time-statuses', projectId ?? ''],
    queryFn: async ({ signal }): Promise<StatusDto[]> => {
      const response = await apiFetch(
        `/api/statuses?projectId=${encodeURIComponent(projectId as string)}`,
        { signal },
      );
      if (!response.ok) throw new Error('Statuses could not be loaded.');
      const payload = (await response.json()) as { items?: unknown };
      const statuses: StatusDto[] = [];
      for (const entry of Array.isArray(payload.items) ? payload.items : []) {
        const record = entry as Record<string, unknown>;
        if (typeof record.id === 'string' && typeof record.label === 'string') {
          statuses.push({
            id: record.id,
            label: record.label,
            color: typeof record.color === 'string' ? record.color : null,
          });
        }
      }
      return statuses;
    },
    enabled: open && projectId !== null,
  });

  const statusesById = useMemo(() => {
    const map = new Map<string, StatusDto>();
    for (const status of statusesQuery.data ?? []) {
      map.set(status.id, status);
    }
    return map;
  }, [statusesQuery.data]);

  // The 409 refresh re-reads the buffer snapshot. A fresh item swaps the
  // frozen confirmation for the current one; an empty set, a missing agent,
  // or a null watermark means nothing is left to assign — the old snapshot
  // becomes unresubmittable and the choice resets. The write never retries.
  const refreshFrozenSnapshot = useCallback(async () => {
    if (!projectId || !frozen) {
      return;
    }
    setSelectedEpicId(null);
    setStaleNotice(true);
    try {
      const response = await apiFetch(
        `/api/agent-time-buffers?projectId=${encodeURIComponent(projectId)}`,
      );
      if (!response.ok) {
        return;
      }
      const payload = (await response.json()) as Record<string, unknown>;
      const capturedAt = typeof payload.capturedAt === 'string' ? payload.capturedAt : null;
      const items = Array.isArray(payload.items) ? payload.items : [];
      const fresh = items.find(
        (entry) =>
          entry !== null &&
          typeof entry === 'object' &&
          (entry as Record<string, unknown>).agentId === frozen.agentId,
      ) as Record<string, unknown> | undefined;
      if (!fresh || !capturedAt || typeof fresh.snapshotToken !== 'string') {
        setDepleted(true);
        return;
      }
      setFrozen({
        agentId: frozen.agentId,
        agentName: frozen.agentName,
        capturedAt,
        snapshotToken: fresh.snapshotToken as string,
        durationMs: typeof fresh.durationMs === 'number' ? fresh.durationMs : frozen.durationMs,
        minutes:
          typeof fresh.minutes === 'number'
            ? Math.max(0, Math.floor(fresh.minutes))
            : frozen.minutes,
        segmentCount:
          typeof fresh.segmentCount === 'number' ? fresh.segmentCount : frozen.segmentCount,
        oldestActivityAt:
          typeof fresh.oldestActivityAt === 'string'
            ? (fresh.oldestActivityAt as string)
            : frozen.oldestActivityAt,
        newestActivityAt:
          typeof fresh.newestActivityAt === 'string'
            ? (fresh.newestActivityAt as string)
            : frozen.newestActivityAt,
      });
    } catch {
      // A failed refresh keeps the previous frozen confirmation intact.
    }
  }, [apiFetch, frozen, projectId]);

  const submit = useCallback(async () => {
    if (!projectId || !frozen || !selectedEpicId || submitting || depleted) {
      return;
    }
    const selectedEpic = epicsQuery.data?.find((epic) => epic.id === selectedEpicId);
    setPendingAction('assign');
    setErrorMessage(null);
    try {
      const response = await apiFetch(
        `/api/agent-time-buffers/${encodeURIComponent(frozen.agentId)}/assign`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            projectId,
            targetEpicId: selectedEpicId,
            capturedAt: frozen.capturedAt,
            snapshotToken: frozen.snapshotToken,
          }),
        },
      );
      if (response.status === 409) {
        // The shared guard stays held until the explicit snapshot refresh
        // settles: neither Log nor Reset may fire while it is in flight.
        await refreshFrozenSnapshot();
        setPendingAction(null);
        return;
      }
      if (!response.ok) {
        setPendingAction(null);
        setErrorMessage('The assignment could not be completed. Try again.');
        return;
      }
      onSuccess(frozen, { id: selectedEpicId, title: selectedEpic?.title ?? selectedEpicId });
    } catch {
      setPendingAction(null);
      setErrorMessage('The assignment could not be completed. Try again.');
    }
  }, [
    apiFetch,
    depleted,
    epicsQuery.data,
    frozen,
    onSuccess,
    projectId,
    refreshFrozenSnapshot,
    selectedEpicId,
    submitting,
  ]);

  // Discard path: no Epic selection and no whole-minute gate — any positive
  // frozen balance, including one whose minutes round down to zero after a
  // refresh, is resettable. The same shared guard and 409 refresh-and-click
  // contract as the assignment apply; the write never retries itself.
  const reset = useCallback(async () => {
    if (!projectId || !frozen || submitting || depleted || frozen.durationMs <= 0) {
      return;
    }
    setPendingAction('reset');
    setErrorMessage(null);
    try {
      const response = await apiFetch(
        `/api/agent-time-buffers/${encodeURIComponent(frozen.agentId)}/reset`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            projectId,
            capturedAt: frozen.capturedAt,
            snapshotToken: frozen.snapshotToken,
          }),
        },
      );
      if (response.status === 409) {
        await refreshFrozenSnapshot();
        setPendingAction(null);
        return;
      }
      if (!response.ok) {
        setPendingAction(null);
        setErrorMessage('The reset could not be completed. Try again.');
        return;
      }
      onReset(frozen);
    } catch {
      setPendingAction(null);
      setErrorMessage('The reset could not be completed. Try again.');
    }
  }, [apiFetch, depleted, frozen, onReset, projectId, refreshFrozenSnapshot, submitting]);

  const durationLabel = frozen ? formatEpicTimeMinutes(frozen.minutes) : '';
  const confirmDisabled =
    submitting || depleted || !frozen || frozen.minutes < 1 || selectedEpicId === null;
  const resetDisabled = submitting || depleted || !frozen || frozen.durationMs <= 0;

  return (
    <Dialog
      open={open && frozen !== null}
      onOpenChange={(next) => {
        // A held mutation (or its awaited 409 refresh) owns the dialog:
        // Escape, the Close control, and outside dismissal are ignored until
        // it settles, so a close-and-reopen can never race the running write
        // or let its eventual callback land on a fresh confirmation.
        if (!next && submitting) {
          return;
        }
        if (!next) onCancel();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Log time to an Epic.</DialogTitle>
          <DialogDescription>
            {frozen ? `${durationLabel} from ${frozen.agentName}.` : null}
          </DialogDescription>
        </DialogHeader>

        <p className="text-xs text-muted-foreground">{AUTOMATIC_ATTRIBUTION_HINT}</p>

        {staleNotice && !depleted && (
          <p className="text-xs text-amber-600 dark:text-amber-400" role="status">
            Buffered time changed since this dialog opened. Review the updated amount and confirm
            again.
          </p>
        )}
        {depleted && (
          <p className="text-xs text-muted-foreground" role="status">
            That time was already assigned or reset elsewhere. Nothing is left to change for{' '}
            {frozen?.agentName}.
          </p>
        )}
        {errorMessage && <p className="text-xs text-destructive">{errorMessage}</p>}

        <div className="relative">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={SEARCH_PLACEHOLDER}
            className="h-8 pl-8 text-sm"
            aria-label="Search Epics"
            autoFocus
          />
        </div>

        <div
          role="listbox"
          aria-label="Epics"
          className="max-h-56 overflow-y-auto rounded-md border border-border"
        >
          {epicsQuery.isLoading ? (
            <div className="flex items-center justify-center gap-2 px-3 py-6 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              Loading Epics…
            </div>
          ) : epicsQuery.isError ? (
            <p className="px-3 py-6 text-center text-xs text-destructive">
              Epics could not be loaded.
            </p>
          ) : (epicsQuery.data ?? []).length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-muted-foreground">
              No matching Epics.
            </p>
          ) : (
            (epicsQuery.data ?? []).map((epic) => {
              const status = statusesById.get(epic.statusId);
              const selected = selectedEpicId === epic.id;
              return (
                <button
                  key={epic.id}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  disabled={submitting}
                  onClick={() => setSelectedEpicId(epic.id)}
                  className={cn(
                    'flex w-full items-center gap-2 border-b border-border/60 px-3 py-2 text-left text-sm transition-colors last:border-b-0 hover:bg-muted/50',
                    selected && 'bg-muted',
                  )}
                >
                  <span className="flex shrink-0 items-center gap-1.5">
                    <span
                      className="inline-block h-2 w-2 rounded-full border border-border/60"
                      style={status?.color ? { backgroundColor: status.color } : undefined}
                      aria-hidden="true"
                    />
                    <span className="max-w-[10rem] truncate text-xs text-muted-foreground">
                      {status?.label ?? 'Status'}
                    </span>
                  </span>
                  <span className="min-w-0 flex-1 truncate text-foreground">{epic.title}</span>
                  <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                    {shortDevChainId(epic.id)}
                  </span>
                </button>
              );
            })
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
          <Button type="button" variant="outline" onClick={reset} disabled={resetDisabled}>
            {submitting && pendingAction === 'reset' ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                Resetting…
              </>
            ) : (
              'Reset time'
            )}
          </Button>
          <Button type="button" onClick={submit} disabled={confirmDisabled}>
            {submitting && pendingAction === 'assign' ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                Logging…
              </>
            ) : (
              `Log ${durationLabel}.`
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
