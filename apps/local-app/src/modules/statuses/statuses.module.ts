import { Module } from '@nestjs/common';
import { StatusesController } from './controllers/statuses.controller';
import { StorageModule } from '../storage/storage.module';

@Module({
  imports: [StorageModule],
  controllers: [StatusesController],
})
export class StatusesModule {}
