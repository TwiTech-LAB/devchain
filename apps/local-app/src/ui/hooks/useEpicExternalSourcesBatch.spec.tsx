import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { epicExternalSourceQueryKeys } from '@/ui/lib/external-my-work';
import { useEpicExternalSourcesBatch } from './useEpicExternalSourcesBatch';

// Layer: hook unit. The fetch factory is mocked because this spec owns the
// batch URL, body, key stability, and source-map contract.
const fetchMock = jest.fn();

jest.mock('@/ui/hooks/useFetchFactory', () => ({
  useFetchFactory: () => fetchMock,
}));

function wrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function sourceItem(epicId: string, remoteKey: string) {
  return {
    epicId,
    provider: 'jira',
    remoteTaskId: 'ENG-1',
    remoteKey,
    title: 'Remote title',
    workAreaName: 'Delivery',
    statusName: 'In Progress',
    webUrl: 'https://acme.atlassian.net/browse/ENG-1',
    linkedAt: '2026-08-19T10:00:00.000Z',
  };
}

describe('useEpicExternalSourcesBatch', () => {
  let client: QueryClient;

  beforeEach(() => {
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ items: [] }) });
  });

  afterEach(() => client.clear());

  it('posts the sorted deduplicated ID set under the batch key', async () => {
    const { result } = renderHook(
      () => useEpicExternalSourcesBatch(['epic-2', 'epic-1', 'epic-2']),
      { wrapper: wrapper(client) },
    );

    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));

    expect(fetchMock).toHaveBeenCalledWith('/api/epics/external-sources/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ epicIds: ['epic-1', 'epic-2'] }),
      signal: expect.any(AbortSignal),
    });
    expect(result.current.sources).toEqual(new Map());
    expect(client.getQueryData(epicExternalSourceQueryKeys.batch(['epic-1', 'epic-2']))).toEqual({
      items: [],
    });
  });

  it('keeps one stable key regardless of input order and derives the map with the first source per Epic', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [
          sourceItem('epic-1', 'ENG-1'),
          sourceItem('epic-1', 'ENG-1-second'),
          sourceItem('epic-2', 'CU-9'),
        ],
      }),
    });
    const first = renderHook(() => useEpicExternalSourcesBatch(['epic-1', 'epic-2']), {
      wrapper: wrapper(client),
    });
    await waitFor(() => expect(first.result.current.query.isSuccess).toBe(true));

    const second = renderHook(() => useEpicExternalSourcesBatch(['epic-2', 'epic-1']), {
      wrapper: wrapper(client),
    });
    await waitFor(() => expect(second.result.current.query.isSuccess).toBe(true));

    // Input order never forks the cache: both orders resolved through one
    // shared query entry (identical data object).
    expect(second.result.current.query.data).toBe(first.result.current.query.data);
    expect(first.result.current.sources?.get('epic-1')?.remoteKey).toBe('ENG-1');
    expect(first.result.current.sources?.get('epic-2')?.remoteKey).toBe('CU-9');
    expect(first.result.current.sources?.get('epic-3')).toBeUndefined();
    // The map value carries only the summary, never the batch epicId wrapper.
    expect(Object.keys(first.result.current.sources?.get('epic-1') ?? {})).not.toContain('epicId');
  });

  it('issues no request and hides cached data while disabled', async () => {
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useEpicExternalSourcesBatch(['epic-1'], { enabled }),
      { wrapper: wrapper(client), initialProps: { enabled: true } },
    );

    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));

    rerender({ enabled: false });

    expect(result.current.sources).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(client.getQueryData(epicExternalSourceQueryKeys.batch(['epic-1']))).toBeDefined();
  });

  it('issues no request for an empty ID set', () => {
    const { result } = renderHook(() => useEpicExternalSourcesBatch([]), {
      wrapper: wrapper(client),
    });

    expect(result.current.sources).toEqual(new Map());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('leaves the map empty when the batch read fails', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 502 });
    const { result } = renderHook(() => useEpicExternalSourcesBatch(['epic-1']), {
      wrapper: wrapper(client),
    });

    await waitFor(() => expect(result.current.query.isError).toBe(true));

    expect(result.current.sources).toEqual(new Map());
  });
});
