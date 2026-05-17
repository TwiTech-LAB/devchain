import { Injectable, Logger } from '@nestjs/common';
import { MessageEnqueueService } from '../sessions/services/message-enqueue.service';
import { SessionLauncherFacade } from '../sessions/services/session-launcher-facade.service';
import { GuestDeliveryService } from '../terminal/services/guest-delivery.service';
import { DeliveryRecipientResolver } from './ports/delivery-recipient-resolver';
import { DeliveryFormatter } from './ports/delivery-formatter';
import type {
  DeliveryMessage,
  DeliveryPolicy,
  DeliveryOutcome,
  RecipientResult,
} from './dtos/delivery.types';
import type { TerminalDeliveryResult } from '../terminal/services/terminal-delivery.types';

@Injectable()
export class AgentMessageDeliveryService {
  private readonly logger = new Logger(AgentMessageDeliveryService.name);

  constructor(
    private readonly recipientResolver: DeliveryRecipientResolver,
    private readonly sessionLauncher: SessionLauncherFacade,
    private readonly formatter: DeliveryFormatter,
    private readonly messageEnqueue: MessageEnqueueService,
    private readonly guestDelivery: GuestDeliveryService,
  ) {}

  formatMessage(message: DeliveryMessage): string {
    return this.formatter.format(message);
  }

  async deliver(
    recipients: string[],
    message: DeliveryMessage,
    policy: DeliveryPolicy = {},
  ): Promise<DeliveryOutcome> {
    const { agentIds } = await this.recipientResolver.resolve(recipients, {
      threadId: message.threadId,
    });

    if (agentIds.length === 0) {
      this.logger.debug('No recipients resolved, nothing to deliver');
      return { status: 'delivered', results: [] };
    }

    const results: RecipientResult[] = [];

    for (const agentId of agentIds) {
      const result = await this.deliverToAgent(agentId, message, policy);
      results.push(result);
    }

    const status = this.aggregateStatus(results);
    return { status, results };
  }

  private async deliverToAgent(
    agentId: string,
    message: DeliveryMessage,
    policy: DeliveryPolicy,
  ): Promise<RecipientResult> {
    try {
      await this.sessionLauncher.ensureActiveSession(agentId, message.projectId);
      const formattedText = this.formatter.format(message);
      const [poolResult] = await this.messageEnqueue.enqueue([
        {
          agentId,
          text: formattedText,
          source: message.source,
          submitKeys: policy.submitKeys ? [...policy.submitKeys] : ['Enter'],
          senderAgentId: message.senderAgentId,
          immediate: policy.immediate,
          projectId: message.projectId,
          agentName: undefined,
        },
      ]);
      if (!poolResult) {
        return { agentId, status: 'failed', error: 'Message enqueue returned no result' };
      }
      return { agentId, status: poolResult.status };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { agentId, status: 'failed', error: msg };
    }
  }

  async deliverToGuest(
    tmuxSessionId: string,
    text: string,
    submitKeys?: readonly string[],
  ): Promise<TerminalDeliveryResult> {
    return this.guestDelivery.deliverToGuest(
      { name: tmuxSessionId },
      text,
      submitKeys ? { submitKeys: [...submitKeys] } : undefined,
    );
  }

  private aggregateStatus(results: RecipientResult[]): DeliveryOutcome['status'] {
    if (results.length === 0) return 'delivered';

    const allFailed = results.every((r) => r.status === 'failed');
    if (allFailed) return 'failed';

    const allDelivered = results.every((r) => r.status === 'delivered');
    if (allDelivered) return 'delivered';

    const allQueued = results.every((r) => r.status === 'queued');
    if (allQueued) return 'queued';

    const hasFailure = results.some((r) => r.status === 'failed');
    if (hasFailure) return 'partial';

    const hasUnconfirmed = results.some((r) => r.status === 'unconfirmed');
    if (hasUnconfirmed) return 'unconfirmed';

    return 'queued';
  }
}
