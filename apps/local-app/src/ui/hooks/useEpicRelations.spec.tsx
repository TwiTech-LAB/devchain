import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import {
  useDeleteEpicRelation,
  useEpicRelationCandidates,
  useEpicRelations,
  useSetEpicRelation,
} from '@/ui/hooks/useEpicRelations';
import {
  epicRelationQueryKeys,
  isEpicRelationConfirmationError,
  type EpicRelation,
} from '@/ui/lib/epic-relations';

// Layer: hook unit. Fetches are stubbed because this spec owns the React
// Query contracts: stable keys across pages, debounced candidate search, and
// mutation-driven cache invalidation over the shared relation key roots.
const fetchMock = jest.fn();

jest.mock('@/ui/hooks/useFetchFactory', () => ({
  useFetchFactory: () => fetchMock,
}));

const EPIC_ID = '11111111-1111-1111-1111-111111111111';
const RELATED_ID = '22222222-2222-2222-2222-222222222222';

function relationFixture(id: string, type: EpicRelation['type'], title: string): EpicRelation {
  return {
    relationId: `relation-${id}`,
    type,
    sourceEpicId: type === 'related' ? id : EPIC_ID,
    targetEpicId: type === 'related' ? EPIC_ID : id,
    relatedEpic: {
      id,
      shortId: id.slice(0, 8),
      title,
      status: { id: 'status-1', label: 'In Progress', color: '#2563eb' },
      project: { id: 'project-1', name: 'Demo Project' },
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

const relationPageOne = {
  items: [
    relationFixture(RELATED_ID, 'blocks', 'Second'),
    relationFixture(EPIC_ID, 'related', 'First'),
  ],
  total: 3,
  limit: 20,
  offset: 0,
};
const relationPageTwo = {
  items: [relationFixture('33333333-3333-3333-3333-333333333333', 'blocked_by', 'Third')],
  total: 3,
  limit: 20,
  offset: 2,
};
const candidatePage = {
  items: [
    {
      id: '44444444-4444-4444-4444-444444444444',
      shortId: '44444444',
      title: 'Auth Service',
      status: { id: 'status-1', label: 'In Progress', color: '#2563eb' },
      project: { id: 'project-2', name: 'Other Project' },
      parentId: null,
    },
  ],
  total: 1,
  limit: 20,
  offset: 0,
};

function jsonResponse(data: unknown): Response {
  return { ok: true, json: async () => data } as Response;
}

const DETAIL_URL_PAGE_ONE = `/api/epics/${EPIC_ID}/relations?limit=20&offset=0`;
// The cursor is rows served so far (offset + items.length), not a fixed step.
const DETAIL_URL_PAGE_TWO = `/api/epics/${EPIC_ID}/relations?limit=20&offset=2`;
const CANDIDATE_URL_FOR = (q: string) =>
  `/api/epics/${EPIC_ID}/relation-candidates?${q ? `q=${q}&` : ''}limit=20&offset=0`;

function installFetchMock() {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url === DETAIL_URL_PAGE_ONE) return jsonResponse(relationPageOne);
    if (url === DETAIL_URL_PAGE_TWO) return jsonResponse(relationPageTwo);
    if (url.startsWith(`/api/epics/${EPIC_ID}/relation-candidates`)) {
      return jsonResponse(candidatePage);
    }
    if (
      url === `/api/epics/${EPIC_ID}/relations/${RELATED_ID}` &&
      (method === 'PUT' || method === 'DELETE')
    ) {
      return jsonResponse(relationFixture(RELATED_ID, 'blocks', 'Second'));
    }
    if (url === `/api/epics/${RELATED_ID}/relations/${EPIC_ID}` && method === 'PUT') {
      return jsonResponse(relationFixture(RELATED_ID, 'related', 'Second'));
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  });
}

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { Wrapper, queryClient };
}

