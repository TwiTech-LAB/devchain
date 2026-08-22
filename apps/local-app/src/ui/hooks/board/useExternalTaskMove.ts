import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type {
  ExternalMyWorkResult,
  ExternalTaskActionResult,
  ExternalTaskDetail,
  ExternalTaskStatusOption,
} from '@/modules/external-integrations/models/external-provider.models';
import { useFetchFactory } from '@/ui/hooks/useFetchFactory';
import type { ExternalBoardProvider } from '@/ui/lib/external-board';
import { externalMyWorkQueryKeys } from '@/ui/lib/external-my-work';
import { fetchFreshExternalTaskDetail } from '@/ui/lib/external-task-detail-query';
import type { IntegrationConnectionEpoch } from '@/ui/lib/integration-connections';
import { fetchJsonOrThrow } from '@/ui/lib/sessions';

type SupportedSnapshot = Extract<ExternalMyWorkResult, { supported: true }>;

/** The card being dragged: column key plus stable remote task ID. */
export interface ExternalTaskMoveSource {
  taskId: string;
  columnKey: string;
}

/**
 * A drop or keyboard destination described by the board. `remoteStatusIds`
 * carries the workflow-column status IDs; empty plus a null `remoteId` means
 * an unmapped or observed-without-IDs column, which can never receive a move.
 */
export interface ExternalTaskMoveTarget {
  columnKey: string;
  name: string;
  remoteId: string | null;
  remoteStatusIds: string[];
  synthetic: boolean;
}

export interface ExternalTaskMoveRequest {
  source: ExternalTaskMoveSource;
  target: ExternalTaskMoveTarget | null;
}

/**
 * Snapshotted choice context for destinations reachable through several
 * transitions. Captured before drag-end cleanup so the dialog survives the
 * drag state being cleared.
 */
export interface ExternalTaskMoveChoice {
  taskId: string;
  taskTitle: string;
  target: ExternalTaskMoveTarget;
  options: ExternalTaskStatusOption[];
}

interface FinalizeMoveRequest {
  taskId: string;
  option: ExternalTaskStatusOption;
}

/**
 * One successful move settlement: `removed` is true when an active-only
 * scope dropped a completed-destination card, so focus must land on the
 * Board fallback instead of the (now absent) card. `nonce` increments per
 * settlement so repeated successes retrigger consumer effects.
 */
export interface ExternalTaskMoveSettlement {
  taskId: string;
  removed: boolean;
  nonce: number;
}

export const MOVE_PENDING_ANNOUNCEMENT = 'Moving task.';
export const MOVE_SUCCESS_ANNOUNCEMENT = 'Task moved.';
export const MOVE_FAILED_ANNOUNCEMENT = 'The move failed. The board was restored.';
export const MOVE_CHOICE_ANNOUNCEMENT = 'Choose how to move this task.';
export const MOVE_CANCELED_ANNOUNCEMENT = 'Move canceled.';
export const MOVE_UNAVAILABLE_ANNOUNCEMENT = 'This column cannot receive the task.';
export const MOVE_BOUNDARY_ANNOUNCEMENT = 'No column can receive the task in that direction.';

function optionStatusIds(option: ExternalTaskStatusOption): string[] {
  return option.remoteStatusIds ?? (option.remoteId !== null ? [option.remoteId] : []);
}

/**
 * Intersects option destination status IDs with the target column's status
 * IDs. Jira resolves by ID only; ClickUp falls back to an exact status-name
 * match when either side carries no status ID. Synthetic and unmapped targets
 * always resolve to zero options, so they never produce a write.
 */
export function resolveExternalMoveOptions(
  provider: ExternalBoardProvider,
  options: ExternalTaskStatusOption[],
  target: ExternalTaskMoveTarget,
): ExternalTaskStatusOption[] {
  if (target.synthetic) return [];
  const targetIds = new Set(target.remoteStatusIds);
  if (target.remoteId !== null) targetIds.add(target.remoteId);
  const byId = options.filter((option) => optionStatusIds(option).some((id) => targetIds.has(id)));
  if (byId.length > 0) return byId;
  if (provider === 'clickup') {
    return options.filter((option) => option.name === target.name);
  }
  return [];
}

/**
 * Cheap pre-check of the same eligibility rule `resolveExternalMoveOptions`
 * applies: a column can receive a move only when it is real and carries status
 * identity. ClickUp is exempt because it can still resolve by exact status
 * name. Kept beside the resolver so drop affordances can never advertise a
 * destination the resolver then refuses.
 */
export function canColumnReceiveMove(
  provider: ExternalBoardProvider,
  column: { remoteId: string | null; remoteStatusIds: string[]; synthetic: boolean },
): boolean {
  if (column.synthetic) return false;
  if (provider === 'clickup') return true;
  return column.remoteId !== null || column.remoteStatusIds.length > 0;
}

/**
 * Applies one optimistic move to a landing snapshot. Every task entry with
 * the moved remote ID is patched. When an active-only snapshot receives a
 * completed-destination option, matching entries are removed instead and each
 * affected work-area count is decremented once, clamped at zero. Entries and
 * work areas untouched by the move keep their original object identity.
 */
