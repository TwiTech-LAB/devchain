import { useEffect, useMemo, useRef } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useHomeQueryClient } from '@/ui/components/BackendBoundary';
import { HOME_BACKEND, apiFetch } from '@/ui/lib/api-transport';
import { useToastHelpers } from '@/ui/lib/toast-helpers';
import type { OpencodeLoginDto } from '@/modules/provider-auth/provider-auth.dto';
import type { ProviderAuthPayloadKind } from '@/modules/storage/models/domain.models';

/** Vault metadata only; the server never sends payloads or ciphertext. */
export interface ProviderAuthEntryItem {
  id: string;
  provider: string;
  kind: 'static' | 'family';
  label: string;
  payloadKind: ProviderAuthPayloadKind;
  checkedOutRemoteId: string | null;
  createdAt: string;
  updatedAt: string;
  lastVerifiedAt: string | null;
  lastWritebackAt: string | null;
}

export interface ProviderAuthReleaseView {
  entry: ProviderAuthEntryItem;
  pullStatus: 'pulled' | 'offline' | 'not-needed';
}

export type ImportResult =
  | { providerId: string; outcome: 'imported'; entryId: string }
  | { providerId: string; outcome: 'refused'; reason: string }
  | { providerId: string; outcome: 'missing' };

/** One login of this PC's OpenCode auth file: an id and a fixed type, never a credential value. */
export type OpencodeLoginItem = OpencodeLoginDto;

export interface ProviderAuthGenerationView {
  id: string;
  provider: string;
  sessionId: string;
  state: 'waiting' | 'verifying' | 'stored' | 'failed' | 'cancelled' | 'timed_out';
  startedAt: string;
  finishedAt: string | null;
  entries: ProviderAuthEntryItem[];
  error: string | null;
}

export const providerAuthKeys = {
  all: [HOME_BACKEND, 'provider-auth'] as const,
};

async function send(path: string, init?: RequestInit): Promise<Response> {
  const response = await apiFetch(path, init, { backend: HOME_BACKEND });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.message ?? `Provider auth request failed (${response.status})`);
  }
  return response;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  return (await send(path, init)).json();
}

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

/**
 * Vault entries and their mutations, on the home client so the panel works
 * whatever project is active. Token values are typed `string` and sent once;
 * they are never stored in query caches beyond the request.
 */
export function useProviderAuth() {
  const client = useHomeQueryClient();
  const { toast, showError } = useToastHelpers();

  const entries = useQuery(
    {
      queryKey: providerAuthKeys.all,
      queryFn: async ({ signal }) =>
        (await request<{ items: ProviderAuthEntryItem[] }>('/api/provider-auth', { signal })).items,
    },
    client,
  );
  // A stable empty array: consumers key effects on this value.
  const items = useMemo(() => entries.data ?? [], [entries.data]);

  const invalidate = () => void client.invalidateQueries({ queryKey: providerAuthKeys.all });

  const createStatic = useMutation(
    {
      mutationFn: (body: Record<string, string>) =>
        request<ProviderAuthEntryItem>('/api/provider-auth/static', {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify(body),
        }),
      onSuccess: invalidate,
      onError: (error: Error) =>
        showError({ title: 'Could not store the token', description: error.message }),
    },
    client,
  );

  const importOpencode = useMutation(
    {
      mutationFn: (providerIds: string[]) =>
        request<{ results: ImportResult[] }>('/api/provider-auth/opencode-import', {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({ providerIds }),
        }),
      onSuccess: invalidate,
      onError: (error: Error) =>
        showError({ title: 'OpenCode import failed', description: error.message }),
    },
    client,
  );

  const remove = useMutation(
    {
      mutationFn: (id: string) =>
        // DELETE answers with an empty body, so it is not parsed.
        send(`/api/provider-auth/${id}`, { method: 'DELETE' }).then(() => undefined),
      onSuccess: invalidate,
      onError: (error: Error) =>
        showError({ title: 'Could not delete the entry', description: error.message }),
    },
    client,
  );

  const rename = useMutation(
    {
      mutationFn: (input: { id: string; label: string }) =>
        request<ProviderAuthEntryItem>(`/api/provider-auth/${input.id}`, {
          method: 'PATCH',
          headers: JSON_HEADERS,
          body: JSON.stringify({ label: input.label }),
        }),
      onSuccess: invalidate,
      // The row shows a refusal inline; an error toast here would repeat it.
    },
    client,
  );

  const release = useMutation(
    {
      mutationFn: (id: string) =>
        request<ProviderAuthReleaseView>(`/api/provider-auth/${id}/release`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({}),
        }),
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
  const client = useHomeQueryClient();
  const query = useQuery(
    {
      queryKey: [...providerAuthKeys.all, 'opencode-logins'],
      queryFn: async ({ signal }) =>
        (
          await request<{ logins: OpencodeLoginItem[] }>('/api/provider-auth/opencode-logins', {
            signal,
          })
        ).logins,
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

/**
 * Polls one login generation until it settles. `null` disables the poll, so
 * the dialog can stop asking once it closes.
 */
export function useProviderAuthGeneration(generationId: string | null) {
  const client = useHomeQueryClient();
  const invalidatedStoredGenerationIds = useRef(new Set<string>());
  const query = useQuery(
    {
      queryKey: [HOME_BACKEND, 'provider-auth', 'generation', generationId],
      enabled: generationId !== null,
      refetchInterval: (poll: { state: { data?: ProviderAuthGenerationView | undefined } }) =>
        poll.state.data && isGenerationTerminal(poll.state.data.state) ? false : 1000,
      queryFn: async ({ signal }) => {
        if (generationId === null) throw new Error('No generation selected');
        return request<ProviderAuthGenerationView>(`/api/provider-auth/generate/${generationId}`, {
          signal,
        });
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
  const client = useHomeQueryClient();
  const { showError } = useToastHelpers();
  const invalidate = () => void client.invalidateQueries({ queryKey: providerAuthKeys.all });
  const start = useMutation(
    {
      mutationFn: (body: { provider: string; label?: string }) =>
        request<ProviderAuthGenerationView>('/api/provider-auth/generate', {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify(body),
        }),
      onError: (error: Error) =>
        showError({ title: 'Could not start the login', description: error.message }),
    },
    client,
  );
  const cancel = useMutation(
    {
      mutationFn: (generationId: string) =>
        request<ProviderAuthGenerationView>(`/api/provider-auth/generate/${generationId}/cancel`, {
          method: 'POST',
        }).then(() => undefined),
      onSuccess: invalidate,
      onError: (error: Error) =>
        showError({ title: 'Could not cancel the login', description: error.message }),
    },
    client,
  );
  return { start, cancel };
}
