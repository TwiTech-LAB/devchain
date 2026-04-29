import { SubEpicCreatedNotifierSubscriber } from './sub-epic-created-notifier.subscriber';
import type { EventLogService } from '../services/event-log.service';
import type { SessionsService } from '../../sessions/services/sessions.service';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import type { SessionsMessagePoolService } from '../../sessions/services/sessions-message-pool.service';
import type { ModuleRef } from '@nestjs/core';
import type { EpicCreatedEventPayload } from '../catalog/epic.created';

const getEventMetadataMock = jest.fn();

jest.mock('../services/events.service', () => ({
  getEventMetadata: (...args: unknown[]) => getEventMetadataMock(...args),
}));

describe('SubEpicCreatedNotifierSubscriber', () => {
  let eventLogService: { recordHandledOk: jest.Mock; recordHandledFail: jest.Mock };
  let listActiveSessionsMock: jest.Mock;
  let launchSessionMock: jest.Mock;
  let moduleRef: ModuleRef;
  let enqueueMock: jest.Mock;
  let messagePoolService: SessionsMessagePoolService;
  let getAgentMock: jest.Mock;
  let getEpicMock: jest.Mock;
  let getGuestMock: jest.Mock;
  let storageService: StorageService;
  let subscriber: SubEpicCreatedNotifierSubscriber;

  const parentEpic = {
    id: 'parent-epic-1',
    title: 'Parent Feature',
    agentId: 'agent-parent',
    projectId: 'project-1',
  };

  function makePayload(overrides: Partial<EpicCreatedEventPayload> = {}): EpicCreatedEventPayload {
    return {
      epicId: 'child-epic-1',
      projectId: 'project-1',
      title: 'Child Task',
      statusId: 'status-1',
      parentId: 'parent-epic-1',
      agentId: 'agent-child',
      actor: { type: 'agent' as const, id: 'agent-creator' },
      ...overrides,
    };
  }

  beforeEach(() => {
    eventLogService = {
      recordHandledOk: jest.fn().mockResolvedValue({ id: 'ok' }),
      recordHandledFail: jest.fn().mockResolvedValue({ id: 'fail' }),
    };

    listActiveSessionsMock = jest.fn().mockResolvedValue([]);
    launchSessionMock = jest.fn().mockResolvedValue({ id: 'session-1', tmuxSessionId: 'tmux-1' });

    moduleRef = {
      get: jest.fn().mockReturnValue({
        listActiveSessions: listActiveSessionsMock,
        launchSession: launchSessionMock,
      } as unknown as SessionsService),
    } as unknown as ModuleRef;

    enqueueMock = jest.fn().mockResolvedValue({ status: 'queued', poolSize: 1 });
    messagePoolService = { enqueue: enqueueMock } as unknown as SessionsMessagePoolService;

    getAgentMock = jest.fn().mockResolvedValue({ id: 'agent-parent', name: 'Parent Agent' });
    getEpicMock = jest.fn().mockResolvedValue(parentEpic);
    getGuestMock = jest.fn();
    storageService = {
      getAgent: getAgentMock,
      getEpic: getEpicMock,
      getGuest: getGuestMock,
    } as unknown as StorageService;

    getEventMetadataMock.mockReturnValue({ id: 'event-1' });

    subscriber = new SubEpicCreatedNotifierSubscriber(
      eventLogService as unknown as EventLogService,
      moduleRef,
      messagePoolService,
      storageService,
    );
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  it('skips top-level epic (no parentId)', async () => {
    await subscriber.handleEpicCreated(makePayload({ parentId: undefined }));
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('skips when parent lookup throws NotFoundError', async () => {
    getEpicMock.mockRejectedValue(new Error('NotFoundError'));
    await subscriber.handleEpicCreated(makePayload());
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('skips when parent is unassigned (agentId null)', async () => {
    getEpicMock.mockResolvedValue({ ...parentEpic, agentId: null });
    await subscriber.handleEpicCreated(makePayload());
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('skips self-spawn (actor.id === parent.agentId)', async () => {
    await subscriber.handleEpicCreated(
      makePayload({ actor: { type: 'agent', id: 'agent-parent' } }),
    );
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('enqueues notification to parent agent when creator is different', async () => {
    getAgentMock
      .mockResolvedValueOnce({ id: 'agent-parent', name: 'Parent Agent' })
      .mockResolvedValueOnce({ id: 'agent-creator', name: 'Creator Agent' });

    await subscriber.handleEpicCreated(makePayload());

    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock).toHaveBeenCalledWith(
      'agent-parent',
      expect.stringContaining(
        "A new sub-epic 'Child Task' (child-epic-1) was created under your epic 'Parent Feature' (parent-epic-1) by Creator Agent.",
      ),
      {
        source: 'epic.sub_epic.created',
        submitKeys: ['Enter'],
        projectId: 'project-1',
        agentName: 'Parent Agent',
      },
    );
  });

  it('enqueues when actor is null (HTTP-path)', async () => {
    await subscriber.handleEpicCreated(makePayload({ actor: null }));

    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock).toHaveBeenCalledWith(
      'agent-parent',
      expect.stringContaining("was created under your epic 'Parent Feature'"),
      expect.objectContaining({ source: 'epic.sub_epic.created' }),
    );
    const message = enqueueMock.mock.calls[0][1] as string;
    expect(message).not.toContain(' by ');
  });

  it('includes guest creator name when resolvable', async () => {
    getGuestMock.mockResolvedValue({ id: 'guest-1', name: 'Bob' });

    await subscriber.handleEpicCreated(makePayload({ actor: { type: 'guest', id: 'guest-1' } }));

    expect(enqueueMock).toHaveBeenCalledTimes(1);
    const message = enqueueMock.mock.calls[0][1] as string;
    expect(message).toContain(' by Bob.');
  });

  it('omits by-clause when guest name is unresolvable', async () => {
    getGuestMock.mockRejectedValue(new Error('NotFoundError'));

    await subscriber.handleEpicCreated(
      makePayload({ actor: { type: 'guest', id: 'guest-unknown' } }),
    );

    expect(enqueueMock).toHaveBeenCalledTimes(1);
    const message = enqueueMock.mock.calls[0][1] as string;
    expect(message).not.toContain(' by ');
    expect(message).toMatch(/\(parent-epic-1\)\.$/);
  });

  it('routes to parent agent and launches session scoped to parent epic', async () => {
    getAgentMock
      .mockResolvedValueOnce({ id: 'agent-parent', name: 'Agent A' })
      .mockResolvedValueOnce({ id: 'agent-creator', name: 'Agent C' });

    await subscriber.handleEpicCreated(
      makePayload({
        agentId: 'agent-child-b',
        actor: { type: 'agent', id: 'agent-creator-c' },
      }),
    );

    expect(enqueueMock).toHaveBeenCalledWith(
      'agent-parent',
      expect.any(String),
      expect.objectContaining({ agentName: 'Agent A' }),
    );

    expect(launchSessionMock).toHaveBeenCalledWith({
      projectId: 'project-1',
      agentId: 'agent-parent',
      epicId: 'parent-epic-1',
      options: { silent: true },
    });
  });

  it('records success in EventLogService', async () => {
    await subscriber.handleEpicCreated(makePayload({ actor: null }));

    expect(eventLogService.recordHandledOk).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: 'event-1',
        handler: 'SubEpicCreatedNotifier',
      }),
    );
  });

  it('records failure in EventLogService when enqueue throws', async () => {
    enqueueMock.mockRejectedValue(new Error('Pool full'));

    await subscriber.handleEpicCreated(makePayload({ actor: null }));

    expect(eventLogService.recordHandledFail).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: 'event-1',
        handler: 'SubEpicCreatedNotifier',
        detail: { message: 'Pool full' },
      }),
    );
  });
});
