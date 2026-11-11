import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { createLogger } from '../../../common/logging/logger';
import { CloudSessionManagerService } from '../../cloud/services/cloud-session-manager.service';
import { EgressQueueService } from '../../cloud/services/egress-queue.service';
import { EventMapperService, type IngestPayload } from '../../cloud/services/event-mapper.service';
import { ProjectEgressConfigService } from '../../cloud/services/project-egress-config.service';
import { WorkspaceModeCoordinatorService } from '../../workspaces/services/workspace-mode-coordinator.service';
import { TunnelClientService } from './tunnel-client.service';

const logger = createLogger('NativePushGate');

/**
 * Grace window after a prompt for the user fires before deciding whether to deliver a
 * native push. It gives the foreground SSE channel time to stay/prove live (the mobile
 * heartbeats the bridge), and gives a just-backgrounded app time for its SSE socket to
 * be marked dead. The decision then queries bridge SSE liveness once. Bounded by the
 * SSE heartbeat interval (see the bridge's SSE_LIVENESS_QUERY_GRACE_MS).
 */
export const NATIVE_PUSH_GRACE_MS = 12_000;

export interface NativePushCandidate {
  readonly projectId: string;
  /**
   * Stable, prompt-scoped idempotency key: re-emissions of the same prompt collapse to one
   * notification via the notifications-service unique (source, sourceEventId) constraint.
   */
  readonly sourceEventId: string;
  /** Identifiers for debug logs; never content. */
  readonly logContext: Record<string, unknown>;
  /**
   * Re-checked when the grace timer fires: a prompt the user already answered
   * (for example in the web modal) sends no push and no generic notice.
   */
  stillRelevant?(): boolean;
  /**
   * The routing kids the push and the notice go to; omit for the default recipients.
   * An empty list sends nothing.
   */
  recipientDeviceKids?(): Promise<string[]>;
  push(sourceEventId: string, userId: string, instanceId: string | null): IngestPayload;
  genericNotice(sourceEventId: string, userId: string): IngestPayload;
}

/**
 * Server-side dual-channel gate for native push of a prompt that waits for the user
 * (closed/background app).
 *
 * Lives here — beside {@link TunnelEventForwarderService}, the SSE-forward sibling — rather
 * than in `CloudEgressBridgeService` because the gate must query the tunnel for SSE
 * liveness, and `cloud-tunnel` already depends on `cloud` (the reverse would cycle; feature
 * modules must not use forwardRef). It reuses the SAME egress queue / payload mapper /
 * project config as CloudEgressBridge (exported from CloudModule).
 *
 * Flow: after the grace window, ask the bridge whether the mobile SSE stream is live.
 * Live → SSE already delivered the hint → SUPPRESS native. Down → enqueue the native push.
 * Either channel is only a HINT: the mobile renders the prompt from an authoritative
 * pending-list RPC keyed by the prompt id, so a liveness race can never show it twice.
 * Multi-workspace mode (or an unknown mode) sends only a content-free account notice.
 */
/** The payload addressed to the resolved recipients; no recipients means every device. */
function addressed(payload: IngestPayload, recipients: string[] | undefined): IngestPayload {
  return recipients ? { ...payload, recipientDeviceKids: recipients } : payload;
}

@Injectable()
export abstract class NativePushGate implements OnModuleDestroy {
  private readonly pendingTimers = new Set<ReturnType<typeof setTimeout>>();

  constructor(
    private readonly cloudSession: CloudSessionManagerService,
    private readonly egressQueue: EgressQueueService,
    protected readonly eventMapper: EventMapperService,
    private readonly projectConfig: ProjectEgressConfigService,
    private readonly tunnelClient: TunnelClientService,
    private readonly workspaceMode: WorkspaceModeCoordinatorService,
  ) {}

  protected schedule(candidate: NativePushCandidate): void {
    const status = this.cloudSession.getStatus();
    if (!status.connected || !status.userId) return;
    // Same project-egress gate CloudEgressBridge applies.
    if (!this.projectConfig.isEnabled(candidate.projectId)) return;

    const userId = status.userId;
    const timer = setTimeout(() => {
      this.pendingTimers.delete(timer);
      void this.decide(candidate, userId);
    }, NATIVE_PUSH_GRACE_MS);
    if (typeof timer.unref === 'function') timer.unref();
    this.pendingTimers.add(timer);
  }

  private async decide(candidate: NativePushCandidate, userId: string): Promise<void> {
    if (candidate.stillRelevant && !candidate.stillRelevant()) {
      logger.debug(candidate.logContext, 'Prompt already answered — suppressing native push');
      return;
    }
    const recipients = candidate.recipientDeviceKids
      ? await candidate.recipientDeviceKids().catch(() => [])
      : undefined;
    if (recipients?.length === 0) {
      logger.debug(candidate.logContext, 'No recipient device — suppressing native push');
      return;
    }
    if (await this.requiresGenericNotice()) {
      this.enqueueGenericNotice(candidate, userId, recipients);
      return;
    }

    let live = false;
    try {
      ({ live } = await this.tunnelClient.querySseLiveness());
    } catch {
      live = false; // fail toward delivering the native push
    }

    if (await this.requiresGenericNotice()) {
      this.enqueueGenericNotice(candidate, userId, recipients);
      return;
    }

    if (live) {
      logger.debug(candidate.logContext, 'SSE live — suppressing native push');
      return;
    }

    this.egressQueue.enqueue(
      addressed(
        candidate.push(candidate.sourceEventId, userId, this.tunnelClient.getInstanceId()),
        recipients,
      ),
    );
    logger.debug(candidate.logContext, 'SSE down — enqueued native push');
  }

  private async requiresGenericNotice(): Promise<boolean> {
    const mode = await this.workspaceMode.getSnapshot().catch(() => null);
    return !mode || mode.multiWorkspaceMode || mode.failClosedPending;
  }

  private enqueueGenericNotice(
    candidate: NativePushCandidate,
    userId: string,
    recipients: string[] | undefined,
  ): void {
    this.egressQueue.enqueue(
      addressed(candidate.genericNotice(candidate.sourceEventId, userId), recipients),
    );
    logger.debug(candidate.logContext, 'Enqueued account-level notice');
  }

  onModuleDestroy(): void {
    for (const timer of this.pendingTimers) clearTimeout(timer);
    this.pendingTimers.clear();
  }
}
