import { Module, forwardRef } from '@nestjs/common';
import { AgentsController } from './controllers/agents.controller';
import { StorageModule } from '../storage/storage.module';
import { SessionsModule } from '../sessions/sessions.module';

@Module({
  imports: [StorageModule, forwardRef(() => SessionsModule)],
  controllers: [AgentsController],
})
export class AgentsModule {}
