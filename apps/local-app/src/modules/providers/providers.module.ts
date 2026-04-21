import { Module } from '@nestjs/common';
import { ProvidersController } from './controllers/providers.controller';
import { ProviderModelsController } from './controllers/provider-models.controller';
import { StorageModule } from '../storage/storage.module';
import { McpModule } from '../mcp/mcp.module';
import { CoreNormalModule } from '../core/core-normal.module';
import { ProviderAdaptersModule } from './adapters';
import { ProbeProofService } from './services/probe-proof.service';
import { ProviderProjectSyncService } from './services/provider-project-sync.service';
import { ProviderDiscoveryService } from './services/provider-discovery.service';
import { SettingsModule } from '../settings/settings.module';
import { RegistryModule } from '../registry/registry.module';

@Module({
  imports: [
    StorageModule,
    McpModule,
    CoreNormalModule,
    ProviderAdaptersModule,
    SettingsModule,
    RegistryModule,
  ],
  controllers: [ProvidersController, ProviderModelsController],
  providers: [ProbeProofService, ProviderProjectSyncService, ProviderDiscoveryService],
  exports: [ProviderProjectSyncService, ProviderDiscoveryService],
})
export class ProvidersModule {}
