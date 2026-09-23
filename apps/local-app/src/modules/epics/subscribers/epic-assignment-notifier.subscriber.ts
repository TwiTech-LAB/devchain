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
import type {
  DeliveryOutcome,
  RecipientResult,
} from '../../agent-message-delivery/dtos/delivery.types';

const TEMPLATE_SETTING_KEY = 'events.epicAssigned.template';
const DEFAULT_TEMPLATE =
  '[Epic Assignment]\n{epic_title} is now assigned to {agent_name} in {project_name}. Status: {epic_status}. (Epic ID: {epic_id})';

const UNKNOWN_STATUS = 'Unknown';

const LEGACY_VARIABLES = [
  'epic_id',
  'agent_name',
  'epic_title',
  'epic_status',
  'project_name',
  'assigner_name',
  'team_name',
  'team_names',
  'is_team_lead',
];

const SAFE_DELIVERY_ERROR_CODES = [
  'SESSION_NOT_RUNNING',
  'SESSION_NOT_FOUND',
  'SESSION_LAUNCH_FAILED',
  'DELIVERY_FAILED',
] as const;

type SafeDeliveryErrorCode = (typeof SAFE_DELIVERY_ERROR_CODES)[number];

type DeliveryHandlerDetail = {
  readonly poolStatus: DeliveryOutcome['status'];
  readonly recipientCount?: number;
  readonly failedCount?: number;
  readonly failedAgentIds?: readonly string[];
  readonly errorCode?: SafeDeliveryErrorCode;
};

