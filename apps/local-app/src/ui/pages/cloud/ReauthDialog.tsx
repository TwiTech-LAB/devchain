import { useCallback, useMemo } from 'react';
import { Button } from '@/ui/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/components/ui/dialog';
import { useProviderAuth } from '@/ui/hooks/useProviderAuth';
import { defaultLoginChoice, setupProviderAuth } from './login-choices';
import { ReauthLoginStep, useAddLoginLink, useLoginChoices } from './LoginChoiceStep';
import { StartError } from './StartError';

/** New logins for the providers whose test failed; Retry runs the same operation again. */
export function ReauthDialog({
  operationId,
  providers,
  remoteId,
  remoteNames,
  pending,
  error,
  onClose,
  onRetry,
}: {
  operationId: string;
  providers: readonly string[];
  /** The VM the operation sets up; logins it already holds stay selectable. */
  remoteId: string | null;
  remoteNames: ReadonlyMap<string, string>;
  pending: boolean;
  /** The refusal of the last retry, shown above the buttons. */
  error?: string | null;
  onClose: () => void;
  onRetry: (operationId: string, providerAuth: Record<string, string>) => void;
}) {
  const { entries } = useProviderAuth();
  const context = useMemo(
    () => ({ targetRemoteId: remoteId, remoteNames }),
    [remoteId, remoteNames],
  );
  const defaultFor = useCallback(
    (provider: string) => defaultLoginChoice(provider, entries, context),
    [entries, context],
  );
  const { choices, setChoice } = useLoginChoices(providers, defaultFor);
  const { onAddLogin, addLoginDialog } = useAddLoginLink(providers, setChoice);

  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <DialogContent className="max-h-[90vh] w-[calc(100vw-2rem)] overflow-y-auto sm:w-full sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Re-authenticate {providers.join(', ')}</DialogTitle>
          <DialogDescription>
            Choose a login for each provider whose test failed. Retry tests only these providers
            again.
          </DialogDescription>
        </DialogHeader>
        <ReauthLoginStep
          onAddLogin={onAddLogin}
          providers={providers}
          entries={entries}
          context={context}
          choices={choices}
          onChange={setChoice}
          disabled={pending}
        />
        <StartError error={error} />
        {addLoginDialog}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            onClick={() => onRetry(operationId, setupProviderAuth(choices))}
            disabled={pending}
            data-testid="reauth-submit"
          >
            Retry with these logins
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
