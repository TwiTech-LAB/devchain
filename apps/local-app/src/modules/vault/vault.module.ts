import { Module } from '@nestjs/common';
import { ProviderAdaptersModule } from '../providers/adapters/provider-adapters.module';
import { RuntimeDirectoryModule } from '../runtime-directory/runtime-directory.module';
import { SessionRowsModule } from '../storage/sessions/session-rows.module';
import { StorageModule } from '../storage/storage.module';
import { VaultAccessService } from './vault-access.service';
import { VaultController } from './vault.controller';
import { VaultDiscoveryService } from './vault-discovery.service';
import { VaultEntriesController } from './vault-entries.controller';
import { VaultEntriesService } from './vault-entries.service';
import { VaultKeyService } from './vault-key.service';
import { VaultLaunchService } from './vault-launch.service';
import { VaultPushBuilder } from './vault-push.builder';
import { VaultStoreMigrationService } from './vault-store-migration.service';
import { VaultValueReader } from './vault-value-reader';
import { VaultLocalPeerGuard } from './vault-local-peer.guard';
import { VaultResolveController } from './vault-resolve.controller';
import { VaultResolveService } from './vault-resolve.service';
import { VAULT_SESSION_OVERLAY } from './vault-session-overlay';
import { VaultSessionValueStore } from './vault-session-values';
import { VaultUseApprovalStore } from './vault-use-approvals';
import { VaultUseGate } from './vault-use-gate';
import { OsVaultKeystore, VAULT_KEYSTORE } from './vault-keystore';
import { VaultVmCacheModule } from './vault-vm-cache.module';
import { VaultRequestStoreModule } from '../vault-requests/vault-request-store.module';

@Module({
  imports: [
    StorageModule,
    SessionRowsModule,
    RuntimeDirectoryModule,
    ProviderAdaptersModule,
    VaultVmCacheModule,
    VaultRequestStoreModule,
  ],
  controllers: [VaultController, VaultEntriesController, VaultResolveController],
  providers: [
    VaultKeyService,
    VaultAccessService,
    VaultEntriesService,
    VaultLaunchService,
    VaultValueReader,
    VaultResolveService,
    VaultLocalPeerGuard,
    VaultSessionValueStore,
    VaultUseApprovalStore,
    VaultUseGate,
    { provide: VAULT_SESSION_OVERLAY, useExisting: VaultSessionValueStore },
    VaultDiscoveryService,
    VaultPushBuilder,
    VaultStoreMigrationService,
    { provide: VAULT_KEYSTORE, useClass: OsVaultKeystore },
  ],
  exports: [
    VaultKeyService,
    VaultAccessService,
    VaultEntriesService,
    VaultLaunchService,
    VaultDiscoveryService,
    VaultPushBuilder,
    VAULT_SESSION_OVERLAY,
    VaultSessionValueStore,
    VaultUseApprovalStore,
  ],
})
export class VaultModule {}
