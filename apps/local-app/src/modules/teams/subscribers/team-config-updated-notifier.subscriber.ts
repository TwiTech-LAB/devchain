import { Inject, Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { AgentMessageDeliveryService } from '../../agent-message-delivery/agent-message-delivery.service';
import { getEventMetadata } from '../../events/services/events.service';
import { EventLogService } from '../../events/services/event-log.service';
import { STORAGE_SERVICE, type StorageService } from '../../storage/interfaces/storage.interface';
import { TeamsService } from '../services/teams.service';
import type { TeamConfigUpdatedEventPayload } from '../../events/catalog/team.config.updated';

export function buildMessage(payload: TeamConfigUpdatedEventPayload): string {
  const capacityChanged =
    payload.previous.maxMembers !== payload.current.maxMembers ||
    payload.previous.maxConcurrentTasks !== payload.current.maxConcurrentTasks;
  const flagChanged =
    payload.previous.allowTeamLeadCreateAgents !== payload.current.allowTeamLeadCreateAgents;

  const capacityPart =
    `max members: ${payload.current.maxMembers}, ` +
    `max concurrent tasks: ${payload.current.maxConcurrentTasks}`;
  const flagPart = payload.current.allowTeamLeadCreateAgents
    ? 'lead can now create team agents'
    : 'lead can no longer create team agents';

  if (capacityChanged && flagChanged) {
    return `Team '${payload.teamName}' updated — ${capacityPart}; ${flagPart}.`;
  }
  if (flagChanged) {
    return `Team '${payload.teamName}' setting updated — ${flagPart}.`;
  }
  return `Team '${payload.teamName}' config updated — ${capacityPart}.`;
}

@Injectable()
export class TeamConfigUpdatedNotifierSubscriber {
  private readonly logger = new Logger(TeamConfigUpdatedNotifierSubscriber.name);

  constructor(
    private readonly eventLogService: EventLogService,
    private readonly messageDelivery: AgentMessageDeliveryService,
    private readonly teamsService: TeamsService,
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
  ) {}

  @OnEvent('team.config.updated', { async: true })
  async handleTeamConfigUpdated(payload: TeamConfigUpdatedEventPayload): Promise<void> {
    if (!payload.teamLeadAgentId) {
      return;
    }

    const metadata = getEventMetadata(payload);
    const eventId = metadata?.id;
    const handler = 'TeamConfigUpdatedNotifier';
    const startedAt = new Date().toISOString();

    try {
      const recipientIds = this.resolveRecipients(payload);
      if (recipientIds.length === 0) {
        return;
      }

      const leadAgentName =
        payload.agentName ??
        (await this.storage
          .getAgent(payload.teamLeadAgentId)
          .then((agent) => agent.name)
          .catch(() => undefined));
      const message = buildMessage(payload);

      await this.resolveRecipientContext(payload.teamLeadAgentId, payload.projectId);
      const result = await this.messageDelivery.deliver(
        recipientIds,
        {
          kind: 'pooled',
          body: message,
          source: 'team.config.updated',
          projectId: payload.projectId,
          senderName: 'System',
        },
        { submitKeys: ['Enter'] },
      );

      this.logger.log(
        {
          eventId,
          leadAgentId: payload.teamLeadAgentId,
          leadAgentName,
          recipientIds,
          poolStatus: result.status,
        },
        'Notified team lead about config update',
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
      this.logger.error({ error, payload }, 'Failed to notify team lead about config update');

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

  private resolveRecipients(payload: TeamConfigUpdatedEventPayload): string[] {
    return this.uniqueRecipientIds(
      payload.recipientIds ?? (payload.teamLeadAgentId ? [payload.teamLeadAgentId] : []),
    );
  }

  private uniqueRecipientIds(recipientIds: readonly string[]): string[] {
    return Array.from(new Set(recipientIds.filter((id) => id.length > 0)));
  }

  private async resolveRecipientContext(agentId: string, projectId: string): Promise<void> {
    await this.teamsService.getRecipientContext(agentId, projectId).catch(() => undefined);
  }
}
