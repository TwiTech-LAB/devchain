import { QueryClient } from '@tanstack/react-query';
import type { WsEnvelope } from '@/ui/lib/socket';
import { dispatchRealtimeEnvelope } from '@/ui/lib/realtime-invalidation-registry';
import { epicTimeQueryKeys } from '@/ui/lib/epic-time';
import { createEpicTimeScopeInvalidationRegistry } from './useEpicTimeScopeSync';

describe('useEpicTimeScopeSync registry', () => {
  const workspaceId = '11111111-1111-4111-8111-111111111111';

  it('invalidates Epic-time detail and batch families for its exact workspace topic', () => {
    const queryClient = new QueryClient();
    const invalidate = jest.spyOn(queryClient, 'invalidateQueries').mockResolvedValue(undefined);
    const envelope: WsEnvelope = {
      topic: `workspace/${workspaceId}/epic-time-scope`,
      type: 'invalidated',
      payload: { workspaceId },
      ts: '2026-08-30T00:00:00.000Z',
    };

    dispatchRealtimeEnvelope(
      envelope,
      createEpicTimeScopeInvalidationRegistry(workspaceId),
      queryClient,
    );

    expect(invalidate).toHaveBeenNthCalledWith(1, {
      queryKey: epicTimeQueryKeys.detailRoot(),
    });
    expect(invalidate).toHaveBeenNthCalledWith(2, {
      queryKey: epicTimeQueryKeys.batchRoot(),
    });
    expect(invalidate).toHaveBeenNthCalledWith(3, {
      queryKey: epicTimeQueryKeys.bufferRoot(),
    });
  });

  it('ignores scope hints for another workspace', () => {
    const queryClient = new QueryClient();
    const invalidate = jest.spyOn(queryClient, 'invalidateQueries').mockResolvedValue(undefined);

    dispatchRealtimeEnvelope(
      {
        topic: 'workspace/22222222-2222-4222-8222-222222222222/epic-time-scope',
        type: 'invalidated',
        payload: { workspaceId: '22222222-2222-4222-8222-222222222222' },
        ts: '2026-08-30T00:00:00.000Z',
      },
      createEpicTimeScopeInvalidationRegistry(workspaceId),
      queryClient,
    );

    expect(invalidate).not.toHaveBeenCalled();
  });

  it('refreshes every runtime scope variant through the family-prefix invalidation', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const epicId = 'epic-1';
    for (const scope of ['main', 'isolated'] as const) {
      queryClient.setQueryData(epicTimeQueryKeys.detail(epicId, 'UTC', scope), 0);
      queryClient.setQueryData(epicTimeQueryKeys.batch([epicId], 'UTC', scope), new Map());
      queryClient.setQueryData(epicTimeQueryKeys.buffers('project-1', scope), {
        capturedAt: null,
        items: [],
      });
    }

    dispatchRealtimeEnvelope(
      {
        topic: `workspace/${workspaceId}/epic-time-scope`,
        type: 'invalidated',
        payload: { workspaceId },
        ts: '2026-08-30T00:00:00.000Z',
      },
      createEpicTimeScopeInvalidationRegistry(workspaceId),
      queryClient,
    );
    await Promise.resolve();

    for (const scope of ['main', 'isolated'] as const) {
      expect(
        queryClient.getQueryState(epicTimeQueryKeys.detail(epicId, 'UTC', scope))?.isInvalidated,
      ).toBe(true);
      expect(
        queryClient.getQueryState(epicTimeQueryKeys.batch([epicId], 'UTC', scope))?.isInvalidated,
      ).toBe(true);
      expect(
        queryClient.getQueryState(epicTimeQueryKeys.buffers('project-1', scope))?.isInvalidated,
      ).toBe(true);
    }
    queryClient.clear();
  });
});
