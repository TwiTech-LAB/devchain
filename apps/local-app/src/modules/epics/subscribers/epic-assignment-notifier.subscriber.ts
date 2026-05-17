import { Inject, Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { AgentMessageDeliveryService } from '../../agent-message-delivery/agent-message-delivery.service';
import { getEventMetadata } from '../../events/services/events.service';
import { EventLogService } from '../../events/services/event-log.service';
import { SettingsService } from '../../settings/services/settings.service';
import { STORAGE_SERVICE, type StorageService } from '../../storage/interfaces/storage.interface';
import { TeamsService } from '../../teams/services/teams.service';
import { renderTemplate } from '../../../common/template/handlebars-renderer';
import type { EpicUpdatedEventPayload } from '../../events/catalog/epic.updated';
import type { EpicCreatedEventPayload } from '../../events/catalog/epic.created';

const TEMPLATE_SETTING_KEY = 'events.epicAssigned.template';
const DEFAULT_TEMPLATE =
  '[Epic Assignment]\n{epic_title} is now assigned to {agent_name} in {project_name}. (Epic ID: {epic_id})';

const LEGACY_VARIABLES = [
  'epic_id',
  'agent_name',
  'epic_title',
  'project_name',
  'assigner_name',
  'team_name',
  'team_names',
  'is_team_lead',
];

@Injectable()
export class EpicAssignmentNotifierSubscriber {
  private readonly logger = new Logger(EpicAssignmentNotifierSubscriber.name);

  constructor(
    private readonly eventLogService: EventLogService,
    private readonly settingsService: SettingsService,
    private readonly messageDelivery: AgentMessageDeliveryService,
    private readonly teamsService: TeamsService,
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
  ) {}

  @OnEvent('epic.created', { async: true })
  async handleEpicCreated(payload: EpicCreatedEventPayload): Promise<void> {
    // Only process if agent is assigned on creation
    if (!payload.agentId) {
      return;
    }

    // Skip self-assignment (agent created epic assigned to themselves)
    if (payload.actor?.type === 'agent' && payload.actor.id === payload.agentId) {
      this.logger.debug(
        { actorId: payload.actor.id, epicId: payload.epicId },
        'Skipping notification: agent created epic assigned to itself',
      );
      return;
    }

    const metadata = getEventMetadata(payload);
    const eventId = metadata?.id;
    const handler = 'EpicAssignmentNotifier';
    const startedAt = new Date().toISOString();

    try {
      // Resolve actor (assigner) name for template placeholder
      const assignerName = await this.resolveActorName(payload.actor);

      const recipientIds = this.resolveCreatedRecipients(payload);
      if (recipientIds.length === 0) {
        return;
      }

      const teamCtx = await this.resolveTeamTemplateContext(payload.agentId, payload.projectId);

      const template = this.resolveTemplate();
      const message = renderTemplate(
        template,
        {
          epic_id: payload.epicId,
          agent_name: payload.agentName ?? payload.agentId,
          epic_title: payload.epicTitle ?? payload.title,
          project_name: payload.projectName ?? payload.projectId,
          assigner_name: assignerName ?? 'System',
          ...teamCtx,
        },
        LEGACY_VARIABLES,
      );

      const result = await this.messageDelivery.deliver(
        recipientIds,
        {
          kind: 'pooled',
          body: message,
          source: 'epic.created',
          projectId: payload.projectId,
          senderName: 'System',
        },
        { submitKeys: ['Enter'] },
      );

      this.logger.debug(
        { agentId: payload.agentId, recipientIds, status: result.status },
        'EpicAssignmentNotifier: message delivered via AMD (epic.created)',
      );

      if (eventId) {
        await this.eventLogService.recordHandledOk({
          eventId,
          handler,
          detail: {
            poolStatus: result.status,
          },
          startedAt,
          endedAt: new Date().toISOString(),
        });
      }

      this.logger.log(
        { eventId, recipientIds, poolStatus: result.status },
        'Notified agent about epic assignment (epic.created)',
      );
    } catch (error) {
      this.logger.error(
        { error, payload },
        'Failed to notify agent about epic assignment (epic.created)',
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

  @OnEvent('epic.updated', { async: true })
  async handleEpicUpdated(payload: EpicUpdatedEventPayload): Promise<void> {
    // Only process if agent assignment changed
    if (!payload.changes.agentId) {
      return;
    }

    // Only process new assignments, not unassignments (A→null)
    const newAgentId = payload.changes.agentId.current;
    if (newAgentId === null) {
      return;
    }

    // Skip self-assignment (agent assigned epic to themselves)
    if (payload.actor?.type === 'agent' && payload.actor.id === newAgentId) {
      this.logger.debug(
        { actorId: payload.actor.id, epicId: payload.epicId },
        'Skipping notification: agent assigned epic to itself',
      );
      return;
    }

    const metadata = getEventMetadata(payload);
    const eventId = metadata?.id;
    const handler = 'EpicAssignmentNotifier';
    const startedAt = new Date().toISOString();

    try {
      const [agentName, projectName, epicTitle] = await this.resolveNames(payload, newAgentId);
      // Resolve actor (assigner) name for template placeholder
      const assignerName = await this.resolveActorName(payload.actor);

      const recipientIds = this.resolveUpdatedRecipients(payload, newAgentId);
      if (recipientIds.length === 0) {
        return;
      }

      const teamCtx = await this.resolveTeamTemplateContext(newAgentId, payload.projectId);

      const template = this.resolveTemplate();
      const message = renderTemplate(
        template,
        {
          epic_id: payload.epicId,
          agent_name: agentName ?? newAgentId,
          epic_title: epicTitle ?? payload.epicId,
          project_name: projectName ?? payload.projectId,
          assigner_name: assignerName ?? 'System',
          ...teamCtx,
        },
        LEGACY_VARIABLES,
      );

      const result = await this.messageDelivery.deliver(
        recipientIds,
        {
          kind: 'pooled',
          body: message,
          source: 'epic.assigned', // Keep for UX continuity
          projectId: payload.projectId,
          senderName: 'System',
        },
        { submitKeys: ['Enter'] },
      );

      this.logger.debug(
        { agentId: newAgentId, recipientIds, status: result.status },
        'EpicAssignmentNotifier: message delivered via AMD',
      );

      if (eventId) {
        await this.eventLogService.recordHandledOk({
          eventId,
          handler,
          detail: {
            poolStatus: result.status,
          },
          startedAt,
          endedAt: new Date().toISOString(),
        });
      }

      this.logger.log(
        { eventId, recipientIds, poolStatus: result.status },
        'Notified agent about epic assignment',
      );
    } catch (error) {
      this.logger.error({ error, payload }, 'Failed to notify agent about epic assignment');

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

  private resolveTemplate(): string {
    const raw = this.settingsService.getSetting(TEMPLATE_SETTING_KEY);
    if (!raw) {
      return DEFAULT_TEMPLATE;
    }

    const trimmed = raw.trim();
    if (!trimmed) {
      return DEFAULT_TEMPLATE;
    }

    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === 'string' && parsed.trim().length > 0) {
        return parsed.trim();
      }
    } catch {
      // Value is not JSON encoded, fall back to raw string
    }

    return trimmed;
  }

  private async resolveNames(
    payload: EpicUpdatedEventPayload,
    agentId: string,
  ): Promise<[string?, string?, string?]> {
    // Use resolved names from payload if available
    const resolvedAgent = payload.changes.agentId?.currentName;
    const resolvedProject = payload.projectName;
    const resolvedEpic = payload.epicTitle;

    if (resolvedAgent && resolvedProject && resolvedEpic) {
      return [resolvedAgent, resolvedProject, resolvedEpic];
    }

    const [agent, project, epic] = await Promise.all([
      resolvedAgent
        ? null
        : this.storage
            .getAgent(agentId)
            .then((value) => value.name)
            .catch(() => null),
      resolvedProject
        ? null
        : this.storage
            .getProject(payload.projectId)
            .then((value) => value.name)
            .catch(() => null),
      resolvedEpic
        ? null
        : this.storage
            .getEpic(payload.epicId)
            .then((value) => value.title)
            .catch(() => null),
    ]);

    return [
      resolvedAgent ?? agent ?? undefined,
      resolvedProject ?? project ?? undefined,
      resolvedEpic ?? epic ?? undefined,
    ];
  }

  /**
   * Resolves the name of the actor who triggered the event.
   * @param actor - Actor from event payload
   * @returns Actor name, or null if not found/unavailable
   */
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
      // Actor lookup failed - return null
      return null;
    }

    return null;
  }

  private resolveCreatedRecipients(payload: EpicCreatedEventPayload): string[] {
    return this.uniqueRecipientIds(
      payload.assignmentRecipientIds ?? (payload.agentId ? [payload.agentId] : []),
    );
  }

  private resolveUpdatedRecipients(payload: EpicUpdatedEventPayload, agentId: string): string[] {
    return this.uniqueRecipientIds(payload.recipientIds ?? [agentId]);
  }

  private uniqueRecipientIds(recipientIds: readonly string[]): string[] {
    return Array.from(new Set(recipientIds.filter((id) => id.length > 0)));
  }

  private async resolveTeamTemplateContext(
    agentId: string,
    projectId: string,
  ): Promise<{ team_name: string; team_names: string; is_team_lead: boolean }> {
    const context = await this.teamsService.getRecipientContext(agentId, projectId);
    return {
      team_name: context.teamNames.length === 1 ? context.teamNames[0] : '',
      team_names: context.teamNames.join(', '),
      is_team_lead: context.isTeamLead,
    };
  }
}
