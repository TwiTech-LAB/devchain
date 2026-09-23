import { useEffect, useState } from 'react';
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import { useFetchFactory } from '@/ui/hooks/useFetchFactory';
import {
  epicRelationQueryKeys,
  nextEpicRelationOffset,
  EpicRelationConfirmationError,
  type EpicRelation,
  type EpicRelationCandidatePage,
  type EpicRelationPage,
  type EpicRelationRouteEffect,
  type EpicRelationType,
} from '@/ui/lib/epic-relations';

const RELATION_PAGE_SIZE = 20;
const CANDIDATE_SEARCH_DEBOUNCE_MS = 250;

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * A relation write. The write's endpoint order defines direction: the source
 * Epic is the first address and the target Epic the second, so a direction
 * swap is simply a write with the pair reversed. `type` is relative to the
 * source address ('blocks' means the source blocks the target).
 */
export interface SetEpicRelationInput {
  sourceEpicId: string;
  targetEpicId: string;
  type: EpicRelationType;
  /** Echo of the server facts issued with a relation_confirmation_required 409. */
  confirmation?: { acceptedRouteEffect: EpicRelationRouteEffect };
}

export interface DeleteEpicRelationInput {
  relatedEpicId: string;
}

export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

function buildPageParams(q: string, limit: number, offset: number): string {
  const params = new URLSearchParams();
  const trimmed = q.trim();
  if (trimmed) {
    params.set('q', trimmed);
  }
  params.set('limit', String(limit));
  params.set('offset', String(offset));
  return params.toString();
}

interface RelationErrorPayload {
  code?: unknown;
  message?: unknown;
  details?: { currentEffect?: { sourceEpicId?: unknown; targetEpicId?: unknown } } | undefined;
}

function isRouteEffect(value: unknown): value is EpicRelationRouteEffect {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.sourceEpicId === 'string' && typeof record.targetEpicId === 'string';
}

async function parseRequestError(res: Response, fallback: string): Promise<Error> {
  const payload = (await res.json().catch(() => null)) as RelationErrorPayload | null;
  // The typed 409 carries the server-issued route facts the retry must echo
  // exactly; anything else degrades to its message.
  if (res.status === 409 && payload?.code === 'relation_confirmation_required') {
    const effect = payload.details?.currentEffect;
    if (isRouteEffect(effect)) {
      return new EpicRelationConfirmationError(
        typeof payload.message === 'string' && payload.message.length > 0
          ? payload.message
          : fallback,
        effect,
      );
    }
  }
  return new Error(
    typeof payload?.message === 'string' && payload.message.length > 0 ? payload.message : fallback,
  );
}

async function fetchEpicRelationPage(
  epicId: string,
  options: { limit: number; offset: number; signal: AbortSignal; fetchFn: FetchFn },
): Promise<EpicRelationPage> {
  const params = buildPageParams('', options.limit, options.offset);
  const res = await options.fetchFn(
    `/api/epics/${encodeURIComponent(epicId)}/relations?${params.toString()}`,
    { signal: options.signal },
  );
  if (!res.ok) {
    throw await parseRequestError(res, 'Epic relations could not be loaded.');
  }
  const page = (await res.json()) as EpicRelationPage;
  if (!Array.isArray(page.items)) {
    throw new Error('Epic relations could not be loaded.');
  }
  return page;
}

async function fetchEpicRelationCandidatePage(
  epicId: string,
  options: {
    q: string;
    limit: number;
    offset: number;
    signal: AbortSignal;
    fetchFn: FetchFn;
  },
): Promise<EpicRelationCandidatePage> {
  const params = buildPageParams(options.q, options.limit, options.offset);
  const res = await options.fetchFn(
    `/api/epics/${encodeURIComponent(epicId)}/relation-candidates?${params.toString()}`,
    { signal: options.signal },
  );
  if (!res.ok) {
    throw await parseRequestError(res, 'Relation candidates could not be loaded.');
  }
  const page = (await res.json()) as EpicRelationCandidatePage;
  if (!Array.isArray(page.items)) {
    throw new Error('Relation candidates could not be loaded.');
  }
  return page;
}

