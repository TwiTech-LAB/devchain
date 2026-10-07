import {
  TeamConfigUpdatedNotifierSubscriber,
  buildMessage,
} from './team-config-updated-notifier.subscriber';
import type { AgentMessageDeliveryService } from '../../agent-message-delivery/agent-message-delivery.service';
import type { EventLogService } from '../../events/services/event-log.service';
import type { TeamConfigUpdatedEventPayload } from '../../events/catalog/team.config.updated';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import type { TeamsService } from '../services/teams.service';

const getEventMetadataMock = jest.fn();

jest.mock('../../events/services/events.service', () => ({
  getEventMetadata: (...args: unknown[]) => getEventMetadataMock(...args),
}));

describe('TeamConfigUpdatedNotifierSubscriber', () => {
  let eventLogService: { recordHandledOk: jest.Mock; recordHandledFail: jest.Mock };
  let deliverMock: jest.Mock;
  let messageDelivery: AgentMessageDeliveryService;
  let getRecipientContextMock: jest.Mock;
  let teamsService: TeamsService;
  let getAgentMock: jest.Mock;
  let storageService: StorageService;
  let subscriber: TeamConfigUpdatedNotifierSubscriber;

  const basePayload: TeamConfigUpdatedEventPayload = {
    teamId: 'team-1',
    projectId: 'project-1',
    teamLeadAgentId: 'agent-lead',
    teamName: 'Alpha Team',
    recipientIds: ['agent-lead'],
    agentName: 'Lead Agent',
    previous: { maxMembers: 5, maxConcurrentTasks: 5, allowTeamLeadCreateAgents: true },
    current: { maxMembers: 8, maxConcurrentTasks: 6, allowTeamLeadCreateAgents: true },
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
      .mockResolvedValue({ isTeamLead: true, teamNames: ['Alpha Team'], memberRole: 'lead' });
    teamsService = { getRecipientContext: getRecipientContextMock } as unknown as TeamsService;
    getAgentMock = jest.fn().mockResolvedValue({ id: 'agent-lead', name: 'Lead Agent' });
    storageService = { getAgent: getAgentMock } as unknown as StorageService;
    getEventMetadataMock.mockReturnValue({ id: 'event-1' });

    subscriber = new TeamConfigUpdatedNotifierSubscriber(
      eventLogService as unknown as EventLogService,
      messageDelivery,
      teamsService,
      storageService,
    );
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  it('skips leadless team (teamLeadAgentId null)', async () => {
    await subscriber.handleTeamConfigUpdated({
      ...basePayload,
      teamLeadAgentId: null,
      recipientIds: [],
    });

    expect(deliverMock).not.toHaveBeenCalled();
  });

  it('delivers with enriched recipientIds, message, source, and project', async () => {
    await subscriber.handleTeamConfigUpdated(basePayload);

    expect(getAgentMock).not.toHaveBeenCalled();
    expect(getRecipientContextMock).toHaveBeenCalledWith('agent-lead', 'project-1');
    expect(deliverMock).toHaveBeenCalledWith(
      ['agent-lead'],
      {
        kind: 'pooled',
        body: "Team 'Alpha Team' config updated \u2014 max members: 8, max concurrent tasks: 6.",
        source: 'team.config.updated',
        projectId: 'project-1',
        senderName: 'System',
      },
      { submitKeys: ['Enter'] },
    );
  });

  it('falls back to teamLeadAgentId when recipientIds is absent', async () => {
    await subscriber.handleTeamConfigUpdated({ ...basePayload, recipientIds: undefined });

    expect(deliverMock).toHaveBeenCalledWith(
      ['agent-lead'],
      expect.objectContaining({ source: 'team.config.updated' }),
      expect.any(Object),
    );
  });

  it('falls back to storage when agentName is missing', async () => {
    await subscriber.handleTeamConfigUpdated({ ...basePayload, agentName: undefined });

    expect(getAgentMock).toHaveBeenCalledWith('agent-lead');
    expect(deliverMock).toHaveBeenCalledTimes(1);
  });

  it('records success in EventLogService', async () => {
    await subscriber.handleTeamConfigUpdated(basePayload);

    expect(eventLogService.recordHandledOk).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: 'event-1',
        handler: 'TeamConfigUpdatedNotifier',
        detail: { poolStatus: 'queued' },
      }),
    );
  });

  it('records failure in EventLogService when delivery throws', async () => {
    deliverMock.mockRejectedValue(new Error('Delivery full'));

    await subscriber.handleTeamConfigUpdated(basePayload);

    expect(eventLogService.recordHandledFail).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: 'event-1',
        handler: 'TeamConfigUpdatedNotifier',
        detail: { message: 'Delivery full' },
      }),
    );
  });
});

describe('buildMessage', () => {
  const base: TeamConfigUpdatedEventPayload = {
    teamId: 'team-1',
    projectId: 'project-1',
    teamLeadAgentId: 'agent-lead',
    teamName: 'Alpha Team',
    previous: { maxMembers: 5, maxConcurrentTasks: 5, allowTeamLeadCreateAgents: true },
    current: { maxMembers: 5, maxConcurrentTasks: 5, allowTeamLeadCreateAgents: true },
  };

  it.each([
    {
      label: 'capacity-only change produces existing message format',
      previous: { maxMembers: 5, maxConcurrentTasks: 5, allowTeamLeadCreateAgents: true },
      current: { maxMembers: 8, maxConcurrentTasks: 6, allowTeamLeadCreateAgents: true },
      expected: "Team 'Alpha Team' config updated \u2014 max members: 8, max concurrent tasks: 6.",
    },
    {
      label: 'flag-only true\u2192false produces no-longer text',
      previous: { maxMembers: 5, maxConcurrentTasks: 5, allowTeamLeadCreateAgents: true },
      current: { maxMembers: 5, maxConcurrentTasks: 5, allowTeamLeadCreateAgents: false },
      expected: "Team 'Alpha Team' setting updated \u2014 lead can no longer create team agents.",
    },
    {
      label: 'flag-only false\u2192true produces now text',
      previous: { maxMembers: 5, maxConcurrentTasks: 5, allowTeamLeadCreateAgents: false },
      current: { maxMembers: 5, maxConcurrentTasks: 5, allowTeamLeadCreateAgents: true },
      expected: "Team 'Alpha Team' setting updated \u2014 lead can now create team agents.",
    },
    {
      label: 'both changed produces combined text',
      previous: { maxMembers: 5, maxConcurrentTasks: 3, allowTeamLeadCreateAgents: true },
      current: { maxMembers: 8, maxConcurrentTasks: 4, allowTeamLeadCreateAgents: false },
      expected:
        "Team 'Alpha Team' updated \u2014 max members: 8, max concurrent tasks: 4; lead can no longer create team agents.",
    },
    {
      label: 'no change still produces capacity message (fallback)',
      previous: base.previous,
      current: base.current,
      expected: "Team 'Alpha Team' config updated \u2014 max members: 5, max concurrent tasks: 5.",
    },
  ])('$label', ({ previous, current, expected }) => {
    expect(buildMessage({ ...base, previous, current })).toBe(expected);
  });
});
