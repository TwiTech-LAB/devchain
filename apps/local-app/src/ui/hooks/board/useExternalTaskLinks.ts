import { useMemo } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type {
  ExternalTaskLinkLookupInput,
  ExternalTaskLinkStateSummary,
} from '@/modules/external-integrations/models/external-provider.models';
import { useFetchFactory } from '@/ui/hooks/useFetchFactory';
import type { ExternalBoardProvider } from '@/ui/lib/external-board';
import { externalMyWorkQueryKeys } from '@/ui/lib/external-my-work';
import type { IntegrationConnectionEpoch } from '@/ui/lib/integration-connections';
import {
  validIntegrationProjectId,
  withIntegrationProjectId,
} from '@/ui/lib/integration-project-scope';

const MAX_LINK_BATCH_ITEMS = 1_000;

function identityKey(input: ExternalTaskLinkLookupInput): string {
  return `${input.scopeKey}\u0000${input.taskId}`;
}

function normalizeLinkInputs(inputs: ExternalTaskLinkLookupInput[]): ExternalTaskLinkLookupInput[] {
  const byIdentity = new Map<string, ExternalTaskLinkLookupInput>();
  for (const input of inputs) {
    byIdentity.set(identityKey(input), { scopeKey: input.scopeKey, taskId: input.taskId });
  }
  return [...byIdentity.values()].sort(
    (left, right) =>
      left.scopeKey.localeCompare(right.scopeKey) || left.taskId.localeCompare(right.taskId),
  );
}

function chunkLinkInputs(inputs: ExternalTaskLinkLookupInput[]): ExternalTaskLinkLookupInput[][] {
  const chunks: ExternalTaskLinkLookupInput[][] = [];
  for (let index = 0; index < inputs.length; index += MAX_LINK_BATCH_ITEMS) {
    chunks.push(inputs.slice(index, index + MAX_LINK_BATCH_ITEMS));
  }
  return chunks;
}

export function useExternalTaskLinks(
  provider: ExternalBoardProvider,
  inputs: ExternalTaskLinkLookupInput[],
  {
    enabled = true,
    connectionEpoch,
    includeLoggedMinutes = false,
    projectId,
  }: {
    enabled?: boolean;
    connectionEpoch: IntegrationConnectionEpoch | null;
    includeLoggedMinutes?: boolean;
    projectId: string | null;
  },
) {
  const apiFetch = useFetchFactory();
  const scopedProjectId = validIntegrationProjectId(projectId);
  const normalized = useMemo(() => normalizeLinkInputs(inputs), [inputs]);
  const chunks = useMemo(() => chunkLinkInputs(normalized), [normalized]);
  const query = useQuery({
    queryKey: [
      ...externalMyWorkQueryKeys.linksBatch(provider, connectionEpoch, includeLoggedMinutes),
      normalized,
    ],
    queryFn: async ({ signal }): Promise<{ items: ExternalTaskLinkStateSummary[] }> => {
      // One logical decoration query: every chunk must settle, so a single
      // failed chunk fails the whole result instead of partial decoration.
      const batches = await Promise.all(
        chunks.map(async (chunk) => {
          const response = await apiFetch(
            withIntegrationProjectId(
              `/api/integrations/my-work/${provider}/links/batch`,
              scopedProjectId,
            ),
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ items: chunk, includeLoggedMinutes }),
              signal,
            },
          );
          if (!response.ok) throw new Error('DevChain link state could not be loaded.');
          return (await response.json()) as { items: ExternalTaskLinkStateSummary[] };
        }),
      );
      return { items: batches.flatMap((batch) => batch.items) };
    },
    enabled:
      enabled && connectionEpoch !== null && scopedProjectId !== null && normalized.length > 0,
    // Completed moves shrink the input set; keeping the previous page as
    // placeholder data stops remaining link badges from blinking off and on.
    placeholderData: keepPreviousData,
  });

  // Placeholder data belongs to a previous input set: link badges may keep it,
  // but time figures must never render from it.
  const data =
    query.isPlaceholderData && query.data
      ? { items: query.data.items.map((item) => ({ ...item, loggedMinutes: null })) }
      : query.data;

  return {
    ...query,
    data: enabled ? data : undefined,
  };
}
