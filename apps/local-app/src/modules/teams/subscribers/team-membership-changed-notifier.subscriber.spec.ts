import { TeamMembershipChangedNotifierSubscriber } from './team-membership-changed-notifier.subscriber';
import type { AgentMessageDeliveryService } from '../../agent-message-delivery/agent-message-delivery.service';
import type { EventLogService } from '../../events/services/event-log.service';
import type { TeamMemberAddedEventPayload } from '../../events/catalog/team.member.added';
import type { TeamMemberRemovedEventPayload } from '../../events/catalog/team.member.removed';
import type { TeamsService } from '../services/teams.service';

const getEventMetadataMock = jest.fn();

jest.mock('../../events/services/events.service', () => ({
  getEventMetadata: (...args: unknown[]) => getEventMetadataMock(...args),
}));

describe('TeamMembershipChangedNotifierSubscriber', () => {
  let eventLogService: { recordHandledOk: jest.Mock; recordHandledFail: jest.Mock };
  let deliverMock: jest.Mock;
  let messageDelivery: AgentMessageDeliveryService;
  let getRecipientContextMock: jest.Mock;
  let teamsService: TeamsService;
  let subscriber: TeamMembershipChangedNotifierSubscriber;

  const addedPayload: TeamMemberAddedEventPayload = {
    teamId: 'team-1',
    projectId: 'project-1',
    teamLeadAgentId: 'agent-lead',
    teamName: 'Alpha Team',
    addedAgentId: 'agent-new',
    addedAgentName: 'New Agent',
    addedAgentDescription: 'Handles backend API work',
    recipientIds: ['agent-new'],
    agentName: 'New Agent',
    teamLeadAgentName: 'Lead Agent',
  };

  const removedPayload: TeamMemberRemovedEventPayload = {
    teamId: 'team-1',
    projectId: 'project-1',
    teamLeadAgentId: 'agent-lead',
    teamName: 'Alpha Team',
    removedAgentId: 'agent-old',
    removedAgentName: 'Old Agent',
    recipientIds: ['agent-old'],
    agentName: 'Old Agent',
    teamLeadAgentName: 'Lead Agent',
  };

  beforeEach(() => {
    eventLogService = {
      recordHandledOk: jest.fn().mockResolvedValue({ id: 'ok' }),
      recordHandledFail: jest.fn().mockResolvedValue({ id: 'fail' }),
    };
    deliverMock = jest.fn().mockResolvedValue({ status: 'queued', results: [] });
    messageDelivery = { deliver: deliverMock } as unknown as AgentMessageDeliveryService;
    getRecipientContextMock = jest
      .fn()
      .mockResolvedValue({ isTeamLead: false, teamNames: ['Alpha Team'], memberRole: 'member' });
    teamsService = { getRecipientContext: getRecipientContextMock } as unknown as TeamsService;
    getEventMetadataMock.mockReturnValue({ id: 'event-1' });

    subscriber = new TeamMembershipChangedNotifierSubscriber(
      eventLogService as unknown as EventLogService,
      messageDelivery,
      teamsService,
    );
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  describe('handleMemberAdded', () => {
    it('skips when teamLeadAgentId is null', async () => {
      await subscriber.handleMemberAdded({
        ...addedPayload,
        teamLeadAgentId: null,
        recipientIds: [],
      });

      expect(deliverMock).not.toHaveBeenCalled();
    });

    it('delivers message with enriched recipientIds and agent name', async () => {
      await subscriber.handleMemberAdded(addedPayload);

      expect(getRecipientContextMock).toHaveBeenCalledWith('agent-lead', 'project-1');
      expect(deliverMock).toHaveBeenCalledWith(
        ['agent-lead'],
        {
          kind: 'pooled',
          body: "Agent 'New Agent' was added to team 'Alpha Team'. Description: Handles backend API work",
          source: 'team.member.added',
          projectId: 'project-1',
          senderName: 'System',
        },
        { submitKeys: ['Enter'] },
      );
    });

    it('falls back to lead recipient when recipientIds is absent', async () => {
      await subscriber.handleMemberAdded({ ...addedPayload, recipientIds: undefined });

      expect(deliverMock).toHaveBeenCalledWith(
        ['agent-lead'],
        expect.objectContaining({ source: 'team.member.added' }),
        expect.any(Object),
      );
    });

    it('falls back to agent ID when name is null', async () => {
      await subscriber.handleMemberAdded({ ...addedPayload, addedAgentName: null });

      expect(deliverMock.mock.calls[0][1].body).toBe(
        "Agent 'agent-new' was added to team 'Alpha Team'. Description: Handles backend API work",
      );
    });

    it('omits description text when added agent description is absent', async () => {
      await subscriber.handleMemberAdded({ ...addedPayload, addedAgentDescription: null });

      expect(deliverMock.mock.calls[0][1].body).toBe(
        "Agent 'New Agent' was added to team 'Alpha Team'.",
      );
    });

    it('records success in EventLogService', async () => {
      await subscriber.handleMemberAdded(addedPayload);

      expect(eventLogService.recordHandledOk).toHaveBeenCalledWith(
        expect.objectContaining({
          eventId: 'event-1',
          handler: 'TeamMembershipChangedNotifier',
          detail: { poolStatus: 'queued' },
        }),
      );
    });

    it('records failure when delivery throws', async () => {
      deliverMock.mockRejectedValue(new Error('Delivery full'));

      await subscriber.handleMemberAdded(addedPayload);

      expect(eventLogService.recordHandledFail).toHaveBeenCalledWith(
        expect.objectContaining({
          eventId: 'event-1',
          handler: 'TeamMembershipChangedNotifier',
          detail: { message: 'Delivery full' },
        }),
      );
    });
  });

  describe('handleMemberRemoved', () => {
    it('skips when teamLeadAgentId is null', async () => {
      await subscriber.handleMemberRemoved({
        ...removedPayload,
        teamLeadAgentId: null,
        recipientIds: [],
      });

      expect(deliverMock).not.toHaveBeenCalled();
    });

    it('delivers message with enriched recipientIds and agent name', async () => {
      await subscriber.handleMemberRemoved(removedPayload);

      expect(getRecipientContextMock).toHaveBeenCalledWith('agent-lead', 'project-1');
      expect(deliverMock).toHaveBeenCalledWith(
        ['agent-lead'],
        expect.objectContaining({
          body: "Agent 'Old Agent' was removed from team 'Alpha Team'.",
          source: 'team.member.removed',
        }),
        { submitKeys: ['Enter'] },
      );
    });

    it('falls back to agent ID when name is null', async () => {
      await subscriber.handleMemberRemoved({ ...removedPayload, removedAgentName: null });

      expect(deliverMock.mock.calls[0][1].body).toBe(
        "Agent 'agent-old' was removed from team 'Alpha Team'.",
      );
    });
  });
});