async function requestSetEpicRelation(
  input: SetEpicRelationInput,
  fetchFn: FetchFn,
): Promise<EpicRelation> {
  const body: { type: EpicRelationType; confirmation?: SetEpicRelationInput['confirmation'] } = {
    type: input.type,
  };
  if (input.confirmation !== undefined) {
    body.confirmation = input.confirmation;
  }
  const res = await fetchFn(
    `/api/epics/${encodeURIComponent(input.sourceEpicId)}/relations/${encodeURIComponent(input.targetEpicId)}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    throw await parseRequestError(res, 'The relation could not be saved.');
  }
  return res.json();
}

async function requestDeleteEpicRelation(
  epicId: string,
  input: DeleteEpicRelationInput,
  fetchFn: FetchFn,
): Promise<void> {
  // Explicit pair deletion is intentionally unconfirmed: it is the remedy for
  // a blocked replacement.
  const res = await fetchFn(
    `/api/epics/${encodeURIComponent(epicId)}/relations/${encodeURIComponent(input.relatedEpicId)}`,
    { method: 'DELETE' },
  );
  if (!res.ok) {
    throw await parseRequestError(res, 'The relation could not be removed.');
  }
}

/**
 * Paginated focal-relative relations. The cache key is page-agnostic by design:
 * realtime workspace invalidation (`ui/hooks/useEpicRelationsSync.ts`) refetches
 * exactly the pages already loaded instead of fragmenting the cache per page.
 */
export function useEpicRelations(
  epicId: string,
  { enabled = true, pageSize = RELATION_PAGE_SIZE }: { enabled?: boolean; pageSize?: number } = {},
) {
  const apiFetch = useFetchFactory();
  return useInfiniteQuery({
    queryKey: epicRelationQueryKeys.detail(epicId),
    initialPageParam: 0,
    queryFn: ({ signal, pageParam }) =>
      fetchEpicRelationPage(epicId, {
        limit: pageSize,
        offset: pageParam,
        signal,
        fetchFn: apiFetch,
      }),
    enabled: enabled && epicId !== '',
    getNextPageParam: nextEpicRelationOffset,
  });
}

/** Same-workspace candidate search; the query fires only after `q` settles. */
export function useEpicRelationCandidates(
  epicId: string,
  q: string,
  {
    enabled = true,
    pageSize = RELATION_PAGE_SIZE,
    debounceMs = CANDIDATE_SEARCH_DEBOUNCE_MS,
  }: { enabled?: boolean; pageSize?: number; debounceMs?: number } = {},
) {
  const apiFetch = useFetchFactory();
  const debouncedQ = useDebouncedValue(q, debounceMs);
  const trimmed = debouncedQ.trim();
  return useInfiniteQuery({
    queryKey: epicRelationQueryKeys.candidates(epicId, trimmed, pageSize, 0),
    initialPageParam: 0,
    queryFn: ({ signal, pageParam }) =>
      fetchEpicRelationCandidatePage(epicId, {
        q: trimmed,
        limit: pageSize,
        offset: pageParam,
        signal,
        fetchFn: apiFetch,
      }),
    enabled: enabled && epicId !== '',
    placeholderData: keepPreviousData,
    getNextPageParam: nextEpicRelationOffset,
  });
}

export function useSetEpicRelation() {
  const apiFetch = useFetchFactory();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SetEpicRelationInput) => requestSetEpicRelation(input, apiFetch),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: epicRelationQueryKeys.detailRoot() });
      void queryClient.invalidateQueries({ queryKey: epicRelationQueryKeys.candidateRoot() });
      void queryClient.invalidateQueries({ queryKey: epicRelationQueryKeys.batchRoot() });
    },
  });
}

export function useDeleteEpicRelation(epicId: string) {
  const apiFetch = useFetchFactory();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: DeleteEpicRelationInput) =>
      requestDeleteEpicRelation(epicId, input, apiFetch),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: epicRelationQueryKeys.detailRoot() });
      void queryClient.invalidateQueries({ queryKey: epicRelationQueryKeys.candidateRoot() });
      // The Board badge counts refresh here rather than waiting for the
      // realtime invalidation event to arrive.
      void queryClient.invalidateQueries({ queryKey: epicRelationQueryKeys.batchRoot() });
    },
  });
}
