import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { OnEvent } from '@nestjs/event-emitter';
import { getEventMetadata } from '../services/events.service';
import { EventLogService } from '../services/event-log.service';
import { SessionsService } from '../../sessions/services/sessions.service';
import { SessionsMessagePoolService } from '../../sessions/services/sessions-message-pool.service';
import { STORAGE_SERVICE, type StorageService } from '../../storage/interfaces/storage.interface';
import type { EpicCreatedEventPayload } from '../catalog/epic.created';

@Injectable()
export class SubEpicCreatedNotifierSubscriber {
  private readonly logger = new Logger(SubEpicCreatedNotifierSubscriber.name);
  private sessionsServiceRef?: SessionsService;

  constructor(
    private readonly eventLogService: EventLogService,
    private readonly moduleRef: ModuleRef,
    @Inject(forwardRef(() => SessionsMessagePoolService))
    private readonly messagePoolService: SessionsMessagePoolService,
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
      const parent = await this.storage.getEpic(payload.parentId).catch(() => null);
      if (!parent) {
        return;
      }

      if (!parent.agentId) {
        return;
      }

      if (payload.actor?.type === 'agent' && payload.actor.id === parent.agentId) {
        this.logger.debug(
          { actorId: payload.actor.id, epicId: payload.epicId },
          'Skipping notification: creator is the parent assignee (self-spawn)',
        );
        return;
      }

      const parentAgent = await this.storage.getAgent(parent.agentId).catch(() => null);
      const creatorName = await this.resolveActorName(payload.actor);

      const byClause = creatorName ? ` by ${creatorName}` : '';
      const message =
        `A new sub-epic '${payload.title}' (${payload.epicId}) was created under ` +
        `your epic '${parent.title}' (${parent.id})${byClause}.`;

      await this.launchSessionIfNeeded({
        targetAgentId: parent.agentId,
        projectId: payload.projectId,
        epicId: parent.id,
      });

      const result = await this.messagePoolService.enqueue(parent.agentId, message, {
        source: 'epic.sub_epic.created',
        submitKeys: ['Enter'],
        projectId: payload.projectId,
        agentName: parentAgent?.name,
      });

      this.logger.log(
        { eventId, parentAgentId: parent.agentId, poolStatus: result.status },
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

  private async launchSessionIfNeeded(opts: {
    targetAgentId: string;
    projectId: string;
    epicId: string;
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
      epicId: opts.epicId,
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
