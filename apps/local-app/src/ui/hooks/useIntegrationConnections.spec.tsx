import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { epicExternalSourceQueryKeys, externalMyWorkQueryKeys } from '@/ui/lib/external-my-work';
import {
  getIntegrationConnectionEpoch,
  integrationConnectionQueryKeys,
  type IntegrationConnectionState,
} from '@/ui/lib/integration-connections';
import {
  IntegrationConnectionApiError,
  useIntegrationConnections,
} from './useIntegrationConnections';

const fetchMock = jest.fn();
const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_PROJECT_ID = '22222222-2222-4222-8222-222222222222';

// Layer: hook + real QueryClient. Cache cancellation, prefix removal, and deferred
// resolution behavior cannot be proven by mocking the query client itself.
jest.mock('@/ui/hooks/useFetchFactory', () => ({
  useFetchFactory: () => fetchMock,
}));

function wrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

const oldJiraConnection: IntegrationConnectionState = {
  provider: 'jira',
  connected: true,
  connectionId: 'connection-jira-a',
  generation: 1,
  subtaskSyncEnabled: false,
  syncSettingRevision: 1,
  updatedAt: '2026-08-19T00:00:00.000Z',
};
const replacementJiraConnection: IntegrationConnectionState = {
  provider: 'jira',
  connected: true,
  connectionId: 'connection-jira-a',
  generation: 2,
  subtaskSyncEnabled: true,
  syncSettingRevision: 2,
  updatedAt: '2026-08-19T01:00:00.000Z',
};
const oldEpoch = getIntegrationConnectionEpoch(oldJiraConnection)!;

function seedProviderQueryFamilies(queryClient: QueryClient) {
  queryClient.setQueryData(externalMyWorkQueryKeys.landingSnapshot('jira', oldEpoch, false), {
    account: 'old',
    family: 'landing',
  });
  queryClient.setQueryData(externalMyWorkQueryKeys.landingSnapshot('jira', oldEpoch, true), {
    account: 'old',
    family: 'landing-completed',
  });
  queryClient.setQueryData(externalMyWorkQueryKeys.taskDetail('jira', oldEpoch, 'ENG-1'), {
    account: 'old',
    family: 'task-detail',
  });
  queryClient.setQueryData(externalMyWorkQueryKeys.taskComments('jira', oldEpoch, 'ENG-1'), {
    account: 'old',
    family: 'task-comments',
  });
  queryClient.setQueryData(
    [...externalMyWorkQueryKeys.links('jira', oldEpoch), [{ scopeKey: 'site', taskId: 'ENG-1' }]],
    { account: 'old', family: 'links' },
  );
}

