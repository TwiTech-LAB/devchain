import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { createLogger } from '../../../common/logging/logger';
import { getEventMetadata } from '../../events/services/events.service';
import { CloudSessionManagerService } from './cloud-session-manager.service';
import { EgressQueueService } from './egress-queue.service';
import { EventMapperService } from './event-mapper.service';
import { ProjectEgressConfigService } from './project-egress-config.service';
import { NotificationRecipientResolverService } from './notification-recipient-resolver.service';
import type { EpicCreatedEventPayload } from '../../events/catalog/epic.created';
import type { EpicDeletedEventPayload } from '../../events/catalog/epic.deleted';
import type { EpicUpdatedEventPayload } from '../../events/catalog/epic.updated';
import type { EpicCommentCreatedEventPayload } from '../../events/catalog/epic.comment.created';
import type { SessionCrashedEventPayload } from '../../events/catalog/session.crashed';
import type { SessionStoppedEventPayload } from '../../events/catalog/session.stopped';
import { WorkspaceModeCoordinatorService } from '../../workspaces/services/workspace-mode-coordinator.service';

const logger = createLogger('CloudEgressBridge');

@Injectable()
export class CloudEgressBridgeService {
  constructor(
    private readonly cloudSession: CloudSessionManagerService,
    private readonly egressQueue: EgressQueueService,
    private readonly eventMapper: EventMapperService,
    private readonly projectConfig: ProjectEgressConfigService,
    private readonly workspaceMode: WorkspaceModeCoordinatorService,
    private readonly recipientResolver: NotificationRecipientResolverService,
  ) {}

  @OnEvent('epic.created', { async: true })
  async onEpicCreated(payload: EpicCreatedEventPayload): Promise<void> {
    await this.forward({ name: 'epic.created', payload });
  }

  @OnEvent('epic.updated', { async: true })
  async onEpicUpdated(payload: EpicUpdatedEventPayload): Promise<void> {
    await this.forward({ name: 'epic.updated', payload });
  }

  @OnEvent('epic.deleted', { async: true })
  async onEpicDeleted(payload: EpicDeletedEventPayload): Promise<void> {
    await this.forward({ name: 'epic.deleted', payload });
  }

  @OnEvent('epic.comment.created', { async: true })
  async onEpicCommentCreated(payload: EpicCommentCreatedEventPayload): Promise<void> {
    await this.forward({ name: 'epic.comment.created', payload });
  }

  @OnEvent('session.crashed', { async: true })
  async onSessionCrashed(payload: SessionCrashedEventPayload): Promise<void> {
    await this.forward({ name: 'session.crashed', payload });
  }

  @OnEvent('session.stopped', { async: true })
  async onSessionStopped(payload: SessionStoppedEventPayload): Promise<void> {
    await this.forward({ name: 'session.stopped', payload });
  }

  private async forward(
    event: Parameters<EventMapperService['mapToIngestPayload']>[0],
  ): Promise<void> {
    const status = this.cloudSession.getStatus();
    if (!status.connected || !status.userId) return;

    const mode = await this.workspaceMode.getSnapshot().catch(() => null);
    if (!mode || mode.failClosedPending) return;

    const metadata = getEventMetadata(event.payload);
    if (!metadata) {
      logger.debug({ eventName: event.name }, 'Skipping event without metadata');
      return;
    }

    const ingestPayload = this.eventMapper.mapToIngestPayload(event, metadata.id, status.userId);

    if (ingestPayload.projectId && !this.projectConfig.isEnabled(ingestPayload.projectId)) {
      return;
    }

    if (!ingestPayload.projectId && !this.projectConfig.hasAnyEnabled()) {
      return;
    }

    // Multi-workspace mode: project notifications target exactly the paired devices with
    // event-time workspace access. Projectless session events stay suppressed (their
    // workspace cannot be established). Single-workspace mode keeps account-wide
    // delivery — no target set on the payload.
    if (mode.multiWorkspaceMode) {
      if (!ingestPayload.projectId) return;

      const recipientDeviceKids = await this.recipientResolver
        .resolveProjectRecipientRoutingKids(ingestPayload.projectId)
        .catch(() => [] as string[]);
      if (recipientDeviceKids.length === 0) {
        logger.debug(
          { eventName: event.name, sourceEventId: metadata.id },
          'Skipping event with no authorized workspace recipient',
        );
        return;
      }
      ingestPayload.recipientDeviceKids = recipientDeviceKids;
    }

    this.egressQueue.enqueue(ingestPayload);
    logger.debug(
      { eventName: event.name, sourceEventId: metadata.id },
      'Event enqueued for cloud egress',
    );
  }
}
