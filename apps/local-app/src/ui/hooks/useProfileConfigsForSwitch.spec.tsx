import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { providerConfigQueryKeys, type ProfileProviderConfig } from '@/ui/lib/provider-configs';
import { useProfileConfigsForSwitch } from './useProfileConfigsForSwitch';

const configs = [{ id: 'cfg-1', name: 'codex-default', providerName: 'codex' }];

describe('useProfileConfigsForSwitch', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  function setup(fetchImpl: () => Promise<Response>) {
    global.fetch = jest.fn(fetchImpl) as unknown as typeof fetch;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    return { queryClient, wrapper };
  }

  it('returns the configs once loaded', async () => {
    const { wrapper } = setup(async () => ({ ok: true, json: async () => configs }) as Response);
    const { result } = renderHook(() => useProfileConfigsForSwitch('profile-1'), { wrapper });
    expect(result.current).toBeUndefined();
    await waitFor(() => expect(result.current).toEqual(configs));
  });

  it('hides earlier configs while a refetch is pending and after it fails', async () => {
    let settle: (response: Response) => void = () => undefined;
    const { wrapper, queryClient } = setup(
      () => new Promise<Response>((resolve) => (settle = resolve)),
    );
    const key = providerConfigQueryKeys.profile('profile-1');
    queryClient.setQueryData(key, configs as unknown as ProfileProviderConfig[]);
    const { result } = renderHook(() => useProfileConfigsForSwitch('profile-1'), { wrapper });
    // Cached data is stale on mount, so the hook starts a fetch and reports unknown.
    await waitFor(() => expect(queryClient.isFetching({ queryKey: key })).toBe(1));
    expect(result.current).toBeUndefined();

    await act(async () => {
      settle({ ok: true, json: async () => configs } as Response);
    });
    await waitFor(() => expect(result.current).toEqual(configs));

    const refetch = queryClient.refetchQueries({ queryKey: key });
    await waitFor(() => expect(result.current).toBeUndefined());
    expect(queryClient.getQueryData(key)).toEqual(configs);
    await act(async () => {
      settle({ ok: false, status: 500, json: async () => ({}) } as Response);
      await refetch;
    });
    expect(result.current).toBeUndefined();
    expect(queryClient.getQueryData(key)).toEqual(configs);
  });
});
