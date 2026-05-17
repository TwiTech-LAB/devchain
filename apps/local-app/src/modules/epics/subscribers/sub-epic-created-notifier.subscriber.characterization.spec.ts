/**
 * Characterization tests — SubEpicCreatedNotifierSubscriber.
 *
 * Layer: backend-unit
 * Justification: locks exact sub-epic notification text and side effects with
 * mocked collaborators before subscriber ownership moves.
 */

import { SubEpicCreatedNotifierSubscriber } from './sub-epic-created-notifier.subscriber';

const getEventMetadataMock = jest.fn();

jest.mock('../../events/services/events.service', () => ({
  getEventMetadata: (...args: unknown[]) => getEventMetadataMock(...args),
}));

describe('SubEpicCreatedNotifierSubscriber characterization', () => {
  function createHarness() {
    const eventLog = {
      recordHandledOk: jest.fn().mockResolvedValue({ id: 'ok' }),
      recordHandledFail: jest.fn().mockResolvedValue({ id: 'fail' }),
    };
    const delivery = {
      deliver: jest.fn().mockResolvedValue({ status: 'queued', results: [] }),
    };
    const storage = {
      getEpic: jest.fn().mockResolvedValue({
        id: 'parent-1',
        title: 'Parent Epic',
        agentId: 'agent-parent',
      }),
      getAgent: jest.fn().mockResolvedValue({ id: 'agent-parent', name: 'Parent Agent' }),
      getGuest: jest.fn().mockResolvedValue({ id: 'guest-1', name: 'Guest User' }),
    };
    const subscriber = new SubEpicCreatedNotifierSubscriber(
      eventLog as never,
      delivery as never,
      storage as never,
    );
    getEventMetadataMock.mockReturnValue({ id: 'event-1' });
    return { eventLog, delivery, storage, subscriber };
  }

  afterEach(() => {
    jest.resetAllMocks();
  });

  it('captures child-created text, delivery, and event-log OK', async () => {
    const { subscriber, delivery, eventLog } = createHarness();

    await subscriber.handleEpicCreated({
      epicId: 'child-1',
      projectId: 'project-1',
      title: 'Child Epic',
      statusId: 'status-1',
      parentId: 'parent-1',
      actor: { type: 'guest', id: 'guest-1' },
    } as never);

    expect(delivery.deliver).toHaveBeenCalledWith(
      ['agent-parent'],
      {
        kind: 'pooled',
        body: "A new sub-epic 'Child Epic' (child-1) was created under your epic 'Parent Epic' (parent-1) by Guest User.",
        source: 'epic.sub_epic.created',
        projectId: 'project-1',
        senderName: 'System',
      },
      { submitKeys: ['Enter'] },
    );
    expect(eventLog.recordHandledOk).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: 'event-1', handler: 'SubEpicCreatedNotifier' }),
    );
  });

  it('skips missing parent and self-spawn without delivery', async () => {
    const { subscriber, storage, delivery } = createHarness();
    storage.getEpic.mockResolvedValueOnce(null);

    await subscriber.handleEpicCreated({
      epicId: 'child-1',
      projectId: 'project-1',
      title: 'Child Epic',
      statusId: 'status-1',
      parentId: 'missing-parent',
    } as never);

    storage.getEpic.mockResolvedValueOnce({
      id: 'parent-1',
      title: 'Parent Epic',
      agentId: 'agent-parent',
    });
    await subscriber.handleEpicCreated({
      epicId: 'child-2',
      projectId: 'project-1',
      title: 'Child Epic 2',
      statusId: 'status-1',
      parentId: 'parent-1',
      actor: { type: 'agent', id: 'agent-parent' },
    } as never);

    expect(delivery.deliver).not.toHaveBeenCalled();
  });
});
