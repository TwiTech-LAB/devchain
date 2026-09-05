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
import { applyExternalTaskStatusSnapshot } from '@/ui/lib/external-my-work-snapshot';
import { fetchFreshExternalTaskDetail } from '@/ui/lib/external-task-detail-query';
import type { IntegrationConnectionEpoch } from '@/ui/lib/integration-connections';
import {
  isSameIntegrationPresentationScope,
  type IntegrationPresentationScope,
  validIntegrationProjectId,
  withIntegrationProjectId,
} from '@/ui/lib/integration-project-scope';
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

interface CurrentMoveScope {
  provider: ExternalBoardProvider;
  projectId: string | null;
  connectionEpoch: IntegrationConnectionEpoch | null;
  includeCompleted: boolean;
}

interface MoveOperation {
  readonly token: number;
  readonly presentationScope: IntegrationPresentationScope;
  readonly includeCompleted: boolean;
  readonly landingKey: ReturnType<typeof externalMyWorkQueryKeys.landingSnapshot>;
  readonly landingScopeKey: ReturnType<typeof externalMyWorkQueryKeys.landing>;
  readonly detailKey: ReturnType<typeof externalMyWorkQueryKeys.taskDetail>;
}

interface ActiveMoveChoice {
  readonly operation: MoveOperation;
  readonly choice: ExternalTaskMoveChoice;
}