const SAFE_DELIVERY_ERROR_CODE_SET = new Set<string>(SAFE_DELIVERY_ERROR_CODES);
const SESSION_LAUNCH_ERROR_PATTERN = /^Unable to ensure active session for agent \S+$/;

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
      const epicStatus = await this.resolveStatusName(template, payload.epicId, {
        statusName: payload.statusName,
        statusId: payload.statusId,
      });
      const message = renderTemplate(
        template,
        {
          epic_id: payload.epicId,
          agent_name: payload.agentName ?? payload.agentId,
          epic_title: payload.epicTitle ?? payload.title,
          epic_status: epicStatus,
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

      await this.recordDeliveryOutcome({
        eventId,
        handler,
        startedAt,
        result,
        logContext: { agentId: payload.agentId, recipientIds },
        successMessage: 'Notified agent about epic assignment (epic.created)',
        failureMessage: 'Failed to deliver epic assignment notification (epic.created)',
      });
    } catch (error) {
      const errorCode = this.classifyErrorCode(error);
      this.logger.error(
        { errorCode, eventId, epicId: payload.epicId },
        'Failed to notify agent about epic assignment (epic.created)',
      );

      if (eventId) {
        await this.eventLogService.recordHandledFail({
          eventId,
          handler,
          detail: { errorCode },
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
      const epicStatus = await this.resolveStatusName(template, payload.epicId, {
        statusName: payload.changes.statusId?.currentName,
        statusId: payload.changes.statusId?.current,
      });
      const message = renderTemplate(
        template,
        {
          epic_id: payload.epicId,
          agent_name: agentName ?? newAgentId,
          epic_title: epicTitle ?? payload.epicId,
          epic_status: epicStatus,
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

      await this.recordDeliveryOutcome({
        eventId,
        handler,
        startedAt,
        result,
        logContext: { agentId: newAgentId, recipientIds },
        successMessage: 'Notified agent about epic assignment',
        failureMessage: 'Failed to deliver epic assignment notification',
      });
    } catch (error) {
      const errorCode = this.classifyErrorCode(error);
      this.logger.error(
        { errorCode, eventId, epicId: payload.epicId },
        'Failed to notify agent about epic assignment',
      );

      if (eventId) {
        await this.eventLogService.recordHandledFail({
          eventId,
          handler,
          detail: { errorCode },
          startedAt,
          endedAt: new Date().toISOString(),
        });
      }
    }
  }

  private async recordDeliveryOutcome(params: {
    eventId: string | undefined;
    handler: string;
    startedAt: string;
    result: DeliveryOutcome;
    logContext: Record<string, unknown>;
    successMessage: string;
    failureMessage: string;
  }): Promise<void> {
    const detail = this.buildDeliveryDetail(params.result);
    const endedAt = new Date().toISOString();
    const failed = params.result.status === 'failed' || params.result.status === 'partial';

    if (params.eventId) {
      const recordParams = {
        eventId: params.eventId,
        handler: params.handler,
        detail,
        startedAt: params.startedAt,
        endedAt,
      };
      if (failed) {
        await this.eventLogService.recordHandledFail(recordParams);
      } else {
        await this.eventLogService.recordHandledOk(recordParams);
      }
    }

    if (failed) {
      this.logger.error({ ...params.logContext, ...detail }, params.failureMessage);
      return;
    }

    this.logger.log(
      { ...params.logContext, poolStatus: params.result.status },
      params.successMessage,
    );
  }

  private buildDeliveryDetail(result: DeliveryOutcome): DeliveryHandlerDetail {
    if (result.status !== 'failed' && result.status !== 'partial') {
      return { poolStatus: result.status };
    }

    const failedResults = result.results.filter((recipient) => recipient.status === 'failed');
    return {
      poolStatus: result.status,
      recipientCount: result.results.length,
      failedCount: failedResults.length,
      failedAgentIds: failedResults.map((recipient) => recipient.agentId),
      errorCode: this.classifyAggregateErrorCode(failedResults),
    };
  }

  private classifyAggregateErrorCode(results: readonly RecipientResult[]): SafeDeliveryErrorCode {
    const codes = new Set(results.map((recipient) => this.classifyErrorCode(recipient.error)));
    if (codes.size === 1) {
      return codes.values().next().value as SafeDeliveryErrorCode;
    }
    return 'DELIVERY_FAILED';
  }

  private classifyErrorCode(error: unknown): SafeDeliveryErrorCode {
    const message = this.errorMessage(error);
    if (message && SAFE_DELIVERY_ERROR_CODE_SET.has(message)) {
      return message as SafeDeliveryErrorCode;
    }

    if (message && SESSION_LAUNCH_ERROR_PATTERN.test(message)) {
      return 'SESSION_LAUNCH_FAILED';
    }

    const code = this.errorCode(error);
    if (code && SAFE_DELIVERY_ERROR_CODE_SET.has(code)) {
      return code as SafeDeliveryErrorCode;
    }

    return 'DELIVERY_FAILED';
  }

  private errorMessage(error: unknown): string | undefined {
    if (typeof error === 'string') {
      return error;
    }
    if (error instanceof Error) {
      return error.message;
    }
    if (error && typeof error === 'object' && 'message' in error) {
      const message = (error as { message?: unknown }).message;
      return typeof message === 'string' ? message : undefined;
    }
    return undefined;
  }

  private errorCode(error: unknown): string | undefined {
    if (!error || typeof error !== 'object' || !('code' in error)) {
      return undefined;
    }

    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
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
   * Resolves the epic's current status label. Storage is read only when the
   * template uses the placeholder and the event payload lacks the name.
   */
  private async resolveStatusName(
    template: string,
    epicId: string,
    known: { statusName?: string; statusId?: string | null },
  ): Promise<string> {
    if (known.statusName) {
      return known.statusName;
    }
    if (!template.includes('epic_status')) {
      return UNKNOWN_STATUS;
    }

    try {
      const statusId = known.statusId ?? (await this.storage.getEpic(epicId)).statusId;
      if (!statusId) {
        return UNKNOWN_STATUS;
      }
      return (await this.storage.getStatus(statusId)).label;
    } catch {
      return UNKNOWN_STATUS;
    }
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
