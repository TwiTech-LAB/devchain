const mockLogger = {
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
};

jest.mock('../../../common/logging/logger', () => ({
  createLogger: () => mockLogger,
}));

/**
 * Layer: module-unit
 * Justification: Tests the notifier's direct-path delivery via mocked
 * TerminalIO and SessionsService — the cheapest layer that proves the
 * cycle-free notification contract (2B.2b fix).
 */

import { DeliveryFailureNotifierService } from './delivery-failure-notifier.service';
import { FAILURE_NOTICE_SOURCE } from './sessions-message-pool.service';
import type { TerminalIOService } from '../../terminal/services/terminal-io/terminal-io.service';
import type { SessionsService } from './sessions.service';
import type { PooledMessage } from './sessions-message-pool.service';

function makeMessage(overrides: Partial<PooledMessage> = {}): PooledMessage {
  return {
    text: 'test',
    source: 'chat.message',
    timestamp: Date.now(),
    submitKeys: ['Enter'],
    logEntryId: 'log-1',
    ...overrides,
  };
}

describe('DeliveryFailureNotifierService', () => {
  let notifier: DeliveryFailureNotifierService;
  let mockTerminalIO: jest.Mocked<Pick<TerminalIOService, 'deliverImmediate'>>;
  let mockSessions: jest.Mocked<Pick<SessionsService, 'listActiveSessions'>>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockTerminalIO = {
      deliverImmediate: jest.fn().mockResolvedValue({ confirmed: true, nonce: 'n', retryCount: 0 }),
    };
    mockSessions = {
      listActiveSessions: jest
        .fn()
        .mockResolvedValue([
          { id: 's1', agentId: 'sender-1', tmuxSessionId: 'tmux-sender-1', status: 'running' },
        ]),
    };

    notifier = new DeliveryFailureNotifierService(
      mockTerminalIO as unknown as TerminalIOService,
      mockSessions as unknown as SessionsService,
    );
  });

  it('sends [Delivery Failed] via TerminalIO.deliverImmediate (direct path)', async () => {
    await notifier.notifySendersOfFailure(
      [makeMessage({ senderAgentId: 'sender-1' })],
      'recipient-1',
      'No active session',
    );

    expect(mockTerminalIO.deliverImmediate).toHaveBeenCalledTimes(1);
    expect(mockTerminalIO.deliverImmediate).toHaveBeenCalledWith(
      { name: 'tmux-sender-1' },
      expect.stringContaining('[Delivery Failed]'),
      expect.objectContaining({ confirm: false }),
    );
  });

  it('excludes FAILURE_NOTICE_SOURCE messages (loop prevention)', async () => {
    await notifier.notifySendersOfFailure(
      [makeMessage({ senderAgentId: 'sender-1', source: FAILURE_NOTICE_SOURCE })],
      'recipient-1',
      'No active session',
    );

    expect(mockTerminalIO.deliverImmediate).not.toHaveBeenCalled();
  });

  it('deduplicates sender agent IDs', async () => {
    await notifier.notifySendersOfFailure(
      [makeMessage({ senderAgentId: 'sender-1' }), makeMessage({ senderAgentId: 'sender-1' })],
      'recipient-1',
      'No active session',
    );

    expect(mockTerminalIO.deliverImmediate).toHaveBeenCalledTimes(1);
  });

  it('skips senders without active sessions', async () => {
    mockSessions.listActiveSessions.mockResolvedValue([]);

    await notifier.notifySendersOfFailure(
      [makeMessage({ senderAgentId: 'sender-1' })],
      'recipient-1',
      'No active session',
    );

    expect(mockTerminalIO.deliverImmediate).not.toHaveBeenCalled();
  });

  it('swallows deliverImmediate errors (best-effort)', async () => {
    mockTerminalIO.deliverImmediate.mockRejectedValue(new Error('tmux error'));

    await expect(
      notifier.notifySendersOfFailure(
        [makeMessage({ senderAgentId: 'sender-1' })],
        'recipient-1',
        'No active session',
      ),
    ).resolves.toBeUndefined();
  });

  it('uses the strictest disclosure for a mixed sender notification', async () => {
    const rawReason = 'provider failed at /private/source/project';

    await notifier.notifySendersOfFailure(
      [
        makeMessage({ senderAgentId: 'sender-1' }),
        makeMessage({
          senderAgentId: 'sender-1',
          failureDisclosure: 'project-safe',
          logEntryId: 'log-2',
        }),
      ],
      'recipient-1',
      rawReason,
    );

    const deliveredText = mockTerminalIO.deliverImmediate.mock.calls[0][1];
    expect(deliveredText).toContain('DELIVERY_FAILED');
    expect(deliveredText).not.toContain(rawReason);
    expect(JSON.stringify(mockLogger.info.mock.calls)).not.toContain(rawReason);
  });

  it('does not log a raw notification-delivery error for protected messages', async () => {
    const rawError = 'tmux failed at /private/source/project';
    mockTerminalIO.deliverImmediate.mockRejectedValue(new Error(rawError));

    await notifier.notifySendersOfFailure(
      [makeMessage({ senderAgentId: 'sender-1', failureDisclosure: 'project-safe' })],
      'recipient-1',
      'provider failed at /private/source/project',
    );

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'DELIVERY_FAILED' }),
      'Failed to notify sender of delivery failure (best-effort, ignored)',
    );
    expect(JSON.stringify(mockLogger.warn.mock.calls)).not.toContain(rawError);
  });

  it('preserves raw legacy notification reasons and delivery errors', async () => {
    const rawReason = 'provider failed at /legacy/project';
    const rawError = 'tmux failed at /legacy/project';
    mockTerminalIO.deliverImmediate.mockRejectedValue(new Error(rawError));

    await notifier.notifySendersOfFailure(
      [makeMessage({ senderAgentId: 'sender-1' })],
      'recipient-1',
      rawReason,
    );

    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ reason: rawReason }),
      'Notifying senders of delivery failure',
    );
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ error: rawError }),
      'Failed to notify sender of delivery failure (best-effort, ignored)',
    );
  });

  it('does nothing when no sender agent IDs in messages', async () => {
    await notifier.notifySendersOfFailure([makeMessage()], 'recipient-1', 'No active session');

    expect(mockTerminalIO.deliverImmediate).not.toHaveBeenCalled();
  });
});
