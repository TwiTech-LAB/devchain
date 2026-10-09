import { Module } from '@nestjs/common';
import { PromptsController } from './controllers/prompts.controller';
import { StorageModule } from '../storage/storage.module';

@Module({
  imports: [StorageModule],
  controllers: [PromptsController],
})
export class PromptsModule {}
