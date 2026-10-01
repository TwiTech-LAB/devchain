import { useCallback, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { HostEnvOverrideEntry } from '@/modules/remotes/host/host-env-override-report';
import { useHomeQueryClient } from '@/ui/components/BackendBoundary';
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
import { HOME_BACKEND, apiFetch } from '@/ui/lib/api-transport';
import {
  LOGIN_PROVIDERS,
  SESSION_REWRITTEN_PROVIDERS,
  changedProviderAuth,
  type LoginChoice,
} from './login-choices';
import {
  ChangeLoginStep,
  useAddLoginLink,
  useLoginChoices,
  type RecordedLogin,
} from './LoginChoiceStep';
import { StartError } from './StartError';

/**
 * How many agent sessions run on the VM now. The VM answers through this
 * PC's proxy; a failed check is null ("unknown") and the server checks again.
 */
function useRunningAgents(remoteId: string) {
  const query = useQuery(
    {
      queryKey: [HOME_BACKEND, 'remote-running-agents', remoteId],
      queryFn: async ({ signal }) => {
        const response = await apiFetch('/api/sessions', { signal }, { backend: remoteId });
        if (!response.ok) throw new Error('session list unavailable');
        const sessions = (await response.json()) as Array<{
          status?: string;
          agentId?: string | null;
        }>;
        return sessions.filter((session) => session.status === 'running' && session.agentId).length;
      },
      staleTime: 15_000,
      retry: false,
    },
    useHomeQueryClient(),
  );
  // undefined while checking; null when the VM could not say.
  return query.isPending ? undefined : (query.data ?? null);
}

/** Changes the logins of a set-up VM; only the providers moved off Keep current are sent. */
export function ChangeLoginsDialog({
  remote,
  remoteNames,
  pending,
  error,
  onClose,
  onChangeLogins,
}: {
  remote: {
    id: string;
    name: string;
    logins: Readonly<Record<string, RecordedLogin>> | null;
    providerEnvOverrides?: HostEnvOverrideEntry[] | null;
  };
  remoteNames: ReadonlyMap<string, string>;
  pending: boolean;
  /** The refusal of the last request, shown above the buttons. */
  error?: string | null;
  onClose: () => void;
  onChangeLogins: (providerAuth: Record<string, string>, force: boolean) => void;
}) {
  const { entries } = useProviderAuth();
  const keep = useCallback((): LoginChoice => 'keep', []);
  const { choices, setChoice } = useLoginChoices(LOGIN_PROVIDERS, keep);
  const { onAddLogin, addLoginDialog } = useAddLoginLink(LOGIN_PROVIDERS, setChoice);
  const context = useMemo(
    () => ({ targetRemoteId: remote.id, remoteNames }),
    [remote.id, remoteNames],
  );
  const runningAgents = useRunningAgents(remote.id);

  const providerAuth = changedProviderAuth(choices);
  const changed = Object.keys(providerAuth);
  const sessionsRun = runningAgents !== undefined && (runningAgents === null || runningAgents > 0);
  // A running session rewrites these logins on its next refresh; the others
  // only need the session restarted.
  const blocked =
    sessionsRun &&
    changed.some((provider) =>
      (SESSION_REWRITTEN_PROVIDERS as readonly string[]).includes(provider),
    );
  const overrideWarnings = changed.flatMap((provider) =>
    (remote.providerEnvOverrides ?? [])
      .filter((entry) => entry.provider === provider)
      .map(
        (entry) =>
          `The VM's provider settings hold ${entry.key} (${entry.source}), which overrides this login. Remove it in that VM's Edit Provider.`,
      ),
  );
  const count = runningAgents === null ? 'An unknown number of' : String(runningAgents);
  const sessionsAre = runningAgents === 1 ? 'session is' : 'sessions are';

  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <DialogContent className="max-h-[90vh] w-[calc(100vw-2rem)] overflow-y-auto sm:w-full sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Change logins for {remote.name}</DialogTitle>
          <DialogDescription>
            Logins left on Keep current stay as they are, including several OpenCode logins. None
            removes a login from the VM.
          </DialogDescription>
        </DialogHeader>
        <ChangeLoginStep
          onAddLogin={onAddLogin}
          entries={entries}
          context={context}
          recorded={remote.logins ?? {}}
          choices={choices}
          onChange={setChoice}
          disabled={pending}
        />
        {blocked && (
          <p role="alert" className="text-sm text-destructive" data-testid="family-block">
            {count} agent {sessionsAre} running on this VM. Stop them first; a running session
            overwrites the new login on its next refresh.
          </p>
        )}
        {!blocked && changed.length > 0 && sessionsRun && (
          <p role="status" className="text-sm text-status-warn" data-testid="env-warning">
            {count} agent {sessionsAre} running on this VM. Restart running agent sessions so they
            use the new logins.
          </p>
        )}
        {overrideWarnings.map((warning) => (
          <p
            key={warning}
            role="alert"
            className="text-sm text-status-warn"
            data-testid="override-warning"
          >
            {warning}
          </p>
        ))}
        <StartError error={error} />
        {addLoginDialog}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            onClick={() => onChangeLogins(providerAuth, blocked)}
            disabled={pending || changed.length === 0}
            variant={blocked ? 'destructive' : 'default'}
            data-testid="change-logins-submit"
          >
            {blocked ? 'Change anyway' : 'Change logins'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
