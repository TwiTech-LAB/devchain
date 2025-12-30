import { Module } from '@nestjs/common';
import { DocumentsController } from './controllers/documents.controller';
import { StorageModule } from '../storage/storage.module';

@Module({
  imports: [StorageModule],
  controllers: [DocumentsController],
})
export class DocumentsModule {}
