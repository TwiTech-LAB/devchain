import { Module } from '@nestjs/common';
import { ProvidersController } from './controllers/providers.controller';
import { ProviderModelsController } from './controllers/provider-models.controller';
import { StorageModule } from '../storage/storage.module';
import { ProviderAdaptersModule } from './adapters';
import { ProbeProofService } from './services/probe-proof.service';
import { ProviderStateManager } from './services/provider-state-manager.service';
import { ProviderProjectSyncService } from './services/provider-project-sync.service';
import { ProviderDiscoveryService } from './services/provider-discovery.service';
import { McpProviderRegistrationService } from './services/mcp-provider-registration.service';
import { ProviderMcpEnsureService } from './services/provider-mcp-ensure.service';
import {
  McpRegistrationPort,
  CliMcpRegistrationAdapter,
  ConfigFileMcpRegistrationAdapter,
} from './services/mcp-registration';
import { SettingsModule } from '../settings/settings.module';
import { RegistryModule } from '../registry/registry.module';
import { ProcessExecutorModule } from '../terminal/services/process-executor/process-executor.module';

@Module({
  imports: [
    StorageModule,
    ProviderAdaptersModule,
    SettingsModule,
    RegistryModule,
    ProcessExecutorModule,
  ],
  controllers: [ProvidersController, ProviderModelsController],
  providers: [
    ProbeProofService,
    ProviderStateManager,
    ProviderProjectSyncService,
    ProviderDiscoveryService,
    McpRegistrationPort,
    CliMcpRegistrationAdapter,
    ConfigFileMcpRegistrationAdapter,
    McpProviderRegistrationService,
    ProviderMcpEnsureService,
  ],
  exports: [
    ProviderProjectSyncService,
    ProviderDiscoveryService,
    McpProviderRegistrationService,
    McpRegistrationPort,
    ProviderMcpEnsureService,
  ],
})
export class ProvidersModule {}
