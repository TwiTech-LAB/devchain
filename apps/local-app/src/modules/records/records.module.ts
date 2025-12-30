import { Module } from '@nestjs/common';
import { RecordsController } from './controllers/records.controller';
import { StorageModule } from '../storage/storage.module';

@Module({
  imports: [StorageModule],
  controllers: [RecordsController],
})
export class RecordsModule {}
