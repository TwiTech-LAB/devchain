import { Module } from '@nestjs/common';
import { AgentMessageDeliveryModule } from '../agent-message-delivery/agent-message-delivery.module';
import { EventsCoreModule } from '../events/events-core.module';
import { HostApiKeyModule } from '../remotes/host/host-api-key.module';
import { HostHelperModule } from '../remotes/host/host-helper.module';
import { RemotesModule } from '../remotes/remotes.module';
import { SessionRowsModule } from '../storage/sessions/session-rows.module';
import { StorageModule } from '../storage/storage.module';
import { VaultModule } from '../vault/vault.module';
import { VaultVmCacheModule } from '../vault/vault-vm-cache.module';
import { HostVaultRequestsController } from './host-vault-requests.controller';
import { VaultRequestFulfillService } from './vault-request-fulfill.service';
import { VaultRequestMirrorService } from './vault-request-mirror.service';
import { VaultRequestNotifierSubscriber } from './vault-request-notifier.subscriber';
import { VaultRequestsController } from './vault-requests.controller';
import { VaultRequestService } from './vault-request.service';
import { VaultRequestStoreModule } from './vault-request-store.module';
import { VaultRequestVmAnswerService } from './vault-request-vm-answer.service';

/**
 * Agent requests for Vault entries. Separate from `VaultModule` because notifying the
 * agent needs message delivery, which depends on sessions, which depend on the Vault.
 */
@Module({
  imports: [
    EventsCoreModule,
    StorageModule,
    SessionRowsModule,
    VaultModule,
    VaultVmCacheModule,
    VaultRequestStoreModule,
    AgentMessageDeliveryModule,
    HostApiKeyModule,
    HostHelperModule,
    // One way only: the health poll reaches the mirror through its listener hook.
    RemotesModule,
  ],
  controllers: [VaultRequestsController, HostVaultRequestsController],
  providers: [
    VaultRequestService,
    VaultRequestFulfillService,
    VaultRequestNotifierSubscriber,
    VaultRequestVmAnswerService,
    VaultRequestMirrorService,
  ],
  exports: [VaultRequestStoreModule, VaultRequestService, VaultRequestFulfillService],
})
export class VaultRequestsModule {}
