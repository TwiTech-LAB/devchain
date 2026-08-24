import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { managedSubtaskSyncQueryKeys } from '@/ui/lib/managed-subtask-sync';
import { useManagedSubtaskSyncHealth } from './useManagedSubtaskSyncHealth';

const fetchMock = jest.fn();

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
    const { result } = renderHook(() => useManagedSubtaskSyncHealth('clickup'), {
      wrapper: wrapper(queryClient),
    });
    await waitFor(() => expect(result.current.health).toEqual(health));

    await act(async () => {
      await result.current.verify('11111111-1111-4111-8111-111111111111');
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/integrations/connections/clickup/managed-subtasks/11111111-1111-4111-8111-111111111111/verification',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
    );

    await act(async () => {
      await result.current.retry('22222222-2222-4222-8222-222222222222');
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/integrations/connections/clickup/managed-subtasks/22222222-2222-4222-8222-222222222222/retry',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
    );
    expect(queryClient.getQueryData(managedSubtaskSyncQueryKeys.provider('clickup'))).toEqual(
      health,
    );
  });

  it('issues no request and suppresses cached health while disabled', () => {
    queryClient.setQueryData(managedSubtaskSyncQueryKeys.provider('jira'), {
      ...health,
      provider: 'jira',
    });

    const { result } = renderHook(() => useManagedSubtaskSyncHealth('jira', { enabled: false }), {
      wrapper: wrapper(queryClient),
    });

    expect(result.current.health).toBeUndefined();
    expect(result.current.error).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
