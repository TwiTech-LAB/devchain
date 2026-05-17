import { Inject, Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { AgentMessageDeliveryService } from '../../agent-message-delivery/agent-message-delivery.service';
import { getEventMetadata } from '../../events/services/events.service';
import { EventLogService } from '../../events/services/event-log.service';
import { STORAGE_SERVICE, type StorageService } from '../../storage/interfaces/storage.interface';
import type { EpicCreatedEventPayload } from '../../events/catalog/epic.created';

@Injectable()
export class SubEpicCreatedNotifierSubscriber {
  private readonly logger = new Logger(SubEpicCreatedNotifierSubscriber.name);

  constructor(
    private readonly eventLogService: EventLogService,
    private readonly messageDelivery: AgentMessageDeliveryService,
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
  ) {}

  // If the parent's assignee also happens to be the child's assignee (with a
  // different actor), both the assignment notification (from
  // EpicAssignmentNotifierSubscriber) and this sub-epic notification will fire.
  // This is intentional — no dedup logic is added.
  @OnEvent('epic.created', { async: true })
  async handleEpicCreated(payload: EpicCreatedEventPayload): Promise<void> {
    if (!payload.parentId) {
      return;
    }

    const metadata = getEventMetadata(payload);
    const eventId = metadata?.id;
    const handler = 'SubEpicCreatedNotifier';
    const startedAt = new Date().toISOString();

    try {
      const parentContext = await this.resolveParentContext(payload);
      if (!parentContext) {
        return;
      }

      if (payload.actor?.type === 'agent' && payload.actor.id === parentContext.agentId) {
        this.logger.debug(
          { actorId: payload.actor.id, epicId: payload.epicId },
          'Skipping notification: creator is the parent assignee (self-spawn)',
        );
        return;
      }

      const recipientIds = this.uniqueRecipientIds(
        payload.subEpicRecipientIds ?? [parentContext.agentId],
      );
      if (recipientIds.length === 0) {
        return;
      }

      const creatorName = payload.creatorName ?? (await this.resolveActorName(payload.actor));

      const byClause = creatorName ? ` by ${creatorName}` : '';
      const message =
        `A new sub-epic '${payload.epicTitle ?? payload.title}' (${payload.epicId}) was created under ` +
        `your epic '${parentContext.title}' (${parentContext.id})${byClause}.`;

      const result = await this.messageDelivery.deliver(
        recipientIds,
        {
          kind: 'pooled',
          body: message,
          source: 'epic.sub_epic.created',
          projectId: payload.projectId,
          senderName: 'System',
        },
        { submitKeys: ['Enter'] },
      );

      this.logger.log(
        { eventId, parentAgentId: parentContext.agentId, recipientIds, poolStatus: result.status },
        'Notified parent agent about sub-epic creation',
      );

      if (eventId) {
        await this.eventLogService.recordHandledOk({
          eventId,
          handler,
          detail: { poolStatus: result.status },
          startedAt,
          endedAt: new Date().toISOString(),
        });
      }
    } catch (error) {
      this.logger.error(
        { error, payload },
        'Failed to notify parent agent about sub-epic creation',
      );

      if (eventId) {
        await this.eventLogService.recordHandledFail({
          eventId,
          handler,
          detail:
            error instanceof Error
              ? { message: error.message }
              : { message: 'Unknown error', value: String(error) },
          startedAt,
          endedAt: new Date().toISOString(),
        });
      }
    }
  }

  private async resolveActorName(
    actor: { type: 'agent' | 'guest'; id: string } | null | undefined,
  ): Promise<string | null> {
    if (!actor) {
      return null;
    }

    try {
      if (actor.type === 'agent') {
        const agent = await this.storage.getAgent(actor.id);
        return agent.name;
      } else if (actor.type === 'guest') {
        const guest = await this.storage.getGuest(actor.id);
        return guest.name;
      }
    } catch {
      return null;
    }

    return null;
  }

  private async resolveParentContext(
    payload: EpicCreatedEventPayload,
  ): Promise<{ id: string; title: string; agentId: string; agentName?: string } | null> {
    if (payload.parentAgentId) {
      return {
        id: payload.parentId!,
        title: payload.parentTitle ?? payload.parentId!,
        agentId: payload.parentAgentId,
        agentName: payload.parentAgentName,
      };
    }

    const parent = await this.storage.getEpic(payload.parentId!).catch(() => null);
    if (!parent?.agentId) {
      return null;
    }

    const parentAgent = await this.storage.getAgent(parent.agentId).catch(() => null);
    return {
      id: parent.id,
      title: parent.title,
      agentId: parent.agentId,
      agentName: parentAgent?.name,
    };
  }

  private uniqueRecipientIds(recipientIds: readonly string[]): string[] {
    return Array.from(new Set(recipientIds.filter((id) => id.length > 0)));
  }
}
