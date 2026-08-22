import { Module } from '@nestjs/common';
import { EventsCoreModule } from '../events/events-core.module';
import { ProcessExecutorModule } from './services/process-executor/process-executor.module';
import { GuestDeliveryService } from './services/guest-delivery.service';
import { TerminalDeliveryFacade } from './services/terminal-delivery-facade.service';
import { HumanPromptStateService } from './services/human-prompt-state.service';
import { TerminalIOService } from './services/terminal-io/terminal-io.service';

@Module({
  imports: [EventsCoreModule, ProcessExecutorModule],
  providers: [
    HumanPromptStateService,
    TerminalIOService,
    GuestDeliveryService,
    TerminalDeliveryFacade,
  ],
  exports: [
    HumanPromptStateService,
    TerminalIOService,
    GuestDeliveryService,
    TerminalDeliveryFacade,
  ],
})
export class TerminalDeliveryModule {}
