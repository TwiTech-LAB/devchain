import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { externalMyWorkQueryKeys } from '@/ui/lib/external-my-work';
import { useExternalMyWork } from './useExternalMyWork';

// Layer: hook unit. The fetch factory is mocked because this spec owns the URL,
// query-key, and error-projection contract; the worktree-aware fetch has its own suite.
const fetchMock = jest.fn();

jest.mock('@/ui/hooks/useFetchFactory', () => ({
  useFetchFactory: () => fetchMock,
}));

function wrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

const snapshot = {
  provider: 'clickup',
  descriptor: { provider: 'clickup', displayName: 'ClickUp', capabilities: { myWork: true } },
  supported: true,
  capabilities: { timeTrackingEnabled: false },
  workAreas: [],
  tasks: [],
  refreshedAt: '2026-08-19T00:00:00.000Z',
};
const connectionEpoch = 'connection-clickup-a:1';
const PROJECT_ID = '11111111-1111-4111-8111-111111111111';

describe('useExternalMyWork', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    fetchMock.mockReset();
  });

  afterEach(() => queryClient.clear());

  it('fetches the provider endpoint with includeCompleted and caches under the canonical key', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => snapshot });

    const { result } = renderHook(
      () =>
        useExternalMyWork('clickup', {
          includeCompleted: false,
          enabled: true,
          connectionEpoch,
          projectId: PROJECT_ID,
        }),
      { wrapper: wrapper(queryClient) },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/integrations/my-work/clickup?includeCompleted=false&projectId=${PROJECT_ID}`,
      { signal: expect.any(AbortSignal) },
    );
    expect(
      queryClient.getQueryData(
        externalMyWorkQueryKeys.landingSnapshot('clickup', connectionEpoch, false),
      ),
    ).toEqual(snapshot);
  });

  it('does not fetch while disabled', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => snapshot });

    const { result } = renderHook(
      () =>
        useExternalMyWork('clickup', {
          includeCompleted: false,
          enabled: false,
          connectionEpoch,
          projectId: PROJECT_ID,
        }),
      { wrapper: wrapper(queryClient) },
    );

    expect(result.current.fetchStatus).toBe('idle');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('carries includeCompleted=true into the request and a distinct cache entry', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => snapshot });

    const { result, rerender } = renderHook(
      ({ includeCompleted }: { includeCompleted: boolean }) =>
        useExternalMyWork('jira', {
          includeCompleted,
          enabled: true,
          connectionEpoch,
          projectId: PROJECT_ID,
        }),
      {
        wrapper: wrapper(queryClient),
        initialProps: { includeCompleted: false },
      },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    await act(async () => {
      rerender({ includeCompleted: true });
    });
    await waitFor(() =>
      expect(fetchMock).toHaveBeenLastCalledWith(
        `/api/integrations/my-work/jira?includeCompleted=true&projectId=${PROJECT_ID}`,
        { signal: expect.any(AbortSignal) },
      ),
    );
    expect(
      queryClient.getQueryData(
        externalMyWorkQueryKeys.landingSnapshot('jira', connectionEpoch, true),
      ),
    ).toEqual(snapshot);
  });

  it('projects the server message into the query error', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      json: async () => ({
        statusCode: 502,
        message: 'ClickUp returned an unavailable response.',
      }),
    });

    const { result } = renderHook(
      () =>
        useExternalMyWork('clickup', {
          includeCompleted: false,
          enabled: true,
          connectionEpoch,
          projectId: PROJECT_ID,
        }),
      { wrapper: wrapper(queryClient) },
    );

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toEqual(new Error('ClickUp returned an unavailable response.'));
  });

  it('keeps the previous snapshot visible while the completed toggle refetches', async () => {
    let releaseCompletedFetch: ((value: unknown) => void) | null = null;
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('includeCompleted=true')) {
        return new Promise((resolve) => {
          releaseCompletedFetch = resolve;
        });
      }
      return Promise.resolve({ ok: true, json: async () => snapshot });
    });

    const { result, rerender } = renderHook(
      ({ includeCompleted }: { includeCompleted: boolean }) =>
        useExternalMyWork('clickup', {
          includeCompleted,
          enabled: true,
          connectionEpoch,
          projectId: PROJECT_ID,
        }),
      {
        wrapper: wrapper(queryClient),
        initialProps: { includeCompleted: false },
      },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    await act(async () => {
      rerender({ includeCompleted: true });
    });

    expect(result.current.isPending).toBe(false);
    expect(result.current.data).toEqual(snapshot);

    await act(async () => {
      releaseCompletedFetch?.({ ok: true, json: async () => snapshot });
      await Promise.resolve();
    });
  });
});