export function applyOptimisticMoveSnapshot(
  snapshot: SupportedSnapshot,
  taskId: string,
  option: ExternalTaskStatusOption,
  activeOnlyScope: boolean,
): SupportedSnapshot {
  const destination = {
    remoteId: option.remoteId,
    name: option.name,
    category: option.category,
  };
  if (!activeOnlyScope || option.category !== 'completed') {
    return {
      ...snapshot,
      tasks: snapshot.tasks.map((entry) =>
        entry.task.remoteId === taskId
          ? { ...entry, task: { ...entry.task, status: { ...destination } } }
          : entry,
      ),
    };
  }
  const removedByWorkArea = new Map<string, number>();
  const workAreaKey = (scopeKey: string, remoteId: string) => `${scopeKey}\u0000${remoteId}`;
  const tasks = snapshot.tasks.filter((entry) => {
    if (entry.task.remoteId !== taskId) return true;
    const key = workAreaKey(entry.workArea.scopeKey, entry.workArea.remoteId);
    removedByWorkArea.set(key, (removedByWorkArea.get(key) ?? 0) + 1);
    return false;
  });
  const workAreas = snapshot.workAreas.map((workArea) => {
    const removed = removedByWorkArea.get(workAreaKey(workArea.scopeKey, workArea.remoteId));
    if (!removed) return workArea;
    return { ...workArea, assignedTaskCount: Math.max(0, workArea.assignedTaskCount - removed) };
  });
  return { ...snapshot, tasks, workAreas };
}

export interface UseExternalTaskMoveOptions {
  connectionEpoch: IntegrationConnectionEpoch | null;
  includeCompleted: boolean;
}

/**
 * Owns pointer/keyboard task-movement state: drag identity, one pending
 * move, transition-choice context, and live announcements. Every requested
 * move reloads current task detail (Jira transitions change after each
 * move), resolves the destination against the detail's status options, then
 * applies one optimistic landing-snapshot update and a single status write.
 */
