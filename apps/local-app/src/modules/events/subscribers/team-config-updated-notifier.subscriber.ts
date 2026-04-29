import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { OnEvent } from '@nestjs/event-emitter';
import { getEventMetadata } from '../services/events.service';
import { EventLogService } from '../services/event-log.service';
import { SessionsService } from '../../sessions/services/sessions.service';
import { SessionsMessagePoolService } from '../../sessions/services/sessions-message-pool.service';
import { STORAGE_SERVICE, type StorageService } from '../../storage/interfaces/storage.interface';
import type { TeamConfigUpdatedEventPayload } from '../catalog/team.config.updated';

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
  private sessionsServiceRef?: SessionsService;

  constructor(
    private readonly eventLogService: EventLogService,
    private readonly moduleRef: ModuleRef,
    @Inject(forwardRef(() => SessionsMessagePoolService))
    private readonly messagePoolService: SessionsMessagePoolService,
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
      const leadAgent = await this.storage.getAgent(payload.teamLeadAgentId).catch(() => null);

      const message = buildMessage(payload);

      await this.launchSessionIfNeeded({
        targetAgentId: payload.teamLeadAgentId,
        projectId: payload.projectId,
        teamId: payload.teamId,
      });

      const result = await this.messagePoolService.enqueue(payload.teamLeadAgentId, message, {
        source: 'team.config.updated',
        submitKeys: ['Enter'],
        projectId: payload.projectId,
        agentName: leadAgent?.name,
      });

      this.logger.log(
        { eventId, leadAgentId: payload.teamLeadAgentId, poolStatus: result.status },
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

  private async launchSessionIfNeeded(opts: {
    targetAgentId: string;
    projectId: string;
    teamId: string;
  }): Promise<{ sessionId: string; launched: boolean }> {
    const sessionsService = this.getSessionsService();
    const activeSessions = await sessionsService.listActiveSessions();
    const existing = activeSessions.find((s) => s.agentId === opts.targetAgentId);

    if (existing?.tmuxSessionId) {
      return { sessionId: existing.id, launched: false };
    }

    const session = await sessionsService.launchSession({
      projectId: opts.projectId,
      agentId: opts.targetAgentId,
      options: { silent: true },
    });

    return { sessionId: session.id, launched: true };
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
