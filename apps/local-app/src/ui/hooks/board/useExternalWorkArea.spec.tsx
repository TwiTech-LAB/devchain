import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { externalMyWorkQueryKeys } from '@/ui/lib/external-my-work';
import { useExternalWorkArea } from './useExternalWorkArea';

// Layer: hook unit. The fetch factory is mocked because this spec owns the URL,
// query-key, and board-derivation contract; worktree-aware fetch has its own suite.
const fetchMock = jest.fn();

jest.mock('@/ui/hooks/useFetchFactory', () => ({
  useFetchFactory: () => fetchMock,
}));

function wrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

function snapshot(workAreas: unknown[], tasks: unknown[] = []) {
  return {
    provider: 'clickup',
    descriptor: { provider: 'clickup', displayName: 'ClickUp', capabilities: { myWork: true } },
    supported: true,
    capabilities: { timeTrackingEnabled: true },
    workAreas: workAreas,
    tasks: tasks,
    refreshedAt: '2026-08-19T10:00:00.000Z',
  };
}

const area = (overrides: Record<string, unknown> = {}) => ({
  remoteId: 'list-1',
  scopeKey: 'workspace-1',
  name: 'Sprint',
  kind: 'list',
  description: null,
  assignedTaskCount: 0,
  hierarchy: [] as unknown[],
  workflow: { isOverridden: true, columns: [] as unknown[] },
  refresh: { state: 'fresh', refreshedAt: null, retryable: false, retryAt: null },
  ...overrides,
});

describe('useExternalWorkArea', () => {
  it('derives the selected area from the shared landing snapshot cache entry', async () => {
    const connectionEpoch = 'connection-clickup-a:1';
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => snapshot([area()]),
    });

    const { result } = renderHook(
      () => useExternalWorkArea('clickup', 'list-1', { connectionEpoch, includeCompleted: false }),
      { wrapper: wrapper(queryClient) },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/integrations/my-work/clickup?includeCompleted=false',
      { signal: expect.any(AbortSignal) },
    );
    expect(result.current.data).toEqual(
      expect.objectContaining({ workArea: expect.objectContaining({ name: 'Sprint' }) }),
    );
    // The cache holds the raw landing snapshot — landing and boards share one entry.
    expect(
      queryClient.getQueryData(
        externalMyWorkQueryKeys.landingSnapshot('clickup', connectionEpoch, false),
      ),
    ).toEqual(expect.objectContaining({ supported: true }));
    queryClient.clear();
  });

  it('requests the completed-inclusive scope and caches it under a distinct key', async () => {
    const connectionEpoch = 'connection-clickup-a:1';
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const completedColumn = {
      remoteId: 'st-done',
      name: 'Done',
      color: '#36b37e',
      category: 'completed',
      position: 0,
    };
    const completedTask = {
      remoteId: 'task-9',
      title: 'Shipped feature',
      status: { name: 'Done', category: 'completed', remoteId: 'st-done' },
      updatedAt: '2026-08-19T09:00:00.000Z',
      dueAt: null,
      completedAt: '2026-08-18T09:00:00.000Z',
      webUrl: null,
    };
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () =>
        snapshot(
          [
            area({
              workflow: { isOverridden: true, columns: [completedColumn] },
              assignedTaskCount: 1,
            }),
          ],
          [{ workArea: area(), task: completedTask }],
        ),
    });

    const { result } = renderHook(
      () => useExternalWorkArea('clickup', 'list-1', { connectionEpoch, includeCompleted: true }),
      { wrapper: wrapper(queryClient) },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/integrations/my-work/clickup?includeCompleted=true',
      { signal: expect.any(AbortSignal) },
    );

    const activeKey = externalMyWorkQueryKeys.landingSnapshot('clickup', connectionEpoch, false);
    const completedKey = externalMyWorkQueryKeys.landingSnapshot('clickup', connectionEpoch, true);
    expect(completedKey).not.toEqual(activeKey);
    expect(result.current.data).toEqual(
      expect.objectContaining({
        columns: [expect.objectContaining({ name: 'Done', tasks: [expect.anything()] })],
      }),
    );
    expect(queryClient.getQueryData(completedKey)).toEqual(
      expect.objectContaining({ supported: true }),
    );
    expect(queryClient.getQueryData(activeKey)).toBeUndefined();
    queryClient.clear();
  });
});
