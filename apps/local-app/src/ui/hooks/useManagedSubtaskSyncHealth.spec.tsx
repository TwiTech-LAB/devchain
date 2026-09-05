import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { managedSubtaskSyncQueryKeys } from '@/ui/lib/managed-subtask-sync';
import { useManagedSubtaskSyncHealth } from './useManagedSubtaskSyncHealth';

const fetchMock = jest.fn();
const PROJECT_ID = '11111111-1111-4111-8111-111111111111';

jest.mock('@/ui/hooks/useFetchFactory', () => ({
  useFetchFactory: () => fetchMock,
}));

function wrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

const health = {
  provider: 'clickup',
  enabled: true,
  syncSettingRevision: 2,
  status: 'needs_attention',
  counts: { total: 1, pending: 0, outcomeUnknown: 1, needsAttention: 0, orphanRisk: 0 },
  items: [],
  truncated: false,
};

describe('useManagedSubtaskSyncHealth', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    fetchMock.mockReset();
  });

  afterEach(() => queryClient.clear());

  it('reads bounded provider health and sends strict empty recovery bodies', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => health })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ outcome: 'confirmed' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => health })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ outcome: 'confirmed' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => health });
    const { result } = renderHook(
      () => useManagedSubtaskSyncHealth('clickup', { projectId: PROJECT_ID }),
      {
        wrapper: wrapper(queryClient),
      },
    );
    await waitFor(() => expect(result.current.health).toEqual(health));
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/integrations/connections/clickup/sync-health?projectId=${PROJECT_ID}`,
      { signal: expect.any(AbortSignal) },
    );

    await act(async () => {
      await result.current.verify('11111111-1111-4111-8111-111111111111');
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/integrations/connections/clickup/managed-subtasks/11111111-1111-4111-8111-111111111111/verification?projectId=${PROJECT_ID}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
    );

    await act(async () => {
      await result.current.retry('22222222-2222-4222-8222-222222222222');
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/integrations/connections/clickup/managed-subtasks/22222222-2222-4222-8222-222222222222/retry?projectId=${PROJECT_ID}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
    );
    expect(
      queryClient.getQueryData(managedSubtaskSyncQueryKeys.provider(PROJECT_ID, 'clickup')),
    ).toEqual(health);
  });

  it('issues no request and suppresses cached health while disabled', () => {
    queryClient.setQueryData(managedSubtaskSyncQueryKeys.provider(PROJECT_ID, 'jira'), {
      ...health,
      provider: 'jira',
    });

    const { result } = renderHook(
      () => useManagedSubtaskSyncHealth('jira', { projectId: PROJECT_ID, enabled: false }),
      { wrapper: wrapper(queryClient) },
    );

    expect(result.current.health).toBeUndefined();
    expect(result.current.error).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('isolates health cache keys by project and suppresses missing-project requests', () => {
    const otherProjectId = '22222222-2222-4222-8222-222222222222';
    expect(managedSubtaskSyncQueryKeys.provider(PROJECT_ID, 'jira')).not.toEqual(
      managedSubtaskSyncQueryKeys.provider(otherProjectId, 'jira'),
    );

    const { result } = renderHook(() => useManagedSubtaskSyncHealth('jira', { projectId: null }), {
      wrapper: wrapper(queryClient),
    });

    expect(result.current.health).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
