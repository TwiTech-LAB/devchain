import { Module } from '@nestjs/common';
import { ProfilesController } from './controllers/profiles.controller';
import { ProviderConfigsController } from './controllers/provider-configs.controller';
import { StorageModule } from '../storage/storage.module';

@Module({
  imports: [StorageModule],
  controllers: [ProfilesController, ProviderConfigsController],
})
export class ProfilesModule {}
