/** @jest-environment jsdom */

import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useCloudConnection } from './useCloudConnection';

jest.mock('./useRealtimeDispatch', () => ({
  useRealtimeDispatch: jest.fn(),
}));

const mockFetch = jest.fn();

function makeWrapper() {
  // One shared client across both backends, exactly like the Cloud page's
  // HomeQueryScope — a key collision here would surface as cross-reads.
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return wrapper;
}

function statusResponse(connected: boolean, email: string) {
  return {
    ok: true,
    status: 200,
    json: async () =>
      connected
        ? { connected: true, email, userId: `u-${email}` }
        : { connected: false, identityServiceUrl: 'http://localhost:3002' },
  };
}

describe('useCloudConnection', () => {
  beforeEach(() => {
    global.fetch = mockFetch;
    mockFetch.mockReset();
  });

  it('fetches status from the given backend through the /r proxy', async () => {
    mockFetch.mockResolvedValue(statusResponse(true, 'remote@example.com'));

    const { result } = renderHook(() => useCloudConnection('remote-1'), {
      wrapper: makeWrapper(),
    });

    await waitFor(() => expect(result.current.status.connected).toBe(true));
    expect(mockFetch).toHaveBeenCalledWith('/r/remote-1/api/auth/cloud/status', undefined);
    expect(result.current.status.email).toBe('remote@example.com');
  });

  it('separates each backend behind its own query key (no cached cross-reads)', async () => {
    const home = statusResponse(false, 'home@example.com');
    const remote = statusResponse(true, 'remote@example.com');
    mockFetch.mockImplementation(async (input: RequestInfo | URL) =>
      String(input).startsWith('/r/remote-1') ? remote : home,
    );

    // Populate the shared cache with BOTH backends' status.
    const first = renderHook(() => useCloudConnection('home'), { wrapper: makeWrapper() });
    await waitFor(() => expect(first.result.current.isLoading).toBe(false));
    const second = renderHook(() => useCloudConnection('remote-1'), { wrapper: makeWrapper() });
    await waitFor(() => expect(second.result.current.isLoading).toBe(false));

    // A shared ['cloud','status'] key would have served home's cached
    // { connected: false } to the remote instance's read.
    expect(second.result.current.status.connected).toBe(true);
    expect(second.result.current.status.email).toBe('remote@example.com');

    // The home entry keeps its own value.
    expect(first.result.current.status.connected).toBe(false);

    const urls = mockFetch.mock.calls.map((call) => String(call[0]));
    expect(urls).toContain('/api/auth/cloud/status');
    expect(urls).toContain('/r/remote-1/api/auth/cloud/status');
  });
});
