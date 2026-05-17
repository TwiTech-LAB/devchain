import { Module } from '@nestjs/common';
import { ProjectsController } from './controllers/projects.controller';
import { MainProjectBootstrapService } from './services/main-project-bootstrap.service';
import { ProjectsService } from './services/projects.service';
import { ProjectProviderProvisioningService } from './services/project-provider-provisioning.service';
import { ProjectTemplateUpgradeService } from './services/project-template-upgrade.service';
import { ProjectRegistryImportService } from './services/project-registry-import.service';
import { StorageModule } from '../storage/storage.module';
import { SessionsModule } from '../sessions/sessions.module';
import { SettingsModule } from '../settings/settings.module';
import { WatchersModule } from '../watchers/watchers.module';
import { TeamsModule } from '../teams/teams.module';
import { RegistryModule } from '../registry/registry.module';
import { CoreNormalModule } from '../core/core-normal.module';
import { ProcessExecutorModule } from '../terminal/services/process-executor/process-executor.module';
import { ProvidersModule } from '../providers/providers.module';
import { ScheduledEpicsModule } from '../scheduled-epics/scheduled-epics.module';

@Module({
  imports: [
    StorageModule,
    SessionsModule,
    SettingsModule,
    WatchersModule,
    TeamsModule,
    RegistryModule,
    CoreNormalModule,
    ProcessExecutorModule,
    ProvidersModule,
    ScheduledEpicsModule,
  ],
  controllers: [ProjectsController],
  providers: [
    ProjectsService,
    MainProjectBootstrapService,
    ProjectProviderProvisioningService,
    ProjectTemplateUpgradeService,
    ProjectRegistryImportService,
  ],
  exports: [
    ProjectsService,
    MainProjectBootstrapService,
    ProjectTemplateUpgradeService,
    ProjectRegistryImportService,
  ],
})
export class ProjectsModule {}
