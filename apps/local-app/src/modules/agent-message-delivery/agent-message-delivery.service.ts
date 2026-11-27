import { Inject, Injectable, Logger } from '@nestjs/common';
import { AgentDisabledError } from '../../common/errors/error-types';
import { SessionLaunchError } from '../session-terminal-runtime/dtos/active-session-info.dto';
import { STORAGE_SERVICE, type AgentStorage } from '../storage/interfaces/storage.interface';
import { MessageEnqueueService } from '../sessions/services/message-enqueue.service';
import { SessionLauncherFacade } from '../sessions/services/session-launcher-facade.service';
import { ActiveSessionLookup } from '../sessions/services/active-session-lookup.service';
import { GuestDeliveryService } from '../terminal/services/guest-delivery.service';
import { DeliveryRecipientResolver } from './ports/delivery-recipient-resolver';
import { DeliveryFormatter } from './ports/delivery-formatter';
import type {
  AgentDescriptor,
  AgentMessageDeliveryMessage,
  AgentMessageRouting,
  DeliveryMessage,
  DeliveryPolicy,
  DeliveryOutcome,
  RecipientResult,
} from './dtos/delivery.types';
import type { TerminalDeliveryResult } from '../terminal/services/terminal-delivery.types';
import { EventsService } from '../events/services/events.service';
import { aggregateDeliveryStatus } from './delivery-outcome';
import { AGENT_DISABLED_DELIVERY_ERROR } from '../sessions/services/message-pool.types';

/** A launch that started after the first check can still find the agent disabled. */
function isAgentDisabledFailure(error: unknown): boolean {
  return (
    error instanceof AgentDisabledError ||
    (error instanceof SessionLaunchError && error.details.cause instanceof AgentDisabledError)
  );
}

@Injectable()
export class AgentMessageDeliveryService {
  private readonly logger = new Logger(AgentMessageDeliveryService.name);

  constructor(
    private readonly recipientResolver: DeliveryRecipientResolver,
    private readonly sessionLauncher: SessionLauncherFacade,
    private readonly formatter: DeliveryFormatter,
    private readonly messageEnqueue: MessageEnqueueService,
    private readonly guestDelivery: GuestDeliveryService,
    private readonly activeSessionLookup: ActiveSessionLookup,
    private readonly eventsService: EventsService,
    @Inject(STORAGE_SERVICE) private readonly storage: Pick<AgentStorage, 'isAgentDisabled'>,
  ) {}

  formatMessage(message: DeliveryMessage): string {
    return this.formatter.format(message);
  }

  async deliver(
    recipients: string[],
    message: DeliveryMessage,
    policy: DeliveryPolicy = {},
  ): Promise<DeliveryOutcome> {
    const { agentIds } = await this.recipientResolver.resolve(recipients);

    if (agentIds.length === 0) {
      this.logger.debug('No recipients resolved, nothing to deliver');
      return { status: 'delivered', results: [] };
    }

    const results: RecipientResult[] = [];

    for (const agentId of agentIds) {
      const result = await this.deliverToAgent(agentId, message, policy);
      results.push(result);
    }

    const status = aggregateDeliveryStatus(results);
    return { status, results };
  }

  async deliverAgentMessage(
    agentDescriptors: readonly AgentDescriptor[],
    routing: AgentMessageRouting,
    message: AgentMessageDeliveryMessage,
    policy: DeliveryPolicy = {},
  ): Promise<DeliveryOutcome> {
    const outcome = await this.deliver(
      agentDescriptors.map((descriptor) => descriptor.agentId),
      message,
      policy,
    );

    if (agentDescriptors.length === 0) {
      return outcome;
    }

    try {
      const recipients = this.reconcileAgentRecipients(agentDescriptors, outcome.results);
      const projectId =
        routing.routingKind === 'project' ? routing.sourceProjectId : message.projectId;
      await this.eventsService.publish('agent.message.sent', {
        projectId,
        senderAgentId: message.senderAgentId,
        senderAgentName: message.senderName,
        ...routing,
        recipients,
        recipientCount: recipients.length,
        deliveryStatus: outcome.status,
      });
    } catch (error) {
      this.logger.error({
        senderAgentId: message.senderAgentId,
        descriptorAgentIds: agentDescriptors.map((descriptor) => descriptor.agentId),
        resultAgentIds: outcome.results.map((result) => result.agentId),
        error:
          routing.routingKind === 'project'
            ? 'EVENT_PUBLISH_FAILED'
            : error instanceof Error
              ? error.message
              : String(error),
      });
    }

    return outcome;
  }

