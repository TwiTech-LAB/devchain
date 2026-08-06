import { Module } from '@nestjs/common';
import { ProvidersController } from './controllers/providers.controller';
import { ProviderModelsController } from './controllers/provider-models.controller';
import { ProviderEffortsController } from './controllers/provider-efforts.controller';
import { ProviderPluginsController } from './controllers/provider-plugins.controller';
import { ProviderPluginPolicyController } from './controllers/provider-plugin-policy.controller';
import { StorageModule } from '../storage/storage.module';
import { ProviderAdaptersModule } from './adapters';
import { ProviderStateManager } from './services/provider-state-manager.service';
import { ProviderProjectSyncService } from './services/provider-project-sync.service';
import { ProviderDiscoveryService } from './services/provider-discovery.service';
import { McpProviderRegistrationService } from './services/mcp-provider-registration.service';
import { ProviderMcpEnsureService } from './services/provider-mcp-ensure.service';
import {
  McpRegistrationPort,
  CliMcpRegistrationAdapter,
  ConfigFileMcpRegistrationAdapter,
  AntigravityMcpRegistrationAdapter,
} from './services/mcp-registration';
import { SettingsModule } from '../settings/settings.module';
import { RegistryModule } from '../registry/registry.module';
import { ProcessExecutorModule } from '../terminal/services/process-executor/process-executor.module';
import { ProviderEffortSeedingModule } from './services/provider-effort-seeding.module';
import { ProviderPluginPolicyService } from './services/provider-plugin-policy.service';
import { ProviderPluginsService } from './services/provider-plugins.service';

@Module({
  imports: [
    StorageModule,
    ProviderAdaptersModule,
    SettingsModule,
    RegistryModule,
    ProcessExecutorModule,
    ProviderEffortSeedingModule,
  ],
  controllers: [
    ProvidersController,
    ProviderModelsController,
    ProviderEffortsController,
    ProviderPluginsController,
    ProviderPluginPolicyController,
  ],
  providers: [
    ProviderStateManager,
    ProviderProjectSyncService,
    ProviderDiscoveryService,
    McpRegistrationPort,
    CliMcpRegistrationAdapter,
    ConfigFileMcpRegistrationAdapter,
    AntigravityMcpRegistrationAdapter,
    McpProviderRegistrationService,
    ProviderMcpEnsureService,
    ProviderPluginPolicyService,
    ProviderPluginsService,
  ],
  exports: [
    ProviderProjectSyncService,
    ProviderDiscoveryService,
    McpProviderRegistrationService,
    McpRegistrationPort,
    ProviderMcpEnsureService,
    ProviderPluginPolicyService,
    ProviderPluginsService,
  ],
})
export class ProvidersModule {}
