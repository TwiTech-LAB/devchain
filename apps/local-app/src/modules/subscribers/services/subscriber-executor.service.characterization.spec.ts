/**
 * Characterization tests — SubscriberExecutorService delivery action context.
 *
 * Layer: backend-unit
 * Justification: direct service tests are the cheapest layer to prove the
 * subscriber executor passes the AgentMessageDeliveryService into action
 * context for send-message style actions.
 */

import { EventEmitter2 } from '@nestjs/event-emitter';
import { SubscriberExecutorService } from './subscriber-executor.service';
import { AutomationSchedulerService } from './automation-scheduler.service';
import { createProjectWriteAdmissionStub } from '../../remotes/admission/testing/project-write-admission.stub';

const actionExecuteMock = jest.fn().mockResolvedValue({ success: true, message: 'ok' });

jest.mock('../actions/actions.registry', () => ({
  getAction: jest.fn(() => ({
    execute: actionExecuteMock,
  })),
}));

describe('SubscriberExecutorService characterization', () => {
  it('includes AMD in subscriber action context', async () => {
    const storage = {
      getSubscriber: jest.fn().mockResolvedValue({
        id: 'sub-1',
        name: 'Send message',
        enabled: true,
        actionType: 'send_message',
        actionInputs: {},
        eventFilter: null,
        cooldownSeconds: 0,
        retryOnError: false,
      }),
      getAgent: jest
        .fn()
        .mockResolvedValue({ id: 'agent-1', projectId: 'project-1', name: 'Agent' }),
    };
    const terminalIO = {};
    const sessions = {
      getSession: jest
        .fn()
        .mockReturnValue({ id: 'session-1', agentId: 'agent-1', tmuxSessionId: 'tmux-1' }),
    };
    const amd = { deliver: jest.fn() };
    const teams = { listTeamsByAgent: jest.fn().mockResolvedValue([]) };
    const eventLog = { recordHandledOk: jest.fn(), recordHandledFail: jest.fn() };
    const moduleRef = { get: jest.fn().mockReturnValue({ launch: jest.fn() }) };
    const service = new SubscriberExecutorService(
      storage as never,
      terminalIO as never,
      sessions as never,
      {} as never,
      amd as never,
      eventLog as never,
      new EventEmitter2(),
      new AutomationSchedulerService(),
      teams as never,
      moduleRef as never,
      createProjectWriteAdmissionStub() as never,
    );

    const result = await (
      service as unknown as {
        executeSubscriberForTask: (
          subscriberId: string,
          subscriberName: string,
          actionType: string,
          eventName: string,
          payload: Record<string, unknown>,
          scheduledAt: string,
        ) => Promise<unknown>;
      }
    ).executeSubscriberForTask(
      'sub-1',
      'Send message',
      'send_message',
      'terminal.watcher.triggered',
      { projectId: 'project-1', sessionId: 'session-1', agentId: 'agent-1' },
      '2026-01-01T00:00:00.000Z',
    );

    expect(result).toEqual(
      expect.objectContaining({
        subscriberId: 'sub-1',
        subscriberName: 'Send message',
        success: true,
      }),
    );
    expect(actionExecuteMock).toHaveBeenCalledWith(
      expect.objectContaining({
        terminalIO,
        sessionsService: sessions,
        amd,
        teamsService: teams,
        projectId: 'project-1',
        tmuxSessionName: 'tmux-1',
      }),
      {},
    );
  });
});
