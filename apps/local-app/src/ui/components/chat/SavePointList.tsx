import { useEffect, useId, useRef, useState } from 'react';
import { Eye, GitFork, Trash2, Undo2 } from 'lucide-react';
import { ConfirmDialog } from '@/ui/components/shared/ConfirmDialog';
import { Button } from '@/ui/components/ui/button';
import { Checkbox } from '@/ui/components/ui/checkbox';
import { Label } from '@/ui/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/components/ui/popover';
import { useSessionTreeRecordActions } from '@/ui/hooks/useSessionTreeRecordActions';
import type { SavePointAvailability, SessionTreeNode } from '@/ui/lib/sessions';
import {
  SESSION_NAME_INPUT_LABEL,
  SessionNameEditor,
  formatRelativeTime,
} from './SessionNameEditor';
import {
  FORK_SESSION_TITLE,
  forkSourceBlocked,
  otherOwnerHint,
  sessionTreeLabel,
  showSavePointControls,
} from './SessionTree';
import { SessionTreeDeleteDialog } from './SessionTreeRecordDialogs';

export interface SavePointListProps {
  /** The viewing agent. Roll back and Fork are only for its own sessions. */
  agentId: string;
  projectId: string;
  /** The session that owns the save points. */
  session: SessionTreeNode;
  /** The session's save points, in display order. */
  savePoints: SessionTreeNode[];
  availability: SavePointAvailability | undefined;
  currentProviderName: string | null;
  /** The running session that a rollback replaces. It is read when the confirmation opens. */
  liveSessionId: string | undefined;
  /** Pending rollbacks, keyed by session ID and by the chosen save point ID. */
  rollingBackIds: Record<string, boolean>;
  forkingIds: Record<string, boolean>;
  /** Gets the session and the replacement ID as they were when the confirmation opened. */
  onRollback: (
    session: SessionTreeNode,
    savePoint: SessionTreeNode,
    keepCurrent: boolean,
    replaceRunningSessionId: string | undefined,
  ) => void;
  onFork: (savePoint: SessionTreeNode) => void;
  onRead: (savePoint: SessionTreeNode) => void;
  /** True while the list, its Roll back confirmation or its delete dialog is open. */
  onOpenChange?: (open: boolean) => void;
  /**
   * Makes the list popover modal. Set it inside a modal dialog: the dialog's scroll lock cancels
   * wheel and touch events in a popover that is not modal, because the popover is outside it.
   */
  modal?: boolean;
}

interface RollbackRequest {
  session: SessionTreeNode;
  savePoint: SessionTreeNode;
  liveSessionId: string | undefined;
}

function isRenameInput(target: EventTarget | null) {
  return (
    target instanceof HTMLInputElement &&
    target.getAttribute('aria-label') === SESSION_NAME_INPUT_LABEL
  );
}

