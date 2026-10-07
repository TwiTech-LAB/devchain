import { broadcastRegistry } from '../catalog/broadcast-registry';
describe('Runtime signal broadcast registry entries', () => {
  it.each([
    {
      name: 'presence topic',
      event: 'session.presence.changed',
      field: 'topic',
      input: { agentId: 'agent-1', online: true, sessionId: 'sess-1' },
      expected: 'agent/agent-1',
    },
    {
      name: 'presence type',
      event: 'session.presence.changed',
      field: 'type',
      input: {},
      expected: 'presence',
    },
    {
      name: 'online presence',
      event: 'session.presence.changed',
      field: 'payload',
      input: { agentId: 'agent-1', online: true, sessionId: 'sess-1' },
      expected: { online: true, sessionId: 'sess-1', agentId: 'agent-1' },
    },
    {
      name: 'offline presence',
      event: 'session.presence.changed',
      field: 'payload',
      input: { agentId: 'agent-1', online: false, sessionId: null },
      expected: { online: false, sessionId: null, agentId: 'agent-1' },
    },
    {
      name: 'recommendation topic',
      event: 'session.recommendation',
      field: 'topic',
      input: {},
      expected: 'system',
    },
    {
      name: 'recommendation type',
      event: 'session.recommendation',
      field: 'type',
      input: {},
      expected: 'session_recommendation',
    },
    {
      name: 'recommendation projection',
      event: 'session.recommendation',
      field: 'projection',
      input: {},
      expected: undefined,
    },
  ] as const)('projects $name', ({ event, field, input, expected }) => {
    const entry = broadcastRegistry[event][0];
    const value =
      field === 'topic' ? entry.topic : field === 'type' ? entry.type : entry.payloadProjection;
    const actual =
      field === 'projection' ? value : typeof value === 'function' ? value(input) : value;
    expect(actual).toEqual(expected);
  });
});
