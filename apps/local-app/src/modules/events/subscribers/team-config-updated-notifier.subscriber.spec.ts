import {
  TeamConfigUpdatedNotifierSubscriber,
  buildMessage,
} from './team-config-updated-notifier.subscriber';
import type { EventLogService } from '../services/event-log.service';
import type { SessionsService } from '../../sessions/services/sessions.service';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import type { SessionsMessagePoolService } from '../../sessions/services/sessions-message-pool.service';
import type { ModuleRef } from '@nestjs/core';
import type { TeamConfigUpdatedEventPayload } from '../catalog/team.config.updated';

const getEventMetadataMock = jest.fn();

jest.mock('../services/events.service', () => ({
  getEventMetadata: (...args: unknown[]) => getEventMetadataMock(...args),
}));

describe('TeamConfigUpdatedNotifierSubscriber', () => {
  let eventLogService: { recordHandledOk: jest.Mock; recordHandledFail: jest.Mock };
  let moduleRef: ModuleRef;
  let enqueueMock: jest.Mock;
  let messagePoolService: SessionsMessagePoolService;
  let getAgentMock: jest.Mock;
  let storageService: StorageService;
  let subscriber: TeamConfigUpdatedNotifierSubscriber;

  const basePayload: TeamConfigUpdatedEventPayload = {
    teamId: 'team-1',
    projectId: 'project-1',
    teamLeadAgentId: 'agent-lead',
    teamName: 'Alpha Team',
    previous: { maxMembers: 5, maxConcurrentTasks: 5, allowTeamLeadCreateAgents: true },
    current: { maxMembers: 8, maxConcurrentTasks: 6, allowTeamLeadCreateAgents: true },
  };

  beforeEach(() => {
    eventLogService = {
      recordHandledOk: jest.fn().mockResolvedValue({ id: 'ok' }),
      recordHandledFail: jest.fn().mockResolvedValue({ id: 'fail' }),
    };

    moduleRef = {
      get: jest.fn().mockReturnValue({
        listActiveSessions: jest.fn().mockResolvedValue([]),
        launchSession: jest.fn().mockResolvedValue({ id: 'session-1', tmuxSessionId: 'tmux-1' }),
      } as unknown as SessionsService),
    } as unknown as ModuleRef;

    enqueueMock = jest.fn().mockResolvedValue({ status: 'queued', poolSize: 1 });
    messagePoolService = { enqueue: enqueueMock } as unknown as SessionsMessagePoolService;

    getAgentMock = jest.fn().mockResolvedValue({ id: 'agent-lead', name: 'Lead Agent' });
    storageService = { getAgent: getAgentMock } as unknown as StorageService;

    getEventMetadataMock.mockReturnValue({ id: 'event-1' });

    subscriber = new TeamConfigUpdatedNotifierSubscriber(
      eventLogService as unknown as EventLogService,
      moduleRef,
      messagePoolService,
      storageService,
    );
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  it('skips leadless team (teamLeadAgentId null)', async () => {
    await subscriber.handleTeamConfigUpdated({ ...basePayload, teamLeadAgentId: null });
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('enqueues when lead agent record is missing (agentName undefined)', async () => {
    getAgentMock.mockRejectedValue(new Error('NotFoundError'));

    await subscriber.handleTeamConfigUpdated(basePayload);

    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock).toHaveBeenCalledWith(
      'agent-lead',
      expect.any(String),
      expect.objectContaining({ agentName: undefined }),
    );
  });

  it('enqueues with correct target, message, source, and agentName', async () => {
    await subscriber.handleTeamConfigUpdated(basePayload);

    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock).toHaveBeenCalledWith(
      'agent-lead',
      expect.stringContaining("Team 'Alpha Team' config updated"),
      {
        source: 'team.config.updated',
        submitKeys: ['Enter'],
        projectId: 'project-1',
        agentName: 'Lead Agent',
      },
    );
  });

  it('message includes current capacity values', async () => {
    await subscriber.handleTeamConfigUpdated(basePayload);

    const message = enqueueMock.mock.calls[0][1] as string;
    expect(message).toContain('max members: 8');
    expect(message).toContain('max concurrent tasks: 6');
  });

  it('records success in EventLogService', async () => {
    await subscriber.handleTeamConfigUpdated(basePayload);

    expect(eventLogService.recordHandledOk).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: 'event-1',
        handler: 'TeamConfigUpdatedNotifier',
      }),
    );
  });

  it('records failure in EventLogService when enqueue throws', async () => {
    enqueueMock.mockRejectedValue(new Error('Pool full'));

    await subscriber.handleTeamConfigUpdated(basePayload);

    expect(eventLogService.recordHandledFail).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: 'event-1',
        handler: 'TeamConfigUpdatedNotifier',
        detail: { message: 'Pool full' },
      }),
    );
  });

  it('enqueues flag-only message when only allowTeamLeadCreateAgents changes', async () => {
    const payload: TeamConfigUpdatedEventPayload = {
      ...basePayload,
      previous: { maxMembers: 5, maxConcurrentTasks: 5, allowTeamLeadCreateAgents: true },
      current: { maxMembers: 5, maxConcurrentTasks: 5, allowTeamLeadCreateAgents: false },
    };

    await subscriber.handleTeamConfigUpdated(payload);

    const message = enqueueMock.mock.calls[0][1] as string;
    expect(message).toBe(
      "Team 'Alpha Team' setting updated — lead can no longer create team agents.",
    );
  });

  it('enqueues combined message when capacity and flag both change', async () => {
    const payload: TeamConfigUpdatedEventPayload = {
      ...basePayload,
      previous: { maxMembers: 5, maxConcurrentTasks: 5, allowTeamLeadCreateAgents: false },
      current: { maxMembers: 8, maxConcurrentTasks: 6, allowTeamLeadCreateAgents: true },
    };

    await subscriber.handleTeamConfigUpdated(payload);

    const message = enqueueMock.mock.calls[0][1] as string;
    expect(message).toBe(
      "Team 'Alpha Team' updated — max members: 8, max concurrent tasks: 6; lead can now create team agents.",
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

  it('capacity-only change produces existing message format', () => {
    const msg = buildMessage({
      ...base,
      previous: { maxMembers: 5, maxConcurrentTasks: 5, allowTeamLeadCreateAgents: true },
      current: { maxMembers: 8, maxConcurrentTasks: 6, allowTeamLeadCreateAgents: true },
    });
    expect(msg).toBe("Team 'Alpha Team' config updated — max members: 8, max concurrent tasks: 6.");
  });

  it('flag-only true→false produces "no longer" text', () => {
    const msg = buildMessage({
      ...base,
      previous: { maxMembers: 5, maxConcurrentTasks: 5, allowTeamLeadCreateAgents: true },
      current: { maxMembers: 5, maxConcurrentTasks: 5, allowTeamLeadCreateAgents: false },
    });
    expect(msg).toBe("Team 'Alpha Team' setting updated — lead can no longer create team agents.");
  });

  it('flag-only false→true produces "now" text', () => {
    const msg = buildMessage({
      ...base,
      previous: { maxMembers: 5, maxConcurrentTasks: 5, allowTeamLeadCreateAgents: false },
      current: { maxMembers: 5, maxConcurrentTasks: 5, allowTeamLeadCreateAgents: true },
    });
    expect(msg).toBe("Team 'Alpha Team' setting updated — lead can now create team agents.");
  });

  it('both changed produces combined text', () => {
    const msg = buildMessage({
      ...base,
      previous: { maxMembers: 5, maxConcurrentTasks: 3, allowTeamLeadCreateAgents: true },
      current: { maxMembers: 8, maxConcurrentTasks: 4, allowTeamLeadCreateAgents: false },
    });
    expect(msg).toBe(
      "Team 'Alpha Team' updated — max members: 8, max concurrent tasks: 4; lead can no longer create team agents.",
    );
  });

  it('no change still produces capacity message (fallback)', () => {
    const msg = buildMessage(base);
    expect(msg).toBe("Team 'Alpha Team' config updated — max members: 5, max concurrent tasks: 5.");
  });
});
