import { broadcastRegistry } from './broadcast-registry';
import { epicRelationsInvalidatedEvent } from './epic.relations.invalidated';
import { epicTimeScopeInvalidatedEvent } from './epic.time.scope.invalidated';
import { projectBroadcast } from './project-broadcast';
describe('workspace invalidation contracts', () => {
  const workspaceId = '11111111-1111-4111-8111-111111111111';
  it.each([
    [epicRelationsInvalidatedEvent, 'epic-relations', 'useEpicRelationsSync'],
    [epicTimeScopeInvalidatedEvent, 'epic-time-scope', 'useEpicTimeScopeSync'],
  ] as const)('keeps %s scoped to one workspace', (event, topic, owner) => {
    expect(event.schema.parse({ workspaceId })).toEqual({ workspaceId });
    expect(() => event.schema.parse({ workspaceId, epicId: 'secret-epic' })).toThrow();
    expect(() => event.schema.parse({ workspaceId: 'not-a-uuid' })).toThrow();
    const [entry] = broadcastRegistry[event.name];
    expect(projectBroadcast(entry, { workspaceId })).toEqual({
      topic: 'workspace/' + workspaceId + '/' + topic,
      type: 'invalidated',
      payload: { workspaceId },
    });
    expect(entry.clientReaction).toEqual({ kind: 'invalidate', owner });
  });
});
