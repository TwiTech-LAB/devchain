import { EpicAssignmentNotifierSubscriber } from './epic-assignment-notifier.subscriber';
import type { AgentMessageDeliveryService } from '../../agent-message-delivery/agent-message-delivery.service';
import type { EventLogService } from '../../events/services/event-log.service';
import type { SettingsService } from '../../settings/services/settings.service';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import type { TeamsService } from '../../teams/services/teams.service';

const getEventMetadataMock = jest.fn();

jest.mock('../../events/services/events.service', () => ({
  getEventMetadata: (...args: unknown[]) => getEventMetadataMock(...args),
}));

describe('EpicAssignmentNotifierSubscriber', () => {
  let eventLogService: { recordHandledOk: jest.Mock; recordHandledFail: jest.Mock };
  let settingsService: { getSetting: jest.Mock };
  let deliverMock: jest.Mock;
  let messageDelivery: AgentMessageDeliveryService;
  let getRecipientContextMock: jest.Mock;
  let teamsService: TeamsService;
  let getAgentMock: jest.Mock;
  let getProjectMock: jest.Mock;
  let getEpicMock: jest.Mock;
  let storageService: StorageService;
  let subscriber: EpicAssignmentNotifierSubscriber;

  const basePayload = {
    epicId: 'epic-1',
    projectId: 'project-1',
    parentId: null,
    version: 2,
    epicTitle: 'Add Feature',
    projectName: 'Demo Project',
    recipientIds: ['agent-1'],
    changes: {
      agentId: {
        previous: null,
        current: 'agent-1',
        currentName: 'Helper Agent',
      },
    },
  } as const;

  beforeEach(() => {
    eventLogService = {
      recordHandledOk: jest.fn().mockResolvedValue({ id: 'handler-ok' }),
      recordHandledFail: jest.fn().mockResolvedValue({ id: 'handler-fail' }),
    };
    settingsService = {
      getSetting: jest.fn().mockReturnValue('[Epic Assignment]\n{epic_title} -> {agent_name}'),
    };
    deliverMock = jest.fn().mockResolvedValue({ status: 'queued', results: [] });
    messageDelivery = { deliver: deliverMock } as unknown as AgentMessageDeliveryService;
    getRecipientContextMock = jest
      .fn()
      .mockResolvedValue({ isTeamLead: false, teamNames: [], memberRole: null });
    teamsService = { getRecipientContext: getRecipientContextMock } as unknown as TeamsService;
    getAgentMock = jest.fn();
    getProjectMock = jest.fn();
    getEpicMock = jest.fn();
    storageService = {
      getAgent: getAgentMock,
      getProject: getProjectMock,
      getEpic: getEpicMock,
    } as unknown as StorageService;
    getEventMetadataMock.mockReturnValue({ id: 'event-1' });

    subscriber = new EpicAssignmentNotifierSubscriber(
      eventLogService as unknown as EventLogService,
      settingsService as unknown as SettingsService,
      messageDelivery,
      teamsService,
      storageService,
    );
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  it('renders template placeholders and delivers epic.updated through AMD', async () => {
    await subscriber.handleEpicUpdated(basePayload);

    expect(deliverMock).toHaveBeenCalledWith(
      ['agent-1'],
      expect.objectContaining({
        kind: 'pooled',
        body: expect.stringContaining('Add Feature -> Helper Agent'),
        source: 'epic.assigned',
        projectId: 'project-1',
        senderName: 'System',
      }),
      { submitKeys: ['Enter'] },
    );
    expect(eventLogService.recordHandledOk).toHaveBeenCalledWith(
      expect.objectContaining({
        handler: 'EpicAssignmentNotifier',
        eventId: 'event-1',
        detail: { poolStatus: 'queued' },
      }),
    );
  });

  it('records failure when AMD delivery throws', async () => {
    deliverMock.mockRejectedValue(new Error('delivery failure'));

    await subscriber.handleEpicUpdated(basePayload);

    expect(eventLogService.recordHandledFail).toHaveBeenCalledWith(
      expect.objectContaining({
        handler: 'EpicAssignmentNotifier',
        eventId: 'event-1',
        detail: { message: 'delivery failure' },
      }),
    );
    expect(eventLogService.recordHandledOk).not.toHaveBeenCalled();
  });

  it('fills missing names from storage when payload lacks context', async () => {
    settingsService.getSetting.mockReturnValue('{epic_title} -> {agent_name} ({project_name})');
    getAgentMock.mockResolvedValue({ name: 'Storage Agent' });
    getProjectMock.mockResolvedValue({ name: 'Storage Project' });
    getEpicMock.mockResolvedValue({ title: 'Storage Epic' });
    getEventMetadataMock.mockReturnValue(null);

    await subscriber.handleEpicUpdated({
      epicId: 'epic-1',
      projectId: 'project-1',
      parentId: null,
      version: 2,
      epicTitle: 'Add Feature',
      projectName: undefined,
      changes: {
        agentId: {
          previous: null,
          current: 'agent-1',
        },
      },
    });

    expect(getAgentMock).toHaveBeenCalled();
    expect(getProjectMock).toHaveBeenCalled();
    expect(getEpicMock).not.toHaveBeenCalled();
    expect(deliverMock).toHaveBeenCalledWith(
      ['agent-1'],
      expect.objectContaining({ body: expect.stringContaining('Add Feature') }),
      expect.any(Object),
    );
  });

  it('ignores events without assignment changes or with unassignment', async () => {
    await subscriber.handleEpicUpdated({
      epicId: 'epic-1',
      projectId: 'project-1',
      parentId: null,
      version: 2,
      epicTitle: 'Updated Title',
      changes: { title: { previous: 'Old Title', current: 'Updated Title' } },
    });

    await subscriber.handleEpicUpdated({
      epicId: 'epic-1',
      projectId: 'project-1',
      parentId: null,
      version: 2,
      epicTitle: 'Add Feature',
      changes: {
        agentId: {
          previous: 'agent-1',
          current: null,
          previousName: 'Helper Agent',
        },
      },
    });

    expect(deliverMock).not.toHaveBeenCalled();
  });

  it('skips self-assignment but delivers same-agent reassignment by another actor', async () => {
    await subscriber.handleEpicUpdated({
      epicId: 'epic-1',
      projectId: 'project-1',
      parentId: null,
      version: 2,
      epicTitle: 'Self Assignment',
      projectName: 'Demo Project',
      actor: { type: 'agent' as const, id: 'agent-1' },
      recipientIds: [],
      changes: {
        agentId: {
          previous: null,
          current: 'agent-1',
          currentName: 'Helper Agent',
        },
      },
    });
    expect(deliverMock).not.toHaveBeenCalled();

    await subscriber.handleEpicUpdated({
      epicId: 'epic-1',
      projectId: 'project-1',
      parentId: null,
      version: 2,
      epicTitle: 'Re-assigned Epic',
      projectName: 'Demo Project',
      actor: { type: 'agent' as const, id: 'agent-2' },
      recipientIds: ['agent-1'],
      changes: {
        agentId: {
          previous: 'agent-1',
          current: 'agent-1',
          currentName: 'Coder',
        },
      },
    });

    expect(deliverMock).toHaveBeenCalledTimes(1);
    expect(deliverMock).toHaveBeenCalledWith(
      ['agent-1'],
      expect.objectContaining({ source: 'epic.assigned' }),
      expect.any(Object),
    );
  });

  it('delivers epic.created assignments using enriched assignmentRecipientIds', async () => {
    await subscriber.handleEpicCreated({
      epicId: 'epic-1',
      projectId: 'project-1',
      title: 'New Epic',
      epicTitle: 'New Epic',
      statusId: 'status-1',
      agentId: 'agent-1',
      assignmentRecipientIds: ['agent-1'],
      actor: { type: 'agent' as const, id: 'agent-2' },
      projectName: 'Demo Project',
      agentName: 'Helper Agent',
    });

    expect(deliverMock).toHaveBeenCalledWith(
      ['agent-1'],
      expect.objectContaining({
        body: '[Epic Assignment]\nNew Epic -> Helper Agent',
        source: 'epic.created',
      }),
      { submitKeys: ['Enter'] },
    );
  });

  describe('team variables', () => {
    it('default template renders without stray team text for teamless agent', async () => {
      settingsService.getSetting.mockReturnValue(null);

      await subscriber.handleEpicUpdated(basePayload);

      expect(deliverMock.mock.calls[0][1].body).toBe(
        '[Epic Assignment]\nAdd Feature is now assigned to Helper Agent in Demo Project. (Epic ID: epic-1)',
      );
    });

    it('custom template resolves team variables from TeamsService.getRecipientContext', async () => {
      settingsService.getSetting.mockReturnValue(
        '{{#if is_team_lead}}LEAD{{else}}MEMBER{{/if}} {team_name}/{team_names}: {epic_title}',
      );
      getRecipientContextMock.mockResolvedValue({
        isTeamLead: true,
        teamNames: ['Backend'],
        memberRole: 'lead',
      });

      await subscriber.handleEpicUpdated(basePayload);

      expect(getRecipientContextMock).toHaveBeenCalledWith('agent-1', 'project-1');
      expect(deliverMock.mock.calls[0][1].body).toBe('LEAD Backend/Backend: Add Feature');
    });

    it('unknown literal tokens are preserved and legacy/native tokens both render', async () => {
      settingsService.getSetting.mockReturnValue('{some_literal} {agent_name} / {{epic_title}}');

      await subscriber.handleEpicUpdated(basePayload);

      expect(deliverMock.mock.calls[0][1].body).toBe('{some_literal} Helper Agent / Add Feature');
    });
  });
});
