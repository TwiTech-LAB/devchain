import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { epicExternalSourceQueryKeys, externalMyWorkQueryKeys } from '@/ui/lib/external-my-work';
import { useEpicExternalSources } from './useEpicExternalSources';

const fetchMock = jest.fn();

// Layer: hook + real QueryClient. The cache namespace is the durable-source contract;
// an HTTP-only test would not detect accidental provider-prefix coupling.
jest.mock('@/ui/hooks/useFetchFactory', () => ({ useFetchFactory: () => fetchMock }));

function wrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

describe('useEpicExternalSources', () => {
  it('keeps durable source snapshots outside every provider credential prefix', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const payload = {
      items: [
        {
          provider: 'jira',
          scopeKey: 'acme.atlassian.net',
          taskId: 'ENG-1',
          remoteKey: 'ENG-1',
          title: 'Imported work',
          description: null,
          webUrl: 'https://acme.atlassian.net/browse/ENG-1',
          workAreaId: 'board-1',
          workAreaName: 'Delivery',
          statusName: 'In Progress',
          linkedAt: '2026-08-19T00:00:00.000Z',
        },
      ],
    };
    fetchMock.mockResolvedValue({ ok: true, json: async () => payload });

    const { result } = renderHook(() => useEpicExternalSources('epic-1'), {
      wrapper: wrapper(client),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(fetchMock).toHaveBeenCalledWith('/api/epics/epic-1/external-sources', {
      signal: expect.any(AbortSignal),
    });
    expect(client.getQueryData(epicExternalSourceQueryKeys.detail('epic-1'))).toEqual(payload);
    expect(
      client.getQueryCache().findAll({ queryKey: externalMyWorkQueryKeys.provider('jira') }),
    ).toHaveLength(0);
    client.clear();
  });
});