describe('useEpicRelations', () => {
  beforeEach(() => {
    installFetchMock();
  });

  it('loads the first bounded relations page under the detail key', async () => {
    const { Wrapper } = createWrapper();
    const { result } = renderHook(() => useEpicRelations(EPIC_ID), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchMock).toHaveBeenCalledWith(DETAIL_URL_PAGE_ONE, { signal: expect.anything() });
    expect(result.current.data?.pages[0]?.items).toHaveLength(2);
    expect(result.current.data?.pages[0]?.total).toBe(3);
  });

  it('load-more requests the next offset without fragmenting the cache', async () => {
    const { Wrapper, queryClient } = createWrapper();
    const { result } = renderHook(() => useEpicRelations(EPIC_ID), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.hasNextPage).toBe(true);

    await act(async () => {
      await result.current.fetchNextPage();
    });

    expect(fetchMock).toHaveBeenCalledWith(DETAIL_URL_PAGE_TWO, { signal: expect.anything() });
    await waitFor(() => expect(result.current.data?.pages).toHaveLength(2));
    expect(queryClient.getQueryCache().findAll()).toHaveLength(1);
    expect(queryClient.getQueryData(epicRelationQueryKeys.detail(EPIC_ID))).toMatchObject({
      pages: [{ offset: 0 }, { offset: 2 }],
    });
  });
});

