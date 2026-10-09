import { Module } from '@nestjs/common';
import { ProfilesController } from './controllers/profiles.controller';
import { ProviderConfigsController } from './controllers/provider-configs.controller';
import { StorageModule } from '../storage/storage.module';
import { SettingsModule } from '../settings/settings.module';
import { ProviderConfigsService } from './services/provider-configs.service';

@Module({
  imports: [StorageModule, SettingsModule],
  controllers: [ProfilesController, ProviderConfigsController],
  providers: [ProviderConfigsService],
})
export class ProfilesModule {}
