import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ExternalLink, RefreshCw } from 'lucide-react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type {
  ExternalTaskDetail,
  ExternalTaskLinkStateSummary,
} from '@/modules/external-integrations/models/external-provider.models';
import { ExternalBoardNav } from '@/ui/components/board/ExternalBoardNav';
import { ExternalTaskDetailDialog } from '@/ui/components/board/ExternalTaskDetailDialog';
import { ExternalTaskImportDialog } from '@/ui/components/board/ExternalTaskImportDialog';
import { ExternalTaskKanban } from '@/ui/components/board/ExternalTaskKanban';
import { ExternalTaskMoveChoiceDialog } from '@/ui/components/board/ExternalTaskMoveChoiceDialog';
import { Breadcrumbs } from '@/ui/components/shared/Breadcrumbs';
import { Alert, AlertDescription, AlertTitle } from '@/ui/components/ui/alert';
import { Button } from '@/ui/components/ui/button';
import { Skeleton } from '@/ui/components/ui/skeleton';
import { useExternalWorkArea } from '@/ui/hooks/board/useExternalWorkArea';
import { useExternalTaskLinks } from '@/ui/hooks/board/useExternalTaskLinks';
import { canColumnReceiveMove, useExternalTaskMove } from '@/ui/hooks/board/useExternalTaskMove';
import { useFetchFactory } from '@/ui/hooks/useFetchFactory';
import { useEpicTimeSummariesBatch } from '@/ui/hooks/useEpicTimeSummariesBatch';
import { useIntegrationAvailability } from '@/ui/hooks/useIntegrationAvailability';
import { useIntegrationConnections } from '@/ui/hooks/useIntegrationConnections';
import { useSelectedProject } from '@/ui/hooks/useProjectSelection';
import {
  buildExternalBoardMyWorkPath,
  externalBoardMyWorkPath,
  externalBoardProviderLabel,
  externalWorkAreaSourceUrl,
  isExternalBoardProvider,
  readExternalCompletedParam,
} from '@/ui/lib/external-board';
import type { ExternalKanbanColumn, ExternalKanbanTask } from '@/ui/lib/external-work-area';
import type {
  ExternalTaskMoveSource,
  ExternalTaskMoveTarget,
} from '@/ui/hooks/board/useExternalTaskMove';
import {
  getIntegrationConnectionEpoch,
  type IntegrationConnectionEpoch,
} from '@/ui/lib/integration-connections';
import {
  isSameIntegrationPresentationScope,
  type IntegrationPresentationScope,
} from '@/ui/lib/integration-project-scope';
import { fetchFreshExternalTaskDetail } from '@/ui/lib/external-task-detail-query';
import { getErrorMessage } from '@/ui/lib/toast-helpers';
import { UnknownExternalBoardProviderPage } from '@/ui/pages/board/UnknownExternalBoardProviderPage';

interface ValidExternalBoardKanbanPageProps {
  provider: 'clickup' | 'jira';
  workAreaId: string;
}

interface CurrentQuickImportScope {
  provider: 'clickup' | 'jira';
  projectId: string | null;
  connectionEpoch: IntegrationConnectionEpoch | null;
  enabled: boolean;
}

interface QuickImportOperation {
  readonly token: number;
  readonly presentationScope: IntegrationPresentationScope;
}

function isSameQuickImportScope(
  operation: QuickImportOperation,
  current: CurrentQuickImportScope,
): boolean {
  const currentPresentationScope =
    current.enabled && current.projectId !== null && current.connectionEpoch !== null
      ? {
          provider: current.provider,
          projectId: current.projectId,
          connectionEpoch: current.connectionEpoch,
          taskId: operation.presentationScope.taskId,
        }
      : null;
  return isSameIntegrationPresentationScope(operation.presentationScope, currentPresentationScope);
}

/**
 * Card and quick-action buttons remount on status-driven column moves, so
 * every focus decision must read a live element: a registry entry that is no
 * longer connected is as good as absent.
 */
