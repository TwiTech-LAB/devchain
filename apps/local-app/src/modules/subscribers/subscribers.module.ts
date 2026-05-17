import { Module } from '@nestjs/common';
import { SubscribersController } from './controllers/subscribers.controller';
import { ActionsController } from './controllers/actions.controller';
import { StorageModule } from '../storage/storage.module';
import { SessionsModule } from '../sessions/sessions.module';
import { TerminalDeliveryModule } from '../terminal/terminal-delivery.module';
import { EventsCoreModule } from '../events/events-core.module';
import { AgentMessageDeliveryModule } from '../agent-message-delivery/agent-message-delivery.module';
import { SubscribersService } from './services/subscribers.service';
import { SubscriberExecutorService } from './services/subscriber-executor.service';
import { AutomationSchedulerService } from './services/automation-scheduler.service';

@Module({
  imports: [
    StorageModule,
    SessionsModule,
    TerminalDeliveryModule,
    EventsCoreModule,
    AgentMessageDeliveryModule,
  ],
  controllers: [SubscribersController, ActionsController],
  providers: [SubscribersService, SubscriberExecutorService, AutomationSchedulerService],
  exports: [SubscribersService, SubscriberExecutorService, AutomationSchedulerService],
})
export class SubscribersModule {}
