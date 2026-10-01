import { Module } from '@nestjs/common';
import { AgentsController } from './controllers/agents.controller';
import { StorageModule } from '../storage/storage.module';
import { SessionsModule } from '../sessions/sessions.module';
import { EventsCoreModule } from '../events/events-core.module';
import { SettingsModule } from '../settings/settings.module';
import { ProjectWriteAdmissionModule } from '../remotes/admission/project-write-admission.module';

@Module({
  imports: [
    StorageModule,
    EventsCoreModule,
    SessionsModule,
    SettingsModule,
    ProjectWriteAdmissionModule,
  ],
  controllers: [AgentsController],
})
export class AgentsModule {}
