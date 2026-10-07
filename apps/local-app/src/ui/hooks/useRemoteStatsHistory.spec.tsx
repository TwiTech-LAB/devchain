import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useRemoteStatsHistory } from './useRemoteStatsHistory';
import { REMOTES_QUERY_PREFIX } from '@/ui/lib/backend-provider';
import { HOME_BACKEND } from '@/ui/lib/api-transport';

const mockApiFetch = jest.fn();
jest.mock('@/ui/lib/api-transport', () => {
  const actual = jest.requireActual('@/ui/lib/api-transport');
  return {
    ...actual,
    apiFetch: (...args: unknown[]) => mockApiFetch(...args),
  };
});

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { wrapper, queryClient };
}

beforeEach(() => {
  mockApiFetch.mockReset();
  mockApiFetch.mockResolvedValue({
    ok: true,
    json: async () => ({
      intervalMs: 10_000,
      samples: [
        { cpuPercent: 10, sampledAt: '2026-09-26T12:00:00Z' },
        { cpuPercent: 20, sampledAt: '2026-09-26T12:00:10Z' },
      ],
    }),
  });
});

describe('useRemoteStatsHistory', () => {
  it('fetches the history endpoint on the home backend', async () => {
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useRemoteStatsHistory('remote-1'), { wrapper });

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/remotes/remote-1/stats/history',
      expect.anything(),
      { backend: HOME_BACKEND },
    );
    expect(result.current.data?.samples).toHaveLength(2);
    expect(result.current.data?.intervalMs).toBe(10_000);
  });

  it('normalizes a malformed body to an empty sample list', async () => {
    mockApiFetch.mockResolvedValue({ ok: true, json: async () => ({}) });
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useRemoteStatsHistory('remote-1'), { wrapper });

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data?.samples).toEqual([]);
    expect(result.current.data?.intervalMs).toBe(0);
  });

  it('refetches when the remotes query prefix is invalidated', async () => {
    const { wrapper, queryClient } = createWrapper();
    const { result } = renderHook(() => useRemoteStatsHistory('remote-1'), { wrapper });

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(mockApiFetch).toHaveBeenCalledTimes(1);

    // BackendProvider issues exactly this invalidation on every `remotes` socket event.
    await queryClient.invalidateQueries({ queryKey: REMOTES_QUERY_PREFIX });
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledTimes(2));
  });

  it('uses a per-remote query key so remotes do not share caches', async () => {
    const { wrapper } = createWrapper();
    const first = renderHook(() => useRemoteStatsHistory('remote-1'), { wrapper });
    await waitFor(() => expect(first.result.current.data).toBeDefined());

    const second = renderHook(() => useRemoteStatsHistory('remote-2'), {
      wrapper,
    });
    await waitFor(() => expect(second.result.current.data).toBeDefined());

    const urls = mockApiFetch.mock.calls.map((call) => call[0]);
    expect(urls).toContain('/api/remotes/remote-1/stats/history');
    expect(urls).toContain('/api/remotes/remote-2/stats/history');
  });
});
