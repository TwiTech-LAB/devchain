import { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { ConfirmDialog } from '@/ui/components/shared/ConfirmDialog';
import { Button } from '@/ui/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/ui/components/ui/dialog';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/ui/components/ui/tooltip';
import { useAgentSessionTree } from '@/ui/hooks/useAgentSessionTree';
import type { UseChatSessionControlsResult } from '@/ui/hooks/useChatSessionControls';
import { useConfirmDialog } from '@/ui/hooks/useFormDialog';
import type { ProfileProviderConfig } from '@/ui/lib/provider-configs';
import type { AgentPresence, SessionTreeNode } from '@/ui/lib/sessions';
import { SavePointList, type SavePointListProps } from './SavePointList';
import { SESSION_NAME_INPUT_LABEL } from './SessionNameEditor';
import { SessionsTable } from './SessionsTable';
import { sessionTreeLabel, showSavePointControls, switchRestoreWarning } from './SessionTree';

interface SessionSwitcherProps {
  agentId: string;
  /** The agent's name, for the provider mismatch reason. */
  agentName?: string | null;
  projectId: string;
  liveSessionId: string;
  liveSessionName: string | null;
  activityState?: AgentPresence['activityState'];
  currentProviderName?: string | null;
  /** The agent's profile configs; undefined while they load or when the fetch failed. */
  providerConfigs?: readonly ProfileProviderConfig[];
  controls: Pick<
    UseChatSessionControlsResult,
    | 'handleSavePoint'
    | 'handleStartFromSavePoint'
    | 'handleRestoreSession'
    | 'handleRollbackSession'
    | 'savingSessionIds'
    | 'forkingSessionIds'
    | 'restoringSessionIds'
    | 'rollingBackSessionIds'
  >;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Gets the Sessions trigger, so the page can reopen Sessions when the transcript closes. */
  onRead: (id: string, sessionsTrigger: HTMLButtonElement | null) => void;
  onDialogOpenChange: (open: boolean) => void;
}

interface Replacement {
  action: 'start' | 'restore';
  target: SessionTreeNode;
  liveSessionId: string;
  liveLabel: string;
  /** The config a restore switches the agent to, as it was when the dialog opened. */
  switchConfig?: ProfileProviderConfig;
}

function SavePointButton({
  disabledReason,
  saving,
  onSave,
}: {
  disabledReason: string | undefined;
  saving: boolean;
  onSave: () => void;
}) {
  const button = (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-6 shrink-0 gap-1.5 px-2 py-0 text-xs"
      disabled={saving || Boolean(disabledReason)}
      pending={saving}
      onClick={onSave}
    >
      {!saving && <span aria-hidden="true">◆</span>}
      Save point
    </Button>
  );
  if (!disabledReason) return button;
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span tabIndex={0} className="inline-flex shrink-0">
            {button}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top">{disabledReason}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export function SessionSwitcher({
  agentId,
  agentName,
  projectId,
  liveSessionId,
  liveSessionName,
  activityState,
  currentProviderName,
  providerConfigs,
  controls,
  open,
  onOpenChange,
  onRead,
  onDialogOpenChange,
}: SessionSwitcherProps) {
  const tree = useAgentSessionTree(agentId, projectId, liveSessionId);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const handingOffFocus = useRef(false);
  const [tableDialogOpen, setTableDialogOpen] = useState(false);
  const [savePointListOpen, setSavePointListOpen] = useState(false);
  const replacement = useConfirmDialog<Replacement>();
  const dialogOpen = replacement.isOpen || tableDialogOpen || savePointListOpen;
  useEffect(() => {
    onDialogOpenChange(dialogOpen);
    return () => onDialogOpenChange(false);
  }, [dialogOpen, onDialogOpenChange]);

  const live = tree.byId.get(liveSessionId);
  const label = (live ? live.node.name : liveSessionName) || liveSessionId.slice(0, 8);
  const savePoints = tree.savePoints;
  const showSaveControls = showSavePointControls(savePoints);
  let saveDisabledReason: string | undefined;
  if (savePoints?.available === false) {
    saveDisabledReason = 'Save points are not available for this provider yet.';
  } else if (activityState === 'busy') {
    saveDisabledReason = 'Wait until the agent completes its turn.';
  }

  /** Closes Sessions without returning focus to the trigger, because the next dialog takes it. */
  function closeForHandoff() {
    handingOffFocus.current = true;
    onOpenChange(false);
  }

  function requestReplacement(
    action: Replacement['action'],
    target: SessionTreeNode,
    switchConfig?: ProfileProviderConfig,
  ) {
    closeForHandoff();
    replacement.open({ action, target, liveSessionId, liveLabel: label, switchConfig });
  }

  function confirmReplacement() {
    const request = replacement.target;
    if (!request) return;
    if (request.action === 'start') {
      void controls.handleStartFromSavePoint(
        request.target.id,
        agentId,
        savePoints,
        request.liveSessionId,
      );
    } else {
      void controls.handleRestoreSession(
        request.target.id,
        agentId,
        request.liveSessionId,
        request.switchConfig?.id,
      );
    }
  }

  const rollback: SavePointListProps['onRollback'] = (
    session,
    savePoint,
    keepCurrent,
    replaceRunningSessionId,
  ) =>
    void controls.handleRollbackSession(
      session.id,
      savePoint.id,
      agentId,
      keepCurrent,
      replaceRunningSessionId,
      sessionTreeLabel(savePoint),
    );

  const request = replacement.target;
  const action = request?.action === 'start' ? 'Fork' : 'Restore';
  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogTrigger asChild>
          <Button
            ref={triggerRef}
            type="button"
            variant="ghost"
            size="sm"
            aria-label={`Switch session, current session ${label}`}
            className="h-6 min-w-0 gap-1 px-2 py-0 text-xs font-medium"
          >
            <span className="truncate">{label}</span>
            <ChevronDown aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
          </Button>
        </DialogTrigger>
        <DialogContent
          className="max-w-3xl gap-3 p-3 sm:p-6"
          onEscapeKeyDown={(event) => {
            if (
              event.target instanceof HTMLInputElement &&
              event.target.getAttribute('aria-label') === SESSION_NAME_INPUT_LABEL
            ) {
              event.preventDefault();
            }
          }}
          onCloseAutoFocus={(event) => {
            if (handingOffFocus.current) {
              event.preventDefault();
              handingOffFocus.current = false;
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>Sessions</DialogTitle>
            <DialogDescription className="sr-only">
              Browse sessions and save points for this agent's family.
            </DialogDescription>
          </DialogHeader>
          <SessionsTable
            agentId={agentId}
            agentName={agentName}
            projectId={projectId}
            liveSessionId={liveSessionId}
            currentProviderName={currentProviderName ?? null}
            providerConfigs={providerConfigs}
            restoringSessionIds={controls.restoringSessionIds}
            forkingSessionIds={controls.forkingSessionIds}
            rollingBackSessionIds={controls.rollingBackSessionIds}
            onRestore={(node, switchConfig) => requestReplacement('restore', node, switchConfig)}
            onFork={(node) => requestReplacement('start', node)}
            onRollback={rollback}
            onRead={(node) => {
              closeForHandoff();
              onRead(node.id, triggerRef.current);
            }}
            onDialogOpenChange={setTableDialogOpen}
          />
        </DialogContent>
      </Dialog>
      {showSaveControls && (
        <>
          <SavePointButton
            disabledReason={saveDisabledReason}
            saving={Boolean(controls.savingSessionIds[liveSessionId])}
            onSave={() => void controls.handleSavePoint(liveSessionId, agentId, savePoints)}
          />
          {live && (
            <SavePointList
              agentId={agentId}
              projectId={projectId}
              session={live.node}
              savePoints={live.savePoints}
              availability={savePoints}
              currentProviderName={currentProviderName ?? null}
              liveSessionId={liveSessionId}
              rollingBackIds={controls.rollingBackSessionIds}
              forkingIds={controls.forkingSessionIds}
              onRollback={rollback}
              onFork={(savePoint) =>
                replacement.open({
                  action: 'start',
                  target: savePoint,
                  liveSessionId,
                  liveLabel: label,
                })
              }
              onRead={(savePoint) => onRead(savePoint.id, null)}
              onOpenChange={setSavePointListOpen}
            />
          )}
        </>
      )}
      <ConfirmDialog
        open={replacement.isOpen}
        onOpenChange={replacement.onOpenChange}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const trigger = triggerRef.current;
          if (trigger?.isConnected) trigger.focus();
        }}
        onConfirm={confirmReplacement}
        title={request?.action === 'start' ? 'Fork session?' : 'Restore session?'}
        confirmText={action}
        description={
          (request && (
            <>
              The current session stops and stays in the list.
              <span className="mt-3 block break-words">
                Current session <strong>{request.liveLabel}</strong>
              </span>
              <span className="block break-words">
                {action} <strong>{sessionTreeLabel(request.target)}</strong>
              </span>
              {request.switchConfig && (
                <span className="mt-3 block break-words">
                  {switchRestoreWarning(
                    request.target,
                    request.switchConfig,
                    currentProviderName,
                    agentName,
                  )}
                </span>
              )}
            </>
          )) ||
          ''
        }
      />
    </>
  );
}
