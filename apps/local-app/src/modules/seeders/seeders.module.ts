import { Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module';
import { StorageModule } from '../storage/storage.module';
import { WatchersModule } from '../watchers/watchers.module';
import {
  DATA_SEEDERS,
  DataSeederService,
  REGISTERED_DATA_SEEDERS,
} from './services/data-seeder.service';

@Module({
  imports: [StorageModule, SettingsModule, WatchersModule],
  providers: [
    {
      provide: DATA_SEEDERS,
      useValue: REGISTERED_DATA_SEEDERS,
    },
    DataSeederService,
  ],
  exports: [DataSeederService, DATA_SEEDERS],
})
export class DataSeederModule {}
