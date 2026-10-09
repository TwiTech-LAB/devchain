import { useEffect, useMemo, useRef } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useHomeQueryClient } from '@/ui/components/BackendBoundary';
import { useRemoteVmApi } from '@/ui/pages/cloud/lib/remote-vm-api-context';
import { useToastHelpers } from '@/ui/lib/toast-helpers';
import type { ProviderAuthGenerationView } from '@/ui/pages/cloud/lib/remote-vm-contracts';
import { ProviderAuthApiError } from '@/ui/pages/cloud/lib/remote-vm-errors';
import { providerAuthKeys } from '@/ui/pages/cloud/lib/remote-vm-query-keys';

/**
 * Vault entries and their mutations, on the home client so the panel works
 * whatever project is active. Token values are typed `string` and sent once;
 * they are never stored in query caches beyond the request.
 */
export function useProviderAuth() {
  const api = useRemoteVmApi();
  const client = useHomeQueryClient();
  const { toast, showError } = useToastHelpers();

  const entries = useQuery(
    {
      queryKey: providerAuthKeys.all,
      queryFn: ({ signal }) => api.listProviderAuthEntries(signal),
    },
    client,
  );
  // A stable empty array: consumers key effects on this value.
  const items = useMemo(() => entries.data ?? [], [entries.data]);

  const invalidate = () => void client.invalidateQueries({ queryKey: providerAuthKeys.all });

  const createStatic = useMutation(
    {
      mutationFn: (body: Record<string, string>) => api.createStaticProviderAuth(body),
      onSuccess: invalidate,
      onError: (error: Error) =>
        showError({ title: 'Could not store the token', description: error.message }),
    },
    client,
  );

  const importOpencode = useMutation(
    {
      mutationFn: (providerIds: string[]) => api.importOpencodeLogins(providerIds),
      onSuccess: invalidate,
      onError: (error: Error) =>
        showError({ title: 'OpenCode import failed', description: error.message }),
    },
    client,
  );

  const remove = useMutation(
    {
      mutationFn: (id: string) => api.deleteProviderAuthEntry(id),
      onSuccess: invalidate,
      onError: (error: Error) =>
        showError({ title: 'Could not delete the entry', description: error.message }),
    },
    client,
  );

  const rename = useMutation(
    {
      mutationFn: (input: { id: string; label: string }) =>
        api.renameProviderAuthEntry(input.id, input.label),
      onSuccess: invalidate,
      // The row shows a refusal inline; an error toast here would repeat it.
    },
    client,
  );

  const release = useMutation(
    {
      mutationFn: (id: string) => api.releaseProviderAuthEntry(id),
      onSuccess: ({ pullStatus }) => {
        invalidate();
        if (pullStatus === 'offline') {
          toast({
            title: 'Login released without a fresh pull',
            description: 'The remote was offline, so the vault keeps the last stored login.',
          });
        }
      },
      onError: (error: Error) =>
        showError({ title: 'Could not release the login', description: error.message }),
    },
    client,
  );

  return {
    entries: items,
    entriesLoading: entries.isLoading,
    createStatic,
    importOpencode,
    remove,
    rename,
    release,
  };
}

/**
 * The OpenCode logins on this PC. The key sits under `providerAuthKeys.all`,
 * so the invalidations after an import, a delete, or a generation refresh the
 * `imported` flags without extra code. The dialog mounts only while open, so
 * the query loads each time it opens.
 */
export function useOpencodeLogins() {
  const api = useRemoteVmApi();
  const client = useHomeQueryClient();
  const query = useQuery(
    {
      queryKey: providerAuthKeys.opencodeLogins(),
      queryFn: ({ signal }) => api.listOpencodeLogins(signal),
    },
    client,
  );
  // A stable empty array: consumers key effects on this value.
  const logins = useMemo(() => query.data ?? [], [query.data]);
  return { logins, loginsLoading: query.isLoading, loginsError: query.isError };
}

const GENERATION_TERMINAL: ReadonlySet<ProviderAuthGenerationView['state']> = new Set([
  'stored',
  'failed',
  'cancelled',
  'timed_out',
]);

export function isGenerationTerminal(state: ProviderAuthGenerationView['state']): boolean {
  return GENERATION_TERMINAL.has(state);
}

/** The login a refused start found running for the same provider, or null. */
export function runningGenerationId(error: unknown): string | null {
  if (!(error instanceof ProviderAuthApiError)) return null;
  if (error.details?.code !== 'PROVIDER_AUTH_GENERATION_RUNNING') return null;
  const id = error.details.generationId;
  return typeof id === 'string' ? id : null;
}

/**
 * Polls one login generation until it settles. `null` disables the poll, so
 * the dialog can stop asking once it closes.
 */
export function useProviderAuthGeneration(generationId: string | null) {
  const api = useRemoteVmApi();
  const client = useHomeQueryClient();
  const invalidatedStoredGenerationIds = useRef(new Set<string>());
  const query = useQuery(
    {
      queryKey: providerAuthKeys.generation(generationId),
      enabled: generationId !== null,
      refetchInterval: (poll: { state: { data?: ProviderAuthGenerationView | undefined } }) =>
        poll.state.data && isGenerationTerminal(poll.state.data.state) ? false : 1000,
      queryFn: async ({ signal }) => {
        if (generationId === null) throw new Error('No generation selected');
        return api.readProviderAuthGeneration(generationId, signal);
      },
    },
    client,
  );

  useEffect(() => {
    const generation = query.data;
    if (
      generationId === null ||
      generation?.id !== generationId ||
      generation.state !== 'stored' ||
      invalidatedStoredGenerationIds.current.has(generationId)
    ) {
      return;
    }

    invalidatedStoredGenerationIds.current.add(generationId);
    void client.invalidateQueries({ queryKey: providerAuthKeys.all });
  }, [client, generationId, query.data?.id, query.data?.state]);

  return { generation: query.data ?? null };
}

/** Starts a login generation and cancels one; the caller closes on terminal state. */
export function useProviderAuthGenerationActions() {
  const api = useRemoteVmApi();
  const client = useHomeQueryClient();
  const { showError } = useToastHelpers();
  const invalidate = () => void client.invalidateQueries({ queryKey: providerAuthKeys.all });
  const start = useMutation(
    {
      mutationFn: (body: { provider: string; label?: string }) =>
        api.startProviderAuthGeneration(body),
      // A login already running is no failure: the dialog shows that login instead.
      onError: (error: Error) => {
        if (runningGenerationId(error)) return;
        showError({ title: 'Could not start the login', description: error.message });
      },
    },
    client,
  );
  const cancel = useMutation(
    {
      mutationFn: (generationId: string) => api.cancelProviderAuthGeneration(generationId),
      onSuccess: invalidate,
      onError: (error: Error) =>
        showError({ title: 'Could not cancel the login', description: error.message }),
    },
    client,
  );
  return { start, cancel };
}
