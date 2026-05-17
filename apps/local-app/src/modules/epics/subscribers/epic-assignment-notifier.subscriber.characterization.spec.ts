/**
 * Characterization tests — EpicAssignmentNotifierSubscriber.
 *
 * Layer: backend-unit
 * Justification: direct subscriber tests with mocked storage/delivery
 * collaborators are the cheapest layer that locks notification text before
 * subscriber relocation.
 */

import { EpicAssignmentNotifierSubscriber } from './epic-assignment-notifier.subscriber';

const getEventMetadataMock = jest.fn();

jest.mock('../../events/services/events.service', () => ({
  getEventMetadata: (...args: unknown[]) => getEventMetadataMock(...args),
}));

describe('EpicAssignmentNotifierSubscriber characterization', () => {
  function createHarness() {
    const eventLog = {
      recordHandledOk: jest.fn().mockResolvedValue({ id: 'ok' }),
      recordHandledFail: jest.fn().mockResolvedValue({ id: 'fail' }),
    };
    const settings = { getSetting: jest.fn().mockReturnValue(undefined) };
    const delivery = {
      deliver: jest.fn().mockResolvedValue({ status: 'queued', results: [] }),
    };
    const teams = {
      getRecipientContext: jest
        .fn()
        .mockResolvedValue({ isTeamLead: false, teamNames: [], memberRole: null }),
    };
    const storage = {
      getAgent: jest.fn().mockResolvedValue({ id: 'actor-1', name: 'Assigning Agent' }),
      getGuest: jest.fn().mockResolvedValue({ id: 'guest-1', name: 'Guest User' }),
      getProject: jest.fn().mockResolvedValue({ id: 'project-1', name: 'Project From Storage' }),
      getEpic: jest.fn().mockResolvedValue({ id: 'epic-1', title: 'Epic From Storage' }),
    };
    const subscriber = new EpicAssignmentNotifierSubscriber(
      eventLog as never,
      settings as never,
      delivery as never,
      teams as never,
      storage as never,
    );

    getEventMetadataMock.mockReturnValue({ id: 'event-1' });
    return { eventLog, delivery, storage, subscriber };
  }

  afterEach(() => {
    jest.resetAllMocks();
  });

  it('captures epic.created notification text, delivery, and event-log OK', async () => {
    const { subscriber, delivery, eventLog } = createHarness();

    await subscriber.handleEpicCreated({
      epicId: 'epic-1',
      projectId: 'project-1',
      title: 'Implement Characterization',
      statusId: 'status-1',
      agentId: 'agent-1',
      assignmentRecipientIds: ['agent-1'],
      actor: { type: 'guest', id: 'guest-1' },
      projectName: 'DevChain',
      agentName: 'Coder',
    } as never);

    expect(delivery.deliver).toHaveBeenCalledWith(
      ['agent-1'],
      {
        kind: 'pooled',
        body: '[Epic Assignment]\nImplement Characterization is now assigned to Coder in DevChain. (Epic ID: epic-1)',
        source: 'epic.created',
        projectId: 'project-1',
        senderName: 'System',
      },
      { submitKeys: ['Enter'] },
    );
    expect(eventLog.recordHandledOk).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: 'event-1',
        handler: 'EpicAssignmentNotifier',
        detail: { poolStatus: 'queued' },
      }),
    );
  });

  it('skips self-assignment without storage, delivery, or event-log writes', async () => {
    const { subscriber, delivery, eventLog, storage } = createHarness();

    await subscriber.handleEpicCreated({
      epicId: 'epic-1',
      projectId: 'project-1',
      title: 'Self Assigned',
      statusId: 'status-1',
      agentId: 'agent-1',
      actor: { type: 'agent', id: 'agent-1' },
    } as never);

    expect(storage.getAgent).not.toHaveBeenCalled();
    expect(delivery.deliver).not.toHaveBeenCalled();
    expect(eventLog.recordHandledOk).not.toHaveBeenCalled();
  });
});
