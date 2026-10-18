import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { PROVIDER_USAGE_SETTINGS_DEFAULTS, type ProviderUsageResponse } from '@devchain/shared';
import type { WsEnvelope } from '@/ui/lib/socket';
import { useAppSocket } from './useAppSocket';
import { useProviderUsage } from './useProviderUsage';

// Layer: hook unit. The fetch factory and the socket are mocked because this spec
// owns the request URL, the non-OK fallback, the socket invalidation and the hover read.
const fetchMock = jest.fn();
jest.mock('@/ui/hooks/useFetchFactory', () => ({ useFetchFactory: () => fetchMock }));
jest.mock('./useAppSocket', () => ({ useAppSocket: jest.fn() }));
const useAppSocketMock = jest.mocked(useAppSocket);

const RESPONSE: ProviderUsageResponse = {
  accounts: [],
  config: { ...PROVIDER_USAGE_SETTINGS_DEFAULTS, hoverMaxAgeSec: 90 },
};

function wrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function emit(envelope: Omit<WsEnvelope, 'ts'>) {
  const handlers = useAppSocketMock.mock.calls.at(-1)?.[0];
  act(() => handlers?.message?.({ ...envelope, ts: '2026-10-17T12:00:00.000Z' }));
}

describe('useProviderUsage', () => {
  let client: QueryClient;

  beforeEach(() => {
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, json: async () => RESPONSE });
    useAppSocketMock.mockClear();
  });

  afterEach(() => client.clear());

  it('reads the project usage with the open-project age', async () => {
    const { result } = renderHook(() => useProviderUsage('project-1'), {
      wrapper: wrapper(client),
    });

    await waitFor(() => expect(result.current.data).toEqual(RESPONSE));
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/provider-usage?projectId=project-1&maxAgeSec=1800',
    );
  });

  it('returns no data for a non-OK response', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 409, json: async () => ({}) });
    const { result } = renderHook(() => useProviderUsage('project-1'), {
      wrapper: wrapper(client),
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(result.current.data).toBeNull();
  });

  it('refetches when the project socket announces new usage', async () => {
    const { result } = renderHook(() => useProviderUsage('project-1'), {
      wrapper: wrapper(client),
    });
    await waitFor(() => expect(result.current.data).toEqual(RESPONSE));

    emit({ topic: 'provider-usage', type: 'updated', payload: { accountKey: 'agy:/home/dev' } });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it('reads with the hover age when the card opens', async () => {
    const { result } = renderHook(() => useProviderUsage('project-1'), {
      wrapper: wrapper(client),
    });
    await waitFor(() => expect(result.current.data).toEqual(RESPONSE));

    await act(() => result.current.refreshForHover());

    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/provider-usage?projectId=project-1&maxAgeSec=90',
    );
  });
});
