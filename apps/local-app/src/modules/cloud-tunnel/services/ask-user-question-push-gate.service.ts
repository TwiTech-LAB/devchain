import { OnCatalogEvent } from '../../events/catalog/on-catalog-event';
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { createLogger } from '../../../common/logging/logger';
import { CloudSessionManagerService } from '../../cloud/services/cloud-session-manager.service';
import { EgressQueueService } from '../../cloud/services/egress-queue.service';
import { EventMapperService, type IngestPayload } from '../../cloud/services/event-mapper.service';
import { ProjectEgressConfigService } from '../../cloud/services/project-egress-config.service';
import type { ClaudeHooksAskUserQuestionPendingEventPayload } from '../../events/catalog/claude.hooks.ask_user_question.pending';
import { TunnelClientService } from './tunnel-client.service';
import { WorkspaceModeCoordinatorService } from '../../workspaces/services/workspace-mode-coordinator.service';

const logger = createLogger('AskUserQuestionPushGate');

/**
 * Grace window after an AskUserQuestion fires before deciding whether to deliver a
 * native push. It gives the foreground SSE channel time to stay/prove live (the mobile
 * heartbeats the bridge), and gives a just-backgrounded app time for its SSE socket to
 * be marked dead. The decision then queries bridge SSE liveness once. Bounded by the
 * SSE heartbeat interval (see the bridge's SSE_LIVENESS_QUERY_GRACE_MS).
 */
export const AUQ_NATIVE_PUSH_GRACE_MS = 12_000;

/**
 * Server-side dual-channel gate for AskUserQuestion native push (closed/background app).
 *
 * Lives here — beside {@link TunnelEventForwarderService}, the SSE-forward sibling — rather
 * than in `CloudEgressBridgeService` because the gate must query the tunnel for SSE
 * liveness, and `cloud-tunnel` already depends on `cloud` (the reverse would cycle; feature
 * modules must not use forwardRef). It reuses the SAME egress queue / payload mapper /
 * project config as CloudEgressBridge (exported from CloudModule).
 *
 * Flow: on `ask_user_question.pending`, after a grace window, ask the bridge whether the
 * mobile SSE stream is live. Live → SSE already delivered the hint → SUPPRESS native.
 * Down → enqueue the native push. Either channel is only a HINT: the mobile renders the
 * card from the authoritative `listPendingAskQuestions` catch-up keyed by `toolUseId`, so a
 * liveness race can never double-fire a card. The forwarded payload carries identifiers
 * only — never question content.
 */
@Injectable()
export class AskUserQuestionPushGateService implements OnModuleDestroy {
  private readonly pendingTimers = new Set<ReturnType<typeof setTimeout>>();

  constructor(
    private readonly cloudSession: CloudSessionManagerService,
    private readonly egressQueue: EgressQueueService,
    private readonly eventMapper: EventMapperService,
    private readonly projectConfig: ProjectEgressConfigService,
    private readonly tunnelClient: TunnelClientService,
    private readonly workspaceMode: WorkspaceModeCoordinatorService,
  ) {}

  @OnCatalogEvent('claude.hooks.ask_user_question.pending', { async: true })
  async onPending(payload: ClaudeHooksAskUserQuestionPendingEventPayload): Promise<void> {
    const status = this.cloudSession.getStatus();
    if (!status.connected || !status.userId) return;

    // Same project-egress gate CloudEgressBridge applies. AUQ always carries a projectId.
    if (!this.projectConfig.isEnabled(payload.projectId)) return;

    // Stable, question-scoped idempotency key: re-emissions of the SAME question (retries,
    // catch-up) collapse to one notification via the notifications-service unique
    // (source, sourceEventId) constraint.
    const sourceEventId = `auq.pending:${payload.toolUseId}`;
    const timer = setTimeout(() => {
      this.pendingTimers.delete(timer);
      void this.decide(payload, sourceEventId, status.userId!);
    }, AUQ_NATIVE_PUSH_GRACE_MS);
    if (typeof timer.unref === 'function') timer.unref();
    this.pendingTimers.add(timer);
  }

  private async decide(
    payload: ClaudeHooksAskUserQuestionPendingEventPayload,
    sourceEventId: string,
    userId: string,
  ): Promise<void> {
    if (await this.requiresGenericNotice()) {
      this.enqueueGenericNotice(sourceEventId, userId);
      return;
    }

    let live = false;
    try {
      ({ live } = await this.tunnelClient.querySseLiveness());
    } catch {
      live = false; // fail toward delivering the native push
    }

    if (await this.requiresGenericNotice()) {
      this.enqueueGenericNotice(sourceEventId, userId);
      return;
    }

    if (live) {
      logger.debug(
        { toolUseId: payload.toolUseId },
        'SSE live — suppressing AskUserQuestion native push',
      );
      return;
    }

    const ingestPayload: IngestPayload = this.eventMapper.mapToIngestPayload(
      { name: 'claude.hooks.ask_user_question.pending', payload },
      sourceEventId,
      userId,
      { instanceId: this.tunnelClient.getInstanceId() },
    );
    this.egressQueue.enqueue(ingestPayload);
    logger.debug(
      { toolUseId: payload.toolUseId },
      'SSE down — enqueued AskUserQuestion native push',
    );
  }

  private async requiresGenericNotice(): Promise<boolean> {
    const mode = await this.workspaceMode.getSnapshot().catch(() => null);
    return !mode || mode.multiWorkspaceMode || mode.failClosedPending;
  }

  private enqueueGenericNotice(sourceEventId: string, userId: string): void {
    this.egressQueue.enqueue(
      this.eventMapper.mapToGenericAskUserQuestionNotice(sourceEventId, userId),
    );
    logger.debug('Enqueued account-level AskUserQuestion notice');
  }

  onModuleDestroy(): void {
    for (const timer of this.pendingTimers) clearTimeout(timer);
    this.pendingTimers.clear();
  }
}
