/**
 * Characterization tests — SessionsMessagePoolService timer/flush behavior.
 *
 * Layer: backend-unit
 * Justification: fake-timer unit tests are the cheapest layer that locks pool
 * debounce, max-wait, max-message, immediate bypass, and failure semantics.
 */

import { SessionsMessagePoolService } from './sessions-message-pool.service';
import { MessageLogService } from './message-log.service';

describe('SessionsMessagePoolService characterization', () => {
  function createHarness(
    config = {
      enabled: true,
      delayMs: 1000,
      maxWaitMs: 3000,
      maxMessages: 3,
      separator: '\n---\n',
    },
  ) {
    const sessions = {
      listActiveSessions: jest
        .fn()
        .mockResolvedValue([{ id: 'session-1', agentId: 'agent-1', tmuxSessionId: 'tmux-1' }]),
    };
    const coordinator = {
      withAgentLock: jest
        .fn()
        .mockImplementation(async (_agentId: string, fn: () => Promise<unknown>) => fn()),
    };
    const terminalIO = {
      deliver: jest.fn().mockResolvedValue({ confirmed: true, nonce: 'nonce-1', retryCount: 0 }),
      deliverImmediate: jest
        .fn()
        .mockResolvedValue({ confirmed: true, nonce: 'nonce-1', retryCount: 0 }),
    };
    const settings = {
      getMessagePoolConfig: jest.fn().mockReturnValue(config),
      getMessagePoolConfigForProject: jest.fn().mockReturnValue(config),
    };
    const storage = {
      getAgent: jest
        .fn()
        .mockResolvedValue({ id: 'agent-1', projectId: 'project-1', name: 'Agent' }),
    };
    const activityStream = {
      broadcastEnqueued: jest.fn(),
      broadcastDelivered: jest.fn(),
      broadcastUnconfirmed: jest.fn(),
      broadcastFailed: jest.fn(),
      broadcastPoolsUpdated: jest.fn(),
    };
    const providerAdapterFactory = {
      getPostPasteDelayMsForAgent: jest.fn().mockResolvedValue(undefined),
    };
    const messageLog = new MessageLogService();
    const failureNotifier = { notifySendersOfFailure: jest.fn().mockResolvedValue(undefined) };
    const service = new SessionsMessagePoolService(
      sessions as never,
      coordinator as never,
      terminalIO as never,
      settings as never,
      storage as never,
      activityStream as never,
      providerAdapterFactory as never,
      messageLog,
      failureNotifier as never,
    );

    return { service, sessions, terminalIO, messageLog, failureNotifier };
  }

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it('debounces pooled messages and flushes joined text with the last submit keys', async () => {
    const { service, terminalIO } = createHarness();

    await service.enqueue('agent-1', 'first', { source: 'one', submitKeys: ['Escape'] });
    await jest.advanceTimersByTimeAsync(800);
    await service.enqueue('agent-1', 'second', { source: 'two', submitKeys: ['Enter'] });
    await jest.advanceTimersByTimeAsync(999);
    expect(terminalIO.deliver).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(2);

    expect(terminalIO.deliver).toHaveBeenCalledWith({ name: 'tmux-1' }, 'first\n---\nsecond', {
      agentId: 'agent-1',
      submitKeys: ['Enter'],
      postPasteDelayMs: undefined,
    });
  });

  it('flushes on max-wait even if debounce keeps moving', async () => {
    const { service, terminalIO } = createHarness();

    await service.enqueue('agent-1', 'first', { source: 'one' });
    await jest.advanceTimersByTimeAsync(900);
    await service.enqueue('agent-1', 'second', { source: 'two' });
    await jest.advanceTimersByTimeAsync(900);
    await service.enqueue('agent-1', 'third', { source: 'three' });
    expect(terminalIO.deliver).toHaveBeenCalledTimes(1);
  });

  it('flushes immediately at max-messages', async () => {
    const { service, terminalIO } = createHarness();

    await service.enqueue('agent-1', 'one', { source: 'one' });
    await service.enqueue('agent-1', 'two', { source: 'two' });
    const result = await service.enqueue('agent-1', 'three', { source: 'three' });

    expect(result).toEqual({ status: 'delivered' });
    expect(terminalIO.deliver).toHaveBeenCalledTimes(1);
  });

  it('bypasses the pool for immediate delivery and records failure without sender notice', async () => {
    const { service, terminalIO, failureNotifier } = createHarness();
    terminalIO.deliverImmediate.mockRejectedValue(new Error('tmux failed'));

    await expect(
      service.enqueue('agent-1', 'urgent', {
        source: 'manual',
        immediate: true,
        senderAgentId: 'sender-1',
      }),
    ).resolves.toEqual({ status: 'failed', error: 'tmux failed' });
    expect(failureNotifier.notifySendersOfFailure).not.toHaveBeenCalled();
  });

  it('notifies senders when a pooled flush has no active session', async () => {
    const { service, sessions, failureNotifier } = createHarness();
    sessions.listActiveSessions.mockResolvedValue([]);

    await service.enqueue('agent-1', 'pooled', { source: 'manual', senderAgentId: 'sender-1' });
    await jest.advanceTimersByTimeAsync(1001);

    expect(failureNotifier.notifySendersOfFailure).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ text: 'pooled', senderAgentId: 'sender-1' }),
      ]),
      'agent-1',
      'No active session',
    );
  });
});