describe('useEpicRelationCandidates', () => {
  beforeEach(() => {
    installFetchMock();
  });

  it('searches only after the term settles and never fires superseded terms', async () => {
    jest.useFakeTimers();
    try {
      const { Wrapper } = createWrapper();
      const { rerender } = renderHook(
        ({ q }: { q: string }) => useEpicRelationCandidates(EPIC_ID, q, { debounceMs: 250 }),
        { wrapper: Wrapper, initialProps: { q: '' } },
      );

      rerender({ q: 'rel' });
      await act(async () => {
        await jest.advanceTimersByTimeAsync(100);
      });
      rerender({ q: 'release' });
      await act(async () => {
        await jest.advanceTimersByTimeAsync(249);
      });

      expect(fetchMock).not.toHaveBeenCalledWith(CANDIDATE_URL_FOR('rel'), expect.anything());
      expect(fetchMock).not.toHaveBeenCalledWith(CANDIDATE_URL_FOR('release'), expect.anything());

      // Settle the debounce, then flush the query fetch it schedules. RTL
      // waitFor is deliberately avoided here: driving it under fake timers
      // leaks into later tests in this file.
      await act(async () => {
        await jest.advanceTimersByTimeAsync(300);
      });

      expect(fetchMock).toHaveBeenCalledWith(CANDIDATE_URL_FOR('release'), {
        signal: expect.anything(),
      });
      expect(fetchMock).not.toHaveBeenCalledWith(CANDIDATE_URL_FOR('rel'), expect.anything());
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps one stable cache entry per settled search term', async () => {
    const { Wrapper, queryClient } = createWrapper();
    const { result, rerender } = renderHook(
      ({ q }: { q: string }) => useEpicRelationCandidates(EPIC_ID, q, { debounceMs: 0 }),
      { wrapper: Wrapper, initialProps: { q: '' } },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(queryClient.getQueryCache().findAll()).toHaveLength(1);

    rerender({ q: 'auth' });
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(CANDIDATE_URL_FOR('auth'), {
        signal: expect.anything(),
      }),
    );
    expect(
      queryClient
        .getQueryCache()
        .find({ queryKey: epicRelationQueryKeys.candidates(EPIC_ID, 'auth', 20, 0) }),
    ).toBeDefined();
  });
});

describe('relation mutations', () => {
  beforeEach(() => {
    installFetchMock();
  });

  it('PUTs endpoint order as direction and invalidates detail, candidate, and badge caches', async () => {
    const { Wrapper, queryClient } = createWrapper();
    const batchKey = epicRelationQueryKeys.batch([EPIC_ID, RELATED_ID]);
    queryClient.setQueryData(batchKey, new Map());
    const { result } = renderHook(
      () => ({
        list: useEpicRelations(EPIC_ID),
        candidates: useEpicRelationCandidates(EPIC_ID, '', { debounceMs: 0 }),
        set: useSetEpicRelation(),
      }),
      { wrapper: Wrapper },
    );

    await waitFor(() => expect(result.current.list.isSuccess).toBe(true));
    await waitFor(() => expect(result.current.candidates.isSuccess).toBe(true));

    act(() => {
      result.current.set.mutate({
        sourceEpicId: EPIC_ID,
        targetEpicId: RELATED_ID,
        type: 'blocks',
      });
    });

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/epics/${EPIC_ID}/relations/${RELATED_ID}`,
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({ type: 'blocks' }),
        }),
      ),
    );

    await waitFor(() => {
      const detailReads = fetchMock.mock.calls.filter(
        ([input]) => String(input) === DETAIL_URL_PAGE_ONE,
      );
      expect(detailReads.length).toBeGreaterThan(1);
    });
    await waitFor(() => {
      const candidateReads = fetchMock.mock.calls.filter(
        ([input]) => String(input) === CANDIDATE_URL_FOR(''),
      );
      expect(candidateReads.length).toBeGreaterThan(1);
    });
    expect(queryClient.getQueryState(batchKey)?.isInvalidated).toBe(true);
  });

  it('PUTs the pair reversed when the arrow swaps source and target', async () => {
    const { Wrapper } = createWrapper();
    const { result } = renderHook(() => useSetEpicRelation(), { wrapper: Wrapper });

    act(() => {
      result.current.mutate({
        sourceEpicId: RELATED_ID,
        targetEpicId: EPIC_ID,
        type: 'related',
      });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchMock).toHaveBeenLastCalledWith(
      `/api/epics/${RELATED_ID}/relations/${EPIC_ID}`,
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ type: 'related' }),
      }),
    );
  });

  it('DELETEs the pair without confirmation parameters and invalidates caches', async () => {
    const { Wrapper } = createWrapper();
    const { result } = renderHook(
      () => ({
        list: useEpicRelations(EPIC_ID),
        candidates: useEpicRelationCandidates(EPIC_ID, '', { debounceMs: 0 }),
        remove: useDeleteEpicRelation(EPIC_ID),
      }),
      { wrapper: Wrapper },
    );

    await waitFor(() => expect(result.current.list.isSuccess).toBe(true));
    await waitFor(() => expect(result.current.candidates.isSuccess).toBe(true));

    act(() => {
      result.current.remove.mutate({ relatedEpicId: RELATED_ID });
    });

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/epics/${EPIC_ID}/relations/${RELATED_ID}`,
        expect.objectContaining({ method: 'DELETE' }),
      ),
    );

    await waitFor(() => {
      const detailReads = fetchMock.mock.calls.filter(
        ([input]) => String(input) === DETAIL_URL_PAGE_ONE,
      );
      expect(detailReads.length).toBeGreaterThan(1);
    });
    await waitFor(() => {
      const candidateReads = fetchMock.mock.calls.filter(
        ([input]) => String(input) === CANDIDATE_URL_FOR(''),
      );
      expect(candidateReads.length).toBeGreaterThan(1);
    });
  });

  it('preserves the typed 409 facts and echoes them exactly on the retry', async () => {
    const { Wrapper } = createWrapper();
    const { result } = renderHook(() => useSetEpicRelation(), { wrapper: Wrapper });
    const effect = { sourceEpicId: RELATED_ID, targetEpicId: EPIC_ID };
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({
        statusCode: 409,
        code: 'relation_confirmation_required',
        message: 'Confirm the current route effect.',
        details: { currentEffect: effect },
      }),
    } as Response);

    act(() => {
      result.current.mutate({ sourceEpicId: EPIC_ID, targetEpicId: RELATED_ID, type: 'related' });
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    const error = result.current.error;
    expect(isEpicRelationConfirmationError(error)).toBe(true);
    if (isEpicRelationConfirmationError(error)) {
      expect(error.currentEffect).toEqual(effect);
    }
    expect(error?.message).toBe('Confirm the current route effect.');

    // A disappeared effect completes the write on the echoed-facts retry,
    // so the flow never loops.
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ relationId: 'relation-1', type: 'related' }),
    } as Response);
    act(() => {
      result.current.mutate({
        sourceEpicId: EPIC_ID,
        targetEpicId: RELATED_ID,
        type: 'related',
        confirmation: { acceptedRouteEffect: effect },
      });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchMock).toHaveBeenLastCalledWith(
      `/api/epics/${EPIC_ID}/relations/${RELATED_ID}`,
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({
          type: 'related',
          confirmation: { acceptedRouteEffect: effect },
        }),
      }),
    );
  });
});
