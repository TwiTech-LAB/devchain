import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import {
  integrationConnectionQueryKeys,
  type IntegrationConnectionDirectory,
} from '@/ui/lib/integration-connections';
import { managedSubtaskSyncQueryKeys } from '@/ui/lib/managed-subtask-sync';
import {
  useIntegrationConnectionDirectory,
  useLegacyIntegrationConnectionActions,
  useLegacyManagedSubtaskSyncHealth,
} from './useIntegrationConnectionDirectory';

const fetchMock = jest.fn();
const CONNECTION_ID = '33333333-3333-4333-8333-333333333333';
const PROJECT_ID = '11111111-1111-4111-8111-111111111111';

jest.mock('@/ui/hooks/useFetchFactory', () => ({
  useFetchFactory: () => fetchMock,
}));

function wrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

const directory: IntegrationConnectionDirectory = {
  items: [
    {
      project: { id: PROJECT_ID, name: 'Product' },
      workspace: { id: '44444444-4444-4444-8444-444444444444', name: 'Main' },
      provider: 'clickup',
      configured: true,
      updatedAt: '2026-08-20T00:00:00.000Z',
      subtaskSyncEnabled: false,
      hasMigratedSharedOrigin: false,
    },
  ],
  unassignedConnections: [],
  truncated: false,
};

const legacyHealth = {
  provider: 'jira',
  enabled: true,
  syncSettingRevision: 1,
  status: 'needs_attention',
  counts: { total: 1, pending: 0, outcomeUnknown: 1, needsAttention: 0, orphanRisk: 0 },
  items: [],
  truncated: false,
};

describe('useIntegrationConnectionDirectory', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    fetchMock.mockReset();
  });

  afterEach(() => queryClient.clear());

  it('reads the cross-project directory exactly once with no project query', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => directory });

    const { result } = renderHook(() => useIntegrationConnectionDirectory(), {
      wrapper: wrapper(queryClient),
    });

    await waitFor(() => expect(result.current.directory).toEqual(directory));
    expect(fetchMock).toHaveBeenCalledWith('/api/integrations/connections/directory', {
      signal: expect.any(AbortSignal),
    });
    expect(fetchMock.mock.calls[0][0]).not.toContain('projectId');
  });

  it('issues no directory request while disabled', () => {
    queryClient.setQueryData(integrationConnectionQueryKeys.directory(), directory);

    const { result } = renderHook(() => useIntegrationConnectionDirectory({ enabled: false }), {
      wrapper: wrapper(queryClient),
    });

    expect(result.current.directory).toBeUndefined();
    expect(result.current.error).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('useLegacyManagedSubtaskSyncHealth', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    fetchMock.mockReset();
  });

  afterEach(() => queryClient.clear());

  it('reads exact connection health and sends strict empty recovery bodies', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => legacyHealth });

    const { result } = renderHook(() => useLegacyManagedSubtaskSyncHealth(CONNECTION_ID), {
      wrapper: wrapper(queryClient),
    });

    await waitFor(() => expect(result.current.health).toEqual(legacyHealth));
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/integrations/connections/legacy/${CONNECTION_ID}/sync-health`,
      { signal: expect.any(AbortSignal) },
    );
    expect(fetchMock.mock.calls[0][0]).not.toContain('projectId');

    await act(async () => {
      await result.current.verify('55555555-5555-4555-8555-555555555555');
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/integrations/connections/legacy/${CONNECTION_ID}/managed-subtasks/55555555-5555-4555-8555-555555555555/verification`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
    );

    await act(async () => {
      await result.current.retry('66666666-6666-4666-8666-666666666666');
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/integrations/connections/legacy/${CONNECTION_ID}/managed-subtasks/66666666-6666-4666-8666-666666666666/retry`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
    );
  });

  it('issues no health request while disabled', () => {
    const { result } = renderHook(
      () => useLegacyManagedSubtaskSyncHealth(CONNECTION_ID, { enabled: false }),
      { wrapper: wrapper(queryClient) },
    );

    expect(result.current.health).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('useLegacyIntegrationConnectionActions', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    fetchMock.mockReset();
  });

  afterEach(() => queryClient.clear());

  it('assigns with a projectId-only body and refreshes directory and list caches', async () => {
    queryClient.setQueryData(integrationConnectionQueryKeys.directory(), directory);
    queryClient.setQueryData(integrationConnectionQueryKeys.list(PROJECT_ID), { items: [] });
    queryClient.setQueryData(managedSubtaskSyncQueryKeys.legacy(CONNECTION_ID), legacyHealth);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ provider: 'jira', connected: true }),
    });

    const { result } = renderHook(() => useLegacyIntegrationConnectionActions(), {
      wrapper: wrapper(queryClient),
    });

    await act(async () => {
      await result.current.assign(CONNECTION_ID, PROJECT_ID);
    });

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/integrations/connections/legacy/${CONNECTION_ID}/assign`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: PROJECT_ID }),
      },
    );
    expect(
      queryClient.getQueryData(managedSubtaskSyncQueryKeys.legacy(CONNECTION_ID)),
    ).toBeUndefined();
    await waitFor(() =>
      expect(
        queryClient.getQueryState(integrationConnectionQueryKeys.directory())?.isInvalidated,
      ).toBe(true),
    );
    await waitFor(() =>
      expect(
        queryClient.getQueryState(integrationConnectionQueryKeys.list(PROJECT_ID))?.isInvalidated,
      ).toBe(true),
    );
  });

  it('disconnects exactly one connection and escalates to the orphan acknowledgement query', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        json: async () => ({
          message: 'Acknowledgement required.',
          details: { reason: 'orphan_risk_ack_required' },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ provider: 'jira', connected: false }),
      });

    const { result } = renderHook(() => useLegacyIntegrationConnectionActions(), {
      wrapper: wrapper(queryClient),
    });

    await act(async () => {
      await result.current.disconnect(CONNECTION_ID).catch(() => undefined);
    });
    expect(fetchMock.mock.calls[0]).toEqual([
      `/api/integrations/connections/legacy/${CONNECTION_ID}`,
      { method: 'DELETE' },
    ]);

    await act(async () => {
      await result.current.disconnect(CONNECTION_ID, true);
    });
    expect(fetchMock.mock.calls[1]).toEqual([
      `/api/integrations/connections/legacy/${CONNECTION_ID}?acknowledgeOrphanRisk=true`,
      { method: 'DELETE' },
    ]);
  });
});
