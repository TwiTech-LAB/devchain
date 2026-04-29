import { Module, forwardRef } from '@nestjs/common';
import { AgentsController } from './controllers/agents.controller';
import { StorageModule } from '../storage/storage.module';
import { SessionsModule } from '../sessions/sessions.module';
import { EventsDomainModule } from '../events/events-domain.module';

@Module({
  imports: [StorageModule, EventsDomainModule, forwardRef(() => SessionsModule)],
  controllers: [AgentsController],
})
export class AgentsModule {}