export function useExternalTaskMove(
  provider: ExternalBoardProvider,
  { connectionEpoch, includeCompleted }: UseExternalTaskMoveOptions,
) {
  const apiFetch = useFetchFactory();
  const queryClient = useQueryClient();
  const [dragSource, setDragSource] = useState<ExternalTaskMoveSource | null>(null);
  const [pendingTaskId, setPendingTaskId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState<string | null>(null);
  const [choice, setChoice] = useState<ExternalTaskMoveChoice | null>(null);
  const [isChoiceResolving, setIsChoiceResolving] = useState(false);
  const [settledMove, setSettledMove] = useState<ExternalTaskMoveSettlement | null>(null);
  const settledNonceRef = useRef(0);
  // Synchronous latch acquired before the detail fetch or status write so a
  // same-tick repeated move request cannot issue a second remote write.
  const moveInFlightRef = useRef(false);
  // The move latch remains held while the user chooses a Jira transition.
  // This second synchronous latch protects the choice itself from two
  // same-tick activations before React can render the pending state.
  const choiceResolvingRef = useRef(false);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      moveInFlightRef.current = false;
      choiceResolvingRef.current = false;
    };
  }, []);

  // Cache identity is epoch-scoped, so a new epoch invalidates every captured
  // move context. Releasing state here does not protect an in-flight remote
  // request; the backend resolves the current connection when it executes.
  useEffect(() => {
    moveInFlightRef.current = false;
    choiceResolvingRef.current = false;
    setDragSource(null);
    setPendingTaskId(null);
    setChoice(null);
    setIsChoiceResolving(false);
    setAnnouncement(null);
    setSettledMove(null);
  }, [connectionEpoch]);

  const finalizeMove = useCallback(
    async (move: FinalizeMoveRequest): Promise<void> => {
      const landingKey = externalMyWorkQueryKeys.landingSnapshot(
        provider,
        connectionEpoch,
        includeCompleted,
      );
      const savedSnapshot = queryClient.getQueryData<SupportedSnapshot>(landingKey);
      queryClient.setQueryData<SupportedSnapshot>(landingKey, (current) =>
        current
          ? applyOptimisticMoveSnapshot(current, move.taskId, move.option, !includeCompleted)
          : current,
      );
      try {
        await fetchJsonOrThrow<ExternalTaskActionResult>(
          `/api/integrations/my-work/${provider}/tasks/${encodeURIComponent(move.taskId)}/status`,
          {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: move.option.actionValue }),
          },
          'The move could not be completed.',
          '',
          apiFetch,
        );
        // Jira board search is eventually consistent: keep the optimistic
        // snapshot and only mark both landing scopes stale, so an immediate
        // refetch cannot move the card back to its previous column.
        await queryClient.invalidateQueries({
          queryKey: externalMyWorkQueryKeys.landing(provider, connectionEpoch),
          refetchType: 'none',
        });
        await queryClient.invalidateQueries({
          queryKey: externalMyWorkQueryKeys.taskDetail(provider, connectionEpoch, move.taskId),
          exact: true,
        });
        if (aliveRef.current) {
          setAnnouncement(MOVE_SUCCESS_ANNOUNCEMENT);
          settledNonceRef.current += 1;
          setSettledMove({
            taskId: move.taskId,
            removed: !includeCompleted && move.option.category === 'completed',
            nonce: settledNonceRef.current,
          });
        }
      } catch {
        if (savedSnapshot !== undefined) {
          queryClient.setQueryData(landingKey, savedSnapshot);
        }
        // The write failed against current provider data: restore the exact
        // prior snapshot, then reconcile authoritatively from the provider.
        await queryClient.invalidateQueries({
          queryKey: externalMyWorkQueryKeys.landing(provider, connectionEpoch),
        });
        await queryClient.invalidateQueries({
          queryKey: externalMyWorkQueryKeys.taskDetail(provider, connectionEpoch, move.taskId),
          exact: true,
        });
        if (aliveRef.current) setAnnouncement(MOVE_FAILED_ANNOUNCEMENT);
      }
    },
    [apiFetch, connectionEpoch, includeCompleted, provider, queryClient],
  );

  const executeMove = useCallback(
    async ({ source, target }: ExternalTaskMoveRequest): Promise<void> => {
      const release = () => {
        moveInFlightRef.current = false;
      };
      if (!target || target.synthetic) {
        release();
        setAnnouncement(MOVE_UNAVAILABLE_ANNOUNCEMENT);
        return;
      }
      if (target.columnKey === source.columnKey) {
        release();
        return;
      }
      setPendingTaskId(source.taskId);
      setAnnouncement(MOVE_PENDING_ANNOUNCEMENT);
      let detail: ExternalTaskDetail;
      try {
        detail = await fetchFreshExternalTaskDetail(
          queryClient,
          apiFetch,
          provider,
          connectionEpoch,
          source.taskId,
        );
      } catch {
        release();
        setPendingTaskId(null);
        setAnnouncement(MOVE_FAILED_ANNOUNCEMENT);
        return;
      }
      if (!aliveRef.current) {
        release();
        return;
      }
      const changeSupported = detail.actions.some(
        (action) => action.action === 'change_status' && action.supported,
      );
      const options = changeSupported
        ? resolveExternalMoveOptions(provider, detail.allowedStatuses, target)
        : [];
      if (options.length === 0) {
        release();
        setPendingTaskId(null);
        setAnnouncement(MOVE_UNAVAILABLE_ANNOUNCEMENT);
        return;
      }
      if (options.length > 1) {
        setChoice({
          taskId: source.taskId,
          taskTitle: detail.title,
          target,
          options,
        });
        setAnnouncement(MOVE_CHOICE_ANNOUNCEMENT);
        return;
      }
      await finalizeMove({ taskId: source.taskId, option: options[0]! });
      release();
      if (aliveRef.current) setPendingTaskId(null);
    },
    [apiFetch, connectionEpoch, finalizeMove, provider, queryClient],
  );

  const requestMove = useCallback(
    (request: ExternalTaskMoveRequest): void => {
      if (moveInFlightRef.current) return;
      moveInFlightRef.current = true;
      void executeMove(request);
    },
    [executeMove],
  );

  const resolveChoice = useCallback(
    (option: ExternalTaskStatusOption): void => {
      const current = choice;
      if (!current || !moveInFlightRef.current || choiceResolvingRef.current) return;
      choiceResolvingRef.current = true;
      setIsChoiceResolving(true);
      setAnnouncement(MOVE_PENDING_ANNOUNCEMENT);
      void (async () => {
        try {
          await finalizeMove({ taskId: current.taskId, option });
        } finally {
          choiceResolvingRef.current = false;
          moveInFlightRef.current = false;
          if (!aliveRef.current) return;
          setIsChoiceResolving(false);
          setChoice(null);
          setPendingTaskId(null);
        }
      })();
    },
    [choice, finalizeMove],
  );

  const cancelChoice = useCallback((): void => {
    if (choiceResolvingRef.current) return;
    moveInFlightRef.current = false;
    setChoice(null);
    setPendingTaskId(null);
    setAnnouncement(MOVE_CANCELED_ANNOUNCEMENT);
  }, []);

  const startDrag = useCallback((source: ExternalTaskMoveSource): void => {
    setDragSource(source);
  }, []);

  const endDrag = useCallback((): void => {
    setDragSource(null);
  }, []);

  const notifyBoundary = useCallback((): void => {
    setAnnouncement(MOVE_BOUNDARY_ANNOUNCEMENT);
  }, []);

  return {
    dragSource,
    startDrag,
    endDrag,
    pendingTaskId,
    isMovePending: pendingTaskId !== null,
    announcement,
    choice,
    isChoiceResolving,
    settledMove,
    requestMove,
    resolveChoice,
    cancelChoice,
    notifyBoundary,
  };
}
