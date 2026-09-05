import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { epicTimeQueryKeys, resolveEpicTimeZone } from '@/ui/lib/epic-time';
import { useEpicTimeDetail } from './useEpicTimeDetail';

// Layer: hook unit. The fetch factory and worktree runtime are mocked
// because this spec owns the detail URL, key shape, runtime gating, and
// refresh cadence.
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

const summaryPayload = {
  isRoot: true,
  directMinutes: 30,
  totalMinutes: 90,
  includesRelatedTime: true,
  items: [
    { activityDate: '2026-08-22', agentId: 'agent-1', agentName: 'Alpha', minutes: 60 },
    { activityDate: '2026-08-22', agentId: 'agent-2', agentName: 'Bravo', minutes: 30 },
  ],
  taskItems: [
    { epicId: 'epic-1', epicTitle: 'Root task', isDirect: true, minutes: 30 },
    { epicId: 'epic-2', epicTitle: 'Child task', isDirect: false, minutes: 60 },
  ],
};

const OriginalDateTimeFormat = Intl.DateTimeFormat;

/**
 * Simulates an operating-system or browser time-zone change: the no-argument
 * resolver reports the given zone while every explicitly configured formatter
 * keeps its real behavior.
 */
function mockBrowserTimeZone(timeZone: string): jest.SpyInstance {
  return jest.spyOn(Intl, 'DateTimeFormat').mockImplementation(((
    locale?: Intl.LocalesArgument,
    options?: Intl.DateTimeFormatOptions,
  ) => {
    if (locale === undefined && options === undefined) {
      const resolved = new OriginalDateTimeFormat().resolvedOptions();
      return {
        resolvedOptions: () => ({ ...resolved, timeZone }),
      } as unknown as Intl.DateTimeFormat;
    }
    return new OriginalDateTimeFormat(locale, options);
  }) as unknown as typeof Intl.DateTimeFormat);
}

