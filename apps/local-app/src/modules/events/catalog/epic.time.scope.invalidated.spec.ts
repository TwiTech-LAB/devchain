import { broadcastRegistry } from './broadcast-registry';
import { epicTimeScopeInvalidatedEvent } from './epic.time.scope.invalidated';
import { projectBroadcast } from './project-broadcast';

describe('epic.time.scope.invalidated', () => {
  const workspaceId = '11111111-1111-4111-8111-111111111111';

  it('accepts exactly one workspace UUID and rejects extra identifiers', () => {
    expect(epicTimeScopeInvalidatedEvent.schema.parse({ workspaceId })).toEqual({ workspaceId });
    expect(() =>
      epicTimeScopeInvalidatedEvent.schema.parse({ workspaceId, epicId: 'secret-epic' }),
    ).toThrow();
    expect(() =>
      epicTimeScopeInvalidatedEvent.schema.parse({ workspaceId: 'not-a-uuid' }),
    ).toThrow();
  });

  it('projects an IDs-only workspace topic and declares one cache owner', () => {
    const [entry] = broadcastRegistry['epic.time.scope.invalidated'];

    expect(projectBroadcast(entry, { workspaceId })).toEqual({
      topic: `workspace/${workspaceId}/epic-time-scope`,
      type: 'invalidated',
      payload: { workspaceId },
    });
    expect(entry.clientReaction).toEqual({
      kind: 'invalidate',
      owner: 'useEpicTimeScopeSync',
    });
  });
});