export function SavePointList({
  agentId,
  projectId,
  session,
  savePoints,
  availability,
  currentProviderName,
  liveSessionId,
  rollingBackIds,
  forkingIds,
  onRollback,
  onFork,
  onRead,
  onOpenChange,
  modal = false,
}: SavePointListProps) {
  const records = useSessionTreeRecordActions(agentId, projectId);
  const [listOpen, setListOpen] = useState(false);
  const [rollback, setRollback] = useState<RollbackRequest | null>(null);
  const [keepCurrent, setKeepCurrent] = useState(true);
  const chip = useRef<HTMLButtonElement>(null);
  const handingOffFocus = useRef(false);
  const keepCurrentId = useId();
  const deleteOpen = records.deleteDialog.isOpen;
  const visible = savePoints.length > 0 && showSavePointControls(availability);
  const open = (visible && listOpen) || rollback !== null || deleteOpen;

  useEffect(() => {
    if (!onOpenChange) return;
    onOpenChange(open);
    return () => onOpenChange(false);
  }, [open, onOpenChange]);

  const sessionPending = Boolean(rollingBackIds[session.id]);
  const ownerHint = otherOwnerHint(agentId, session);
  const count = savePoints.length;

  /** Closes the list without returning focus to the chip, because the next view takes it. */
  function closeForHandoff() {
    handingOffFocus.current = true;
    setListOpen(false);
  }

  function returnFocusToChip(event: Event) {
    event.preventDefault();
    if (chip.current?.isConnected) chip.current.focus();
  }

  function confirmRollback() {
    if (rollback)
      onRollback(rollback.session, rollback.savePoint, keepCurrent, rollback.liveSessionId);
  }

  return (
    <>
      {visible && (
        <Popover open={listOpen} onOpenChange={setListOpen} modal={modal}>
          <PopoverTrigger asChild>
            <Button
              ref={chip}
              type="button"
              variant="ghost"
              size="sm"
              aria-label={`${count} save point${count === 1 ? '' : 's'}`}
              className="h-6 shrink-0 gap-1 px-2 py-0 text-xs text-status-info"
            >
              <span aria-hidden="true">◆</span>
              {count}
            </Button>
          </PopoverTrigger>
          <PopoverContent
            className="w-[min(28rem,calc(100vw-1rem))] p-2"
            onEscapeKeyDown={(event) => {
              if (isRenameInput(event.target)) event.preventDefault();
            }}
            onCloseAutoFocus={(event) => {
              if (handingOffFocus.current) {
                event.preventDefault();
                handingOffFocus.current = false;
              }
            }}
          >
            <ul
              aria-label="Save points"
              className="max-h-[min(360px,60vh)] space-y-1 overflow-y-auto"
            >
              {savePoints.map((savePoint) => {
                const blocked =
                  !availability?.available || forkSourceBlocked(savePoint, currentProviderName);
                const rollingBack = Boolean(rollingBackIds[savePoint.id]);
                const forking = Boolean(forkingIds[savePoint.id]);
                return (
                  <li key={savePoint.id} className="flex min-w-0 items-center gap-1 rounded px-1">
                    <div className="flex min-w-0 flex-1 flex-col">
                      <SessionNameEditor
                        node={savePoint}
                        label={sessionTreeLabel(savePoint)}
                        title={savePoint.name ?? savePoint.providerSessionId ?? savePoint.id}
                        renamable={!savePoint.beforeRollback}
                        renamePending={records.renamePending}
                        onRename={records.renameRecord}
                      />
                      <span className="text-[11px] text-muted-foreground">
                        {formatRelativeTime(
                          savePoint.lastActivityAt ?? savePoint.endedAt ?? savePoint.startedAt,
                        )}
                      </span>
                    </div>
                    {ownerHint ? (
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        {ownerHint}
                      </span>
                    ) : (
                      <>
                        <Button
                          type="button"
                          size="sm"
                          className="h-7 shrink-0 gap-1 px-2 text-xs"
                          pending={rollingBack}
                          disabled={blocked || sessionPending || forking}
                          onClick={() => {
                            closeForHandoff();
                            setKeepCurrent(true);
                            setRollback({ session, savePoint, liveSessionId });
                          }}
                        >
                          {!rollingBack && <Undo2 aria-hidden="true" className="h-3.5 w-3.5" />}
                          Roll back
                        </Button>
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7 shrink-0"
                          aria-label="Fork from save point"
                          title={FORK_SESSION_TITLE}
                          pending={forking}
                          disabled={blocked || sessionPending}
                          onClick={() => {
                            closeForHandoff();
                            onFork(savePoint);
                          }}
                        >
                          {!forking && <GitFork aria-hidden="true" className="h-3.5 w-3.5" />}
                        </Button>
                      </>
                    )}
                    {savePoint.transcriptAvailable && (
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 shrink-0"
                        aria-label="Read transcript"
                        title="Read transcript"
                        onClick={() => {
                          closeForHandoff();
                          onRead(savePoint);
                        }}
                      >
                        <Eye aria-hidden="true" className="h-3.5 w-3.5" />
                      </Button>
                    )}
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 shrink-0"
                      aria-label="Delete session record"
                      title="Delete session record"
                      disabled={sessionPending}
                      onClick={() => {
                        closeForHandoff();
                        records.deleteDialog.open(savePoint);
                      }}
                    >
                      <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
                    </Button>
                  </li>
                );
              })}
            </ul>
          </PopoverContent>
        </Popover>
      )}
      <ConfirmDialog
        open={rollback !== null}
        onOpenChange={(next) => {
          if (!next) setRollback(null);
        }}
        onCloseAutoFocus={returnFocusToChip}
        onConfirm={confirmRollback}
        title="Roll back session?"
        confirmText="Roll back"
        description={
          rollback && (
            <>
              <strong className="break-words">{sessionTreeLabel(rollback.session)}</strong> restarts
              at <strong className="break-words">{sessionTreeLabel(rollback.savePoint)}</strong>.
              Later messages leave this session. Files and Git changes do not go back.
              {rollback.liveSessionId && rollback.liveSessionId !== rollback.session.id && (
                <span className="mt-3 block">The current session stops and stays in the list.</span>
              )}
            </>
          )
        }
      >
        <div className="flex items-center gap-2">
          <Checkbox
            id={keepCurrentId}
            checked={keepCurrent}
            onCheckedChange={(checked) => setKeepCurrent(checked === true)}
          />
          <Label htmlFor={keepCurrentId} className="cursor-pointer">
            Keep the current conversation
          </Label>
        </div>
      </ConfirmDialog>
      <SessionTreeDeleteDialog
        dialog={records.deleteDialog}
        onConfirm={records.submitDelete}
        onCloseAutoFocus={returnFocusToChip}
      />
    </>
  );
}
