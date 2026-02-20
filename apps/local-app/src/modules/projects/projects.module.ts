import { Module } from '@nestjs/common';
import { ProjectsController } from './controllers/projects.controller';
import { MainProjectBootstrapService } from './services/main-project-bootstrap.service';
import { ProjectsService } from './services/projects.service';
import { StorageModule } from '../storage/storage.module';
import { SessionsModule } from '../sessions/sessions.module';
import { SettingsModule } from '../settings/settings.module';
import { WatchersModule } from '../watchers/watchers.module';

@Module({
  imports: [StorageModule, SessionsModule, SettingsModule, WatchersModule],
  controllers: [ProjectsController],
  providers: [ProjectsService, MainProjectBootstrapService],
  exports: [ProjectsService, MainProjectBootstrapService],
})
export class ProjectsModule {}
