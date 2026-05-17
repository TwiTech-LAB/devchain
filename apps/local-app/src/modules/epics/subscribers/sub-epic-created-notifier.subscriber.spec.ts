import { SubEpicCreatedNotifierSubscriber } from './sub-epic-created-notifier.subscriber';
import type { AgentMessageDeliveryService } from '../../agent-message-delivery/agent-message-delivery.service';
import type { EventLogService } from '../../events/services/event-log.service';
import type { EpicCreatedEventPayload } from '../../events/catalog/epic.created';
import type { StorageService } from '../../storage/interfaces/storage.interface';

const getEventMetadataMock = jest.fn();

jest.mock('../../events/services/events.service', () => ({
  getEventMetadata: (...args: unknown[]) => getEventMetadataMock(...args),
}));

describe('SubEpicCreatedNotifierSubscriber', () => {
  let eventLogService: { recordHandledOk: jest.Mock; recordHandledFail: jest.Mock };
  let deliverMock: jest.Mock;
  let messageDelivery: AgentMessageDeliveryService;
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
    deliverMock = jest.fn().mockResolvedValue({ status: 'queued', results: [] });
    messageDelivery = { deliver: deliverMock } as unknown as AgentMessageDeliveryService;
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
      messageDelivery,
      storageService,
    );
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  it('skips top-level epic (no parentId)', async () => {
    await subscriber.handleEpicCreated(makePayload({ parentId: undefined }));
    expect(deliverMock).not.toHaveBeenCalled();
  });

  it('skips when parent lookup throws or parent is unassigned', async () => {
    getEpicMock.mockRejectedValueOnce(new Error('NotFoundError'));
    await subscriber.handleEpicCreated(makePayload());

    getEpicMock.mockResolvedValueOnce({ ...parentEpic, agentId: null });
    await subscriber.handleEpicCreated(makePayload());

    expect(deliverMock).not.toHaveBeenCalled();
  });

  it('skips self-spawn (actor.id === parentAgentId)', async () => {
    await subscriber.handleEpicCreated(
      makePayload({
        actor: { type: 'agent', id: 'agent-parent' },
        parentAgentId: 'agent-parent',
        parentTitle: 'Parent Feature',
      }),
    );

    expect(deliverMock).not.toHaveBeenCalled();
    expect(getEpicMock).not.toHaveBeenCalled();
  });

  it('delivers notification to parent agent using enriched payload facts', async () => {
    await subscriber.handleEpicCreated(
      makePayload({
        epicTitle: 'Child Task',
        parentAgentId: 'agent-parent',
        parentAgentName: 'Parent Agent',
        parentTitle: 'Parent Feature',
        creatorName: 'Creator Agent',
        subEpicRecipientIds: ['agent-parent'],
      }),
    );

    expect(deliverMock).toHaveBeenCalledWith(
      ['agent-parent'],
      {
        kind: 'pooled',
        body: "A new sub-epic 'Child Task' (child-epic-1) was created under your epic 'Parent Feature' (parent-epic-1) by Creator Agent.",
        source: 'epic.sub_epic.created',
        projectId: 'project-1',
        senderName: 'System',
      },
      { submitKeys: ['Enter'] },
    );
    expect(getEpicMock).not.toHaveBeenCalled();
  });

  it('falls back to storage for legacy payloads and actor names', async () => {
    getAgentMock
      .mockResolvedValueOnce({ id: 'agent-parent', name: 'Parent Agent' })
      .mockResolvedValueOnce({ id: 'agent-creator', name: 'Creator Agent' });

    await subscriber.handleEpicCreated(makePayload());

    expect(deliverMock).toHaveBeenCalledWith(
      ['agent-parent'],
      expect.objectContaining({
        body: "A new sub-epic 'Child Task' (child-epic-1) was created under your epic 'Parent Feature' (parent-epic-1) by Creator Agent.",
      }),
      expect.any(Object),
    );
  });

  it('omits by-clause when actor is null or unresolvable guest', async () => {
    await subscriber.handleEpicCreated(makePayload({ actor: null }));
    expect(deliverMock.mock.calls[0][1].body).not.toContain(' by ');

    deliverMock.mockClear();
    getGuestMock.mockRejectedValue(new Error('NotFoundError'));
    await subscriber.handleEpicCreated(
      makePayload({ actor: { type: 'guest', id: 'guest-unknown' } }),
    );

    expect(deliverMock.mock.calls[0][1].body).not.toContain(' by ');
    expect(deliverMock.mock.calls[0][1].body).toMatch(/\(parent-epic-1\)\.$/);
  });

  it('records success and failure in EventLogService', async () => {
    await subscriber.handleEpicCreated(makePayload({ actor: null }));

    expect(eventLogService.recordHandledOk).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: 'event-1',
        handler: 'SubEpicCreatedNotifier',
        detail: { poolStatus: 'queued' },
      }),
    );

    eventLogService.recordHandledOk.mockClear();
    deliverMock.mockRejectedValue(new Error('Delivery full'));

    await subscriber.handleEpicCreated(makePayload({ actor: null }));

    expect(eventLogService.recordHandledFail).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: 'event-1',
        handler: 'SubEpicCreatedNotifier',
        detail: { message: 'Delivery full' },
      }),
    );
  });
});
