import { useEffect, useRef } from 'react';
import { Button } from '@/ui/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/components/ui/dialog';
import { ChatTerminal } from '@/ui/components/terminal/ChatTerminal';
import {
  isGenerationTerminal,
  useProviderAuthGeneration,
  useProviderAuthGenerationActions,
  type ProviderAuthGenerationView,
} from '@/ui/hooks/useProviderAuth';

const STATE_TEXT: Record<ProviderAuthGenerationView['state'], string> = {
  waiting: 'Waiting for the login to finish — the CLI prints its URL in the terminal below.',
  verifying: 'Login captured; verifying it works before storing.',
  stored: 'Login verified and stored.',
  failed: 'The login did not complete.',
  cancelled: 'Login cancelled.',
  timed_out: 'Login timed out.',
};

/**
 * Embeds the isolated login's terminal. In `start` mode it begins a new
 * generation for the provider; in `attach` mode it follows one a claim
 * operation already started. The dialog closes by itself once the login is
 * stored; failures stay open with the error. Escape or an outside click
 * cancels a login this dialog started, but only hides one a claim started:
 * cancelling it would fail the claim's resolve step.
 */
export function GenerateLoginDialog({
  provider,
  label,
  attach,
  onClose,
  onStored,
}: {
  provider: string;
  /** `attach` carries a generation a claim operation started. */
  attach?: ProviderAuthGenerationView;
  label?: string;
  onClose: () => void;
  /** Called once with the stored logins, before the dialog closes itself. */
  onStored?: (generation: ProviderAuthGenerationView) => void;
}) {
  const { start, cancel } = useProviderAuthGenerationActions();
  const generationId = attach?.id ?? start.data?.id ?? null;
  const { generation: polled } = useProviderAuthGeneration(generationId);
  const generation = polled ?? attach ?? start.data ?? null;
  const settledRef = useRef(false);
  const onCloseRef = useRef(onClose);
  const onStoredRef = useRef(onStored);

  useEffect(() => {
    onCloseRef.current = onClose;
    onStoredRef.current = onStored;
  }, [onClose, onStored]);

  useEffect(() => {
    if (!start.isPending && generationId === null) {
      start.mutate({ provider, label });
    }
    // The generation starts exactly once per dialog mount.
  }, []);

  const close = () => {
    if (generationId && generation && !isGenerationTerminal(generation.state)) {
      cancel.mutate(generationId);
    }
    onClose();
  };

  const stored = generation?.state === 'stored';
  useEffect(() => {
    if (stored && !settledRef.current) {
      settledRef.current = true;
      if (generation) onStoredRef.current?.(generation);
      const timer = window.setTimeout(() => onCloseRef.current(), 400);
      return () => window.clearTimeout(timer);
    }
  }, [stored]);

  return (
    <Dialog open onOpenChange={(open) => !open && (attach ? onClose() : close())}>
      <DialogContent className="max-h-[90vh] sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Log in to {provider}</DialogTitle>
          <DialogDescription>
            This login runs isolated from this PC's own credentials. Complete it in the terminal;
            DevChain stores the result when it verifies.
          </DialogDescription>
        </DialogHeader>
        <p className="text-sm" role="status" data-testid="login-generation-state">
          {generation ? STATE_TEXT[generation.state] : 'Starting the login terminal…'}
        </p>
        {generation?.error && (
          <p role="alert" className="text-sm text-destructive">
            {generation.error}
          </p>
        )}
        {generation?.sessionId && (
          <div className="h-72 overflow-hidden rounded-md border">
            <ChatTerminal
              sessionId={generation.sessionId}
              socket="home"
              chrome="none"
              ariaLabel={`${provider} login terminal`}
              className="h-full"
            />
          </div>
        )}
        <DialogFooter>
          {attach && !stored && (
            <Button variant="outline" onClick={onClose}>
              Hide
            </Button>
          )}
          <Button variant="outline" onClick={close} disabled={cancel.isPending}>
            {stored ? 'Close' : 'Cancel login'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
