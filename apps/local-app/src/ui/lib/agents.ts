import { queryOptions } from '@tanstack/react-query';
import type { AgentOrGuestItem } from '@/modules/agents/controllers/agents.controller';
import type { ListResult } from '@/modules/storage/interfaces/storage.interface';
import type { Agent } from '@/modules/storage/models/domain.models';
import type { FetchFn } from './api-transport';
import { fetchJsonOrThrow } from './sessions';

export type { Agent, AgentOrGuestItem };

export const agentQueryKeys = {
  project: <T extends string | null | undefined>(projectId: T) => ['agents', projectId] as const,
  list: <T extends string | null | undefined>(projectId: T) =>
    ['agents', projectId, 'list'] as const,
  withGuests: <T extends string | null | undefined>(projectId: T) =>
    ['agents', projectId, 'with-guests'] as const,
};

export function fetchAgents(fetchFn: FetchFn, projectId: string): Promise<ListResult<Agent>> {
  return fetchJsonOrThrow(
    `/api/agents?projectId=${encodeURIComponent(projectId)}`,
    {},
    'Failed to fetch agents',
    fetchFn,
  );
}

export function fetchAgentsWithGuests(
  fetchFn: FetchFn,
  projectId: string,
): Promise<ListResult<AgentOrGuestItem>> {
  return fetchJsonOrThrow(
    `/api/agents?projectId=${encodeURIComponent(projectId)}&includeGuests=true`,
    {},
    'Failed to fetch agents',
    fetchFn,
  );
}

export const agentQueries = {
  list: (fetchFn: FetchFn, projectId: string | null | undefined) =>
    queryOptions({
      queryKey: agentQueryKeys.list(projectId),
      queryFn: () => fetchAgents(fetchFn, projectId!),
    }),
  withGuests: (fetchFn: FetchFn, projectId: string | null | undefined) =>
    queryOptions({
      queryKey: agentQueryKeys.withGuests(projectId),
      queryFn: () => fetchAgentsWithGuests(fetchFn, projectId!),
    }),
};
