import { ZodError } from 'zod';
import { agentDeletedEvent } from './agent.deleted';

describe('agent.deleted catalog entry', () => {
  const schema = agentDeletedEvent.schema;

  it('has the correct event name', () => {
    expect(agentDeletedEvent.name).toBe('agent.deleted');
  });

  it('accepts a full payload with actor and team fields', () => {
    const payload = {
      agentId: 'agent-1',
      agentName: 'Test Agent',
      projectId: 'project-1',
      actor: { type: 'agent' as const, id: 'lead-1' },
      teamId: 'team-1',
      teamName: 'Alpha Team',
    };
    expect(schema.parse(payload)).toEqual(payload);
  });

  it('accepts a minimal payload with actor=null and no team fields', () => {
    const payload = {
      agentId: 'agent-1',
      agentName: 'Test Agent',
      projectId: 'project-1',
      actor: null,
    };
    expect(schema.parse(payload)).toEqual(payload);
  });

  it('accepts a payload with team fields set to null', () => {
    const payload = {
      agentId: 'agent-1',
      agentName: 'Test Agent',
      projectId: 'project-1',
      actor: { type: 'guest' as const, id: 'guest-1' },
      teamId: null,
      teamName: null,
    };
    expect(schema.parse(payload)).toEqual(payload);
  });

  it('rejects payload missing required agentId', () => {
    const payload = {
      agentName: 'Test Agent',
      projectId: 'project-1',
      actor: null,
    };
    expect(() => schema.parse(payload)).toThrow(ZodError);
  });

  it('rejects payload with empty agentId', () => {
    const payload = {
      agentId: '',
      agentName: 'Test Agent',
      projectId: 'project-1',
      actor: null,
    };
    expect(() => schema.parse(payload)).toThrow(ZodError);
  });

  it('rejects payload with invalid actor type', () => {
    const payload = {
      agentId: 'agent-1',
      agentName: 'Test Agent',
      projectId: 'project-1',
      actor: { type: 'unknown', id: 'x' },
    };
    expect(() => schema.parse(payload)).toThrow(ZodError);
  });
});
