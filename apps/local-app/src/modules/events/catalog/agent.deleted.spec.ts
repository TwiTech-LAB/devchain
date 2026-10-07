import { agentDeletedEvent } from './agent.deleted';

describe('agent.deleted catalog entry', () => {
  const schema = agentDeletedEvent.schema;

  it('has the correct event name', () => {
    expect(agentDeletedEvent.name).toBe('agent.deleted');
  });

  it.each([
    {
      name: 'accepts a full payload with actor and team fields',
      payload: {
        agentId: 'agent-1',
        agentName: 'Test Agent',
        projectId: 'project-1',
        actor: { type: 'agent' as const, id: 'lead-1' },
        teamId: 'team-1',
        teamName: 'Alpha Team',
      },
    },
    {
      name: 'accepts a minimal payload with actor=null and no team fields',
      payload: {
        agentId: 'agent-1',
        agentName: 'Test Agent',
        projectId: 'project-1',
        actor: null,
      },
    },
    {
      name: 'accepts a payload with team fields set to null',
      payload: {
        agentId: 'agent-1',
        agentName: 'Test Agent',
        projectId: 'project-1',
        actor: { type: 'guest' as const, id: 'guest-1' },
        teamId: null,
        teamName: null,
      },
    },
  ])('$name', ({ payload }) => {
    expect(schema.parse(payload)).toEqual(payload);
  });
});
