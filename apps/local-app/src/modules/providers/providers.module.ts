import { SessionsReadModule } from '../sessions/sessions-read.module';
import { ProviderCliInstallerService } from './services/provider-cli-installer.service';
import { ProviderCliStateModule } from './services/provider-cli-state.module';
import { Module } from '@nestjs/common';
import { ProvidersController } from './controllers/providers.controller';
import { ProviderModelsController } from './controllers/provider-models.controller';
import { ProviderEffortsController } from './controllers/provider-efforts.controller';
import { ProviderPluginsController } from './controllers/provider-plugins.controller';
import { ProviderPluginPolicyController } from './controllers/provider-plugin-policy.controller';
import { ProviderClisController } from './controllers/provider-clis.controller';
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
import {
  NPM_REGISTRY_BASE_URL,
  ProviderCliNpmLookupService,
} from './services/provider-cli-npm-lookup.service';
import { ProviderCliVersionsService } from './services/provider-cli-versions.service';
import { NPM_PUBLIC_REGISTRY_URL } from '@devchain/shared';
import { ProjectWriteAdmissionModule } from '../remotes/admission/project-write-admission.module';

@Module({
  imports: [
    StorageModule,
    SessionsReadModule,
    ProviderCliStateModule,
    ProviderAdaptersModule,
    SettingsModule,
    RegistryModule,
    ProcessExecutorModule,
    ProviderEffortSeedingModule,
    ProjectWriteAdmissionModule,
  ],
  controllers: [
    ProvidersController,
    ProviderModelsController,
    ProviderEffortsController,
    ProviderPluginsController,
    ProviderPluginPolicyController,
    ProviderClisController,
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
    { provide: NPM_REGISTRY_BASE_URL, useValue: NPM_PUBLIC_REGISTRY_URL },
    ProviderCliNpmLookupService,
    ProviderCliVersionsService,
    ProviderCliInstallerService,
  ],
  exports: [
    ProviderProjectSyncService,
    ProviderDiscoveryService,
    McpProviderRegistrationService,
    McpRegistrationPort,
    ProviderMcpEnsureService,
    ProviderPluginPolicyService,
    ProviderPluginsService,
    ProviderCliVersionsService,
    ProviderCliInstallerService,
  ],
})
export class ProvidersModule {}
