import { QueryClient } from '@tanstack/react-query';
import {
  dispatchRealtimeEnvelope,
  type RealtimeInvalidationRegistry,
} from './realtime-invalidation-registry';
import { boardCacheKeys, createBoardInvalidationRegistry, refreshBoardCache } from './board-cache';

function createQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function seedQuery(queryClient: QueryClient, queryKey: readonly unknown[]): void {
  queryClient.setQueryData(queryKey, { seeded: true });
}

function isInvalidated(queryClient: QueryClient, queryKey: readonly unknown[]): boolean {
  return queryClient.getQueryState(queryKey)?.isInvalidated ?? false;
}

function dispatchEpicEvent(
  queryClient: QueryClient,
  registry: RealtimeInvalidationRegistry,
  payload: Record<string, unknown>,
  topic = 'project/project-1/epics',
  type = 'updated',
): void {
  dispatchRealtimeEnvelope(
    {
      topic,
      type,
      payload,
      ts: new Date().toISOString(),
    },
    registry,
    queryClient,
  );
}

describe('board cache ownership', () => {
  it('preserves native Board key families and disabled-query arguments', () => {
    expect(boardCacheKeys.all).toEqual(['epics']);
    expect(boardCacheKeys.project('project-1')).toEqual(['epics', 'project-1']);
    expect(boardCacheKeys.list('project-1', 'active')).toEqual(['epics', 'project-1', 'active']);
    expect(boardCacheKeys.list(null, 'all')).toEqual(['epics', null, 'all']);
    expect(boardCacheKeys.list(undefined, 'archived')).toEqual(['epics', undefined, 'archived']);
    expect(boardCacheKeys.children(null)).toEqual(['epics', 'parent', null]);
    expect(boardCacheKeys.children(undefined)).toEqual(['epics', 'parent', undefined]);
    expect(boardCacheKeys.subCounts('epic-1')).toEqual(['epics', 'epic-1', 'sub-counts']);
  });

  // Real cache state and the shared dispatcher exercise matching without mounting the Board.
  it.each(['created', 'updated', 'deleted'])(
    'invalidates only the selected project and affected parent caches for %s events',
    (type) => {
      const queryClient = createQueryClient();
      const registry = createBoardInvalidationRegistry({
        projectId: 'project-1',
        parentFilter: 'root-1',
      });

      const selectedProjectKey = boardCacheKeys.project('project-1');
      const otherProjectKey = boardCacheKeys.project('project-2');
      const selectedParentKey = boardCacheKeys.children('root-1');
      const otherParentKey = boardCacheKeys.children('root-2');
      const selectedCountKey = boardCacheKeys.subCounts('root-1');
      const otherCountKey = boardCacheKeys.subCounts('root-2');
      [
        selectedProjectKey,
        otherProjectKey,
        selectedParentKey,
        otherParentKey,
        selectedCountKey,
        otherCountKey,
      ].forEach((key) => seedQuery(queryClient, key));

      dispatchEpicEvent(
        queryClient,
        registry,
        { epic: { parentId: 'root-1' }, parentId: 'root-2' },
        'project/project-1/epics',
        type,
      );

      expect(isInvalidated(queryClient, selectedProjectKey)).toBe(true);
      expect(isInvalidated(queryClient, selectedCountKey)).toBe(true);
      expect(isInvalidated(queryClient, selectedParentKey)).toBe(true);
      expect(isInvalidated(queryClient, otherProjectKey)).toBe(false);
      expect(isInvalidated(queryClient, otherParentKey)).toBe(false);
      expect(isInvalidated(queryClient, otherCountKey)).toBe(false);
    },
  );

  it.each([
    ['project/project-2/epics', 'updated'],
    ['project/project-1/epics/extra', 'updated'],
    ['project/project-1/agents', 'updated'],
    ['project/project-1/epics', 'archived'],
  ])('leaves selected caches untouched for rejected %s %s events', (topic, type) => {
    const queryClient = createQueryClient();
    const registry = createBoardInvalidationRegistry({
      projectId: 'project-1',
      parentFilter: 'root-1',
    });
    const selectedKeys = [
      boardCacheKeys.project('project-1'),
      boardCacheKeys.children('root-1'),
      boardCacheKeys.subCounts('root-1'),
    ];
    selectedKeys.forEach((key) => seedQuery(queryClient, key));

    dispatchEpicEvent(queryClient, registry, { parentId: 'root-1' }, topic, type);

    selectedKeys.forEach((key) => {
      expect(queryClient.getQueryState(key)).toMatchObject({ isInvalidated: false });
    });
  });

  it('invalidates both sides of a parent move and falls back to the selected parent when unknown', () => {
    const queryClient = createQueryClient();
    const registry = createBoardInvalidationRegistry({
      projectId: 'project-1',
      parentFilter: 'root-1',
    });
    const oldCountKey = boardCacheKeys.subCounts('root-1');
    const newCountKey = boardCacheKeys.subCounts('root-2');
    const selectedParentKey = boardCacheKeys.children('root-1');
    seedQuery(queryClient, oldCountKey);
    seedQuery(queryClient, newCountKey);
    seedQuery(queryClient, selectedParentKey);

    dispatchEpicEvent(queryClient, registry, {
      parentId: 'root-2',
      changes: { parentId: { previous: 'root-1', current: 'root-2' } },
    });

    expect(isInvalidated(queryClient, oldCountKey)).toBe(true);
    expect(isInvalidated(queryClient, newCountKey)).toBe(true);
    expect(isInvalidated(queryClient, selectedParentKey)).toBe(true);

    const unknownParentClient = createQueryClient();
    const unknownParentRegistry = createBoardInvalidationRegistry({
      projectId: 'project-1',
      parentFilter: 'root-1',
    });
    const unknownParentChildren = boardCacheKeys.children('root-1');
    const unrelatedCount = boardCacheKeys.subCounts('root-9');
    seedQuery(unknownParentClient, unknownParentChildren);
    seedQuery(unknownParentClient, unrelatedCount);

    dispatchEpicEvent(unknownParentClient, unknownParentRegistry, {});

    expect(isInvalidated(unknownParentClient, unknownParentChildren)).toBe(true);
    expect(isInvalidated(unknownParentClient, unrelatedCount)).toBe(false);
  });

  it('keeps each registry bound to the scope captured at construction', () => {
    const queryClient = createQueryClient();
    const firstRegistry = createBoardInvalidationRegistry({
      projectId: 'project-1',
      parentFilter: 'root-1',
    });
    createBoardInvalidationRegistry({ projectId: 'project-2', parentFilter: 'root-2' });
    const firstProjectKey = boardCacheKeys.project('project-1');
    const secondProjectKey = boardCacheKeys.project('project-2');
    const firstParentKey = boardCacheKeys.children('root-1');
    const secondParentKey = boardCacheKeys.children('root-2');
    seedQuery(queryClient, firstProjectKey);
    seedQuery(queryClient, secondProjectKey);
    seedQuery(queryClient, firstParentKey);
    seedQuery(queryClient, secondParentKey);

    dispatchEpicEvent(queryClient, firstRegistry, { parentId: 'root-1' });

    expect(isInvalidated(queryClient, firstProjectKey)).toBe(true);
    expect(isInvalidated(queryClient, firstParentKey)).toBe(true);
    expect(isInvalidated(queryClient, secondProjectKey)).toBe(false);
    expect(isInvalidated(queryClient, secondParentKey)).toBe(false);
  });

  it('refreshes the selected project, all cached sub-counts, and selected parent in order', () => {
    const queryClient = createQueryClient();
    const selectedProjectKey = boardCacheKeys.list('project-1', 'active');
    const selectedArchivedKey = boardCacheKeys.list('project-1', 'archived');
    const otherProjectKey = boardCacheKeys.list('project-2', 'active');
    const selectedParentKey = boardCacheKeys.children('root-1');
    const otherParentKey = boardCacheKeys.children('root-2');
    const selectedCountKey = boardCacheKeys.subCounts('root-1');
    const otherCountKey = boardCacheKeys.subCounts('root-9');
    [
      selectedProjectKey,
      selectedArchivedKey,
      otherProjectKey,
      selectedParentKey,
      otherParentKey,
      selectedCountKey,
      otherCountKey,
    ].forEach((key) => seedQuery(queryClient, key));
    const invalidate = jest.spyOn(queryClient, 'invalidateQueries');

    refreshBoardCache(queryClient, { projectId: 'project-1', parentFilter: 'root-1' });

    expect(invalidate).toHaveBeenCalledTimes(3);
    expect(invalidate.mock.calls[0][0]).toEqual({ queryKey: ['epics', 'project-1'] });
    expect(invalidate.mock.calls[1][0]).toEqual({ predicate: expect.any(Function) });
    expect(invalidate.mock.calls[2][0]).toEqual({ queryKey: ['epics', 'parent', 'root-1'] });
    expect(isInvalidated(queryClient, selectedProjectKey)).toBe(true);
    expect(isInvalidated(queryClient, selectedArchivedKey)).toBe(true);
    expect(isInvalidated(queryClient, otherProjectKey)).toBe(false);
    expect(isInvalidated(queryClient, selectedParentKey)).toBe(true);
    expect(isInvalidated(queryClient, otherParentKey)).toBe(false);
    expect(isInvalidated(queryClient, selectedCountKey)).toBe(true);
    expect(isInvalidated(queryClient, otherCountKey)).toBe(true);
  });

  it('does nothing when no project is selected', () => {
    const queryClient = createQueryClient();
    const projectKey = boardCacheKeys.list(null, 'active');
    const parentKey = boardCacheKeys.children('root-1');
    seedQuery(queryClient, projectKey);
    seedQuery(queryClient, parentKey);
    const invalidate = jest.spyOn(queryClient, 'invalidateQueries');

    expect(
      refreshBoardCache(queryClient, { projectId: null, parentFilter: 'root-1' }),
    ).toBeUndefined();
    expect(
      refreshBoardCache(queryClient, { projectId: undefined, parentFilter: undefined }),
    ).toBeUndefined();

    expect(invalidate).not.toHaveBeenCalled();
    expect(isInvalidated(queryClient, projectKey)).toBe(false);
    expect(isInvalidated(queryClient, parentKey)).toBe(false);
    expect(createBoardInvalidationRegistry({ projectId: null, parentFilter: 'root-1' })).toEqual(
      [],
    );
  });
});
