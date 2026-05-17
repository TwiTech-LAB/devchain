import { Injectable } from '@nestjs/common';
import { createLogger } from '../../../common/logging/logger';
import { TerminalIOService } from '../../terminal/services/terminal-io/terminal-io.service';
import { SessionsService } from './sessions.service';
import { FAILURE_NOTICE_SOURCE, type PooledMessage } from './message-pool.types';

const logger = createLogger('DeliveryFailureNotifier');

@Injectable()
export class DeliveryFailureNotifierService {
  constructor(
    private readonly terminalIO: TerminalIOService,
    private readonly sessions: SessionsService,
  ) {}

  async notifySendersOfFailure(
    messages: PooledMessage[],
    recipientAgentId: string,
    reason: string,
  ): Promise<void> {
    const senderAgentIds = new Set<string>();
    for (const msg of messages) {
      if (msg.senderAgentId && msg.source !== FAILURE_NOTICE_SOURCE) {
        senderAgentIds.add(msg.senderAgentId);
      }
    }

    if (senderAgentIds.size === 0) {
      logger.debug({ recipientAgentId }, 'No senders to notify of failure');
      return;
    }

    logger.info(
      { recipientAgentId, senderCount: senderAgentIds.size, reason },
      'Notifying senders of delivery failure',
    );

    for (const senderAgentId of senderAgentIds) {
      try {
        const activeSessions = await this.sessions.listActiveSessions();
        const session = activeSessions.find((s) => s.agentId === senderAgentId);

        if (!session || !session.tmuxSessionId) {
          logger.debug(
            { senderAgentId, recipientAgentId },
            'No active session for sender, skipping failure notification',
          );
          continue;
        }

        const failureMessage = `[Delivery Failed] Message to agent ${recipientAgentId} could not be delivered: ${reason}`;

        await this.terminalIO.deliverImmediate({ name: session.tmuxSessionId }, failureMessage, {
          submitKeys: ['Enter'],
          confirm: false,
        });

        logger.debug({ senderAgentId, recipientAgentId }, 'Failure notification sent to sender');
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        logger.warn(
          { senderAgentId, recipientAgentId, error: errorMsg },
          'Failed to notify sender of delivery failure (best-effort, ignored)',
        );
      }
    }
  }
}