describe('useIntegrationConnections', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    fetchMock.mockReset();
  });

  afterEach(() => queryClient.clear());

  it('uses the canonical query key and returns safe connection states', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [
          {
            provider: 'clickup',
            connected: false,
            connectionId: null,
            generation: null,
            updatedAt: null,
          },
          {
            provider: 'jira',
            connected: false,
            connectionId: null,
            generation: null,
            updatedAt: null,
          },
        ],
      }),
    });
    const { result } = renderHook(() => useIntegrationConnections({ projectId: PROJECT_ID }), {
      wrapper: wrapper(queryClient),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.connections).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/integrations/connections?projectId=${PROJECT_ID}`,
      { signal: expect.any(AbortSignal) },
    );
    expect(queryClient.getQueryData(integrationConnectionQueryKeys.list(PROJECT_ID))).toEqual({
      items: result.current.connections,
    });
  });

  it('issues no request and hides cached connection data while disabled', () => {
    queryClient.setQueryData(integrationConnectionQueryKeys.list(PROJECT_ID), {
      items: [
        {
          provider: 'clickup',
          connected: true,
          connectionId: 'connection-clickup-a',
          generation: 1,
          updatedAt: '2026-08-19',
        },
      ],
    });

    const { result } = renderHook(
      () => useIntegrationConnections({ projectId: PROJECT_ID, enabled: false }),
      {
        wrapper: wrapper(queryClient),
      },
    );

    expect(result.current.connections).toEqual([]);
    expect(result.current.error).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('issues no request without a valid selected project', () => {
    const { result } = renderHook(() => useIntegrationConnections({ projectId: null }), {
      wrapper: wrapper(queryClient),
    });

    expect(result.current.connections).toEqual([]);
    expect(result.current.isLoading).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never publishes a deferred connection list from the previously selected project', async () => {
    let resolveFirstProject!: (response: { ok: true; json: () => Promise<unknown> }) => void;
    const secondProjectConnection = {
      ...oldJiraConnection,
      connectionId: 'connection-jira-b',
    };
    fetchMock.mockImplementation((url: string) => {
      if (url.includes(PROJECT_ID)) {
        return new Promise((resolve) => {
          resolveFirstProject = resolve;
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ items: [secondProjectConnection] }),
      });
    });

    const { result, rerender } = renderHook(
      ({ projectId }: { projectId: string }) => useIntegrationConnections({ projectId }),
      {
        wrapper: wrapper(queryClient),
        initialProps: { projectId: PROJECT_ID },
      },
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    rerender({ projectId: OTHER_PROJECT_ID });
    await waitFor(() => expect(result.current.connections).toEqual([secondProjectConnection]));

    await act(async () => {
      resolveFirstProject({
        ok: true,
        json: async () => ({ items: [oldJiraConnection] }),
      });
      await Promise.resolve();
    });

    expect(result.current.connections).toEqual([secondProjectConnection]);
    expect(queryClient.getQueryData(integrationConnectionQueryKeys.list(OTHER_PROJECT_ID))).toEqual(
      { items: [secondProjectConnection] },
    );
  });

  it('replaces credentials through the one collection PUT and refreshes the list', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({ items: [] }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          provider: 'clickup',
          connected: true,
          connectionId: 'connection-clickup-a',
          generation: 1,
          updatedAt: '2026-08-19T00:00:00.000Z',
        }),
      })
      .mockResolvedValue({ ok: true, json: async () => ({ items: [] }) });
    const { result } = renderHook(() => useIntegrationConnections({ projectId: PROJECT_ID }), {
      wrapper: wrapper(queryClient),
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.replaceConnection({ provider: 'clickup', token: 'test-token' });
    });

    expect(fetchMock).toHaveBeenCalledWith('/api/integrations/connections', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'clickup', token: 'test-token', projectId: PROJECT_ID }),
    });
  });

  it('disconnects the provider resource through the shared hook', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({ items: [] }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          provider: 'jira',
          connected: false,
          connectionId: null,
          generation: null,
          updatedAt: null,
        }),
      })
      .mockResolvedValue({ ok: true, json: async () => ({ items: [] }) });
    const { result } = renderHook(() => useIntegrationConnections({ projectId: PROJECT_ID }), {
      wrapper: wrapper(queryClient),
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.disconnectConnection('jira');
    });

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/integrations/connections/jira?projectId=${PROJECT_ID}`,
      { method: 'DELETE' },
    );
  });

  it('updates only the managed-subtask setting without sending credentials', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ items: [oldJiraConnection] }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => replacementJiraConnection })
      .mockResolvedValue({
        ok: true,
        json: async () => ({ items: [replacementJiraConnection] }),
      });
    const { result } = renderHook(() => useIntegrationConnections({ projectId: PROJECT_ID }), {
      wrapper: wrapper(queryClient),
    });
    await waitFor(() => expect(result.current.connections).toEqual([oldJiraConnection]));

    await act(async () => {
      await result.current.updateSubtaskSync('jira', true);
    });

    expect(fetchMock).toHaveBeenCalledWith('/api/integrations/connections/jira/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: PROJECT_ID, subtaskSyncEnabled: true }),
    });
    expect(fetchMock.mock.calls[1]?.[1]?.body).not.toContain('token');
  });

  it('sends explicit orphan-risk acknowledgement only on a confirmed disconnect', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({ items: [oldJiraConnection] }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ...oldJiraConnection,
          connected: false,
          connectionId: null,
          generation: null,
        }),
      })
      .mockResolvedValue({ ok: true, json: async () => ({ items: [] }) });
    const { result } = renderHook(() => useIntegrationConnections({ projectId: PROJECT_ID }), {
      wrapper: wrapper(queryClient),
    });
    await waitFor(() => expect(result.current.connections).toEqual([oldJiraConnection]));

    await act(async () => {
      await result.current.disconnectConnection('jira', true);
    });

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/integrations/connections/jira?acknowledgeOrphanRisk=true&projectId=${PROJECT_ID}`,
      { method: 'DELETE' },
    );
  });

  it('preserves field and provider reason metadata from safe API errors', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({ items: [] }) })
      .mockResolvedValueOnce({
        ok: false,
        json: async () => ({
          code: 'jira_authentication_failed',
          message: 'Jira integration request failed',
          details: { provider: 'jira', reason: 'authentication_failed', retryable: false },
        }),
      });
    const { result } = renderHook(() => useIntegrationConnections({ projectId: PROJECT_ID }), {
      wrapper: wrapper(queryClient),
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    let caught: unknown;
    await act(async () => {
      try {
        await result.current.replaceConnection({
          provider: 'jira',
          siteUrl: 'https://acme.atlassian.net',
          email: 'private@example.com',
          token: 'bad-token',
        });
      } catch (error) {
        caught = error;
      }
    });

    expect(caught).toMatchObject<IntegrationConnectionApiError>({
      field: 'token',
      providerReason: 'authentication_failed',
    });
  });

  it('routes Jira tenant-policy rejection back to the site URL field', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({ items: [] }) })
      .mockResolvedValueOnce({
        ok: false,
        json: async () => ({
          code: 'jira_request_rejected',
          message: 'Jira integration request failed',
          details: { provider: 'jira', reason: 'request_rejected', retryable: false },
        }),
      });
    const { result } = renderHook(() => useIntegrationConnections({ projectId: PROJECT_ID }), {
      wrapper: wrapper(queryClient),
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    let caught: unknown;
    await act(async () => {
      try {
        await result.current.replaceConnection({
          provider: 'jira',
          siteUrl: 'https://jira.example.com',
          email: 'private@example.com',
          token: 'token',
        });
      } catch (error) {
        caught = error;
      }
    });

    expect(caught).toMatchObject<IntegrationConnectionApiError>({
      field: 'siteUrl',
      providerReason: 'request_rejected',
    });
  });

  it('uses generation plus connection instance time so reconnect epochs cannot repeat', () => {
    const reconnected = {
      ...oldJiraConnection,
      connectionId: 'connection-jira-b',
      generation: 1,
      updatedAt: oldJiraConnection.updatedAt,
    };

    expect(getIntegrationConnectionEpoch(oldJiraConnection)).toBe(oldEpoch);
    expect(getIntegrationConnectionEpoch(reconnected)).not.toBe(oldEpoch);
    expect(
      getIntegrationConnectionEpoch({
        provider: 'jira',
        connected: false,
        connectionId: null,
        generation: null,
        subtaskSyncEnabled: false,
        syncSettingRevision: null,
        updatedAt: null,
      }),
    ).toBeNull();
  });

  it('purges only the replaced connection epoch while retaining other projects and Epic sources', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({ items: [oldJiraConnection] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => replacementJiraConnection })
      .mockResolvedValue({
        ok: true,
        json: async () => ({ items: [replacementJiraConnection] }),
      });
    const cancelQueries = jest.spyOn(queryClient, 'cancelQueries');
    const removeQueries = jest.spyOn(queryClient, 'removeQueries');
    const durableSource = { items: [{ provider: 'jira', taskId: 'ENG-1' }] };
    queryClient.setQueryData(epicExternalSourceQueryKeys.detail('epic-1'), durableSource);
    const { result } = renderHook(() => useIntegrationConnections({ projectId: PROJECT_ID }), {
      wrapper: wrapper(queryClient),
    });
    await waitFor(() => expect(result.current.connections).toEqual([oldJiraConnection]));
    seedProviderQueryFamilies(queryClient);
    const otherProjectEpoch = 'connection-jira-other-project:1';
    const otherProjectKey = externalMyWorkQueryKeys.taskDetail(
      'jira',
      otherProjectEpoch,
      'OTHER-1',
    );
    queryClient.setQueryData(otherProjectKey, { account: 'other-project' });

    await act(async () => {
      await result.current.replaceConnection({ provider: 'jira', token: 'replacement-token' });
    });

    expect(cancelQueries).toHaveBeenCalledWith({
      queryKey: externalMyWorkQueryKeys.epoch('jira', oldEpoch),
    });
    expect(removeQueries).toHaveBeenCalledWith({
      queryKey: externalMyWorkQueryKeys.epoch('jira', oldEpoch),
    });
    expect(
      queryClient.getQueryCache().findAll({
        queryKey: externalMyWorkQueryKeys.epoch('jira', oldEpoch),
      }),
    ).toHaveLength(0);
    expect(queryClient.getQueryData(otherProjectKey)).toEqual({ account: 'other-project' });
    expect(queryClient.getQueryData(epicExternalSourceQueryKeys.detail('epic-1'))).toEqual(
      durableSource,
    );
    await waitFor(() =>
      expect(getIntegrationConnectionEpoch(result.current.connections[0])).toBe(
        getIntegrationConnectionEpoch(replacementJiraConnection),
      ),
    );
  });

  it('purges only the disconnected connection epoch without deleting other project data', async () => {
    const disconnected: IntegrationConnectionState = {
      provider: 'jira',
      connected: false,
      connectionId: null,
      generation: null,
      subtaskSyncEnabled: false,
      syncSettingRevision: null,
      updatedAt: null,
    };
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({ items: [oldJiraConnection] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => disconnected })
      .mockResolvedValue({ ok: true, json: async () => ({ items: [disconnected] }) });
    const durableSource = { items: [{ provider: 'jira', taskId: 'ENG-1' }] };
    queryClient.setQueryData(epicExternalSourceQueryKeys.detail('epic-1'), durableSource);
    const { result } = renderHook(() => useIntegrationConnections({ projectId: PROJECT_ID }), {
      wrapper: wrapper(queryClient),
    });
    await waitFor(() => expect(result.current.connections).toEqual([oldJiraConnection]));
    seedProviderQueryFamilies(queryClient);
    const otherProjectKey = externalMyWorkQueryKeys.taskDetail(
      'jira',
      'connection-jira-other-project:1',
      'OTHER-1',
    );
    queryClient.setQueryData(otherProjectKey, { account: 'other-project' });

    await act(async () => {
      await result.current.disconnectConnection('jira');
    });

    expect(
      queryClient.getQueryCache().findAll({
        queryKey: externalMyWorkQueryKeys.epoch('jira', oldEpoch),
      }),
    ).toHaveLength(0);
    expect(queryClient.getQueryData(otherProjectKey)).toEqual({ account: 'other-project' });
    expect(queryClient.getQueryData(epicExternalSourceQueryKeys.detail('epic-1'))).toEqual(
      durableSource,
    );
    await waitFor(() => expect(result.current.connections).toEqual([disconnected]));
  });

  it('preserves the current identity caches when replacement verification fails', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({ items: [oldJiraConnection] }) })
      .mockResolvedValueOnce({
        ok: false,
        json: async () => ({ message: 'Verification failed.' }),
      });
    const { result } = renderHook(() => useIntegrationConnections({ projectId: PROJECT_ID }), {
      wrapper: wrapper(queryClient),
    });
    await waitFor(() => expect(result.current.connections).toEqual([oldJiraConnection]));
    seedProviderQueryFamilies(queryClient);

    await act(async () => {
      await expect(
        result.current.replaceConnection({ provider: 'jira', token: 'invalid-token' }),
      ).rejects.toThrow('Verification failed.');
    });

    expect(
      queryClient.getQueryCache().findAll({
        queryKey: externalMyWorkQueryKeys.provider('jira'),
      }),
    ).toHaveLength(5);
    expect(result.current.connections).toEqual([oldJiraConnection]);
  });

  it('aborts and discards a deferred old-account request that resolves after replacement', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({ items: [oldJiraConnection] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => replacementJiraConnection })
      .mockResolvedValue({
        ok: true,
        json: async () => ({ items: [replacementJiraConnection] }),
      });
    const { result } = renderHook(() => useIntegrationConnections({ projectId: PROJECT_ID }), {
      wrapper: wrapper(queryClient),
    });
    await waitFor(() => expect(result.current.connections).toEqual([oldJiraConnection]));

    let releaseOldRequest!: (value: unknown) => void;
    let oldRequestSignal: AbortSignal | undefined;
    const oldRequest = queryClient.fetchQuery({
      queryKey: externalMyWorkQueryKeys.taskDetail('jira', oldEpoch, 'ENG-1'),
      queryFn: ({ signal }) => {
        oldRequestSignal = signal;
        return new Promise((resolve) => {
          releaseOldRequest = resolve;
        });
      },
    });
    const oldRequestOutcome = oldRequest.catch(() => undefined);
    await waitFor(() => expect(oldRequestSignal).toBeDefined());

    await act(async () => {
      await result.current.replaceConnection({ provider: 'jira', token: 'replacement-token' });
    });
    expect(oldRequestSignal?.aborted).toBe(true);

    releaseOldRequest({ account: 'old', title: 'Must not reappear' });
    await oldRequestOutcome;
    expect(
      queryClient.getQueryCache().findAll({
        queryKey: externalMyWorkQueryKeys.provider('jira'),
      }),
    ).toHaveLength(0);
  });
});