function liveRegisteredElement(
  registry: Map<string, HTMLButtonElement>,
  taskId: string | null,
): HTMLButtonElement | null {
  if (taskId === null) return null;
  const element = registry.get(taskId);
  return element && element.isConnected ? element : null;
}

function ValidExternalBoardKanbanPage({ provider, workAreaId }: ValidExternalBoardKanbanPageProps) {
  const label = externalBoardProviderLabel(provider);
  const navigate = useNavigate();
  const apiFetch = useFetchFactory();
  const queryClient = useQueryClient();
  const { selectedProjectId: selectedProjectIdValue, selectedProject } = useSelectedProject();
  const selectedProjectId = selectedProjectIdValue ?? null;
  const availability = useIntegrationAvailability();
  const { connections } = useIntegrationConnections({
    projectId: selectedProjectId,
    enabled: availability.canUseIntegrations,
  });
  const connectionEpoch = getIntegrationConnectionEpoch(
    connections.find((connection) => connection.provider === provider),
  );
  const [searchParams] = useSearchParams();
  const includeCompleted = readExternalCompletedParam(searchParams);
  const previousProjectIdRef = useRef<string | null>(selectedProjectId);
  useEffect(() => {
    const previousProjectId = previousProjectIdRef.current;
    previousProjectIdRef.current = selectedProjectId;
    // A work-area URL addresses the connection that listed it; after a real
    // project switch it may point into another project's board, so the tab
    // restarts at the provider landing. Initial resolution (no prior project)
    // keeps deep links working.
    if (
      previousProjectId !== null &&
      selectedProjectId !== null &&
      previousProjectId !== selectedProjectId
    ) {
      navigate(externalBoardMyWorkPath(provider));
    }
  }, [navigate, provider, selectedProjectId]);
  const board = useExternalWorkArea(provider, workAreaId, {
    enabled: availability.canUseIntegrations,
    connectionEpoch,
    includeCompleted,
    projectId: selectedProjectId,
  });
  const visibleBoard = availability.canUseIntegrations ? board.data : undefined;
  const sourceUrl = visibleBoard
    ? externalWorkAreaSourceUrl(provider, visibleBoard.workArea)
    : null;
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [importDetail, setImportDetail] = useState<ExternalTaskDetail | null>(null);
  const [quickImportPendingTaskId, setQuickImportPendingTaskId] = useState<string | null>(null);
  const [quickImportError, setQuickImportError] = useState<string | null>(null);
  // Card buttons remount on status-driven column moves, so focus resolution
  // must read live element references, not captured ones.
  const cardFocusRegistry = useRef(new Map<string, HTMLButtonElement>()).current;
  const boardFocusFallbackRef = useRef<HTMLDivElement | null>(null);
  const detailImportFocusResolverRef = useRef<(() => HTMLElement | null) | null>(null);
  // Quick-action buttons remount with their cards, so their registry also
  // reads live elements only.
  const quickImportFocusRegistry = useRef(new Map<string, HTMLButtonElement>()).current;
  // Import's return-focus origin is fixed when Import opens — the detail
  // dialog's live resolver for a detail-origin import, a live quick-button
  // lookup for a card-origin one. Radix flips the controlled open state and
  // rerenders before onCloseAutoFocus runs, so the chosen origin must survive
  // that rerender and must never be re-derived while closing.
  const activeImportFocusResolverRef = useRef<(() => HTMLElement | null) | null>(null);
  // Radix clears the controlled open state before onCloseAutoFocus runs, so
  // focus resolution must not read selectedTaskId — retain the last opened ID.
  const lastOpenedTaskIdRef = useRef<string | null>(null);
  const quickImportTokenRef = useRef(0);
  // Token ownership prevents an older continuation from releasing a lookup
  // that a replacement presentation scope has already started.
  const quickImportOwnerRef = useRef<QuickImportOperation | null>(null);
  const quickImportFocusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const quickImportAliveRef = useRef(true);
  const quickImportScopeRef = useRef<CurrentQuickImportScope>({
    provider,
    projectId: selectedProjectId,
    connectionEpoch,
    enabled: availability.canUseIntegrations,
  });
  quickImportScopeRef.current = {
    provider,
    projectId: selectedProjectId,
    connectionEpoch,
    enabled: availability.canUseIntegrations,
  };
  const releaseQuickImport = useCallback((operation: QuickImportOperation): boolean => {
    if (quickImportOwnerRef.current?.token !== operation.token) return false;
    const canPublish =
      quickImportAliveRef.current &&
      quickImportTokenRef.current === operation.token &&
      isSameQuickImportScope(operation, quickImportScopeRef.current);
    quickImportOwnerRef.current = null;
    return canPublish;
  }, []);
  const isLatestQuickImportScope = useCallback((operation: QuickImportOperation): boolean => {
    return (
      quickImportAliveRef.current &&
      quickImportTokenRef.current === operation.token &&
      isSameQuickImportScope(operation, quickImportScopeRef.current)
    );
  }, []);

  useEffect(() => {
    quickImportAliveRef.current = true;
    return () => {
      quickImportAliveRef.current = false;
      quickImportTokenRef.current += 1;
      quickImportOwnerRef.current = null;
      if (quickImportFocusTimerRef.current !== null) {
        clearTimeout(quickImportFocusTimerRef.current);
        quickImportFocusTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const operation = quickImportOwnerRef.current;
    if (operation && isSameQuickImportScope(operation, quickImportScopeRef.current)) return;
    quickImportTokenRef.current += 1;
    quickImportOwnerRef.current = null;
    if (quickImportFocusTimerRef.current !== null) {
      clearTimeout(quickImportFocusTimerRef.current);
      quickImportFocusTimerRef.current = null;
    }
    activeImportFocusResolverRef.current = null;
    setQuickImportPendingTaskId(null);
    setQuickImportError(null);
    setImportDetail(null);
  }, [availability.canUseIntegrations, connectionEpoch, provider, selectedProjectId]);

  const handleImportFocusTargetReady = useCallback((resolve: (() => HTMLElement | null) | null) => {
    detailImportFocusResolverRef.current = resolve;
  }, []);
  const resolveImportFocusTarget = useCallback(
    () => activeImportFocusResolverRef.current?.() ?? null,
    [],
  );
  const resolveDialogFocusTarget = useCallback(
    (): HTMLElement | null =>
      liveRegisteredElement(cardFocusRegistry, lastOpenedTaskIdRef.current) ??
      boardFocusFallbackRef.current,
    [cardFocusRegistry],
  );
  const linkInputs = useMemo(
    () =>
      visibleBoard
        ? visibleBoard.columns.flatMap((column) =>
            column.tasks.map((task) => ({
              scopeKey: visibleBoard.workArea.scopeKey,
              taskId: task.remoteId,
            })),
          )
        : [],
    [visibleBoard],
  );
  const links = useExternalTaskLinks(provider, linkInputs, {
    enabled: availability.canUseIntegrations,
    connectionEpoch,
    includeLoggedMinutes: true,
    projectId: selectedProjectId,
  });
  // Placeholder (previous input set) and error-retained data keep the existing
  // link affordances, but the time metrics require a settled successful link
  // identity set — stale identities must never drive a numeric figure.
  const linksMetricsReady = links.data !== undefined && !links.isPlaceholderData && !links.isError;
  // Current time comes from one mixed-focal batch over the deduplicated
  // linked Epic IDs; a failed or unadmitted batch leaves the totals absent
  // and the cards suppress the unknown figure instead of guessing.
  const linkedEpicIds = useMemo(() => {
    if (!linksMetricsReady || links.data === undefined) return [];
    return [
      ...new Set(
        links.data.items
          .filter((item) => item.linked && item.epicId !== null)
          .map((item) => item.epicId as string),
      ),
    ];
  }, [links.data, linksMetricsReady]);
  const epicTime = useEpicTimeSummariesBatch(linkedEpicIds, {
    enabled: availability.canUseIntegrations,
  });
  // TanStack retains the last successful map after a failed background
  // refetch. The native Board keeps that retained decoration, but external
  // cards must not derive stale Current/New figures from it, so a failed
  // batch supplies no totals while an authoritative Logged value still
  // renders alone. An initially unresolved batch (no error) passes through
  // the same unknown-Current path.
  const epicTimeTotals = epicTime.query.isError ? undefined : epicTime.totals;
  const selectedTaskLink: ExternalTaskLinkStateSummary | null = links.isPlaceholderData
    ? null
    : (links.data?.items.find((link) => link.taskId === selectedTaskId) ?? null);

  const move = useExternalTaskMove(provider, {
    connectionEpoch,
    includeCompleted,
    projectId: selectedProjectId,
  });
  // Arrow movement needs columns in workflow order; the board builder is the
  // one place that knows which areas are only observed-status ordered.
  const keyboardMovesEnabled = visibleBoard?.workflowOrdered ?? true;
  const moves = useMemo(
    () => ({
      keyboardMovesEnabled,
      dragSource: move.dragSource,
      pendingTaskId: move.pendingTaskId,
      // A column receives a drop only when the resolver could reach it and it
      // is not the source column the card already sits in.
      isReceivingColumn: (column: ExternalKanbanColumn) =>
        canColumnReceiveMove(provider, column) && move.dragSource?.columnKey !== column.key,
      onCardDragStart: move.startDrag,
      onCardDragEnd: move.endDrag,
      onCardDrop: (source: ExternalTaskMoveSource, target: ExternalTaskMoveTarget) => {
        move.endDrag();
        move.requestMove({ source, target });
      },
      onKeyboardMove: (source: ExternalTaskMoveSource, target: ExternalTaskMoveTarget) => {
        move.requestMove({ source, target });
      },
      onKeyboardBoundary: move.notifyBoundary,
    }),
    [keyboardMovesEnabled, move, provider],
  );

  const settledMove = move.settledMove;
  useEffect(() => {
    if (!settledMove) return;
    // Let the optimistic snapshot re-render land first so a moved card has
    // remounted and re-registered before focus resolves.
    const timer = setTimeout(() => {
      // A removed card has no destination left, so focus goes straight to the
      // board fallback rather than to a stale registry entry.
      const card = settledMove.removed
        ? null
        : liveRegisteredElement(cardFocusRegistry, settledMove.taskId);
      (card ?? boardFocusFallbackRef.current)?.focus();
    }, 0);
    return () => clearTimeout(timer);
  }, [settledMove, cardFocusRegistry]);

  const resolveChoiceFocusTarget = useCallback(
    (): HTMLElement | null =>
      liveRegisteredElement(cardFocusRegistry, move.choice?.taskId ?? null) ??
      boardFocusFallbackRef.current,
    [cardFocusRegistry, move.choice],
  );

  const handleOpenTask = (task: ExternalKanbanTask) => {
    lastOpenedTaskIdRef.current = task.remoteId;
    setSelectedTaskId(task.remoteId);
  };
  const handleDetailOpenChange = (open: boolean) => {
    if (!open) setSelectedTaskId(null);
  };
  const handleRetry = () => {
    if (!availability.canUseIntegrations) return;
    void board.refetch();
  };
  const handleCreateDevChainTask = (detail: ExternalTaskDetail) => {
    // The task dialog stays open behind the nested Import dialog; its Create
    // button (or heading fallback) is the return-focus origin. The live
    // resolver is copied before Import opens so only this origin is used.
    activeImportFocusResolverRef.current = detailImportFocusResolverRef.current;
    setImportDetail(detail);
  };
  const handleQuickImport = (task: ExternalKanbanTask) => {
    if (
      quickImportOwnerRef.current !== null ||
      !availability.canUseIntegrations ||
      selectedProjectId === null ||
      connectionEpoch === null
    ) {
      return;
    }
    const operation: QuickImportOperation = {
      token: ++quickImportTokenRef.current,
      presentationScope: {
        provider,
        projectId: selectedProjectId,
        connectionEpoch,
        taskId: task.remoteId,
      },
    };
    quickImportOwnerRef.current = operation;
    if (!isLatestQuickImportScope(operation)) {
      releaseQuickImport(operation);
      return;
    }
    setQuickImportError(null);
    setQuickImportPendingTaskId(task.remoteId);
    void (async () => {
      let detail: ExternalTaskDetail;
      try {
        detail = await fetchFreshExternalTaskDetail(
          queryClient,
          apiFetch,
          operation.presentationScope.provider,
          operation.presentationScope.connectionEpoch,
          operation.presentationScope.projectId,
          operation.presentationScope.taskId,
        );
      } catch (error) {
        if (!releaseQuickImport(operation)) return;
        setQuickImportPendingTaskId(null);
        setQuickImportError(getErrorMessage(error, 'This task could not be loaded.'));
        // Let React apply the re-enabled button state before refocusing it.
        quickImportFocusTimerRef.current = setTimeout(() => {
          quickImportFocusTimerRef.current = null;
          if (!isLatestQuickImportScope(operation)) return;
          (
            liveRegisteredElement(quickImportFocusRegistry, operation.presentationScope.taskId) ??
            boardFocusFallbackRef.current
          )?.focus();
        }, 0);
        return;
      }
      if (!releaseQuickImport(operation)) return;
      if (detail.linkState.linked && detail.linkState.epicId) {
        setQuickImportPendingTaskId(null);
        navigate(`/epics/${detail.linkState.epicId}`);
        return;
      }
      activeImportFocusResolverRef.current = () =>
        liveRegisteredElement(quickImportFocusRegistry, operation.presentationScope.taskId) ??
        boardFocusFallbackRef.current;
      setQuickImportPendingTaskId(null);
      // Opening Import from a card must not also open the task detail.
      setImportDetail(detail);
    })();
  };
  const handleImportOpenChange = (open: boolean) => {
    if (!open) setImportDetail(null);
  };
  const handleImported = (epicId: string) => navigate(`/epics/${epicId}`);

  return (
    <div className="flex h-full flex-col">
      <ExternalBoardNav />
      <div className="flex min-h-0 flex-1 flex-col px-4 py-4">
        <Breadcrumbs
          className="mb-3"
          items={[
            { label: 'Board', href: '/board' },
            {
              label: `${label} My Work`,
              href: buildExternalBoardMyWorkPath(provider, includeCompleted),
            },
            ...(visibleBoard ? [{ label: visibleBoard.workArea.name }] : []),
          ]}
        />

        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-1">
              <h1 className="text-2xl font-semibold">
                {visibleBoard?.workArea.name ?? `${label} board`}
              </h1>
              {sourceUrl && visibleBoard ? (
                <Button asChild variant="ghost" size="icon">
                  <a
                    href={sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                    title={`Open ${visibleBoard.workArea.name} in ${label}`}
                    aria-label={`Open ${visibleBoard.workArea.name} in ${label}`}
                  >
                    <ExternalLink className="h-4 w-4" aria-hidden="true" />
                  </a>
                </Button>
              ) : null}
            </div>
            {visibleBoard?.workArea.description ? (
              <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
                {visibleBoard.workArea.description}
              </p>
            ) : null}
          </div>
          {visibleBoard ? (
            <Button type="button" variant="outline" size="sm" onClick={handleRetry}>
              <RefreshCw
                className={board.isFetching ? 'mr-2 h-4 w-4 animate-spin' : 'mr-2 h-4 w-4'}
                aria-hidden="true"
              />
              Refresh
            </Button>
          ) : null}
        </div>

        {quickImportError ? (
          <Alert variant="destructive" className="mb-4">
            <AlertTitle>Quick import unavailable</AlertTitle>
            <AlertDescription>{quickImportError}</AlertDescription>
          </Alert>
        ) : null}

        {!availability.canUseIntegrations ? (
          <Alert>
            <AlertTitle>External boards unavailable</AlertTitle>
            <AlertDescription>
              {availability.reason === 'resolving'
                ? 'Runtime access is still being resolved.'
                : 'External boards are available only from the main local runtime.'}
            </AlertDescription>
          </Alert>
        ) : board.isLoading ? (
          <div className="flex min-h-0 flex-1 gap-3" role="status" aria-label="Loading board">
            {[0, 1, 2].map((value) => (
              <Skeleton key={value} className="h-full min-w-[280px] flex-1" />
            ))}
          </div>
        ) : board.isError ? (
          <div className="space-y-4">
            <Alert variant="destructive">
              <AlertTitle>Work area unavailable</AlertTitle>
              <AlertDescription>
                {getErrorMessage(board.error, 'This work area could not be loaded.')}
              </AlertDescription>
            </Alert>
            <Button type="button" variant="outline" onClick={handleRetry}>
              Retry
            </Button>
          </div>
        ) : visibleBoard === null ? (
          <Alert>
            <AlertTitle>Work area not found</AlertTitle>
            <AlertDescription>
              This work area is no longer present in your assigned work. Return to {label} My Work
              and refresh the available boards.
            </AlertDescription>
          </Alert>
        ) : visibleBoard ? (
          <div className="min-h-0 flex-1">
            <ExternalTaskKanban
              columns={visibleBoard.columns}
              links={links.data?.items ?? []}
              linksFetching={links.isFetching}
              linksError={links.isError}
              timeMetricsReady={linksMetricsReady}
              epicTimeTotals={epicTimeTotals}
              onOpenTask={handleOpenTask}
              cardFocusRegistry={cardFocusRegistry}
              boardFocusFallbackRef={boardFocusFallbackRef}
              moves={moves}
              onQuickImport={handleQuickImport}
              quickImportPendingTaskId={quickImportPendingTaskId}
              quickActionFocusRegistry={quickImportFocusRegistry}
            />
          </div>
        ) : null}
      </div>

      <div aria-live="polite" role="status" className="sr-only">
        {move.announcement ?? ''}
      </div>

      {move.choice ? (
        <ExternalTaskMoveChoiceDialog
          choice={move.choice}
          onResolve={move.resolveChoice}
          onCancel={move.cancelChoice}
          pending={move.isChoiceResolving}
          returnFocusTo={resolveChoiceFocusTarget}
        />
      ) : null}

      <ExternalTaskDetailDialog
        provider={provider}
        projectId={selectedProjectId}
        taskId={selectedTaskId}
        open={selectedTaskId !== null}
        onOpenChange={handleDetailOpenChange}
        onCreateDevChainTask={handleCreateDevChainTask}
        enabled={availability.canUseIntegrations}
        connectionEpoch={connectionEpoch}
        returnFocusTo={resolveDialogFocusTarget}
        onImportFocusTargetReady={handleImportFocusTargetReady}
        projectLink={selectedTaskLink}
      />
      <ExternalTaskImportDialog
        provider={provider}
        detail={importDetail}
        open={importDetail !== null}
        enabled={availability.canUseIntegrations}
        connectionEpoch={connectionEpoch}
        projectId={selectedProjectId}
        projectName={selectedProject?.name ?? null}
        onOpenChange={handleImportOpenChange}
        onImported={handleImported}
        returnFocusTo={resolveImportFocusTarget}
      />
    </div>
  );
}

export function ExternalBoardKanbanPage() {
  const { provider: providerParam, workAreaId } = useParams<{
    provider: string;
    workAreaId: string;
  }>();

  if (!providerParam || !isExternalBoardProvider(providerParam)) {
    return <UnknownExternalBoardProviderPage />;
  }

  return <ValidExternalBoardKanbanPage provider={providerParam} workAreaId={workAreaId ?? ''} />;
}
