import { Module } from '@nestjs/common';
import { ProfilesController } from './controllers/profiles.controller';
import { StorageModule } from '../storage/storage.module';

@Module({
  imports: [StorageModule],
  controllers: [ProfilesController],
})
export class ProfilesModule {}
