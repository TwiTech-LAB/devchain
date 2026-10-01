import { Module } from '@nestjs/common';
import { SettingsController } from './controllers/settings.controller';
import { SettingsService } from './services/settings.service';
import { DbModule } from '../storage/db/db.module';
import { StorageModule } from '../storage/storage.module';
import { ProjectWriteAdmissionModule } from '../remotes/admission/project-write-admission.module';

@Module({
  imports: [DbModule, StorageModule, ProjectWriteAdmissionModule],
  controllers: [SettingsController],
  providers: [SettingsService],
  exports: [SettingsService],
})
export class SettingsModule {}
