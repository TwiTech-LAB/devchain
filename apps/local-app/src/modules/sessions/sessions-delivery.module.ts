import { Module } from '@nestjs/common';
import { MessageEnqueueService } from './services/message-enqueue.service';
import { SessionLauncherFacade } from './services/session-launcher-facade.service';
import { SessionsModule } from './sessions.module';
import { SessionsReadModule } from './sessions-read.module';
import { TerminalDeliveryModule } from '../terminal/terminal-delivery.module';

@Module({
  imports: [SessionsReadModule, SessionsModule, TerminalDeliveryModule],
  providers: [MessageEnqueueService, SessionLauncherFacade],
  exports: [MessageEnqueueService, SessionLauncherFacade],
})
export class SessionsDeliveryModule {}
