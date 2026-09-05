import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { epicRelationQueryKeys } from '@/ui/lib/epic-relations';
import { useEpicRelationCountsBatch } from './useEpicRelationCountsBatch';

// Layer: hook unit. The fetch factory and worktree runtime are mocked
// because this spec owns the batch URL, body, key stability, runtime-scope
// isolation, and the decorative-failure counts-map contract.
const fetchMock = jest.fn();

jest.mock('@/ui/hooks/useFetchFactory', () => ({
  useFetchFactory: () => fetchMock,
}));

const worktreeRuntime = {
  activeWorktree: null,
  setActiveWorktree: () => undefined,
  apiBase: '',
  worktrees: [],
  worktreesLoading: false,
  runtimeResolved: true,
};

jest.mock('@/ui/hooks/useWorktreeTab', () => ({
  useOptionalWorktreeTab: () => worktreeRuntime,
}));

function wrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function batchResponse(
  items: Array<{
    epicId: string;
    related: number;
    blocks: number;
    blockedBy: number;
    total: number;
    relatedSources?: number;
    relatedTargets?: number;
    relatedNeutral?: number;
  }>,
) {
  return { ok: true, json: async () => ({ items }) };
}

describe('useEpicRelationCountsBatch', () => {
  let client: QueryClient;

  beforeEach(() => {
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(batchResponse([]));
    worktreeRuntime.runtimeResolved = true;
    worktreeRuntime.apiBase = '';
  });

  afterEach(() => client.clear());

  it('posts the sorted deduplicated ID set and caches under the main scope', async () => {
    const { result } = renderHook(
      () => useEpicRelationCountsBatch(['epic-2', 'epic-1', 'epic-2']),
      { wrapper: wrapper(client) },
    );

    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));

    expect(fetchMock).toHaveBeenCalledWith('/api/epics/relations/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ epicIds: ['epic-1', 'epic-2'] }),
      signal: expect.any(AbortSignal),
    });
    expect(result.current.counts).toEqual(new Map());
    expect(client.getQueryData(epicRelationQueryKeys.batch(['epic-1', 'epic-2'], 'main'))).toEqual(
      new Map(),
    );
  });

  it('keeps one stable key regardless of input order and maps counts per Epic', async () => {
    fetchMock.mockResolvedValue(
      batchResponse([
        { epicId: 'epic-1', related: 2, blocks: 0, blockedBy: 1, total: 3 },
        { epicId: 'epic-2', related: 0, blocks: 4, blockedBy: 0, total: 4 },
      ]),
    );
    const first = renderHook(() => useEpicRelationCountsBatch(['epic-1', 'epic-2']), {
      wrapper: wrapper(client),
    });
    await waitFor(() => expect(first.result.current.query.isSuccess).toBe(true));

    const second = renderHook(() => useEpicRelationCountsBatch(['epic-2', 'epic-1']), {
      wrapper: wrapper(client),
    });
    await waitFor(() => expect(second.result.current.query.isSuccess).toBe(true));

    // Input order never forks the cache: both orders resolved through one
    // shared query entry (identical data object).
    expect(second.result.current.query.data).toBe(first.result.current.query.data);
    expect(first.result.current.counts?.get('epic-1')).toEqual({
      related: 2,
      blocks: 0,
      blockedBy: 1,
      total: 3,
    });
    expect(first.result.current.counts?.get('epic-2')).toEqual({
      related: 0,
      blocks: 4,
      blockedBy: 0,
      total: 4,
    });
    expect(first.result.current.counts?.get('epic-3')).toBeUndefined();
  });

  it('returns a stable empty map and issues no request while the runtime is unresolved', async () => {
    worktreeRuntime.runtimeResolved = false;
    const { result, rerender } = renderHook(() => useEpicRelationCountsBatch(['epic-1']), {
      wrapper: wrapper(client),
    });

    expect(result.current.counts).toEqual(new Map());
    expect(result.current.query.data).toBeUndefined();
    const disabledCounts = result.current.counts;
    rerender();
    // The empty map is reference-stable across disabled renders.
    expect(result.current.counts).toBe(disabledCounts);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns empty maps through any returned field after main-to-worktree and main-to-unresolved transitions', async () => {
    fetchMock.mockResolvedValue(
      batchResponse([{ epicId: 'epic-1', related: 1, blocks: 1, blockedBy: 0, total: 2 }]),
    );
    const { result, rerender } = renderHook(() => useEpicRelationCountsBatch(['epic-1']), {
      wrapper: wrapper(client),
    });

    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));
    expect(result.current.counts?.get('epic-1')?.total).toBe(2);
    expect(result.current.query.data?.get('epic-1')?.total).toBe(2);

    worktreeRuntime.apiBase = '/wt/demo';
    rerender();
    expect(result.current.counts).toEqual(new Map());
    expect(result.current.query.data).toBeUndefined();
    expect(result.current.query.isSuccess).toBe(false);

    worktreeRuntime.runtimeResolved = false;
    worktreeRuntime.apiBase = '';
    rerender();
    expect(result.current.counts).toEqual(new Map());
    expect(result.current.query.data).toBeUndefined();

    // Only the admitted main-scope observer issued a request.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The main cache entry itself survives for re-admission.
    expect(client.getQueryData(epicRelationQueryKeys.batch(['epic-1'], 'main'))).toBeDefined();
    // A worktree observer keys under an isolated scope, never the main one.
    expect(epicRelationQueryKeys.batch(['epic-1'], 'isolated')).not.toEqual(
      epicRelationQueryKeys.batch(['epic-1'], 'main'),
    );
    // Every variant stays under the batch-family prefix so one workspace
    // invalidation refreshes all of them.
    for (const scope of ['main', 'isolated'] as const) {
      const key = epicRelationQueryKeys.batch(['epic-1'], scope);
      expect(key.slice(0, epicRelationQueryKeys.batchRoot().length)).toEqual(
        epicRelationQueryKeys.batchRoot(),
      );
    }
  });

  it('re-admits to the primed main cache immediately after a disabled stretch', async () => {
    fetchMock.mockResolvedValue(
      batchResponse([{ epicId: 'epic-1', related: 0, blocks: 0, blockedBy: 1, total: 1 }]),
    );
    const { result, rerender } = renderHook(() => useEpicRelationCountsBatch(['epic-1']), {
      wrapper: wrapper(client),
    });

    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));

    worktreeRuntime.apiBase = '/wt/demo';
    rerender();
    expect(result.current.counts).toEqual(new Map());

    worktreeRuntime.apiBase = '';
    rerender();
    // The main cache entry serves the badge again right away; any later
    // refresh is a fresh main-scope request, not a disabled-scope leak.
    expect(result.current.counts?.get('epic-1')?.blockedBy).toBe(1);
  });

  it('issues no request for an empty ID set', () => {
    const { result } = renderHook(() => useEpicRelationCountsBatch([]), {
      wrapper: wrapper(client),
    });

    expect(result.current.counts).toEqual(new Map());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('leaves the map empty when the batch read fails', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 502 });
    const { result } = renderHook(() => useEpicRelationCountsBatch(['epic-1']), {
      wrapper: wrapper(client),
    });

    await waitFor(() => expect(result.current.query.isError).toBe(true));

    expect(result.current.counts).toEqual(new Map());
  });

  it('ignores malformed batch items instead of crashing the Board', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [{ epicId: 'epic-1' }, { related: 5 }, 'junk', null],
      }),
    });
    const { result } = renderHook(() => useEpicRelationCountsBatch(['epic-1']), {
      wrapper: wrapper(client),
    });

    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));

    expect(result.current.counts).toEqual(new Map());
  });

  it('admits a complete directional group consistent with the aggregate related count', async () => {
    fetchMock.mockResolvedValue(
      batchResponse([
        {
          epicId: 'epic-1',
          related: 3,
          blocks: 0,
          blockedBy: 0,
          total: 3,
          relatedSources: 1,
          relatedTargets: 2,
          relatedNeutral: 0,
        },
      ]),
    );
    const { result } = renderHook(() => useEpicRelationCountsBatch(['epic-1']), {
      wrapper: wrapper(client),
    });

    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));

    expect(result.current.counts?.get('epic-1')).toEqual({
      related: 3,
      blocks: 0,
      blockedBy: 0,
      total: 3,
      relatedSources: 1,
      relatedTargets: 2,
      relatedNeutral: 0,
    });
  });

  it('drops directional groups that are negative, non-finite, partial, or inconsistent', async () => {
    fetchMock.mockResolvedValue(
      batchResponse([
        {
          epicId: 'epic-1',
          related: 2,
          blocks: 0,
          blockedBy: 0,
          total: 2,
          relatedSources: -1,
          relatedTargets: 2,
          relatedNeutral: 1,
        },
        {
          epicId: 'epic-2',
          related: 2,
          blocks: 0,
          blockedBy: 0,
          total: 2,
          relatedSources: Number.NaN,
          relatedTargets: 2,
          relatedNeutral: 0,
        },
        {
          epicId: 'epic-3',
          related: 2,
          blocks: 0,
          blockedBy: 0,
          total: 2,
          relatedSources: 2,
        },
        {
          epicId: 'epic-4',
          related: 2,
          blocks: 0,
          blockedBy: 0,
          total: 2,
          relatedSources: 1,
          relatedTargets: 2,
          relatedNeutral: 1,
        },
      ]),
    );
    const { result } = renderHook(
      () => useEpicRelationCountsBatch(['epic-1', 'epic-2', 'epic-3', 'epic-4']),
      { wrapper: wrapper(client) },
    );

    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));

    // The aggregate counts survive every rejected group; only the
    // directional split is dropped, matching the legacy fallback shape.
    for (const epicId of ['epic-1', 'epic-2', 'epic-3', 'epic-4']) {
      expect(result.current.counts?.get(epicId)).toEqual({
        related: 2,
        blocks: 0,
        blockedBy: 0,
        total: 2,
      });
    }
  });

  it('returns an empty map and issues no request when explicitly disabled', async () => {
    const { result } = renderHook(
      () => useEpicRelationCountsBatch(['epic-1'], { enabled: false }),
      {
        wrapper: wrapper(client),
      },
    );

    expect(result.current.counts).toEqual(new Map());
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