describe('useEpicTimeDetail', () => {
  let client: QueryClient;
  const timeZone = resolveEpicTimeZone();

  beforeEach(() => {
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, json: async () => summaryPayload });
    worktreeRuntime.runtimeResolved = true;
    worktreeRuntime.apiBase = '';
  });

  afterEach(() => client.clear());

  it('fetches the time-logs detail with the time zone and caches it under the keyed summary', async () => {
    const { result } = renderHook(() => useEpicTimeDetail('epic-1'), {
      wrapper: wrapper(client),
    });

    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/epics/epic-1/time-logs?timeZone=${encodeURIComponent(timeZone)}`,
      { signal: expect.any(AbortSignal) },
    );
    expect(result.current.admitted).toBe(true);
    // The exposed zone is the exact value behind the query key and request,
    // so export surfaces can reuse it without re-reading the browser.
    expect(result.current.timeZone).toBe(timeZone);
    expect(result.current.summary).toEqual(summaryPayload);
    expect(client.getQueryData(epicTimeQueryKeys.detail('epic-1', timeZone))).toEqual(
      summaryPayload,
    );
  });

  it('normalizes degraded payloads to an empty summary instead of crashing', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });
    const { result } = renderHook(() => useEpicTimeDetail('epic-1'), {
      wrapper: wrapper(client),
    });

    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));

    expect(result.current.summary).toEqual({
      isRoot: false,
      directMinutes: 0,
      totalMinutes: 0,
      includesRelatedTime: false,
      items: [],
      taskItems: [],
    });
  });

  it('defaults the routed-scope flag to false when the payload omits it', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        isRoot: true,
        directMinutes: 30,
        totalMinutes: 90,
        items: summaryPayload.items,
        taskItems: summaryPayload.taskItems,
      }),
    });
    const { result } = renderHook(() => useEpicTimeDetail('epic-1'), {
      wrapper: wrapper(client),
    });

    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));

    expect(result.current.summary?.includesRelatedTime).toBe(false);
  });

  it('keeps complete team rows and normalizes incomplete attribution to direct time', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        isRoot: true,
        directMinutes: 40,
        totalMinutes: 50,
        items: [
          {
            activityDate: '2026-08-22',
            agentId: 'agent-1',
            agentName: 'Alpha',
            minutes: 30,
            attributionSource: 'team',
            teamId: 'team-builders',
            teamName: 'Builders',
          },
          {
            activityDate: '2026-08-22',
            agentId: 'agent-1',
            agentName: 'Alpha',
            minutes: 10,
            attributionSource: 'team',
            teamId: 7,
            teamName: 'Builders',
          },
          {
            activityDate: '2026-08-21',
            agentId: 'agent-2',
            agentName: 'Bravo',
            minutes: 5,
            attributionSource: 'unknown-source',
            teamId: 'team-builders',
            teamName: 'Builders',
          },
          {
            activityDate: '2026-08-20',
            agentId: 'agent-3',
            agentName: 'Charlie',
            minutes: 5,
            attributionSource: 'team',
            teamId: 'team-builders',
            teamName: '',
          },
        ],
        taskItems: [],
      }),
    });
    const { result } = renderHook(() => useEpicTimeDetail('epic-1'), {
      wrapper: wrapper(client),
    });

    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));

    expect(result.current.summary?.items).toEqual([
      {
        activityDate: '2026-08-22',
        agentId: 'agent-1',
        agentName: 'Alpha',
        minutes: 30,
        attributionSource: 'team',
        teamId: 'team-builders',
        teamName: 'Builders',
      },
      { activityDate: '2026-08-22', agentId: 'agent-1', agentName: 'Alpha', minutes: 10 },
      { activityDate: '2026-08-21', agentId: 'agent-2', agentName: 'Bravo', minutes: 5 },
      { activityDate: '2026-08-20', agentId: 'agent-3', agentName: 'Charlie', minutes: 5 },
    ]);
  });

  it('retains every valid base task row and keeps only complete group pairs', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        isRoot: true,
        directMinutes: 30,
        totalMinutes: 90,
        includesRelatedTime: true,
        items: summaryPayload.items,
        taskItems: [
          {
            epicId: 'epic-1',
            epicTitle: 'Root task',
            isDirect: true,
            minutes: 30,
            groupEpicId: 'group-focal',
            groupEpicTitle: 'Focal task',
          },
          {
            epicId: 'epic-2',
            epicTitle: 'Empty group id',
            isDirect: false,
            minutes: 20,
            groupEpicId: '',
            groupEpicTitle: 'Focal task',
          },
          {
            epicId: 'epic-3',
            epicTitle: 'Non-string title',
            isDirect: false,
            minutes: 20,
            groupEpicId: 'group-focal',
            groupEpicTitle: 42,
          },
          {
            epicId: 'epic-4',
            epicTitle: 'Missing pair',
            isDirect: false,
            minutes: 20,
          },
        ],
      }),
    });
    const { result } = renderHook(() => useEpicTimeDetail('epic-1'), {
      wrapper: wrapper(client),
    });

    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));

    expect(result.current.summary?.taskItems).toEqual([
      {
        epicId: 'epic-1',
        epicTitle: 'Root task',
        isDirect: true,
        minutes: 30,
        groupEpicId: 'group-focal',
        groupEpicTitle: 'Focal task',
      },
      { epicId: 'epic-2', epicTitle: 'Empty group id', isDirect: false, minutes: 20 },
      { epicId: 'epic-3', epicTitle: 'Non-string title', isDirect: false, minutes: 20 },
      { epicId: 'epic-4', epicTitle: 'Missing pair', isDirect: false, minutes: 20 },
    ]);
  });

  it('issues no request and hides cached data for unresolved, worktree, or missing IDs', async () => {
    worktreeRuntime.runtimeResolved = false;
    const resolving = renderHook(() => useEpicTimeDetail('epic-1'), {
      wrapper: wrapper(client),
    });
    expect(resolving.result.current.admitted).toBe(false);
    expect(resolving.result.current.summary).toBeUndefined();
    expect(resolving.result.current.query.data).toBeUndefined();

    worktreeRuntime.runtimeResolved = true;
    worktreeRuntime.apiBase = '/wt/demo';
    const worktree = renderHook(() => useEpicTimeDetail('epic-1'), {
      wrapper: wrapper(client),
    });
    expect(worktree.result.current.admitted).toBe(false);
    expect(worktree.result.current.summary).toBeUndefined();
    expect(worktree.result.current.query.data).toBeUndefined();

    worktreeRuntime.apiBase = '';
    const missing = renderHook(() => useEpicTimeDetail(null), {
      wrapper: wrapper(client),
    });
    expect(missing.result.current.admitted).toBe(false);
    expect(missing.result.current.summary).toBeUndefined();
    expect(missing.result.current.query.data).toBeUndefined();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('exposes no main result through any returned field after main-to-worktree and main-to-unresolved transitions', async () => {
    const { result, rerender } = renderHook(() => useEpicTimeDetail('epic-1'), {
      wrapper: wrapper(client),
    });

    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));
    expect(result.current.summary?.totalMinutes).toBe(90);
    expect(result.current.query.data?.totalMinutes).toBe(90);

    worktreeRuntime.apiBase = '/wt/demo';
    rerender();
    expect(result.current.admitted).toBe(false);
    expect(result.current.summary).toBeUndefined();
    expect(result.current.query.data).toBeUndefined();
    expect(result.current.query.isSuccess).toBe(false);

    worktreeRuntime.runtimeResolved = false;
    worktreeRuntime.apiBase = '';
    rerender();
    expect(result.current.summary).toBeUndefined();
    expect(result.current.query.data).toBeUndefined();

    // Only the admitted main-scope observer issued a request.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The main cache entry itself survives for re-admission.
    expect(client.getQueryData(epicTimeQueryKeys.detail('epic-1', timeZone, 'main'))).toBeDefined();
  });

  it('re-admits to the primed main cache immediately after a disabled stretch', async () => {
    const { result, rerender } = renderHook(() => useEpicTimeDetail('epic-1'), {
      wrapper: wrapper(client),
    });

    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));

    worktreeRuntime.apiBase = '/wt/demo';
    rerender();
    expect(result.current.summary).toBeUndefined();

    worktreeRuntime.apiBase = '';
    rerender();
    // The main cache entry serves the card again right away; any later
    // refresh is a fresh main-scope request, not a disabled-scope leak.
    expect(result.current.summary?.totalMinutes).toBe(90);
  });

  it('refreshes the summary every 60 seconds', async () => {
    jest.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { result } = renderHook(() => useEpicTimeDetail('epic-1'), {
        wrapper: wrapper(client),
      });

      await waitFor(() => expect(result.current.query.isSuccess).toBe(true));
      expect(fetchMock).toHaveBeenCalledTimes(1);

      await act(async () => {
        await jest.advanceTimersByTimeAsync(60_000);
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps the mounted zone across browser-zone drift and adopts a new zone only on remount', async () => {
    const mountedZone = resolveEpicTimeZone();
    const driftedZone = mountedZone === 'America/New_York' ? 'Europe/Berlin' : 'America/New_York';
    const driftSpy = mockBrowserTimeZone(driftedZone);
    try {
      jest.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const { result, unmount } = renderHook(() => useEpicTimeDetail('epic-1'), {
          wrapper: wrapper(client),
        });

        await waitFor(() => expect(result.current.query.isSuccess).toBe(true));
        expect(result.current.timeZone).toBe(mountedZone);

        await act(async () => {
          await jest.advanceTimersByTimeAsync(60_000);
        });

        // The 60-second refresh keeps requesting and caching under the
        // mounted zone; the exposed value never drifts with the browser.
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(fetchMock).toHaveBeenLastCalledWith(
          `/api/epics/epic-1/time-logs?timeZone=${encodeURIComponent(mountedZone)}`,
          { signal: expect.any(AbortSignal) },
        );
        expect(result.current.timeZone).toBe(mountedZone);
        expect(
          client.getQueryData(epicTimeQueryKeys.detail('epic-1', mountedZone, 'main')),
        ).toBeDefined();

        unmount();
      } finally {
        jest.useRealTimers();
      }

      const remounted = renderHook(() => useEpicTimeDetail('epic-1'), {
        wrapper: wrapper(client),
      });
      await waitFor(() => expect(remounted.result.current.query.isSuccess).toBe(true));
      expect(remounted.result.current.timeZone).toBe(driftedZone);
      expect(fetchMock).toHaveBeenLastCalledWith(
        `/api/epics/epic-1/time-logs?timeZone=${encodeURIComponent(driftedZone)}`,
        { signal: expect.any(AbortSignal) },
      );
    } finally {
      driftSpy.mockRestore();
    }
  });

  it('exposes the error state without throwing', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    const { result } = renderHook(() => useEpicTimeDetail('epic-1'), {
      wrapper: wrapper(client),
    });

    await waitFor(() => expect(result.current.query.isError).toBe(true));

    expect(result.current.summary).toBeUndefined();
    expect(result.current.admitted).toBe(true);
  });
});
