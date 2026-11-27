import { ChevronRight, Copy, Eye, GitFork, RotateCcw, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/ui/components/ui/button';
import { Skeleton } from '@/ui/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/ui/components/ui/table';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/ui/components/ui/tooltip';
import { useAgentSessionTree, type SessionTreeBranch } from '@/ui/hooks/useAgentSessionTree';
import { useSessionTreeRecordActions } from '@/ui/hooks/useSessionTreeRecordActions';
import { providerDisplayName } from '@/ui/components/project/wizard/providerDisplay';
import { getProviderIconAltText, getProviderIconDataUri } from '@/ui/lib/providers';
import type { ProfileProviderConfig } from '@/ui/lib/provider-configs';
import type { SavePointAvailability, SessionTreeNode } from '@/ui/lib/sessions';
import { cn } from '@/ui/lib/utils';
import {
  FORK_SESSION_TITLE,
  findSwitchConfig,
  forkSourceBlocked,
  noSwitchConfigReason,
  otherOwnerHint,
  ownedBy,
  ownerLabel,
  providerMismatchReason,
  runningElsewhere,
  runningOnLabel,
  sessionProviderMismatch,
  sessionTreeLabel,
  showSavePointControls,
  switchRestoreHint,
  type SessionTreeTableRow,
} from './SessionTree';
import { SavePointList, type SavePointListProps } from './SavePointList';
import { SessionNameEditor, formatRelativeTime } from './SessionNameEditor';
import { SessionTreeDeleteDialog } from './SessionTreeRecordDialogs';

export interface SessionsTableProps {
  /** The viewing agent. The table lists its family's sessions. */
  agentId: string;
  /** The viewing agent's name, for the provider mismatch reason. */
  agentName?: string | null;
  projectId: string;
  liveSessionId?: string;
  children?: ReactNode;
  onRead: (node: SessionTreeNode) => void;
  /** Gets the config the restore switches the agent to, when the row ran on another provider. */
  onRestore: (node: SessionTreeNode, switchConfig: ProfileProviderConfig | undefined) => void;
  onFork: (node: SessionTreeNode, availability: SavePointAvailability | undefined) => void;
  /** Gets the replacement ID as it was when the confirmation opened. */
  onRollback: SavePointListProps['onRollback'];
  /** True while a dialog or a save point list of the table is open. */
  onDialogOpenChange?: (open: boolean) => void;
  currentProviderName: string | null;
  /**
   * The configs of the viewing agent's profile. Undefined while they load or when the fetch
   * failed; a row from another provider then keeps Restore off.
   */
  providerConfigs?: readonly ProfileProviderConfig[];
  restoringSessionIds: Record<string, boolean>;
  forkingSessionIds: Record<string, boolean>;
  /** Sessions with a pending rollback: their rows and save point rows take no other action. */
  rollingBackSessionIds?: Record<string, boolean>;
}

function lastActive(node: SessionTreeNode): number {
  return Date.parse(node.lastActivityAt ?? node.endedAt ?? node.startedAt);
}

function newestFirst(a: SessionTreeBranch, b: SessionTreeBranch): number {
  return lastActive(b.node) - lastActive(a.node) || b.node.id.localeCompare(a.node.id);
}

/** Children that are rows: a save point is not a row, so its forks take its place. */
function visibleChildren(children: SessionTreeBranch[]): SessionTreeBranch[] {
  return children.flatMap((child) =>
    child.node.kind === 'save_point'
      ? visibleChildren(child.children)
      : [{ ...child, children: visibleChildren(child.children).sort(newestFirst) }],
  );
}

/**
 * The rows of the table: sessions and forks. The save points of a session are in its list.
 * A save point with no session in the tree (its session was deleted) stays a root row.
 */
export function visibleSessionTree(roots: SessionTreeBranch[]): SessionTreeBranch[] {
  return roots.map((root) => ({
    ...root,
    children: visibleChildren(root.children).sort(newestFirst),
  }));
}

function livePath(branches: SessionTreeBranch[], liveSessionId: string): string[] {
  for (const branch of branches) {
    if (branch.node.id === liveSessionId) return [liveSessionId];
    const path = livePath(branch.children, liveSessionId);
    if (path.length) return [branch.node.id, ...path];
  }
  return [];
}

function useSessionTreeRows(treeRoots: SessionTreeBranch[], liveSessionId?: string) {
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const roots = useMemo(() => visibleSessionTree(treeRoots), [treeRoots]);
  const defaultOpen = useMemo(
    () => new Set(liveSessionId ? livePath(roots, liveSessionId) : []),
    [roots, liveSessionId],
  );

  const rows: SessionTreeTableRow[] = [];
  function append(branches: SessionTreeBranch[], depth: number) {
    for (const { node, children, savePoints } of branches) {
      const branch =
        children.length > 0
          ? {
              expanded: overrides[node.id] ?? defaultOpen.has(node.id),
              toggle: () =>
                setOverrides((previous) => ({
                  ...previous,
                  [node.id]: !(previous[node.id] ?? defaultOpen.has(node.id)),
                })),
            }
          : null;
      rows.push({ node, depth, branch, savePoints });
      if (branch?.expanded) append(children, depth + 1);
    }
  }
  append(roots, 0);
  return rows;
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The provider the session launched with: its icon, else its name, else "Provider unknown". */
function LaunchProvider({ name }: { name: string | null }) {
  if (!name) {
    return <span className="shrink-0 text-[11px] text-muted-foreground">Provider unknown</span>;
  }
  const display = providerDisplayName(name);
  const icon = getProviderIconDataUri(name);
  if (!icon) {
    return (
      <span title={display} className="shrink-0 text-[11px] text-muted-foreground">
        {display}
      </span>
    );
  }
  return (
    <img
      src={icon}
      alt={getProviderIconAltText(name)}
      title={display}
      className="h-3.5 w-3.5 shrink-0"
    />
  );
}

function SessionName({
  row: { node, depth, branch },
  agentId,
  inBar,
  live,
  renamePending,
  onRename,
  savePointList,
}: {
  row: SessionTreeTableRow;
  agentId: string;
  inBar: boolean;
  live: boolean;
  renamePending: boolean;
  onRename: (node: SessionTreeNode, name: string) => void;
  savePointList: ReactNode;
}) {
  const label = sessionTreeLabel(node);
  // A renamed save point loses its default name, so the mark comes from its kind.
  const savePoint = node.kind === 'save_point';
  const indent = inBar ? `min(${depth * 16}px, 15%)` : depth * 16;
  const branchWidth = inBar ? 'w-4 sm:w-6' : 'w-6';

  return (
    <div className="flex min-w-0 items-center gap-1" style={{ paddingInlineStart: indent }}>
      {branch ? (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className={cn('h-6 shrink-0', branchWidth)}
          aria-label={`${branch.expanded ? 'Collapse' : 'Expand'} ${label}`}
          aria-expanded={branch.expanded}
          onClick={branch.toggle}
        >
          <ChevronRight
            aria-hidden="true"
            className={`h-3.5 w-3.5 ${branch.expanded ? 'rotate-90' : ''}`}
          />
        </Button>
      ) : (
        <span aria-hidden="true" className={cn('shrink-0', branchWidth)} />
      )}
      {savePoint && (
        <span
          role="img"
          aria-label="Save point"
          title="Save point"
          className="shrink-0 text-xs text-status-info"
        >
          ◆
        </span>
      )}
      {!savePoint && <LaunchProvider name={node.providerNameAtLaunch} />}
      <SessionNameEditor
        node={node}
        label={label}
        title={(inBar ? node.name : null) ?? node.providerSessionId ?? node.id}
        renamable={!node.beforeRollback}
        renamePending={renamePending}
        onRename={onRename}
      />
      {!ownedBy(node, agentId) && (
        <span
          title={`Owned by ${ownerLabel(node)}`}
          className="shrink-0 truncate rounded bg-muted px-1.5 text-[11px] text-muted-foreground"
        >
          {ownerLabel(node)}
        </span>
      )}
      {savePointList}
      {live && <span className="ml-1 shrink-0 text-xs font-medium text-status-ok">Live</span>}
      {runningElsewhere(node, agentId) && (
        <span className="ml-1 shrink-0 text-xs text-muted-foreground">{runningOnLabel(node)}</span>
      )}
    </div>
  );
}

/** Shows a disabled control's reason in a tooltip; a disabled button gets no pointer events. */
function WithReason({ reason, children }: { reason: string | null; children: ReactNode }) {
  if (!reason) return children;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="inline-flex">
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-52 text-center">{reason}</TooltipContent>
    </Tooltip>
  );
}

function RestoreButton({
  node,
  agentId,
  agentName,
  currentProviderName,
  providerConfigs,
  pending,
  forking,
  onRestore,
}: {
  node: SessionTreeNode;
  agentId: string;
  agentName: string | null | undefined;
  currentProviderName: string | null;
  providerConfigs: readonly ProfileProviderConfig[] | undefined;
  pending: boolean;
  forking: boolean;
  onRestore: SessionsTableProps['onRestore'];
}) {
  const switchConfig = sessionProviderMismatch(node, currentProviderName)
    ? findSwitchConfig(node, providerConfigs)
    : undefined;
  const disabledReason = restoreDisabledReason(
    node,
    agentId,
    agentName,
    currentProviderName,
    providerConfigs,
    switchConfig,
  );
  const hint = !disabledReason && switchConfig ? switchRestoreHint(node, switchConfig) : null;
  const button = (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="h-7 w-7"
      aria-label={disabledReason ?? (hint ? `Restore session. ${hint}` : 'Restore session')}
      disabled={Boolean(disabledReason) || forking}
      pending={pending}
      onClick={() => onRestore(node, switchConfig)}
    >
      {!pending && <RotateCcw aria-hidden="true" className="h-3.5 w-3.5" />}
    </Button>
  );
  return <WithReason reason={disabledReason ?? hint}>{button}</WithReason>;
}

/** Why Restore is off for a row, or null when it may run. */
function restoreDisabledReason(
  node: SessionTreeNode,
  agentId: string,
  agentName: string | null | undefined,
  currentProviderName: string | null,
  providerConfigs: readonly ProfileProviderConfig[] | undefined,
  switchConfig: ProfileProviderConfig | undefined,
): string | null {
  if (runningElsewhere(node, agentId)) return runningOnLabel(node);
  if (!node.providerSessionId) {
    return "Cannot restore — provider session id wasn't captured for this run.";
  }
  if (currentProviderName && sessionProviderMismatch(node, currentProviderName)) {
    if (!providerConfigs) return providerMismatchReason(node, currentProviderName, agentName);
    if (!switchConfig) return noSwitchConfigReason(node, currentProviderName, agentName);
  }
  return null;
}

/** The save point list of one row; it reports its open state with the session ID. */
function RowSavePointList({
  onSessionOpenChange,
  ...props
}: Omit<SavePointListProps, 'onOpenChange'> & {
  onSessionOpenChange: (sessionId: string, open: boolean) => void;
}) {
  const sessionId = props.session.id;
  const onOpenChange = useCallback(
    (open: boolean) => onSessionOpenChange(sessionId, open),
    [onSessionOpenChange, sessionId],
  );
  return <SavePointList {...props} onOpenChange={onOpenChange} />;
}

export function SessionsTable({
  agentId,
  agentName,
  projectId,
  liveSessionId,
  children,
  onRead,
  onRestore,
  onFork,
  onRollback,
  onDialogOpenChange,
  currentProviderName,
  providerConfigs,
  restoringSessionIds,
  forkingSessionIds,
  rollingBackSessionIds = {},
}: SessionsTableProps) {
  const inBar = Boolean(liveSessionId);
  // Other family members change the list too, so each opening fetches it again.
  const tree = useAgentSessionTree(agentId, projectId, liveSessionId);
  const records = useSessionTreeRecordActions(agentId, projectId);
  const rows = useSessionTreeRows(tree.roots, liveSessionId);
  const deleteOpen = records.deleteDialog.isOpen;
  const [openSavePointLists, setOpenSavePointLists] = useState<Record<string, boolean>>({});
  const dialogOpen = deleteOpen || Object.values(openSavePointLists).some(Boolean);
  const tableRoot = useRef<HTMLDivElement>(null);
  // The confirmation opens without a Radix trigger, so it returns focus here itself.
  const deleteTrigger = useRef<HTMLElement | null>(null);

  function returnFocusAfterDelete(event: Event) {
    event.preventDefault();
    const trigger = deleteTrigger.current;
    deleteTrigger.current = null;
    (trigger?.isConnected ? trigger : tableRoot.current)?.focus();
  }

  function confirmDelete() {
    // The deleted row leaves the table, so focus stays on the table instead.
    deleteTrigger.current = null;
    records.submitDelete();
  }

  const savePointListOpenChange = useCallback(
    (sessionId: string, open: boolean) =>
      setOpenSavePointLists((previous) =>
        previous[sessionId] === open ? previous : { ...previous, [sessionId]: open },
      ),
    [],
  );

  useEffect(() => {
    if (!dialogOpen || !onDialogOpenChange) return;
    onDialogOpenChange(true);
    return () => onDialogOpenChange(false);
  }, [dialogOpen, onDialogOpenChange]);

  if (tree.isLoading) {
    return (
      <>
        {children}
        <div role="status">
          <span className="sr-only">Loading sessions…</span>
          <div className="space-y-1.5">
            {[0, 1, 2].map((index) => (
              <Skeleton key={index} className="h-8 w-full" />
            ))}
          </div>
        </div>
      </>
    );
  }

  if (!tree.isError && tree.roots.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No previous sessions for this agent's family yet.
      </p>
    );
  }

  return (
    <div ref={tableRoot} tabIndex={-1} className="text-left">
      {children}
      {tree.roots.length > 0 && (
        <div className="max-h-[min(400px,60vh)] overflow-y-auto">
          <TooltipProvider>
            <Table className={inBar ? 'table-fixed' : undefined}>
              <TableHeader>
                <TableRow>
                  <TableHead
                    className={cn('h-8 whitespace-nowrap px-2 text-xs', inBar && 'w-20 sm:w-24')}
                  >
                    Last active
                  </TableHead>
                  <TableHead
                    className={cn('h-8 px-2 text-xs', inBar && 'hidden w-20 sm:table-cell')}
                  >
                    Size
                  </TableHead>
                  <TableHead className="h-8 px-2 text-xs">Session</TableHead>
                  <TableHead className={cn('h-8 px-2 text-right text-xs', inBar && 'w-24 sm:w-48')}>
                    Actions
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => {
                  const { node } = row;
                  const saved = node.kind === 'save_point';
                  const running = node.status === 'running';
                  const live = node.id === liveSessionId;
                  const rollingBack = Boolean(
                    rollingBackSessionIds[saved ? (node.parentSessionId ?? '') : node.id],
                  );
                  const canMutate = !running && !live;
                  const forking = Boolean(forkingSessionIds[node.id]);
                  const restoring = Boolean(restoringSessionIds[node.id]);
                  const elsewhere = runningElsewhere(node, agentId);
                  const ownerHint = otherOwnerHint(agentId, node);
                  // A save point never runs and is never live, so only session rows need canMutate.
                  const showFork = saved
                    ? showSavePointControls(tree.savePoints)
                    : canMutate && tree.savePoints?.available;

                  return (
                    <TableRow key={node.id}>
                      <TableCell className="whitespace-nowrap px-2 py-1.5 text-xs text-muted-foreground">
                        {formatRelativeTime(node.lastActivityAt ?? node.endedAt ?? node.startedAt)}
                      </TableCell>
                      <TableCell
                        className={cn(
                          'whitespace-nowrap px-2 py-1.5 text-xs text-muted-foreground',
                          inBar && 'hidden sm:table-cell',
                        )}
                      >
                        {formatBytes(node.sizeBytes)}
                      </TableCell>
                      <TableCell className={cn('min-w-0 px-2 py-1.5', !inBar && 'w-full')}>
                        <SessionName
                          row={row}
                          agentId={agentId}
                          inBar={inBar}
                          live={live}
                          renamePending={records.renamePending}
                          onRename={records.renameRecord}
                          savePointList={
                            !saved && (
                              <RowSavePointList
                                agentId={agentId}
                                projectId={projectId}
                                session={node}
                                savePoints={row.savePoints}
                                availability={tree.savePoints}
                                currentProviderName={currentProviderName}
                                liveSessionId={liveSessionId}
                                modal={inBar}
                                rollingBackIds={rollingBackSessionIds}
                                forkingIds={forkingSessionIds}
                                onRollback={onRollback}
                                onFork={(savePoint) => onFork(savePoint, tree.savePoints)}
                                onRead={onRead}
                                onSessionOpenChange={savePointListOpenChange}
                              />
                            )
                          }
                        />
                      </TableCell>
                      <TableCell className="px-2 py-1.5 text-right">
                        <div
                          className={cn(
                            'inline-flex items-center gap-0.5',
                            inBar && 'flex-wrap justify-end sm:flex-nowrap',
                          )}
                        >
                          {showFork && (
                            <WithReason reason={ownerHint}>
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                className="h-7 gap-1 px-1.5 text-xs"
                                pending={forking}
                                disabled={
                                  Boolean(ownerHint) ||
                                  !tree.savePoints?.available ||
                                  forkSourceBlocked(node, currentProviderName) ||
                                  restoring ||
                                  rollingBack
                                }
                                title={ownerHint ? undefined : FORK_SESSION_TITLE}
                                onClick={() => onFork(node, tree.savePoints)}
                              >
                                {!forking && <GitFork aria-hidden="true" className="h-3.5 w-3.5" />}
                                Fork
                              </Button>
                            </WithReason>
                          )}
                          {!saved && (
                            <>
                              {!live && (!running || elsewhere) && (
                                <RestoreButton
                                  node={node}
                                  agentId={agentId}
                                  agentName={agentName}
                                  currentProviderName={currentProviderName}
                                  providerConfigs={providerConfigs}
                                  pending={restoring}
                                  forking={forking || rollingBack}
                                  onRestore={onRestore}
                                />
                              )}
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7"
                                aria-label="Copy session ID"
                                title="Copy session ID"
                                onClick={() => void records.copyId(node)}
                              >
                                <Copy aria-hidden="true" className="h-3.5 w-3.5" />
                              </Button>
                            </>
                          )}
                          {!live && node.transcriptAvailable && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7"
                              aria-label="Read transcript"
                              title="Read transcript"
                              onClick={() => onRead(node)}
                            >
                              <Eye aria-hidden="true" className="h-3.5 w-3.5" />
                            </Button>
                          )}
                          {canMutate && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7"
                              aria-label="Delete session record"
                              title="Delete session record"
                              disabled={rollingBack}
                              onClick={(event) => {
                                deleteTrigger.current = event.currentTarget;
                                records.deleteDialog.open(node);
                              }}
                            >
                              <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TooltipProvider>
        </div>
      )}
      {tree.isError && (
        <p role="alert" className="flex items-center gap-2 text-xs text-destructive">
          Failed to load previous sessions.
          <Button type="button" size="sm" variant="ghost" onClick={() => void tree.refetch()}>
            Retry
          </Button>
        </p>
      )}
      {tree.hasNextPage && (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="mt-1 w-full"
          pending={tree.isFetching}
          onClick={() => void tree.fetchNextPage()}
        >
          Load more
        </Button>
      )}
      <SessionTreeDeleteDialog
        dialog={records.deleteDialog}
        onConfirm={confirmDelete}
        onCloseAutoFocus={returnFocusAfterDelete}
      />
    </div>
  );
}
