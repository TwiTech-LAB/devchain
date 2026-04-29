import { TeamMembershipChangedNotifierSubscriber } from './team-membership-changed-notifier.subscriber';
import type { EventLogService } from '../services/event-log.service';
import type { SessionsService } from '../../sessions/services/sessions.service';
import type { SessionsMessagePoolService } from '../../sessions/services/sessions-message-pool.service';
import type { ModuleRef } from '@nestjs/core';
import type { TeamMemberAddedEventPayload } from '../catalog/team.member.added';
import type { TeamMemberRemovedEventPayload } from '../catalog/team.member.removed';

const getEventMetadataMock = jest.fn();

jest.mock('../services/events.service', () => ({
  getEventMetadata: (...args: unknown[]) => getEventMetadataMock(...args),
}));

describe('TeamMembershipChangedNotifierSubscriber', () => {
  let eventLogService: { recordHandledOk: jest.Mock; recordHandledFail: jest.Mock };
  let moduleRef: ModuleRef;
  let enqueueMock: jest.Mock;
  let messagePoolService: SessionsMessagePoolService;
  let subscriber: TeamMembershipChangedNotifierSubscriber;

  const addedPayload: TeamMemberAddedEventPayload = {
    teamId: 'team-1',
    projectId: 'project-1',
    teamLeadAgentId: 'agent-lead',
    teamName: 'Alpha Team',
    addedAgentId: 'agent-new',
    addedAgentName: 'New Agent',
  };

  const removedPayload: TeamMemberRemovedEventPayload = {
    teamId: 'team-1',
    projectId: 'project-1',
    teamLeadAgentId: 'agent-lead',
    teamName: 'Alpha Team',
    removedAgentId: 'agent-old',
    removedAgentName: 'Old Agent',
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

    getEventMetadataMock.mockReturnValue({ id: 'event-1' });

    subscriber = new TeamMembershipChangedNotifierSubscriber(
      eventLogService as unknown as EventLogService,
      moduleRef,
      messagePoolService,
    );
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  describe('handleMemberAdded', () => {
    it('skips when teamLeadAgentId is null', async () => {
      await subscriber.handleMemberAdded({ ...addedPayload, teamLeadAgentId: null });
      expect(enqueueMock).not.toHaveBeenCalled();
    });

    it('enqueues message with agent name', async () => {
      await subscriber.handleMemberAdded(addedPayload);

      expect(enqueueMock).toHaveBeenCalledWith(
        'agent-lead',
        "Agent 'New Agent' was added to team 'Alpha Team'.",
        expect.objectContaining({ source: 'team.member.added', projectId: 'project-1' }),
      );
    });

    it('falls back to agent ID when name is null', async () => {
      await subscriber.handleMemberAdded({ ...addedPayload, addedAgentName: null });

      const message = enqueueMock.mock.calls[0][1] as string;
      expect(message).toBe("Agent 'agent-new' was added to team 'Alpha Team'.");
    });

    it('records success in EventLogService', async () => {
      await subscriber.handleMemberAdded(addedPayload);

      expect(eventLogService.recordHandledOk).toHaveBeenCalledWith(
        expect.objectContaining({
          eventId: 'event-1',
          handler: 'TeamMembershipChangedNotifier',
        }),
      );
    });

    it('records failure when enqueue throws', async () => {
      enqueueMock.mockRejectedValue(new Error('Pool full'));

      await subscriber.handleMemberAdded(addedPayload);

      expect(eventLogService.recordHandledFail).toHaveBeenCalledWith(
        expect.objectContaining({
          eventId: 'event-1',
          handler: 'TeamMembershipChangedNotifier',
          detail: { message: 'Pool full' },
        }),
      );
    });
  });

  describe('handleMemberRemoved', () => {
    it('skips when teamLeadAgentId is null', async () => {
      await subscriber.handleMemberRemoved({ ...removedPayload, teamLeadAgentId: null });
      expect(enqueueMock).not.toHaveBeenCalled();
    });

    it('enqueues message with agent name', async () => {
      await subscriber.handleMemberRemoved(removedPayload);

      expect(enqueueMock).toHaveBeenCalledWith(
        'agent-lead',
        "Agent 'Old Agent' was removed from team 'Alpha Team'.",
        expect.objectContaining({ source: 'team.member.removed', projectId: 'project-1' }),
      );
    });

    it('falls back to agent ID when name is null', async () => {
      await subscriber.handleMemberRemoved({ ...removedPayload, removedAgentName: null });

      const message = enqueueMock.mock.calls[0][1] as string;
      expect(message).toBe("Agent 'agent-old' was removed from team 'Alpha Team'.");
    });
  });
});
