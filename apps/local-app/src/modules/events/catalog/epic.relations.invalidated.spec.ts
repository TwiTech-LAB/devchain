import { broadcastRegistry } from './broadcast-registry';
import { epicRelationsInvalidatedEvent } from './epic.relations.invalidated';
import { projectBroadcast } from './project-broadcast';

describe('epic.relations.invalidated', () => {
  const workspaceId = '11111111-1111-4111-8111-111111111111';

  it('accepts exactly one workspace UUID and rejects extra identifiers', () => {
    expect(epicRelationsInvalidatedEvent.schema.parse({ workspaceId })).toEqual({ workspaceId });
    expect(() =>
      epicRelationsInvalidatedEvent.schema.parse({ workspaceId, epicId: 'secret-epic' }),
    ).toThrow();
    expect(() =>
      epicRelationsInvalidatedEvent.schema.parse({ workspaceId: 'not-a-uuid' }),
    ).toThrow();
  });

  it('projects an IDs-only workspace topic and declares one cache owner', () => {
    const [entry] = broadcastRegistry['epic.relations.invalidated'];

    expect(projectBroadcast(entry, { workspaceId })).toEqual({
      topic: `workspace/${workspaceId}/epic-relations`,
      type: 'invalidated',
      payload: { workspaceId },
    });
    expect(entry.clientReaction).toEqual({
      kind: 'invalidate',
      owner: 'useEpicRelationsSync',
    });
  });
});
