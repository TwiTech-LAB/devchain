import { queryOptions } from '@tanstack/react-query';
import type {
  ListResult,
  PromptListFilters,
  PromptSummary,
} from '@/modules/storage/interfaces/storage.interface';
import type { Prompt } from '@/modules/storage/models/domain.models';
import type { FetchFn } from './api-transport';
import { fetchJsonOrThrow, SessionApiError } from './sessions';

export type { Prompt, PromptSummary };
export type PromptsResponse = ListResult<PromptSummary>;
export type PromptListParams = Pick<PromptListFilters, 'q' | 'limit' | 'offset'>;
export type PromptSearchParams = Required<PromptListParams>;

export const promptQueryKeys = {
  project: (projectId: string | null | undefined) => ['prompts', projectId] as const,
  list: (projectId: string | null | undefined) => ['prompts', projectId, 'list'] as const,
  search: (projectId: string | null | undefined, params: PromptSearchParams) =>
    ['prompts', projectId, 'search', params] as const,
};

export function fetchPrompts(
  fetchFn: FetchFn,
  projectId: string | null,
  params: PromptListParams = {},
  signal?: AbortSignal,
): Promise<PromptsResponse> {
  const query = new URLSearchParams({ projectId: projectId ?? '' });
  if (params.q !== undefined) query.set('q', params.q);
  if (params.limit !== undefined) query.set('limit', String(params.limit));
  if (params.offset !== undefined) query.set('offset', String(params.offset));

  return fetchJsonOrThrow(
    `/api/prompts?${query.toString()}`,
    signal ? { signal } : {},
    'Failed to fetch prompts',
    fetchFn,
  );
}

async function fetchPromptSuggestions(
  fetchFn: FetchFn,
  projectId: string | null | undefined,
  params: PromptSearchParams,
): Promise<PromptsResponse> {
  const empty: PromptsResponse = {
    items: [],
    total: 0,
    limit: params.limit,
    offset: params.offset,
  };
  if (projectId === undefined) return empty;
  try {
    return await fetchPrompts(fetchFn, projectId, params);
  } catch (error) {
    // Autocomplete is decorative; HTTP failures must not block instruction editing.
    if (error instanceof SessionApiError) return empty;
    throw error;
  }
}

export function selectPromptRows(data: PromptsResponse): PromptSummary[] {
  return data.items ?? [];
}

export const promptQueries = {
  list: (fetchFn: FetchFn, projectId: string | null | undefined) =>
    queryOptions({
      queryKey: promptQueryKeys.list(projectId),
      queryFn: () => fetchPrompts(fetchFn, projectId!),
    }),
  search: (fetchFn: FetchFn, projectId: string | null | undefined, params: PromptSearchParams) =>
    queryOptions({
      queryKey: promptQueryKeys.search(projectId, params),
      queryFn: () => fetchPromptSuggestions(fetchFn, projectId, params),
    }),
};