  private async deliverToAgent(
    agentId: string,
    message: DeliveryMessage,
    policy: DeliveryPolicy,
  ): Promise<RecipientResult> {
    try {
      // Read before any session is resolved: the pool refuses the message if Disable advances
      // the fence meanwhile, so it never reaches a session started after Enable.
      const admissionFence = this.messageEnqueue.getAdmissionFence(agentId);
      if (this.storage.isAgentDisabled(agentId)) {
        return { agentId, status: 'failed', error: AGENT_DISABLED_DELIVERY_ERROR };
      }
      if (policy.requireActiveSession) {
        // Deliver-only: validate an active session exists but never launch one.
        // Eliminates the pre-check→deliver race where ensureActiveSession would
        // otherwise auto-launch behind the caller's back.
        const active = await this.activeSessionLookup.getActiveSession(agentId, message.projectId);
        if (!active) {
          return { agentId, status: 'failed', error: 'SESSION_NOT_RUNNING' };
        }
      } else {
        await this.sessionLauncher.ensureActiveSession(agentId, message.projectId);
      }
      const formattedText = this.formatter.format(message);
      const [poolResult] = await this.messageEnqueue.enqueue([
        {
          agentId,
          text: formattedText,
          source: message.source,
          submitKeys: policy.submitKeys ? [...policy.submitKeys] : ['Enter'],
          preKeys: policy.preKeys ? [...policy.preKeys] : undefined,
          preDelayMs: policy.preDelayMs,
          senderAgentId: message.senderAgentId,
          deliveryMode: policy.deliveryMode,
          immediate: policy.immediate,
          projectId: message.projectId,
          agentName: undefined,
          clientMessageId: message.clientMessageId,
          deferWhileHumanTyping:
            message.kind === 'pooled' ||
            message.senderType === 'agent' ||
            message.senderType === 'guest',
          humanPromptSubmit: message.senderType === 'user',
          outsideText: message.outsideText === true || message.senderType === 'guest',
          admissionFence,
          ...(message.kind === 'mcp.project' ? { failureDisclosure: 'project-safe' as const } : {}),
        },
      ]);
      if (!poolResult) {
        return this.deliveryFailure(agentId, message, 'Message enqueue returned no result');
      }
      return {
        agentId,
        status: poolResult.status,
        ...(poolResult.status === 'failed' && poolResult.error ? { error: poolResult.error } : {}),
        ...(poolResult.logEntryId ? { messageId: poolResult.logEntryId } : {}),
      };
    } catch (error) {
      if (isAgentDisabledFailure(error)) {
        return { agentId, status: 'failed', error: AGENT_DISABLED_DELIVERY_ERROR };
      }
      const msg = error instanceof Error ? error.message : String(error);
      return this.deliveryFailure(agentId, message, msg);
    }
  }

  private deliveryFailure(
    agentId: string,
    message: DeliveryMessage,
    error: string,
  ): RecipientResult {
    if (message.kind !== 'mcp.project') {
      return { agentId, status: 'failed', error };
    }

    const code = 'DELIVERY_FAILED';
    this.logger.error({ code, agentId, projectId: message.projectId });
    return { agentId, status: 'failed', error: code };
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

  private reconcileAgentRecipients(
    descriptors: readonly AgentDescriptor[],
    results: readonly RecipientResult[],
  ): Array<AgentDescriptor & Pick<RecipientResult, 'status'>> {
    const descriptorsById = new Map(
      descriptors.map((descriptor) => [descriptor.agentId, descriptor]),
    );
    const resultsById = new Map(results.map((result) => [result.agentId, result]));

    if (
      descriptorsById.size !== descriptors.length ||
      resultsById.size !== results.length ||
      descriptorsById.size !== resultsById.size ||
      [...descriptorsById.keys()].some((agentId) => !resultsById.has(agentId))
    ) {
      throw new Error('Agent descriptor and delivery result IDs do not reconcile');
    }

    return descriptors.map((descriptor) => ({
      ...descriptor,
      status: resultsById.get(descriptor.agentId)!.status,
    }));
  }
}
