import { Module } from '@nestjs/common';
import { EventsCoreModule } from '../events/events-core.module';
import { RealtimeBroadcastModule } from '../realtime/realtime-broadcast.module';
import { StorageModule } from '../storage/storage.module';
import { E2eeModule } from '../e2ee/e2ee.module';
import { EncryptedTokenStoreService } from './services/encrypted-token-store.service';
import { CloudSessionManagerService } from './services/cloud-session-manager.service';
import { RefreshGateService } from './services/refresh-gate.service';
import { EgressQueueService } from './services/egress-queue.service';
import { EventMapperService } from './services/event-mapper.service';
import { ProjectEgressConfigService } from './services/project-egress-config.service';
import { CloudEgressBridgeService } from './services/cloud-egress-bridge.service';
import { ProjectActivityReporterService } from './services/project-activity-reporter.service';
import { NotificationRecipientResolverService } from './services/notification-recipient-resolver.service';
import { AuthCallbackController } from './controllers/auth-callback.controller';
import { EgressConfigController } from './controllers/egress-config.controller';
import { DevicesProxyController } from './controllers/devices-proxy.controller';
import { QrInitiateProxyController } from './controllers/qr-initiate-proxy.controller';
import { PreferencesProxyController } from './controllers/preferences-proxy.controller';
import { ActivityProxyController } from './controllers/activity-proxy.controller';
import { WorkspacesModule } from '../workspaces/workspaces.module';

@Module({
  imports: [EventsCoreModule, RealtimeBroadcastModule, StorageModule, E2eeModule, WorkspacesModule],
  controllers: [
    AuthCallbackController,
    EgressConfigController,
    DevicesProxyController,
    QrInitiateProxyController,
    PreferencesProxyController,
    ActivityProxyController,
  ],
  providers: [
    EncryptedTokenStoreService,
    CloudSessionManagerService,
    RefreshGateService,
    EgressQueueService,
    EventMapperService,
    ProjectEgressConfigService,
    CloudEgressBridgeService,
    ProjectActivityReporterService,
    NotificationRecipientResolverService,
  ],
  exports: [
    CloudSessionManagerService,
    RefreshGateService,
    EncryptedTokenStoreService,
    // Exposed so the cloud-tunnel AskUserQuestion native-push gate (which lives with
    // the tunnel client to avoid a cloud↔cloud-tunnel module cycle) can reuse the SAME
    // egress queue, payload mapper, and project-egress config as CloudEgressBridge.
    EgressQueueService,
    EventMapperService,
    ProjectEgressConfigService,
  ],
})
export class CloudModule {}
