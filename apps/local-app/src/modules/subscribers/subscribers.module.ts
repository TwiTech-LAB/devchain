import { Module, forwardRef } from '@nestjs/common';
import { SubscribersController } from './controllers/subscribers.controller';
import { ActionsController } from './controllers/actions.controller';
import { StorageModule } from '../storage/storage.module';
import { SessionsModule } from '../sessions/sessions.module';
import { TerminalModule } from '../terminal/terminal.module';
import { EventsModule } from '../events/events.module';
import { SubscribersService } from './services/subscribers.service';
import { SubscriberExecutorService } from './services/subscriber-executor.service';
import { AutomationSchedulerService } from './services/automation-scheduler.service';

@Module({
  imports: [
    StorageModule,
    forwardRef(() => SessionsModule),
    forwardRef(() => TerminalModule),
    EventsModule,
  ],
  controllers: [SubscribersController, ActionsController],
  providers: [SubscribersService, SubscriberExecutorService, AutomationSchedulerService],
  exports: [SubscribersService, SubscriberExecutorService, AutomationSchedulerService],
})
export class SubscribersModule {}
