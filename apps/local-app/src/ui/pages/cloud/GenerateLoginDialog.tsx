import { useEffect, useRef, useState } from 'react';
import { Button } from '@/ui/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/components/ui/dialog';
import { Spinner } from '@/ui/components/ui/spinner';
import { ChatTerminal } from '@/ui/components/terminal/ChatTerminal';
import {
  isGenerationTerminal,
  runningGenerationId,
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
 * operation already started. Only one login per provider runs at a time, so
 * when one is already running, `start` mode follows that one instead. The
 * dialog closes by itself once the login is stored; failures stay open with
 * the error. Escape, an outside click or an unmount without a close cancels a
 * login this dialog started, also when its start answers after the close. A
 * followed login is only hidden: it may be a claim's, and cancelling it would
 * fail the claim's resolve step. Cancel login ends any login.
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
  const [started, setStarted] = useState<ProviderAuthGenerationView | null>(null);
  /** The provider's login that was already running when this dialog tried to start one. */
  const [runningId, setRunningId] = useState<string | null>(null);
  const generationId = attach?.id ?? runningId ?? started?.id ?? null;
  const { generation: polled } = useProviderAuthGeneration(generationId);
  const generation = polled ?? attach ?? started ?? null;
  const followed = Boolean(attach) || runningId !== null;
  const settledRef = useRef(false);
  const onCloseRef = useRef(onClose);
  const onStoredRef = useRef(onStored);
  const startRequestedRef = useRef(false);
  const mountedRef = useRef(false);
  const closedRef = useRef(false);
  /** The unfinished login this dialog started; null once it ends or is cancelled. */
  const ownedIdRef = useRef<string | null>(null);

  useEffect(() => {
    onCloseRef.current = onClose;
    onStoredRef.current = onStored;
  }, [onClose, onStored]);

  /** Cancels the login this dialog started, at most once. */
  const cancelOwn = () => {
    const id = ownedIdRef.current;
    ownedIdRef.current = null;
    if (id) cancel.mutate(id);
  };

  useEffect(() => {
    // StrictMode runs effects twice in development; the ref keeps it to one login.
    if (attach || startRequestedRef.current) return;
    startRequestedRef.current = true;
    void start.mutateAsync({ provider, label }).then(
      (view) => {
        ownedIdRef.current = view.id;
        // The dialog closed before the start answered: nobody can finish this login.
        if (closedRef.current) cancelOwn();
        else setStarted(view);
      },
      (error: unknown) => {
        const id = runningGenerationId(error);
        if (id && !closedRef.current) setRunningId(id);
      },
    );
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // StrictMode unmounts and mounts again at once; only a real unmount ends the login.
      window.setTimeout(() => {
        if (mountedRef.current) return;
        closedRef.current = true;
        cancelOwn();
      }, 0);
    };
  }, []);

  useEffect(() => {
    if (
      generation &&
      generation.id === ownedIdRef.current &&
      isGenerationTerminal(generation.state)
    ) {
      ownedIdRef.current = null;
    }
  }, [generation?.id, generation?.state]);

  /** Escape, an outside click and Hide: they end only a login this dialog started. */
  const dismiss = () => {
    closedRef.current = true;
    cancelOwn();
    onClose();
  };

  const cancelLogin = () => {
    closedRef.current = true;
    cancelOwn();
    if (followed && generation && !isGenerationTerminal(generation.state)) {
      cancel.mutate(generation.id);
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
    <Dialog open onOpenChange={(open) => !open && dismiss()}>
      <DialogContent className="max-h-[90vh] sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Log in to {provider}</DialogTitle>
          <DialogDescription>
            This login runs isolated from this PC's own credentials. Complete it in the terminal;
            DevChain stores the result when it verifies.
          </DialogDescription>
        </DialogHeader>
        {runningId && (
          <p className="text-sm text-muted-foreground">
            A {provider} login was already running, so this is that login. Finish it below, or
            cancel it and start again.
          </p>
        )}
        <p className="text-sm" role="status" data-testid="login-generation-state">
          {(!generation || !isGenerationTerminal(generation.state)) && <Spinner className="mr-1" />}
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
          {followed && !stored && (
            <Button variant="outline" onClick={dismiss}>
              Hide
            </Button>
          )}
          <Button variant="outline" onClick={cancelLogin} pending={cancel.isPending}>
            {stored ? 'Close' : 'Cancel login'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
