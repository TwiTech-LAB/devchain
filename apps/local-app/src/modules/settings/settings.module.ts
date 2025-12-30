import { Module } from '@nestjs/common';
import { SettingsController } from './controllers/settings.controller';
import { SettingsService } from './services/settings.service';
import { DbModule } from '../storage/db/db.module';
import { StorageModule } from '../storage/storage.module';

@Module({
  imports: [DbModule, StorageModule],
  controllers: [SettingsController],
  providers: [SettingsService],
  exports: [SettingsService],
})
export class SettingsModule {}
