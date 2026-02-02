import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { OnEvent } from '@nestjs/event-emitter';
import { getEventMetadata } from '../services/events.service';
import { EventLogService } from '../services/event-log.service';
import { SettingsService } from '../../settings/services/settings.service';
import { SessionsService } from '../../sessions/services/sessions.service';
import { SessionCoordinatorService } from '../../sessions/services/session-coordinator.service';
import { SessionsMessagePoolService } from '../../sessions/services/sessions-message-pool.service';
import { STORAGE_SERVICE, type StorageService } from '../../storage/interfaces/storage.interface';
import type { EpicUpdatedEventPayload } from '../catalog/epic.updated';
import type { EpicCreatedEventPayload } from '../catalog/epic.created';

const TEMPLATE_SETTING_KEY = 'events.epicAssigned.template';
const DEFAULT_TEMPLATE =
  '[Epic Assignment]\n{epic_title} is now assigned to {agent_name} in {project_name}. (Epic ID: {epic_id})';

@Injectable()
export class EpicAssignmentNotifierSubscriber {
  private readonly logger = new Logger(EpicAssignmentNotifierSubscriber.name);
  private sessionsServiceRef?: SessionsService;

  constructor(
    private readonly eventLogService: EventLogService,
    private readonly settingsService: SettingsService,
    private readonly moduleRef: ModuleRef,
    @Inject(forwardRef(() => SessionCoordinatorService))
    private readonly sessionCoordinator: SessionCoordinatorService,
    @Inject(forwardRef(() => SessionsMessagePoolService))
    private readonly messagePoolService: SessionsMessagePoolService,
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

      const template = this.resolveTemplate();
      const message = this.renderTemplate(template, {
        epic_id: payload.epicId,
        agent_name: payload.agentName ?? payload.agentId,
        epic_title: payload.title,
        project_name: payload.projectName ?? payload.projectId,
        assigner_name: assignerName ?? 'System',
      });

      // Ensure agent has an active session (launch if needed)
      // Note: ensureAgentSession calls launchSession() which has internal withAgentLock.
      // No outer lock needed here - it would cause deadlock (nested non-reentrant locks).
      const { sessionId, launched } = await this.ensureAgentSessionForCreated(payload);

      // Enqueue message to pool for batched delivery
      const result = await this.messagePoolService.enqueue(payload.agentId, message, {
        source: 'epic.created',
        submitKeys: ['Enter'],
        projectId: payload.projectId,
        agentName: payload.agentName ?? undefined,
      });

      this.logger.debug(
        { agentId: payload.agentId, sessionId, status: result.status },
        'EpicAssignmentNotifier: message enqueued to pool (epic.created)',
      );

      if (eventId) {
        await this.eventLogService.recordHandledOk({
          eventId,
          handler,
          detail: {
            sessionId,
            launched,
            poolStatus: result.status,
          },
          startedAt,
          endedAt: new Date().toISOString(),
        });
      }

      this.logger.log(
        { eventId, sessionId, launched, poolStatus: result.status },
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

      const template = this.resolveTemplate();
      const message = this.renderTemplate(template, {
        epic_id: payload.epicId,
        agent_name: agentName ?? newAgentId,
        epic_title: epicTitle ?? payload.epicId,
        project_name: projectName ?? payload.projectId,
        assigner_name: assignerName ?? 'System',
      });

      // Ensure agent has an active session (launch if needed)
      // Note: ensureAgentSession calls launchSession() which has internal withAgentLock.
      // No outer lock needed here - it would cause deadlock (nested non-reentrant locks).
      const { sessionId, launched } = await this.ensureAgentSession(payload, newAgentId);

      // Enqueue message to pool for batched delivery
      const result = await this.messagePoolService.enqueue(newAgentId, message, {
        source: 'epic.assigned', // Keep for UX continuity
        submitKeys: ['Enter'],
        projectId: payload.projectId,
        agentName: agentName ?? undefined,
        // No senderAgentId - system-generated, no failure notice needed
      });

      this.logger.debug(
        { agentId: newAgentId, sessionId, status: result.status },
        'EpicAssignmentNotifier: message enqueued to pool',
      );

      if (eventId) {
        await this.eventLogService.recordHandledOk({
          eventId,
          handler,
          detail: {
            sessionId,
            launched,
            poolStatus: result.status,
          },
          startedAt,
          endedAt: new Date().toISOString(),
        });
      }

      this.logger.log(
        { eventId, sessionId, launched, poolStatus: result.status },
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

  private renderTemplate(
    template: string,
    context: Record<
      'epic_id' | 'agent_name' | 'epic_title' | 'project_name' | 'assigner_name',
      string
    >,
  ): string {
    return Object.entries(context).reduce((acc, [key, value]) => {
      const placeholder = `{${key}}`;
      return acc.split(placeholder).join(value);
    }, template);
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

  private async ensureAgentSession(
    payload: EpicUpdatedEventPayload,
    agentId: string,
  ): Promise<{
    sessionId: string;
    tmuxSessionId: string;
    launched: boolean;
  }> {
    const activeSessions = await this.getSessionsService().listActiveSessions();
    const existing = activeSessions.find((session) => session.agentId === agentId);

    if (existing?.tmuxSessionId) {
      return {
        sessionId: existing.id,
        tmuxSessionId: existing.tmuxSessionId,
        launched: false,
      };
    }

    const session = await this.getSessionsService().launchSession({
      projectId: payload.projectId,
      agentId: agentId,
      epicId: payload.epicId,
    });

    if (!session.tmuxSessionId) {
      throw new Error('Launched session missing tmuxSessionId');
    }

    return {
      sessionId: session.id,
      tmuxSessionId: session.tmuxSessionId,
      launched: true,
    };
  }

  private async ensureAgentSessionForCreated(payload: EpicCreatedEventPayload): Promise<{
    sessionId: string;
    tmuxSessionId: string;
    launched: boolean;
  }> {
    if (!payload.agentId) {
      throw new Error('Cannot ensure session for epic without agentId');
    }

    const activeSessions = await this.getSessionsService().listActiveSessions();
    const existing = activeSessions.find((session) => session.agentId === payload.agentId);

    if (existing?.tmuxSessionId) {
      return {
        sessionId: existing.id,
        tmuxSessionId: existing.tmuxSessionId,
        launched: false,
      };
    }

    const session = await this.getSessionsService().launchSession({
      projectId: payload.projectId,
      agentId: payload.agentId,
      epicId: payload.epicId,
    });

    if (!session.tmuxSessionId) {
      throw new Error('Launched session missing tmuxSessionId');
    }

    return {
      sessionId: session.id,
      tmuxSessionId: session.tmuxSessionId,
      launched: true,
    };
  }

  private getSessionsService(): SessionsService {
    if (!this.sessionsServiceRef) {
      this.sessionsServiceRef = this.moduleRef.get(SessionsService, { strict: false });
      if (!this.sessionsServiceRef) {
        throw new Error('SessionsService is not available in the current module context');
      }
    }
    return this.sessionsServiceRef;
  }
}
