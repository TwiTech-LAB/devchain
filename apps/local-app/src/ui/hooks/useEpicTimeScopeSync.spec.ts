import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import React from 'react';
import { dispatchRealtimeEnvelope } from '@/ui/lib/realtime-invalidation-registry';
import { epicTimeQueryKeys } from '@/ui/lib/epic-time';
import { epicExternalSourceQueryKeys, externalMyWorkQueryKeys } from '@/ui/lib/external-my-work';
import { useAppSocket } from './useAppSocket';
import { useHomeSocket } from './useHomeSocket';
import {
  createEpicTimeScopeInvalidationRegistry,
  useEpicTimeScopeSync,
} from './useEpicTimeScopeSync';

jest.mock('./useAppSocket', () => ({ useAppSocket: jest.fn() }));
jest.mock('./useHomeSocket', () => ({ useHomeSocket: jest.fn() }));

const useAppSocketMock = jest.mocked(useAppSocket);
const useHomeSocketMock = jest.mocked(useHomeSocket);

function makeWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    queryClient,
    wrapper: ({ children }: { children: React.ReactNode }) =>
      React.createElement(QueryClientProvider, { client: queryClient }, children),
  };
}

describe('useEpicTimeScopeSync registry', () => {
  const workspaceId = '11111111-1111-4111-8111-111111111111';

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

  it('refreshes every runtime scope variant and the link views after an external link change', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const epicId = 'epic-1';
    for (const scope of ['active', 'disabled'] as const) {
      queryClient.setQueryData(epicTimeQueryKeys.detail(epicId, 'UTC', scope), 0);
      queryClient.setQueryData(epicTimeQueryKeys.batch([epicId], 'UTC', scope), new Map());
      queryClient.setQueryData(epicTimeQueryKeys.buffers('project-1', scope), {
        capturedAt: null,
        items: [],
      });
    }
    queryClient.setQueryData(epicExternalSourceQueryKeys.detail(epicId), { items: [] });
    queryClient.setQueryData(epicExternalSourceQueryKeys.batch([epicId]), { items: [] });
    queryClient.setQueryData(['epic', epicId], { version: 7 });
    queryClient.setQueryData(['external-my-work', 'clickup', 'connection-1', 'landing'], {});

    dispatchRealtimeEnvelope(
      {
        topic: `workspace/${workspaceId}/epic-time-scope`,
        type: 'invalidated',
        payload: { workspaceId, externalLinks: true },
        ts: '2026-08-30T00:00:00.000Z',
      },
      createEpicTimeScopeInvalidationRegistry(workspaceId),
      queryClient,
    );
    await Promise.resolve();

    for (const scope of ['active', 'disabled'] as const) {
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
    for (const key of [
      epicExternalSourceQueryKeys.detail(epicId),
      epicExternalSourceQueryKeys.batch([epicId]),
      ['epic', epicId],
    ]) {
      expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);
    }
    // Provider data that does not show link state is left alone.
    expect(
      queryClient.getQueryState(['external-my-work', 'clickup', 'connection-1', 'landing'])
        ?.isInvalidated,
    ).toBe(false);
    queryClient.clear();
  });

  it('refreshes only Epic time for a hint without an external link change', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const epicId = 'epic-1';
    const taskDetailKey = externalMyWorkQueryKeys.taskDetail('jira', 'connection-1', 'ENG-1');
    queryClient.setQueryData(epicTimeQueryKeys.detail(epicId, 'UTC', 'active'), 0);
    queryClient.setQueryData(epicExternalSourceQueryKeys.detail(epicId), { items: [] });
    queryClient.setQueryData(['epic', epicId], { version: 7 });
    queryClient.setQueryData(taskDetailKey, {});

    dispatchRealtimeEnvelope(
      {
        topic: `workspace/${workspaceId}/epic-time-scope`,
        type: 'invalidated',
        payload: { workspaceId },
        ts: '2026-11-23T00:00:00.000Z',
      },
      createEpicTimeScopeInvalidationRegistry(workspaceId),
      queryClient,
    );
    await Promise.resolve();

    expect(
      queryClient.getQueryState(epicTimeQueryKeys.detail(epicId, 'UTC', 'active'))?.isInvalidated,
    ).toBe(true);
    for (const key of [
      epicExternalSourceQueryKeys.detail(epicId),
      ['epic', epicId],
      taskDetailKey,
    ]) {
      expect(queryClient.getQueryState(key)?.isInvalidated).toBe(false);
    }
    queryClient.clear();
  });
});

describe('useEpicTimeScopeSync socket source', () => {
  const workspaceId = '11111111-1111-4111-8111-111111111111';

  beforeEach(() => {
    useAppSocketMock.mockClear();
    useHomeSocketMock.mockClear();
  });

  it('subscribes on the home socket, not the project socket', () => {
    const { wrapper } = makeWrapper();

    renderHook(() => useEpicTimeScopeSync(workspaceId), { wrapper });

    expect(useHomeSocketMock).toHaveBeenCalled();
    expect(useAppSocketMock).not.toHaveBeenCalled();
  });

  it.each([
    ['the scope hint', 'message'],
    ['a reconnect', 'connect'],
  ] as const)(
    'clears the former epic from active provider link lookups and task detail after %s',
    async (_name, trigger) => {
      const { wrapper } = makeWrapper();
      let linkedEpicId: string | null = 'epic-1';
      const linkLookup = renderHook(
        () =>
          useQuery({
            queryKey: externalMyWorkQueryKeys.linksBatch('jira', 'connection-1', true),
            queryFn: async () => ({ 'ENG-1': { epicId: linkedEpicId } }),
          }),
        { wrapper },
      );
      const taskDetail = renderHook(
        () =>
          useQuery({
            queryKey: externalMyWorkQueryKeys.taskDetail('jira', 'connection-1', 'ENG-1'),
            queryFn: async () => ({ remoteId: 'ENG-1', linkedEpicId }),
          }),
        { wrapper },
      );
      renderHook(() => useEpicTimeScopeSync(workspaceId), { wrapper });
      await waitFor(() => expect(taskDetail.result.current.data?.linkedEpicId).toBe('epic-1'));
      expect(linkLookup.result.current.data?.['ENG-1'].epicId).toBe('epic-1');

      linkedEpicId = null;
      const handlers = useHomeSocketMock.mock.lastCall![0];
      act(() => {
        if (trigger === 'connect') handlers.connect?.();
        else
          handlers.message?.({
            topic: `workspace/${workspaceId}/epic-time-scope`,
            type: 'invalidated',
            payload: { workspaceId, externalLinks: true },
            ts: '2026-11-23T00:00:00.000Z',
          });
      });

      await waitFor(() => {
        expect(linkLookup.result.current.data?.['ENG-1'].epicId).toBeNull();
        expect(taskDetail.result.current.data?.linkedEpicId).toBeNull();
      });
    },
  );
});
