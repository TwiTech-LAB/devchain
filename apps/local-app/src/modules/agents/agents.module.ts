import { Module } from '@nestjs/common';
import { AgentsController } from './controllers/agents.controller';
import { StorageModule } from '../storage/storage.module';
import { SessionsModule } from '../sessions/sessions.module';
import { EventsCoreModule } from '../events/events-core.module';

@Module({
  imports: [StorageModule, EventsCoreModule, SessionsModule],
  controllers: [AgentsController],
})
export class AgentsModule {}
