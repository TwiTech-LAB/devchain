import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { OnEvent } from '@nestjs/event-emitter';
import { getEventMetadata } from '../services/events.service';
import { EventLogService } from '../services/event-log.service';
import { SessionsService } from '../../sessions/services/sessions.service';
import { SessionsMessagePoolService } from '../../sessions/services/sessions-message-pool.service';
import type { TeamMemberAddedEventPayload } from '../catalog/team.member.added';
import type { TeamMemberRemovedEventPayload } from '../catalog/team.member.removed';

@Injectable()
export class TeamMembershipChangedNotifierSubscriber {
  private readonly logger = new Logger(TeamMembershipChangedNotifierSubscriber.name);
  private sessionsServiceRef?: SessionsService;

  constructor(
    private readonly eventLogService: EventLogService,
    private readonly moduleRef: ModuleRef,
    @Inject(forwardRef(() => SessionsMessagePoolService))
    private readonly messagePoolService: SessionsMessagePoolService,
  ) {}

  @OnEvent('team.member.added', { async: true })
  async handleMemberAdded(payload: TeamMemberAddedEventPayload): Promise<void> {
    if (!payload.teamLeadAgentId) return;

    const message = `Agent '${payload.addedAgentName ?? payload.addedAgentId}' was added to team '${payload.teamName}'.`;
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
    payload: { projectId: string; teamId: string },
  ): Promise<void> {
    const metadata = getEventMetadata(payload);
    const eventId = metadata?.id;
    const handler = 'TeamMembershipChangedNotifier';
    const startedAt = new Date().toISOString();

    try {
      await this.launchSessionIfNeeded({
        targetAgentId: leadAgentId,
        projectId: payload.projectId,
        teamId: payload.teamId,
      });

      const result = await this.messagePoolService.enqueue(leadAgentId, message, {
        source,
        submitKeys: ['Enter'],
        projectId: payload.projectId,
      });

      this.logger.log(
        { eventId, leadAgentId, poolStatus: result.status },
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
