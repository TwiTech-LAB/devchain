import type { ReactNode } from 'react';
import { GitFork, Power, RotateCcw } from 'lucide-react';
import { Button } from '@/ui/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/ui/components/ui/tooltip';

interface SessionBarProps {
  left?: ReactNode;
  children: ReactNode;
}

export function SessionBar({ left, children }: SessionBarProps) {
  return (
    <div className="flex h-8 shrink-0 items-center justify-between gap-2 border-t bg-muted/40 px-3">
      <div className="flex min-w-0 items-center gap-2">{left}</div>
      <div role="group" aria-label="Session actions" className="flex shrink-0 items-center gap-1">
        {children}
      </div>
    </div>
  );
}

export const LIVE_FORK_TOOLTIP = 'Fork into a new session with a copy of this conversation.';

type PendingAction = 'fork' | 'restart' | 'stop' | null;

interface SessionAction {
  id: NonNullable<PendingAction>;
  label: string;
  tooltip: string;
  disabledReason?: string;
  icon: typeof GitFork;
  run: () => void;
}

/** The bar's buttons share one look, and every one waits while any action is pending. */
function SessionActionButtons({
  actions,
  pendingAction,
}: {
  actions: SessionAction[];
  pendingAction: PendingAction;
}) {
  return (
    <TooltipProvider>
      {actions.map(({ id, label, tooltip, disabledReason, icon: Icon, run }) => {
        const pending = pendingAction === id;
        const button = (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 shrink-0 gap-1.5 px-2 py-0 text-xs"
            disabled={pendingAction !== null || Boolean(disabledReason)}
            pending={pending}
            onClick={run}
          >
            {!pending && <Icon className="h-3.5 w-3.5" aria-hidden="true" />}
            {label}
          </Button>
        );
        return (
          <Tooltip key={id}>
            <TooltipTrigger asChild>
              {/* A disabled button gets no pointer or focus events, so its reason needs a wrapper. */}
              {disabledReason ? (
                <span tabIndex={0} className="inline-flex shrink-0">
                  {button}
                </span>
              ) : (
                button
              )}
            </TooltipTrigger>
            <TooltipContent side="top">{tooltip}</TooltipContent>
          </Tooltip>
        );
      })}
    </TooltipProvider>
  );
}

interface SessionForkActionProps {
  onFork: () => void;
  disabledReason?: string;
  pendingAction: PendingAction;
}

/** The live Fork action. It sits in the bar's left slot, next to the save point controls. */
export function SessionForkAction({
  onFork,
  disabledReason,
  pendingAction,
}: SessionForkActionProps) {
  return (
    <SessionActionButtons
      pendingAction={pendingAction}
      actions={[
        {
          id: 'fork',
          label: 'Fork',
          tooltip: disabledReason ?? LIVE_FORK_TOOLTIP,
          disabledReason,
          icon: GitFork,
          run: onFork,
        },
      ]}
    />
  );
}

interface SessionBarActionsProps {
  onRestart: () => void;
  onStop: () => void;
  pendingAction: PendingAction;
}

export function SessionBarActions({ onRestart, onStop, pendingAction }: SessionBarActionsProps) {
  return (
    <SessionActionButtons
      pendingAction={pendingAction}
      actions={[
        {
          id: 'restart',
          label: 'Restart',
          tooltip: 'Restart session',
          icon: RotateCcw,
          run: onRestart,
        },
        { id: 'stop', label: 'Stop', tooltip: 'Stop session', icon: Power, run: onStop },
      ]}
    />
  );
}
