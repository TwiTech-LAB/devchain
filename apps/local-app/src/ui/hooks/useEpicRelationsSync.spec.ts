import { QueryClient } from '@tanstack/react-query';
import type { WsEnvelope } from '@/ui/lib/socket';
import { dispatchRealtimeEnvelope } from '@/ui/lib/realtime-invalidation-registry';
import { epicRelationQueryKeys } from '@/ui/lib/epic-relations';
import { epicTimeQueryKeys } from '@/ui/lib/epic-time';
import { createEpicRelationsInvalidationRegistry } from './useEpicRelationsSync';

describe('useEpicRelationsSync registry', () => {
  const workspaceId = '11111111-1111-4111-8111-111111111111';

  it('invalidates relation and Epic-time families for its exact workspace topic', () => {
    const queryClient = new QueryClient();
    const invalidate = jest.spyOn(queryClient, 'invalidateQueries').mockResolvedValue(undefined);
    const envelope: WsEnvelope = {
      topic: `workspace/${workspaceId}/epic-relations`,
      type: 'invalidated',
      payload: { workspaceId },
      ts: '2026-08-29T00:00:00.000Z',
    };

    dispatchRealtimeEnvelope(
      envelope,
      createEpicRelationsInvalidationRegistry(workspaceId),
      queryClient,
    );

    expect(invalidate).toHaveBeenNthCalledWith(1, {
      queryKey: epicRelationQueryKeys.detailRoot(),
    });
    expect(invalidate).toHaveBeenNthCalledWith(2, {
      queryKey: epicRelationQueryKeys.candidateRoot(),
    });
    expect(invalidate).toHaveBeenNthCalledWith(3, {
      queryKey: epicRelationQueryKeys.batchRoot(),
    });
    expect(invalidate).toHaveBeenNthCalledWith(4, {
      queryKey: epicTimeQueryKeys.detailRoot(),
    });
    expect(invalidate).toHaveBeenNthCalledWith(5, {
      queryKey: epicTimeQueryKeys.batchRoot(),
    });
  });

  it('ignores globally broadcast envelopes for another workspace', () => {
    const queryClient = new QueryClient();
    const invalidate = jest.spyOn(queryClient, 'invalidateQueries').mockResolvedValue(undefined);

    dispatchRealtimeEnvelope(
      {
        topic: 'workspace/22222222-2222-4222-8222-222222222222/epic-relations',
        type: 'invalidated',
        payload: { workspaceId: '22222222-2222-4222-8222-222222222222' },
        ts: '2026-08-29T00:00:00.000Z',
      },
      createEpicRelationsInvalidationRegistry(workspaceId),
      queryClient,
    );

    expect(invalidate).not.toHaveBeenCalled();
  });

  it('refreshes every runtime batch variant through the family-prefix invalidation', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const ids = ['epic-1', 'epic-2'];
    for (const scope of ['main', 'isolated'] as const) {
      queryClient.setQueryData(epicRelationQueryKeys.batch(ids, scope), new Map());
    }

    dispatchRealtimeEnvelope(
      {
        topic: `workspace/${workspaceId}/epic-relations`,
        type: 'invalidated',
        payload: { workspaceId },
        ts: '2026-08-29T00:00:00.000Z',
      },
      createEpicRelationsInvalidationRegistry(workspaceId),
      queryClient,
    );
    await Promise.resolve();

    for (const scope of ['main', 'isolated'] as const) {
      expect(
        queryClient.getQueryState(epicRelationQueryKeys.batch(ids, scope))?.isInvalidated,
      ).toBe(true);
    }
    queryClient.clear();
  });
});
