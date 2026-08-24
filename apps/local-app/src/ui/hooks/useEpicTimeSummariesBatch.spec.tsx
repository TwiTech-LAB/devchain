import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { epicTimeQueryKeys, resolveEpicTimeZone } from '@/ui/lib/epic-time';
import { useEpicTimeSummariesBatch } from './useEpicTimeSummariesBatch';

// Layer: hook unit. The fetch factory and worktree runtime are mocked
// because this spec owns the batch URL, body, key stability, runtime
// gating, and totals-map contract.
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

function batchResponse(items: Array<{ epicId: string; totalMinutes: number }>) {
  return { ok: true, json: async () => ({ items }) };
}

describe('useEpicTimeSummariesBatch', () => {
  let client: QueryClient;
  const timeZone = resolveEpicTimeZone();

  beforeEach(() => {
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(batchResponse([]));
    worktreeRuntime.runtimeResolved = true;
    worktreeRuntime.apiBase = '';
  });

  afterEach(() => client.clear());

  it('posts the sorted deduplicated ID set with the time zone', async () => {
    const { result } = renderHook(() => useEpicTimeSummariesBatch(['epic-2', 'epic-1', 'epic-2']), {
      wrapper: wrapper(client),
    });

    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));

    expect(fetchMock).toHaveBeenCalledWith('/api/epics/time-summary/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ epicIds: ['epic-1', 'epic-2'], timeZone }),
      signal: expect.any(AbortSignal),
    });
    expect(result.current.totals).toEqual(new Map());
    expect(client.getQueryData(epicTimeQueryKeys.batch(['epic-1', 'epic-2'], timeZone))).toEqual(
      new Map(),
    );
  });

  it('keeps one stable key regardless of input order and maps totals per Epic', async () => {
    fetchMock.mockResolvedValue(
      batchResponse([
        { epicId: 'epic-1', totalMinutes: 90 },
        { epicId: 'epic-2', totalMinutes: 30 },
      ]),
    );
    const first = renderHook(() => useEpicTimeSummariesBatch(['epic-1', 'epic-2']), {
      wrapper: wrapper(client),
    });
    await waitFor(() => expect(first.result.current.query.isSuccess).toBe(true));

    const second = renderHook(() => useEpicTimeSummariesBatch(['epic-2', 'epic-1']), {
      wrapper: wrapper(client),
    });
    await waitFor(() => expect(second.result.current.query.isSuccess).toBe(true));

    // Input order never forks the cache: both orders resolved through one
    // shared query entry (identical data object).
    expect(second.result.current.query.data).toBe(first.result.current.query.data);
    expect(first.result.current.totals?.get('epic-1')).toBe(90);
    expect(first.result.current.totals?.get('epic-2')).toBe(30);
    expect(first.result.current.totals?.get('epic-3')).toBeUndefined();
  });

  it('issues no request while the runtime is unresolved', async () => {
    worktreeRuntime.runtimeResolved = false;
    const { result } = renderHook(() => useEpicTimeSummariesBatch(['epic-1']), {
      wrapper: wrapper(client),
    });

    expect(result.current.totals).toBeUndefined();
    expect(result.current.query.data).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('exposes no main result through any returned field after main-to-worktree and main-to-unresolved transitions', async () => {
    fetchMock.mockResolvedValue(batchResponse([{ epicId: 'epic-1', totalMinutes: 90 }]));
    const { result, rerender } = renderHook(() => useEpicTimeSummariesBatch(['epic-1']), {
      wrapper: wrapper(client),
    });

    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));
    expect(result.current.totals?.get('epic-1')).toBe(90);
    expect(result.current.query.data?.get('epic-1')).toBe(90);

    worktreeRuntime.apiBase = '/wt/demo';
    rerender();
    expect(result.current.totals).toBeUndefined();
    expect(result.current.query.data).toBeUndefined();
    expect(result.current.query.isSuccess).toBe(false);

    worktreeRuntime.runtimeResolved = false;
    worktreeRuntime.apiBase = '';
    rerender();
    expect(result.current.totals).toBeUndefined();
    expect(result.current.query.data).toBeUndefined();

    // Only the admitted main-scope observer issued a request.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The main cache entry itself survives for re-admission.
    expect(
      client.getQueryData(epicTimeQueryKeys.batch(['epic-1'], timeZone, 'main')),
    ).toBeDefined();
  });

  it('re-admits to the primed main cache immediately after a disabled stretch', async () => {
    fetchMock.mockResolvedValue(batchResponse([{ epicId: 'epic-1', totalMinutes: 90 }]));
    const { result, rerender } = renderHook(() => useEpicTimeSummariesBatch(['epic-1']), {
      wrapper: wrapper(client),
    });

    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));

    worktreeRuntime.apiBase = '/wt/demo';
    rerender();
    expect(result.current.totals).toBeUndefined();

    worktreeRuntime.apiBase = '';
    rerender();
    // The main cache entry serves the badge again right away; any later
    // refresh is a fresh main-scope request, not a disabled-scope leak.
    expect(result.current.totals?.get('epic-1')).toBe(90);
  });

  it('issues no request for an empty ID set', () => {
    const { result } = renderHook(() => useEpicTimeSummariesBatch([]), {
      wrapper: wrapper(client),
    });

    expect(result.current.totals).toEqual(new Map());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('leaves the map empty when the batch read fails', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 502 });
    const { result } = renderHook(() => useEpicTimeSummariesBatch(['epic-1']), {
      wrapper: wrapper(client),
    });

    await waitFor(() => expect(result.current.query.isError).toBe(true));

    expect(result.current.totals).toEqual(new Map());
  });

  it('ignores malformed batch items instead of crashing the Board', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ items: [{ epicId: 'epic-1' }, { totalMinutes: 5 }, 'junk', null] }),
    });
    const { result } = renderHook(() => useEpicTimeSummariesBatch(['epic-1']), {
      wrapper: wrapper(client),
    });

    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));

    expect(result.current.totals).toEqual(new Map());
  });
});