function isSameMoveScope(operation: MoveOperation, current: CurrentMoveScope): boolean {
  const currentPresentationScope =
    current.projectId !== null && current.connectionEpoch !== null
      ? {
          projectId: current.projectId,
          provider: current.provider,
          connectionEpoch: current.connectionEpoch,
          taskId: operation.presentationScope.taskId,
        }
      : null;
  return (
    operation.includeCompleted === current.includeCompleted &&
    isSameIntegrationPresentationScope(operation.presentationScope, currentPresentationScope)
  );
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

export { applyExternalTaskStatusSnapshot as applyOptimisticMoveSnapshot };

export interface UseExternalTaskMoveOptions {
  connectionEpoch: IntegrationConnectionEpoch | null;
  projectId: string | null;
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
  { connectionEpoch, projectId, includeCompleted }: UseExternalTaskMoveOptions,
) {
  const apiFetch = useFetchFactory();
  const queryClient = useQueryClient();
  const scopedProjectId = validIntegrationProjectId(projectId);
  const [dragSource, setDragSource] = useState<ExternalTaskMoveSource | null>(null);
  const [pendingTaskId, setPendingTaskId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState<string | null>(null);
  const [activeChoice, setActiveChoice] = useState<ActiveMoveChoice | null>(null);
  const [isChoiceResolving, setIsChoiceResolving] = useState(false);
  const [settledMove, setSettledMove] = useState<ExternalTaskMoveSettlement | null>(null);
  const settledNonceRef = useRef(0);
  const operationTokenRef = useRef(0);
  // Ownership is token-based because an older async continuation may settle
  // after a replacement scope has already acquired its own move latch.
  const operationOwnerRef = useRef<MoveOperation | null>(null);
  const choiceResolvingOwnerRef = useRef<number | null>(null);
  const scopeRef = useRef<CurrentMoveScope>({
    provider,
    projectId: scopedProjectId,
    connectionEpoch,
    includeCompleted,
  });
  scopeRef.current = {
    provider,
    projectId: scopedProjectId,
    connectionEpoch,
    includeCompleted,
  };
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      operationOwnerRef.current = null;
      choiceResolvingOwnerRef.current = null;
    };
  }, []);

  const isCurrentOperation = useCallback((operation: MoveOperation): boolean => {
    return (
      aliveRef.current &&
      operationOwnerRef.current?.token === operation.token &&
      isSameMoveScope(operation, scopeRef.current)
    );
  }, []);

  const releaseOperation = useCallback((operation: MoveOperation): boolean => {
    if (operationOwnerRef.current?.token !== operation.token) return false;
    const canPublish = aliveRef.current && isSameMoveScope(operation, scopeRef.current);
    operationOwnerRef.current = null;
    if (choiceResolvingOwnerRef.current === operation.token) {
      choiceResolvingOwnerRef.current = null;
    }
    return canPublish;
  }, []);

  useEffect(() => {
    const operation = operationOwnerRef.current;
    if (operation && isSameMoveScope(operation, scopeRef.current)) return;
    if (operationOwnerRef.current?.token === operation?.token) {
      operationOwnerRef.current = null;
    }
    if (choiceResolvingOwnerRef.current === operation?.token || operation === null) {
      choiceResolvingOwnerRef.current = null;
    }
    setDragSource(null);
    setPendingTaskId(null);
    setActiveChoice(null);
    setIsChoiceResolving(false);
    setAnnouncement(null);
    setSettledMove(null);
  }, [connectionEpoch, includeCompleted, provider, scopedProjectId]);

  const finalizeMove = useCallback(
    async (operation: MoveOperation, move: FinalizeMoveRequest): Promise<void> => {
      if (!isCurrentOperation(operation)) return;
      const savedSnapshot = queryClient.getQueryData<SupportedSnapshot>(operation.landingKey);
      queryClient.setQueryData<SupportedSnapshot>(operation.landingKey, (current) =>
        current
          ? applyExternalTaskStatusSnapshot(
              current,
              move.taskId,
              move.option,
              !operation.includeCompleted,
            )
          : current,
      );
      try {
        await fetchJsonOrThrow<ExternalTaskActionResult>(
          withIntegrationProjectId(
            `/api/integrations/my-work/${operation.presentationScope.provider}/tasks/${encodeURIComponent(move.taskId)}/status`,
            operation.presentationScope.projectId,
          ),
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
          queryKey: operation.landingScopeKey,
          refetchType: 'none',
        });
        await queryClient.invalidateQueries({
          queryKey: operation.detailKey,
          exact: true,
        });
        if (isCurrentOperation(operation)) {
          setAnnouncement(MOVE_SUCCESS_ANNOUNCEMENT);
          settledNonceRef.current += 1;
          setSettledMove({
            taskId: move.taskId,
            removed: !operation.includeCompleted && move.option.category === 'completed',
            nonce: settledNonceRef.current,
          });
        }
      } catch {
        if (savedSnapshot !== undefined) {
          queryClient.setQueryData(operation.landingKey, savedSnapshot);
        }
        // The write failed against current provider data: restore the exact
        // prior snapshot, then reconcile authoritatively from the provider.
        await queryClient.invalidateQueries({
          queryKey: operation.landingScopeKey,
        });
        await queryClient.invalidateQueries({
          queryKey: operation.detailKey,
          exact: true,
        });
        if (isCurrentOperation(operation)) setAnnouncement(MOVE_FAILED_ANNOUNCEMENT);
      }
    },
    [apiFetch, isCurrentOperation, queryClient],
  );

  const executeMove = useCallback(
    async (
      operation: MoveOperation,
      { source, target }: ExternalTaskMoveRequest,
    ): Promise<void> => {
      if (!isCurrentOperation(operation)) {
        releaseOperation(operation);
        return;
      }
      if (!target || target.synthetic) {
        if (releaseOperation(operation)) setAnnouncement(MOVE_UNAVAILABLE_ANNOUNCEMENT);
        return;
      }
      if (target.columnKey === source.columnKey) {
        releaseOperation(operation);
        return;
      }
      setPendingTaskId(source.taskId);
      setAnnouncement(MOVE_PENDING_ANNOUNCEMENT);
      let detail: ExternalTaskDetail;
      try {
        detail = await fetchFreshExternalTaskDetail(
          queryClient,
          apiFetch,
          operation.presentationScope.provider,
          operation.presentationScope.connectionEpoch,
          operation.presentationScope.projectId,
          source.taskId,
        );
      } catch {
        if (releaseOperation(operation)) {
          setPendingTaskId(null);
          setAnnouncement(MOVE_FAILED_ANNOUNCEMENT);
        }
        return;
      }
      if (!isCurrentOperation(operation)) {
        releaseOperation(operation);
        return;
      }
      const changeSupported = detail.actions.some(
        (action) => action.action === 'change_status' && action.supported,
      );
      const options = changeSupported
        ? resolveExternalMoveOptions(
            operation.presentationScope.provider,
            detail.allowedStatuses,
            target,
          )
        : [];
      if (options.length === 0) {
        if (releaseOperation(operation)) {
          setPendingTaskId(null);
          setAnnouncement(MOVE_UNAVAILABLE_ANNOUNCEMENT);
        }
        return;
      }
      if (options.length > 1) {
        setActiveChoice({
          operation,
          choice: {
            taskId: source.taskId,
            taskTitle: detail.title,
            target,
            options,
          },
        });
        setAnnouncement(MOVE_CHOICE_ANNOUNCEMENT);
        return;
      }
      await finalizeMove(operation, { taskId: source.taskId, option: options[0]! });
      if (releaseOperation(operation)) setPendingTaskId(null);
    },
    [apiFetch, finalizeMove, isCurrentOperation, queryClient, releaseOperation],
  );

  const requestMove = useCallback(
    (request: ExternalTaskMoveRequest): void => {
      if (
        operationOwnerRef.current !== null ||
        connectionEpoch === null ||
        scopedProjectId === null
      ) {
        if (connectionEpoch === null || scopedProjectId === null) {
          setAnnouncement(MOVE_UNAVAILABLE_ANNOUNCEMENT);
        }
        return;
      }
      const operation: MoveOperation = {
        token: ++operationTokenRef.current,
        presentationScope: {
          provider,
          projectId: scopedProjectId,
          connectionEpoch,
          taskId: request.source.taskId,
        },
        includeCompleted,
        landingKey: externalMyWorkQueryKeys.landingSnapshot(
          provider,
          connectionEpoch,
          includeCompleted,
        ),
        landingScopeKey: externalMyWorkQueryKeys.landing(provider, connectionEpoch),
        detailKey: externalMyWorkQueryKeys.taskDetail(
          provider,
          connectionEpoch,
          request.source.taskId,
        ),
      };
      operationOwnerRef.current = operation;
      void executeMove(operation, request);
    },
    [connectionEpoch, executeMove, includeCompleted, provider, scopedProjectId],
  );

  const resolveChoice = useCallback(
    (option: ExternalTaskStatusOption): void => {
      if (
        !activeChoice ||
        !isCurrentOperation(activeChoice.operation) ||
        choiceResolvingOwnerRef.current !== null
      ) {
        return;
      }
      const selected = activeChoice.choice.options.find(
        (candidate) => candidate.actionValue === option.actionValue,
      );
      if (!selected) return;
      choiceResolvingOwnerRef.current = activeChoice.operation.token;
      setIsChoiceResolving(true);
      setAnnouncement(MOVE_PENDING_ANNOUNCEMENT);
      void (async () => {
        try {
          await finalizeMove(activeChoice.operation, {
            taskId: activeChoice.choice.taskId,
            option: selected,
          });
        } finally {
          if (choiceResolvingOwnerRef.current === activeChoice.operation.token) {
            choiceResolvingOwnerRef.current = null;
          }
          if (releaseOperation(activeChoice.operation)) {
            setIsChoiceResolving(false);
            setActiveChoice(null);
            setPendingTaskId(null);
          }
        }
      })();
    },
    [activeChoice, finalizeMove, isCurrentOperation, releaseOperation],
  );

  const cancelChoice = useCallback((): void => {
    if (
      !activeChoice ||
      choiceResolvingOwnerRef.current !== null ||
      !isCurrentOperation(activeChoice.operation)
    ) {
      return;
    }
    if (releaseOperation(activeChoice.operation)) {
      setActiveChoice(null);
      setPendingTaskId(null);
      setAnnouncement(MOVE_CANCELED_ANNOUNCEMENT);
    }
  }, [activeChoice, isCurrentOperation, releaseOperation]);

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
    choice: activeChoice?.choice ?? null,
    isChoiceResolving,
    settledMove,
    requestMove,
    resolveChoice,
    cancelChoice,
    notifyBoundary,
  };
}
