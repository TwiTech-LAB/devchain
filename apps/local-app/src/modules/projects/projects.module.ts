import { Module } from '@nestjs/common';
import { ProjectsController } from './controllers/projects.controller';
import { MainProjectBootstrapService } from './services/main-project-bootstrap.service';
import { ProjectsService } from './services/projects.service';
import { ProjectProviderProvisioningService } from './services/project-provider-provisioning.service';
import { StorageModule } from '../storage/storage.module';
import { SessionsModule } from '../sessions/sessions.module';
import { SettingsModule } from '../settings/settings.module';
import { WatchersModule } from '../watchers/watchers.module';
import { TeamsModule } from '../teams/teams.module';
import { CoreNormalModule } from '../core/core-normal.module';

@Module({
  imports: [
    StorageModule,
    SessionsModule,
    SettingsModule,
    WatchersModule,
    TeamsModule,
    CoreNormalModule,
  ],
  controllers: [ProjectsController],
  providers: [ProjectsService, MainProjectBootstrapService, ProjectProviderProvisioningService],
  exports: [ProjectsService, MainProjectBootstrapService],
})
export class ProjectsModule {}
