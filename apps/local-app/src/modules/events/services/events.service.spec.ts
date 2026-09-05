import { EventEmitter2 } from '@nestjs/event-emitter';
import { ZodError } from 'zod';
import { EventsService, getEventMetadata } from './events.service';
import { EventLogService } from './event-log.service';
import { transientEventNames } from '../catalog';

// Layer: module unit. Calling EventsService with mocked persistence and emitter
// edges is the cheapest reliable proof of schema parsing, metadata attachment,
// and publication orchestration without involving storage or realtime transport.
describe('EventsService', () => {
  let eventEmitter: EventEmitter2;
  let eventLogService: { recordPublished: jest.Mock };
  let service: EventsService;

  beforeEach(() => {
    eventEmitter = {
      emit: jest.fn(),
    } as unknown as EventEmitter2;

    eventLogService = {
      recordPublished: jest
        .fn()
        .mockResolvedValue({ id: 'event-123', publishedAt: new Date().toISOString() }),
    };

    service = new EventsService(eventEmitter, eventLogService as unknown as EventLogService);
  });

  it('publishes known event with valid payload', async () => {
    const payload = {
      sessionId: 'session-1',
      projectId: 'project-1',
      epicId: null,
      agentId: 'agent-1',
      tmuxSessionName: 'devchain_project_epic_agent_session',
    };

    const eventId = await service.publish('session.started', payload);

    expect(eventLogService.recordPublished).toHaveBeenCalledWith({
      name: 'session.started',
      payload,
      requestId: null,
    });
    expect(eventEmitter.emit).toHaveBeenCalledWith('session.started', payload);
    expect(eventId).toBe('event-123');
    const emittedPayload = (eventEmitter.emit as jest.Mock).mock.calls[0][1];
    const metadata = getEventMetadata(emittedPayload);
    expect(metadata).toEqual({ id: 'event-123' });
  });

  it('publishes transcript updates transiently after schema parsing', async () => {
    const payload = {
      kind: 'full-refetch-required' as const,
      sessionId: 'session-1',
      transcriptPath: '/tmp/transcript.jsonl',
      sourceChangeKind: 'file-replacement' as const,
    };

    const eventId = await service.publish('session.transcript.updated', payload);

    expect(transientEventNames).toEqual([
      'epic.relations.invalidated',
      'epic.time.scope.invalidated',
      'session.transcript.updated',
    ]);
    expect(eventId).toBeNull();
    expect(eventLogService.recordPublished).not.toHaveBeenCalled();
    expect(eventEmitter.emit).toHaveBeenCalledWith('session.transcript.updated', payload);
    const emittedPayload = (eventEmitter.emit as jest.Mock).mock.calls[0][1];
    expect(getEventMetadata(emittedPayload)).toBeNull();
  });

  it('publishes Epic-time scope hints transiently without event-log persistence', async () => {
    const payload = { workspaceId: '11111111-1111-4111-8111-111111111111' };

    const eventId = await service.publish('epic.time.scope.invalidated', payload);

    expect(eventId).toBeNull();
    expect(eventLogService.recordPublished).not.toHaveBeenCalled();
    expect(eventEmitter.emit).toHaveBeenCalledWith('epic.time.scope.invalidated', payload);
    const emittedPayload = (eventEmitter.emit as jest.Mock).mock.calls[0][1];
    expect(getEventMetadata(emittedPayload)).toBeNull();
  });

  it('validates transient transcript updates before emitting them', async () => {
    const publish = service.publish.bind(service) as unknown as (
      name: string,
      payload: unknown,
    ) => Promise<string | null>;

    await expect(
      publish('session.transcript.updated', {
        kind: 'full-refetch-required',
        sessionId: 'session-1',
        transcriptPath: '/tmp/transcript.jsonl',
        sourceChangeKind: 'invalid-change-kind',
      }),
    ).rejects.toBeInstanceOf(ZodError);
    expect(eventEmitter.emit).not.toHaveBeenCalled();
    expect(eventLogService.recordPublished).not.toHaveBeenCalled();
  });

  it.each([undefined, ''])(
    'rejects session.started with invalid projectId=%p',
    async (projectId) => {
      const publish = service.publish.bind(service) as unknown as (
        name: string,
        payload: unknown,
      ) => Promise<string | null>;
      await expect(
        publish('session.started', {
          sessionId: 'session-1',
          projectId,
          epicId: null,
          agentId: 'agent-1',
          tmuxSessionName: 'devchain_project_epic_agent_session',
        }),
      ).rejects.toBeInstanceOf(ZodError);
      expect(eventEmitter.emit).not.toHaveBeenCalled();
      expect(eventLogService.recordPublished).not.toHaveBeenCalled();
    },
  );

  it('keeps session.started non-strict and strips unknown fields', async () => {
    const publish = service.publish.bind(service) as unknown as (
      name: string,
      payload: unknown,
    ) => Promise<string | null>;

    await publish('session.started', {
      sessionId: 'session-1',
      projectId: 'project-1',
      epicId: null,
      agentId: 'agent-1',
      tmuxSessionName: 'devchain_project_epic_agent_session',
      legacyExtension: 'accepted-but-not-published',
    });

    const projectedPayload = {
      sessionId: 'session-1',
      projectId: 'project-1',
      epicId: null,
      agentId: 'agent-1',
      tmuxSessionName: 'devchain_project_epic_agent_session',
    };
    expect(eventLogService.recordPublished).toHaveBeenCalledWith({
      name: 'session.started',
      payload: projectedPayload,
      requestId: null,
    });
    expect(eventEmitter.emit).toHaveBeenCalledWith('session.started', projectedPayload);
  });

  it('keeps new integration connection facts strict and project-owned', () => {
    const prepare = service.prepareCommitted.bind(service) as (
      name: 'integration.connection.created',
      payload: unknown,
    ) => unknown;
    const payload = {
      connectionId: 'connection-1',
      projectId: 'project-1',
      provider: 'clickup',
      generation: 1,
      subtaskSyncEnabled: false,
      syncSettingRevision: 1,
      createdAt: '2026-08-25T00:00:00.000Z',
      updatedAt: '2026-08-25T00:00:00.000Z',
    };

    expect(() => prepare('integration.connection.created', payload)).not.toThrow();
    const { projectId: _projectId, ...legacyPayload } = payload;
    expect(() => prepare('integration.connection.created', legacyPayload)).toThrow(ZodError);
    expect(() =>
      prepare('integration.connection.created', { ...payload, unexpected: true }),
    ).toThrow(ZodError);
  });

  it('rejects unknown event names', async () => {
    await expect(
      service.publish('unknown.event' as never, { foo: 'bar' } as never),
    ).rejects.toThrow('Unknown event: unknown.event');
    expect(eventEmitter.emit).not.toHaveBeenCalled();
    expect(eventLogService.recordPublished).not.toHaveBeenCalled();
  });

  describe('agent.created schema', () => {
    it('publishes valid agent.created payload', async () => {
      const payload = {
        agentId: 'agent-new',
        agentName: 'New Bot',
        projectId: 'project-1',
        profileId: 'profile-1',
        providerConfigId: 'config-1',
        actor: null,
      };

      await service.publish('agent.created', payload);

      expect(eventLogService.recordPublished).toHaveBeenCalledWith({
        name: 'agent.created',
        payload,
        requestId: null,
      });
      expect(eventEmitter.emit).toHaveBeenCalledWith('agent.created', payload);
    });

    it('publishes agent.created with actor', async () => {
      const payload = {
        agentId: 'agent-new',
        agentName: 'Team Bot',
        projectId: 'project-1',
        profileId: 'profile-1',
        providerConfigId: 'config-1',
        actor: { type: 'agent' as const, id: 'lead-agent-1' },
      };

      await service.publish('agent.created', payload);

      expect(eventLogService.recordPublished).toHaveBeenCalledWith({
        name: 'agent.created',
        payload,
        requestId: null,
      });
    });

    it('rejects agent.created with missing required fields', async () => {
      const publish = service.publish.bind(service) as unknown as (
        name: string,
        payload: unknown,
      ) => Promise<string | null>;

      await expect(publish('agent.created', { agentId: 'agent-1' })).rejects.toBeInstanceOf(
        ZodError,
      );
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });
  });
});
