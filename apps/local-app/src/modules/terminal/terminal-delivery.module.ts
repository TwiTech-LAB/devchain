import { Module } from '@nestjs/common';
import { EventsCoreModule } from '../events/events-core.module';
import { SettingsModule } from '../settings/settings.module';
import { ProcessExecutorModule } from './services/process-executor/process-executor.module';
import { GuestDeliveryService } from './services/guest-delivery.service';
import { TerminalDeliveryFacade } from './services/terminal-delivery-facade.service';
import { HumanPromptStateService } from './services/human-prompt-state.service';
import { HumanPromptInputService } from './services/human-prompt-input.service';
import { TerminalIOService } from './services/terminal-io/terminal-io.service';

@Module({
  imports: [EventsCoreModule, ProcessExecutorModule, SettingsModule],
  providers: [
    HumanPromptStateService,
    HumanPromptInputService,
    TerminalIOService,
    GuestDeliveryService,
    TerminalDeliveryFacade,
  ],
  exports: [
    HumanPromptStateService,
    HumanPromptInputService,
    TerminalIOService,
    GuestDeliveryService,
    TerminalDeliveryFacade,
  ],
})
export class TerminalDeliveryModule {}
