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
  let getStatusMock: jest.Mock;
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
    getStatusMock = jest.fn();
    storageService = {
      getAgent: getAgentMock,
      getProject: getProjectMock,
      getEpic: getEpicMock,
      getStatus: getStatusMock,
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
        detail: { errorCode: 'DELIVERY_FAILED' },
      }),
    );
    expect(eventLogService.recordHandledOk).not.toHaveBeenCalled();
  });

  it.each([
    ['failed', 'SESSION_NOT_RUNNING'],
    ['partial', 'SESSION_LAUNCH_FAILED'],
  ] as const)('records returned %s delivery as handler failure', async (status, errorCode) => {
    deliverMock.mockResolvedValue({
      status,
      results: [
        {
          agentId: 'agent-1',
          status: 'failed',
          error:
            errorCode === 'SESSION_LAUNCH_FAILED'
              ? 'Unable to ensure active session for agent agent-1'
              : errorCode,
        },
        ...(status === 'partial' ? [{ agentId: 'agent-2', status: 'delivered' as const }] : []),
      ],
    });
    const logSpy = jest.spyOn(
      (subscriber as unknown as { logger: { log: (...args: unknown[]) => void } }).logger,
      'log',
    );

    await subscriber.handleEpicUpdated(basePayload);

    expect(eventLogService.recordHandledFail).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: 'event-1',
        handler: 'EpicAssignmentNotifier',
        detail: {
          poolStatus: status,
          recipientCount: status === 'partial' ? 2 : 1,
          failedCount: 1,
          failedAgentIds: ['agent-1'],
          errorCode,
        },
      }),
    );
    expect(eventLogService.recordHandledOk).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it.each(['queued', 'delivered', 'unconfirmed'] as const)(
    'records %s delivery as handler success',
    async (status) => {
      deliverMock.mockResolvedValue({
        status,
        results: [{ agentId: 'agent-1', status }],
      });

      await subscriber.handleEpicUpdated(basePayload);

      expect(eventLogService.recordHandledOk).toHaveBeenCalledWith(
        expect.objectContaining({
          eventId: 'event-1',
          handler: 'EpicAssignmentNotifier',
          detail: { poolStatus: status },
        }),
      );
      expect(eventLogService.recordHandledFail).not.toHaveBeenCalled();
    },
  );

  it('classifies returned failures from epic.created through the same outcome helper', async () => {
    deliverMock.mockResolvedValue({
      status: 'failed',
      results: [{ agentId: 'agent-1', status: 'failed', error: 'SESSION_NOT_FOUND' }],
    });

    await subscriber.handleEpicCreated({
      epicId: 'epic-1',
      projectId: 'project-1',
      title: 'New Epic',
      agentId: 'agent-1',
      assignmentRecipientIds: ['agent-1'],
      actor: { type: 'agent' as const, id: 'agent-2' },
      projectName: 'Demo Project',
      agentName: 'Helper Agent',
    } as never);

    expect(eventLogService.recordHandledFail).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: 'event-1',
        handler: 'EpicAssignmentNotifier',
        detail: {
          poolStatus: 'failed',
          recipientCount: 1,
          failedCount: 1,
          failedAgentIds: ['agent-1'],
          errorCode: 'SESSION_NOT_FOUND',
        },
      }),
    );
    expect(eventLogService.recordHandledOk).not.toHaveBeenCalled();
  });

  it.each([
    ['SESSION_NOT_RUNNING', 'SESSION_NOT_RUNNING'],
    ['SESSION_NOT_FOUND', 'SESSION_NOT_FOUND'],
    ['SESSION_LAUNCH_FAILED', 'SESSION_LAUNCH_FAILED'],
    ['DELIVERY_FAILED', 'DELIVERY_FAILED'],
    ['Unable to ensure active session for agent agent-1', 'SESSION_LAUNCH_FAILED'],
    ['SOME_PROVIDER_ERROR', 'DELIVERY_FAILED'],
    ['ENOENT', 'DELIVERY_FAILED'],
    ['/var/lib/provider/runtime.sock', 'DELIVERY_FAILED'],
    ['the rendered assignment message', 'DELIVERY_FAILED'],
  ] as const)('persists only the safe error code for %s', async (error, expectedCode) => {
    deliverMock.mockResolvedValue({
      status: 'failed',
      results: [{ agentId: 'agent-1', status: 'failed', error }],
    });

    await subscriber.handleEpicUpdated(basePayload);

    const detail = eventLogService.recordHandledFail.mock.calls[0][0].detail;
    expect(detail).toEqual(
      expect.objectContaining({
        poolStatus: 'failed',
        errorCode: expectedCode,
      }),
    );
    if (
      ![
        'SESSION_NOT_RUNNING',
        'SESSION_NOT_FOUND',
        'SESSION_LAUNCH_FAILED',
        'DELIVERY_FAILED',
      ].includes(error)
    ) {
      expect(JSON.stringify(detail)).not.toContain(error);
    }
  });

  it('keeps thrown handler failures sanitized and maps the stable launch error', async () => {
    deliverMock.mockRejectedValue(new Error('Unable to ensure active session for agent agent-1'));

    await subscriber.handleEpicUpdated(basePayload);

    expect(eventLogService.recordHandledFail).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: { errorCode: 'SESSION_LAUNCH_FAILED' },
      }),
    );
  });

  it('keeps the no-recipient early return unchanged', async () => {
    await subscriber.handleEpicUpdated({ ...basePayload, recipientIds: [] });

    expect(deliverMock).not.toHaveBeenCalled();
    expect(eventLogService.recordHandledOk).not.toHaveBeenCalled();
    expect(eventLogService.recordHandledFail).not.toHaveBeenCalled();
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
      getEpicMock.mockResolvedValue({ title: 'Add Feature', statusId: 'status-1' });
      getStatusMock.mockResolvedValue({ label: 'In Progress' });

      await subscriber.handleEpicUpdated(basePayload);

      expect(getStatusMock).toHaveBeenCalledWith('status-1');
      expect(deliverMock.mock.calls[0][1].body).toBe(
        '[Epic Assignment]\nAdd Feature is now assigned to Helper Agent in Demo Project. Status: In Progress. (Epic ID: epic-1)',
      );
    });

    it('uses the status name from the payload when the status changed with the assignment', async () => {
      settingsService.getSetting.mockReturnValue('{epic_title}: {epic_status}');

      await subscriber.handleEpicUpdated({
        ...basePayload,
        changes: {
          ...basePayload.changes,
          statusId: { previous: 'status-1', current: 'status-2', currentName: 'Review' },
        },
      });

      expect(getEpicMock).not.toHaveBeenCalled();
      expect(getStatusMock).not.toHaveBeenCalled();
      expect(deliverMock.mock.calls[0][1].body).toBe('Add Feature: Review');
    });

    it('renders Unknown when the status lookup fails', async () => {
      settingsService.getSetting.mockReturnValue('{epic_title}: {epic_status}');
      getEpicMock.mockRejectedValue(new Error('not found'));

      await subscriber.handleEpicUpdated(basePayload);

      expect(deliverMock.mock.calls[0][1].body).toBe('Add Feature: Unknown');
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
