import { Injectable } from '@nestjs/common';
import { CloudSessionManagerService } from '../../cloud/services/cloud-session-manager.service';
import { EgressQueueService } from '../../cloud/services/egress-queue.service';
import { EventMapperService } from '../../cloud/services/event-mapper.service';
import { NotificationRecipientResolverService } from '../../cloud/services/notification-recipient-resolver.service';
import { ProjectEgressConfigService } from '../../cloud/services/project-egress-config.service';
import { OnCatalogEvent } from '../../events/catalog/on-catalog-event';
import type { VaultRequestPendingEventPayload } from '../../events/catalog/vault.request.pending';
import { VaultVmCacheService } from '../../vault/vault-vm-cache.service';
import { VaultRequestStore } from '../../vault-requests/vault-request.store';
import { WorkspaceModeCoordinatorService } from '../../workspaces/services/workspace-mode-coordinator.service';
import { NativePushGate } from './native-push-gate';
import { TunnelClientService } from './tunnel-client.service';
import { VaultUseOptInRegistry } from './vault-use-opt-in';

/**
 * Native push for a pending Vault request, through the dual-channel gate of
 * {@link NativePushGate}. The phone renders the request from `vault.listRequests` keyed by
 * `requestId`; the push carries identifiers only — never the name or description.
 */
@Injectable()
export class VaultRequestPushGateService extends NativePushGate {
  constructor(
    cloudSession: CloudSessionManagerService,
    egressQueue: EgressQueueService,
    eventMapper: EventMapperService,
    projectConfig: ProjectEgressConfigService,
    tunnelClient: TunnelClientService,
    workspaceMode: WorkspaceModeCoordinatorService,
    private readonly requests: VaultRequestStore,
    private readonly vmCache: VaultVmCacheService,
    private readonly useOptIns: VaultUseOptInRegistry,
    private readonly recipients: NotificationRecipientResolverService,
  ) {
    super(cloudSession, egressQueue, eventMapper, projectConfig, tunnelClient, workspaceMode);
  }

  @OnCatalogEvent('vault.request.pending', { async: true })
  onPending(payload: VaultRequestPendingEventPayload): void {
    // Home is the only answering surface: a push from a VM would open the VM instance.
    if (this.vmCache.isClaimedHost()) return;
    this.schedule({
      projectId: payload.projectId,
      sourceEventId: `vault.request:${payload.requestId}`,
      logContext: { requestId: payload.requestId },
      // Answered or expired while the grace timer ran → no push, no generic notice.
      stillRelevant: () => this.requests.get(payload.requestId) !== null,
      ...(payload.type === 'use' && {
        recipientDeviceKids: () =>
          this.recipients.resolveProjectRecipientRoutingKids(
            payload.projectId,
            this.useOptIns.snapshot(),
          ),
      }),
      push: (sourceEventId, userId, instanceId) =>
        this.eventMapper.mapToIngestPayload(
          { name: 'vault.request.pending', payload },
          sourceEventId,
          userId,
          { instanceId },
        ),
      genericNotice: (sourceEventId, userId) =>
        this.eventMapper.mapToGenericVaultRequestNotice(sourceEventId, userId),
    });
  }
}
