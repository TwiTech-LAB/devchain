import type { ExternalTaskStatusOption } from '@/modules/external-integrations/models/external-provider.models';
import { Button } from '@/ui/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/ui/components/ui/dialog';
import type { ExternalTaskMoveChoice } from '@/ui/hooks/board/useExternalTaskMove';
import { externalTaskStatusOptionLabel } from '@/ui/lib/external-board';

export interface ExternalTaskMoveChoiceDialogProps {
  choice: ExternalTaskMoveChoice;
  /** Controlled open; defaults to true for conditional-render callers. */
  open?: boolean;
  onResolve: (option: ExternalTaskStatusOption) => void;
  onCancel: () => void;
  pending?: boolean;
  /** Focus target when the dialog closes; defaults to the heading fallback. */
  returnFocusTo?: () => HTMLElement | null;
}

/**
 * Accessible chooser for destinations reachable through several provider
 * actions. Every close path (Cancel, Escape, outside) cancels without a write
 * and returns focus to the source card.
 */
export function ExternalTaskMoveChoiceDialog({
  choice,
  open = true,
  onResolve,
  onCancel,
  pending = false,
  returnFocusTo,
}: ExternalTaskMoveChoiceDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(next) => (next || pending ? undefined : onCancel())}>
      <DialogContent
        className="sm:max-w-md"
        aria-busy={pending}
        onEscapeKeyDown={(event) => {
          if (pending) event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          if (pending) event.preventDefault();
        }}
        onCloseAutoFocus={(event) => {
          // The card never moved while the choice was open; focus must return
          // to it, never to document.body.
          const target = returnFocusTo?.();
          if (target) {
            event.preventDefault();
            target.focus();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>Choose a move for {choice.taskTitle}</DialogTitle>
          <DialogDescription>
            Multiple actions lead to {choice.target.name}. Choose the action to apply.
          </DialogDescription>
        </DialogHeader>
        <div
          role="group"
          aria-label={`Actions leading to ${choice.target.name}`}
          aria-busy={pending}
        >
          <ul className="space-y-2">
            {choice.options.map((option) => (
              <li key={option.actionValue}>
                <Button
                  type="button"
                  variant="outline"
                  className="w-full justify-start whitespace-normal"
                  onClick={() => onResolve(option)}
                  disabled={pending}
                >
                  {externalTaskStatusOptionLabel(option)}
                </Button>
              </li>
            ))}
          </ul>
        </div>
        {pending ? (
          <p className="text-sm text-muted-foreground" role="status">
            Moving task…
          </p>
        ) : null}
        <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
      </DialogContent>
    </Dialog>
  );
}
