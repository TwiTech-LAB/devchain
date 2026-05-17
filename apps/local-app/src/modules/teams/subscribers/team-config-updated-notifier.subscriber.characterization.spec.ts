/**
 * Characterization tests — TeamConfigUpdatedNotifierSubscriber.
 *
 * Layer: backend-unit
 * Justification: direct subscriber coverage locks exact team-config text and
 * delivery side effects before the subscriber moves to Teams.
 */

import {
  buildMessage,
  TeamConfigUpdatedNotifierSubscriber,
} from './team-config-updated-notifier.subscriber';

const getEventMetadataMock = jest.fn();

jest.mock('../../events/services/events.service', () => ({
  getEventMetadata: (...args: unknown[]) => getEventMetadataMock(...args),
}));

const basePayload = {
  teamId: 'team-1',
  projectId: 'project-1',
  teamLeadAgentId: 'lead-1',
  teamName: 'Builders',
  recipientIds: ['lead-1'],
  agentName: 'Lead Agent',
  previous: { maxMembers: 3, maxConcurrentTasks: 1, allowTeamLeadCreateAgents: false },
  current: { maxMembers: 4, maxConcurrentTasks: 2, allowTeamLeadCreateAgents: true },
};

describe('TeamConfigUpdatedNotifierSubscriber characterization', () => {
  it('captures exact message variants', () => {
    expect(buildMessage(basePayload)).toBe(
      "Team 'Builders' updated \u2014 max members: 4, max concurrent tasks: 2; lead can now create team agents.",
    );
    expect(
      buildMessage({
        ...basePayload,
        current: { maxMembers: 3, maxConcurrentTasks: 1, allowTeamLeadCreateAgents: true },
      }),
    ).toBe("Team 'Builders' setting updated \u2014 lead can now create team agents.");
    expect(
      buildMessage({
        ...basePayload,
        current: { maxMembers: 4, maxConcurrentTasks: 2, allowTeamLeadCreateAgents: false },
      }),
    ).toBe("Team 'Builders' config updated \u2014 max members: 4, max concurrent tasks: 2.");
  });

  it('delivers config update notification and records handled OK', async () => {
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
        .mockResolvedValue({ isTeamLead: true, teamNames: ['Builders'], memberRole: 'lead' }),
    };
    const storage = {
      getAgent: jest.fn().mockResolvedValue({ id: 'lead-1', name: 'Lead Agent' }),
    };
    const subscriber = new TeamConfigUpdatedNotifierSubscriber(
      eventLog as never,
      delivery as never,
      teams as never,
      storage as never,
    );
    getEventMetadataMock.mockReturnValue({ id: 'event-1' });

    await subscriber.handleTeamConfigUpdated(basePayload);

    expect(delivery.deliver).toHaveBeenCalledWith(
      ['lead-1'],
      {
        kind: 'pooled',
        body: buildMessage(basePayload),
        source: 'team.config.updated',
        projectId: 'project-1',
        senderName: 'System',
      },
      { submitKeys: ['Enter'] },
    );
    expect(eventLog.recordHandledOk).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: 'event-1', handler: 'TeamConfigUpdatedNotifier' }),
    );
  });
});
