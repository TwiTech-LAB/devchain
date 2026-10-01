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
import { InstanceLabelController } from './controllers/instance-label.controller';
import { InstanceLabelService } from './services/instance-label.service';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { SettingsModule } from '../settings/settings.module';

@Module({
  imports: [
    EventsCoreModule,
    RealtimeBroadcastModule,
    StorageModule,
    E2eeModule,
    WorkspacesModule,
    SettingsModule,
  ],
  controllers: [
    AuthCallbackController,
    EgressConfigController,
    DevicesProxyController,
    QrInitiateProxyController,
    PreferencesProxyController,
    ActivityProxyController,
    InstanceLabelController,
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
    InstanceLabelService,
  ],
  exports: [
    CloudSessionManagerService,
    RefreshGateService,
    EncryptedTokenStoreService,
    // The tunnel client attests this instance's display name; exposing the same
    // stored value keeps the REST endpoint and the attestation on one source.
    InstanceLabelService,
    // Exposed so the cloud-tunnel AskUserQuestion native-push gate (which lives with
    // the tunnel client to avoid a cloud↔cloud-tunnel module cycle) can reuse the SAME
    // egress queue, payload mapper, and project-egress config as CloudEgressBridge.
    EgressQueueService,
    EventMapperService,
    ProjectEgressConfigService,
  ],
})
export class CloudModule {}
