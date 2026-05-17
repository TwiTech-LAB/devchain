import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { AgentMessageDeliveryService } from '../../agent-message-delivery/agent-message-delivery.service';
import { getEventMetadata } from '../../events/services/events.service';
import { EventLogService } from '../../events/services/event-log.service';
import { TeamsService } from '../services/teams.service';
import type { TeamMemberAddedEventPayload } from '../../events/catalog/team.member.added';
import type { TeamMemberRemovedEventPayload } from '../../events/catalog/team.member.removed';

type TeamMembershipPayload = TeamMemberAddedEventPayload | TeamMemberRemovedEventPayload;

@Injectable()
export class TeamMembershipChangedNotifierSubscriber {
  private readonly logger = new Logger(TeamMembershipChangedNotifierSubscriber.name);

  constructor(
    private readonly eventLogService: EventLogService,
    private readonly messageDelivery: AgentMessageDeliveryService,
    private readonly teamsService: TeamsService,
  ) {}

  @OnEvent('team.member.added', { async: true })
  async handleMemberAdded(payload: TeamMemberAddedEventPayload): Promise<void> {
    if (!payload.teamLeadAgentId) return;

    const agentDescription = payload.addedAgentDescription?.trim();
    const descriptionSuffix = agentDescription ? ` Description: ${agentDescription}` : '';
    const message = `Agent '${payload.addedAgentName ?? payload.addedAgentId}' was added to team '${payload.teamName}'.${descriptionSuffix}`;
    await this.notify(payload.teamLeadAgentId, message, 'team.member.added', payload);
  }

  @OnEvent('team.member.removed', { async: true })
  async handleMemberRemoved(payload: TeamMemberRemovedEventPayload): Promise<void> {
    if (!payload.teamLeadAgentId) return;

    const message = `Agent '${payload.removedAgentName ?? payload.removedAgentId}' was removed from team '${payload.teamName}'.`;
    await this.notify(payload.teamLeadAgentId, message, 'team.member.removed', payload);
  }

  private async notify(
    leadAgentId: string,
    message: string,
    source: string,
    payload: TeamMembershipPayload,
  ): Promise<void> {
    const metadata = getEventMetadata(payload);
    const eventId = metadata?.id;
    const handler = 'TeamMembershipChangedNotifier';
    const startedAt = new Date().toISOString();

    try {
      const recipientIds = this.resolveRecipients(payload, leadAgentId);
      if (recipientIds.length === 0) {
        return;
      }

      await this.resolveRecipientContext(payload, leadAgentId);
      const result = await this.messageDelivery.deliver(
        recipientIds,
        {
          kind: 'pooled',
          body: message,
          source,
          projectId: payload.projectId,
          senderName: 'System',
        },
        { submitKeys: ['Enter'] },
      );

      this.logger.log(
        { eventId, leadAgentId, recipientIds, poolStatus: result.status },
        `Notified team lead about membership change (${source})`,
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
      this.logger.error({ error, payload }, `Failed to notify team lead (${source})`);

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

  private resolveRecipients(payload: TeamMembershipPayload, fallbackAgentId: string): string[] {
    return this.uniqueRecipientIds([fallbackAgentId]);
  }

  private uniqueRecipientIds(recipientIds: readonly string[]): string[] {
    return Array.from(new Set(recipientIds.filter((id) => id.length > 0)));
  }

  private async resolveRecipientContext(
    payload: TeamMembershipPayload,
    fallbackAgentId: string,
  ): Promise<void> {
    await this.teamsService
      .getRecipientContext(fallbackAgentId, payload.projectId)
      .catch(() => undefined);
  }
}
