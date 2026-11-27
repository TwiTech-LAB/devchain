import { QueryClient } from '@tanstack/react-query';
import { dispatchRealtimeEnvelope } from '@/ui/lib/realtime-invalidation-registry';
import { createEpicDetailInvalidationRegistry, epicDetailQueryKey } from './useEpicDetailSync';

// Layer: UI unit. The registry is the routing rule from project epic frames to
// the one open epic read; the page spec proves the socket wiring end to end.
describe('createEpicDetailInvalidationRegistry', () => {
  const registry = createEpicDetailInvalidationRegistry('project-1', 'epic-1');

  function staleAfter(type: string, payload: Record<string, unknown>, topic?: string) {
    const queryClient = new QueryClient();
    queryClient.setQueryData(epicDetailQueryKey('epic-1'), { version: 7 });
    dispatchRealtimeEnvelope(
      { topic: topic ?? 'project/project-1/epics', type, payload, ts: '2026-11-23T00:00:00.000Z' },
      registry,
      queryClient,
    );
    const stale = queryClient.getQueryState(epicDetailQueryKey('epic-1'))?.isInvalidated;
    queryClient.clear();
    return stale;
  }

  it.each([
    ['an update of the open epic', 'updated', { epicId: 'epic-1' }, undefined, true],
    [
      'a replica apply of the project',
      'remote-synced',
      { projectId: 'project-1' },
      undefined,
      true,
    ],
    ['an update of another epic', 'updated', { epicId: 'epic-2' }, undefined, false],
    ['an update in another project', 'updated', { epicId: 'epic-1' }, 'project/p-2/epics', false],
  ])('handles %s', (_name, type, payload, topic, expected) => {
    expect(staleAfter(type, payload, topic)).toBe(expected);
  });
});
