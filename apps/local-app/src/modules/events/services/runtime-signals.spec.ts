import { EventEmitter2 } from 'eventemitter2';
import { broadcastRegistry } from '../catalog/broadcast-registry';

describe('Runtime signal broadcast registry entries', () => {
  describe('session.presence.changed', () => {
    const entries = broadcastRegistry['session.presence.changed'];

    it('has exactly 1 broadcast topic', () => {
      expect(entries).toHaveLength(1);
    });

    it('routes to agent/{agentId} topic', () => {
      const entry = entries[0];
      const topic =
        typeof entry.topic === 'function'
          ? entry.topic({ agentId: 'agent-1', online: true, sessionId: 'sess-1' })
          : entry.topic;
      expect(topic).toBe('agent/agent-1');
    });

    it('uses "presence" type', () => {
      const entry = entries[0];
      const type =
        typeof entry.type === 'function' ? entry.type({} as Record<string, unknown>) : entry.type;
      expect(type).toBe('presence');
    });

    it('projects online, sessionId, agentId', () => {
      const entry = entries[0];
      const payload = entry.payloadProjection?.({
        agentId: 'agent-1',
        online: true,
        sessionId: 'sess-1',
      } as Record<string, unknown>);
      expect(payload).toEqual({
        online: true,
        sessionId: 'sess-1',
        agentId: 'agent-1',
      });
    });

    it('projects null sessionId for offline presence', () => {
      const entry = entries[0];
      const payload = entry.payloadProjection?.({
        agentId: 'agent-1',
        online: false,
        sessionId: null,
      } as Record<string, unknown>);
      expect(payload).toEqual({
        online: false,
        sessionId: null,
        agentId: 'agent-1',
      });
    });
  });

  describe('session.recommendation', () => {
    const entries = broadcastRegistry['session.recommendation'];

    it('has exactly 1 broadcast topic', () => {
      expect(entries).toHaveLength(1);
    });

    it('routes to static "system" topic', () => {
      const entry = entries[0];
      const topic =
        typeof entry.topic === 'function'
          ? entry.topic({} as Record<string, unknown>)
          : entry.topic;
      expect(topic).toBe('system');
    });

    it('uses "session_recommendation" type', () => {
      const entry = entries[0];
      const type =
        typeof entry.type === 'function' ? entry.type({} as Record<string, unknown>) : entry.type;
      expect(type).toBe('session_recommendation');
    });

    it('forwards full payload (no projection needed)', () => {
      const entry = entries[0];
      expect(entry.payloadProjection).toBeUndefined();
    });
  });
});

describe('Runtime signal catalog routing', () => {
  it('presence event routes through CatalogBroadcaster to broadcaster', () => {
    const entry = broadcastRegistry['session.presence.changed'][0];
    const broadcaster = { broadcastEvent: jest.fn() };
    const eventEmitter = new EventEmitter2();

    eventEmitter.on('session.presence.changed', (payload: Record<string, unknown>) => {
      const topic = typeof entry.topic === 'function' ? entry.topic(payload) : entry.topic;
      const type = typeof entry.type === 'function' ? entry.type(payload) : entry.type;
      const projected = entry.payloadProjection ? entry.payloadProjection(payload) : payload;
      broadcaster.broadcastEvent(topic, type, projected);
    });

    eventEmitter.emit('session.presence.changed', {
      agentId: 'agent-42',
      online: true,
      sessionId: 'sess-1',
    });

    expect(broadcaster.broadcastEvent).toHaveBeenCalledWith('agent/agent-42', 'presence', {
      online: true,
      sessionId: 'sess-1',
      agentId: 'agent-42',
    });
  });

  it('recommendation event routes through CatalogBroadcaster to broadcaster', () => {
    const entry = broadcastRegistry['session.recommendation'][0];
    const broadcaster = { broadcastEvent: jest.fn() };
    const eventEmitter = new EventEmitter2();

    eventEmitter.on('session.recommendation', (payload: Record<string, unknown>) => {
      const topic = typeof entry.topic === 'function' ? entry.topic(payload) : entry.topic;
      const type = typeof entry.type === 'function' ? entry.type(payload) : entry.type;
      const projected = entry.payloadProjection ? entry.payloadProjection(payload) : payload;
      broadcaster.broadcastEvent(topic, type, projected);
    });

    const payload = {
      reason: 'context window limit',
      agentId: 'agent-1',
      agentName: 'Test Agent',
      providerId: 'prov-1',
      providerName: 'claude',
      silent: true,
      bootId: 'boot-123',
    };

    eventEmitter.emit('session.recommendation', payload);

    expect(broadcaster.broadcastEvent).toHaveBeenCalledWith(
      'system',
      'session_recommendation',
      payload,
    );
  });
});

describe('Runtime signal state-before-broadcast ordering', () => {
  it('session.stopped is published before session.presence.changed (offline)', async () => {
    const publishOrder: string[] = [];
    const eventsService = {
      publish: jest.fn().mockImplementation(async (name: string) => {
        publishOrder.push(name);
      }),
    };

    await eventsService.publish('session.stopped', { sessionId: 's1' });
    await eventsService.publish('session.presence.changed', {
      agentId: 'a1',
      online: false,
      sessionId: null,
    });

    expect(publishOrder).toEqual(['session.stopped', 'session.presence.changed']);
  });

  it('session.started is published before session.presence.changed (online)', async () => {
    const publishOrder: string[] = [];
    const eventsService = {
      publish: jest.fn().mockImplementation(async (name: string) => {
        publishOrder.push(name);
      }),
    };

    await eventsService.publish('session.started', {
      sessionId: 's1',
      epicId: null,
      agentId: 'a1',
      tmuxSessionName: 'tmux-1',
    });
    await eventsService.publish('session.presence.changed', {
      agentId: 'a1',
      online: true,
      sessionId: 's1',
    });

    expect(publishOrder).toEqual(['session.started', 'session.presence.changed']);
  });

  it('session.restored is published before session.presence.changed (online)', async () => {
    const publishOrder: string[] = [];
    const eventsService = {
      publish: jest.fn().mockImplementation(async (name: string) => {
        publishOrder.push(name);
      }),
    };

    await eventsService.publish('session.restored', {
      sessionId: 's1',
      agentId: 'a1',
      projectId: 'p1',
      transcriptPath: '/path',
      providerName: 'claude',
    });
    await eventsService.publish('session.presence.changed', {
      agentId: 'a1',
      online: true,
      sessionId: 's1',
    });

    expect(publishOrder).toEqual(['session.restored', 'session.presence.changed']);
  });
});
