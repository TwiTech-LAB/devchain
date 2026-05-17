/**
 * Characterization tests — TeamMembershipChangedNotifierSubscriber.
 *
 * Layer: backend-unit
 * Justification: locks exact team membership notification text and failure
 * handling with mocked delivery collaborators.
 */

import { TeamMembershipChangedNotifierSubscriber } from './team-membership-changed-notifier.subscriber';

const getEventMetadataMock = jest.fn();

jest.mock('../../events/services/events.service', () => ({
  getEventMetadata: (...args: unknown[]) => getEventMetadataMock(...args),
}));

describe('TeamMembershipChangedNotifierSubscriber characterization', () => {
  function createHarness() {
    const eventLog = {
      recordHandledOk: jest.fn().mockResolvedValue({ id: 'ok' }),
      recordHandledFail: jest.fn().mockResolvedValue({ id: 'fail' }),
    };
    const delivery = {
      deliver: jest.fn().mockResolvedValue({ status: 'queued', results: [] }),
    };
    const teams = {
      getRecipientContext: jest
        .fn()
        .mockResolvedValue({ isTeamLead: false, teamNames: ['Builders'], memberRole: 'member' }),
    };
    const subscriber = new TeamMembershipChangedNotifierSubscriber(
      eventLog as never,
      delivery as never,
      teams as never,
    );
    getEventMetadataMock.mockReturnValue({ id: 'event-1' });
    return { eventLog, delivery, subscriber };
  }

  afterEach(() => {
    jest.resetAllMocks();
  });

  it('captures added and removed notification text', async () => {
    const { subscriber, delivery, eventLog } = createHarness();

    await subscriber.handleMemberAdded({
      teamId: 'team-1',
      projectId: 'project-1',
      teamLeadAgentId: 'lead-1',
      teamName: 'Builders',
      addedAgentId: 'agent-1',
      addedAgentName: 'New Agent',
      addedAgentDescription: 'Builds backend features',
      recipientIds: ['lead-1'],
    });
    await subscriber.handleMemberRemoved({
      teamId: 'team-1',
      projectId: 'project-1',
      teamLeadAgentId: 'lead-1',
      teamName: 'Builders',
      removedAgentId: 'agent-2',
      removedAgentName: null,
      recipientIds: ['lead-1'],
    });

    expect(delivery.deliver.mock.calls).toEqual([
      [
        ['lead-1'],
        {
          kind: 'pooled',
          body: "Agent 'New Agent' was added to team 'Builders'. Description: Builds backend features",
          source: 'team.member.added',
          projectId: 'project-1',
          senderName: 'System',
        },
        { submitKeys: ['Enter'] },
      ],
      [
        ['lead-1'],
        {
          kind: 'pooled',
          body: "Agent 'agent-2' was removed from team 'Builders'.",
          source: 'team.member.removed',
          projectId: 'project-1',
          senderName: 'System',
        },
        { submitKeys: ['Enter'] },
      ],
    ]);
    expect(eventLog.recordHandledOk).toHaveBeenCalledTimes(2);
  });

  it('records handled failure when delivery fails', async () => {
    const { subscriber, delivery, eventLog } = createHarness();
    delivery.deliver.mockRejectedValue(new Error('delivery failed'));

    await subscriber.handleMemberAdded({
      teamId: 'team-1',
      projectId: 'project-1',
      teamLeadAgentId: 'lead-1',
      teamName: 'Builders',
      addedAgentId: 'agent-1',
      addedAgentName: null,
      recipientIds: ['lead-1'],
    });

    expect(eventLog.recordHandledFail).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: 'event-1',
        handler: 'TeamMembershipChangedNotifier',
        detail: { message: 'delivery failed' },
      }),
    );
  });
});
