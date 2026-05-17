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

  it('does nothing when no sender agent IDs in messages', async () => {
    await notifier.notifySendersOfFailure([makeMessage()], 'recipient-1', 'No active session');

    expect(mockTerminalIO.deliverImmediate).not.toHaveBeenCalled();
  });
});
