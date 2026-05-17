import { CloudEgressBridgeService } from './cloud-egress-bridge.service';
import { CloudSessionManagerService } from './cloud-session-manager.service';
import { EgressQueueService } from './egress-queue.service';
import { EventMapperService } from './event-mapper.service';
import { ProjectEgressConfigService } from './project-egress-config.service';

const mockEventMetadata = new Map<unknown, { id: string }>();

jest.mock('../../events/services/events.service', () => ({
  getEventMetadata: (payload: unknown) => mockEventMetadata.get(payload) ?? null,
}));

describe('CloudEgressBridgeService', () => {
  let bridge: CloudEgressBridgeService;
  let cloudSession: jest.Mocked<CloudSessionManagerService>;
  let egressQueue: jest.Mocked<EgressQueueService>;
  let projectConfig: jest.Mocked<ProjectEgressConfigService>;

  beforeEach(() => {
    cloudSession = {
      getStatus: jest.fn().mockReturnValue({
        connected: true,
        userId: 'user-1',
        identityServiceUrl: 'http://localhost:3002',
      }),
    } as unknown as jest.Mocked<CloudSessionManagerService>;

    egressQueue = {
      enqueue: jest.fn(),
    } as unknown as jest.Mocked<EgressQueueService>;

    projectConfig = {
      isEnabled: jest.fn().mockReturnValue(true),
      hasAnyEnabled: jest.fn().mockReturnValue(true),
    } as unknown as jest.Mocked<ProjectEgressConfigService>;

    bridge = new CloudEgressBridgeService(
      cloudSession,
      egressQueue,
      new EventMapperService(),
      projectConfig,
    );

    mockEventMetadata.clear();
  });

  function withMetadata<T extends object>(payload: T, eventId: string): T {
    mockEventMetadata.set(payload, { id: eventId });
    return payload;
  }

  it('should enqueue epic.created events with projectId', async () => {
    const payload = withMetadata(
      { epicId: 'e1', projectId: 'p1', title: 'Test', statusId: null },
      'evt-1',
    );

    await bridge.onEpicCreated(payload);

    expect(egressQueue.enqueue).toHaveBeenCalledTimes(1);
    const enqueued = egressQueue.enqueue.mock.calls[0][0];
    expect(enqueued.sourceEventType).toBe('epic.created');
    expect(enqueued.sourceEventId).toBe('evt-1');
    expect(enqueued.projectId).toBe('p1');
  });

  it('should skip events when not connected', async () => {
    cloudSession.getStatus.mockReturnValue({
      connected: false,
      identityServiceUrl: 'http://localhost:3002',
    });

    const payload = withMetadata(
      { epicId: 'e1', projectId: 'p1', title: 'Test', statusId: null },
      'evt-1',
    );

    await bridge.onEpicCreated(payload);

    expect(egressQueue.enqueue).not.toHaveBeenCalled();
  });

  it('should skip events without metadata', async () => {
    const payload = { epicId: 'e1', projectId: 'p1', title: 'Test', statusId: null };

    await bridge.onEpicCreated(payload);

    expect(egressQueue.enqueue).not.toHaveBeenCalled();
  });

  it('should skip events for disabled projects', async () => {
    projectConfig.isEnabled.mockReturnValue(false);

    const payload = withMetadata(
      { epicId: 'e1', projectId: 'p1', title: 'Test', statusId: null },
      'evt-1',
    );

    await bridge.onEpicCreated(payload);

    expect(egressQueue.enqueue).not.toHaveBeenCalled();
  });

  it('should forward session.crashed (no projectId) when any project is enabled', async () => {
    projectConfig.hasAnyEnabled.mockReturnValue(true);

    const payload = withMetadata({ sessionId: 's1', sessionName: 'test' }, 'evt-2');

    await bridge.onSessionCrashed(payload);

    expect(egressQueue.enqueue).toHaveBeenCalledTimes(1);
    const enqueued = egressQueue.enqueue.mock.calls[0][0];
    expect(enqueued.sourceEventType).toBe('session.crashed');
    expect(enqueued.projectId).toBeNull();
  });

  it('should enqueue epic.deleted events with projectId', async () => {
    const payload = withMetadata(
      { epicId: 'e1', projectId: 'p1', title: 'Deleted Epic', parentId: null, actor: null },
      'evt-del-1',
    );

    await bridge.onEpicDeleted(payload);

    expect(egressQueue.enqueue).toHaveBeenCalledTimes(1);
    const enqueued = egressQueue.enqueue.mock.calls[0][0];
    expect(enqueued.sourceEventType).toBe('epic.deleted');
    expect(enqueued.sourceEventId).toBe('evt-del-1');
    expect(enqueued.projectId).toBe('p1');
  });

  it('should enqueue epic.comment.created events with projectId', async () => {
    const payload = withMetadata(
      {
        commentId: 'c1',
        epicId: 'e1',
        projectId: 'p1',
        parentId: null,
        authorName: 'Coder',
        content: 'Looks good',
        actor: null,
      },
      'evt-comment-1',
    );

    await bridge.onEpicCommentCreated(payload);

    expect(egressQueue.enqueue).toHaveBeenCalledTimes(1);
    const enqueued = egressQueue.enqueue.mock.calls[0][0];
    expect(enqueued.sourceEventType).toBe('epic.comment.created');
    expect(enqueued.sourceEventId).toBe('evt-comment-1');
    expect(enqueued.projectId).toBe('p1');
  });

  it('should skip session events when no project has notifications enabled', async () => {
    projectConfig.hasAnyEnabled.mockReturnValue(false);

    const payload = withMetadata({ sessionId: 's1', sessionName: 'test' }, 'evt-2');

    await bridge.onSessionCrashed(payload);

    expect(egressQueue.enqueue).not.toHaveBeenCalled();
  });

  it('should forward all 6 allowlisted event types', async () => {
    const events = [
      {
        method: 'onEpicCreated' as const,
        payload: { epicId: 'e1', projectId: 'p1', title: 'T', statusId: null },
      },
      {
        method: 'onEpicUpdated' as const,
        payload: {
          epicId: 'e1',
          projectId: 'p1',
          parentId: null,
          version: 1,
          epicTitle: 'T',
          changes: {},
        },
      },
      {
        method: 'onEpicDeleted' as const,
        payload: {
          epicId: 'e1',
          projectId: 'p1',
          title: 'Deleted',
          parentId: null,
          actor: null,
        },
      },
      {
        method: 'onEpicCommentCreated' as const,
        payload: {
          commentId: 'c1',
          epicId: 'e1',
          projectId: 'p1',
          parentId: null,
          authorName: 'Coder',
          content: 'hello',
          actor: null,
        },
      },
      { method: 'onSessionCrashed' as const, payload: { sessionId: 's1', sessionName: 'n' } },
      { method: 'onSessionStopped' as const, payload: { sessionId: 's1' } },
    ];

    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      const payload = withMetadata(e.payload, `evt-${i}`);
      await (bridge[e.method] as (p: unknown) => Promise<void>)(payload);
    }

    expect(egressQueue.enqueue).toHaveBeenCalledTimes(6);
  });
});
