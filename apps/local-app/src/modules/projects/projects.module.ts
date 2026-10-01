import { Module } from '@nestjs/common';
import { ProjectsController } from './controllers/projects.controller';
import { ProjectsService } from './services/projects.service';
import { ProjectProviderProvisioningService } from './services/project-provider-provisioning.service';
import { ProjectTemplateUpgradeService } from './services/project-template-upgrade.service';
import { ProjectRegistryImportService } from './services/project-registry-import.service';
import { TemplatePipeline } from './template-codec/template-pipeline';
import { StorageModule } from '../storage/storage.module';
import { SessionsModule } from '../sessions/sessions.module';
import { SettingsModule } from '../settings/settings.module';
import { WatchersModule } from '../watchers/watchers.module';
import { TeamsModule } from '../teams/teams.module';
import { RegistryModule } from '../registry/registry.module';
import { CoreNormalModule } from '../core/core-normal.module';
import { ProvidersModule } from '../providers/providers.module';
import { ScheduledEpicsModule } from '../scheduled-epics/scheduled-epics.module';
import { EventsCoreModule } from '../events/events-core.module';
import { ProjectWriteAdmissionModule } from '../remotes/admission/project-write-admission.module';

@Module({
  imports: [
    StorageModule,
    SessionsModule,
    SettingsModule,
    WatchersModule,
    TeamsModule,
    RegistryModule,
    CoreNormalModule,
    ProvidersModule,
    ScheduledEpicsModule,
    EventsCoreModule,
    ProjectWriteAdmissionModule,
  ],
  controllers: [ProjectsController],
  providers: [
    ProjectsService,
    ProjectProviderProvisioningService,
    ProjectTemplateUpgradeService,
    ProjectRegistryImportService,
    TemplatePipeline,
  ],
  exports: [ProjectsService, ProjectTemplateUpgradeService, ProjectRegistryImportService],
})
export class ProjectsModule {}
