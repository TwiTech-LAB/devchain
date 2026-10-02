import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { epicTimeQueryKeys } from '@/ui/lib/epic-time';
import { useAgentTimeBuffers } from './useAgentTimeBuffers';

// Layer: hook unit. The fetch factory is mocked because this spec owns the
// buffer URL, key shape, active/disabled scope gating, poll cadence, and
// minute-map reference stability.
const fetchMock = jest.fn();

jest.mock('@/ui/hooks/useFetchFactory', () => ({
  useFetchFactory: () => fetchMock,
}));

function wrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

const snapshotPayload = {
  capturedAt: '2026-09-01T00:00:00.000Z',
  items: [
    {
      agentId: 'agent-1',
      snapshotToken: 'a'.repeat(64),
      minutes: 10,
      durationMs: 600_000,
      segmentCount: 2,
      oldestActivityAt: '2026-09-01T00:00:00.000Z',
      newestActivityAt: '2026-09-01T00:10:00.000Z',
    },
    {
      agentId: 'agent-2',
      snapshotToken: 'b'.repeat(64),
      minutes: 9,
      durationMs: 540_000,
      segmentCount: 1,
      oldestActivityAt: '2026-09-01T00:00:00.000Z',
      newestActivityAt: '2026-09-01T00:09:00.000Z',
    },
  ],
};

describe('useAgentTimeBuffers', () => {
  let client: QueryClient;

  beforeEach(() => {
    client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, json: async () => snapshotPayload });
  });

  afterEach(() => client.clear());

  it('fetches the admitted project read under the active scope and polls every five seconds', async () => {
    const { result } = renderHook(() => useAgentTimeBuffers('project-1'), {
      wrapper: wrapper(client),
    });

    await waitFor(() =>
      expect(result.current.snapshot?.capturedAt).toBe(snapshotPayload.capturedAt),
    );

    expect(fetchMock).toHaveBeenCalledWith('/api/agent-time-buffers?projectId=project-1', {
      signal: expect.any(AbortSignal),
    });
    expect(result.current.admitted).toBe(true);
    expect(client.getQueryData(epicTimeQueryKeys.buffers('project-1', 'active'))).toEqual(
      snapshotPayload,
    );
    const cachedOptions: unknown = client.getQueryCache().find({
      queryKey: epicTimeQueryKeys.buffers('project-1', 'active'),
    })?.options;
    expect(
      cachedOptions !== null &&
        typeof cachedOptions === 'object' &&
        'refetchInterval' in cachedOptions
        ? cachedOptions.refetchInterval
        : undefined,
    ).toBe(5_000);
  });

  it('exposes entries from ten whole minutes and keeps the map reference across equal polls', async () => {
    const { result, rerender } = renderHook(() => useAgentTimeBuffers('project-1'), {
      wrapper: wrapper(client),
    });

    await waitFor(() => expect(result.current.snapshot).toBeDefined());
    // Ten minutes is inclusive; agent-2 remains buffered below the threshold.
    expect(result.current.minutesByAgentId).toEqual({ 'agent-1': 10 });
    const first = result.current.minutesByAgentId;

    rerender();
    expect(result.current.minutesByAgentId).toBe(first);
  });

  it('drops the map to a stable empty record when the read fails', async () => {
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({}) });
    const { result } = renderHook(() => useAgentTimeBuffers('project-1'), {
      wrapper: wrapper(client),
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await waitFor(() => expect(result.current.snapshot).toBeUndefined());
    expect(result.current.minutesByAgentId).toEqual({});
  });

  it('suppresses the exposed snapshot and map when a refetch fails after earlier success', async () => {
    const { result } = renderHook(() => useAgentTimeBuffers('project-1'), {
      wrapper: wrapper(client),
    });

    await waitFor(() => expect(result.current.snapshot?.items).toHaveLength(2));
    expect(result.current.minutesByAgentId).toEqual({ 'agent-1': 10 });

    // The next poll fails; TanStack retains the last payload internally, but
    // the exposed view must fail closed with no marker- or action-feeding data.
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({}) });
    await act(async () => {
      await client.refetchQueries({ queryKey: epicTimeQueryKeys.buffers('project-1', 'active') });
    });

    await waitFor(() => expect(result.current.snapshot).toBeUndefined());
    expect(result.current.minutesByAgentId).toEqual({});
  });

  it('issues no request and keys under the disabled scope when no project is selected', async () => {
    const noProject = renderHook(() => useAgentTimeBuffers(null), {
      wrapper: wrapper(client),
    });
    expect(noProject.result.current.admitted).toBe(false);
    expect(noProject.result.current.snapshot).toBeUndefined();

    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
    // A disabled read never primes the active-scope cache entry.
    expect(
      client.getQueryCache().find({ queryKey: epicTimeQueryKeys.buffers('', 'active') }),
    ).toBeUndefined();
  });
});
