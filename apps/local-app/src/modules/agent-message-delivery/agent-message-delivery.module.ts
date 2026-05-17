import { Module } from '@nestjs/common';
import { AgentMessageDeliveryService } from './agent-message-delivery.service';
import { DeliveryRecipientResolver } from './ports/delivery-recipient-resolver';
import { DeliveryFormatter } from './ports/delivery-formatter';
import { LegacyRecipientResolverAdapter } from './adapters/legacy-recipient-resolver.adapter';
import { LegacyDeliveryFormatterAdapter } from './adapters/legacy-delivery-formatter.adapter';
import { ChatMessageDeliverySubscriber } from './subscribers/chat-message-delivery.subscriber';
import { EventsCoreModule } from '../events/events-core.module';
import { StorageModule } from '../storage/storage.module';
import { SettingsModule } from '../settings/settings.module';
import { SessionsReadModule } from '../sessions/sessions-read.module';
import { SessionsDeliveryModule } from '../sessions/sessions-delivery.module';
import { TerminalDeliveryModule } from '../terminal/terminal-delivery.module';

@Module({
  imports: [
    EventsCoreModule,
    StorageModule,
    SettingsModule,
    SessionsReadModule,
    SessionsDeliveryModule,
    TerminalDeliveryModule,
  ],
  providers: [
    AgentMessageDeliveryService,
    ChatMessageDeliverySubscriber,
    { provide: DeliveryRecipientResolver, useClass: LegacyRecipientResolverAdapter },
    { provide: DeliveryFormatter, useClass: LegacyDeliveryFormatterAdapter },
  ],
  exports: [AgentMessageDeliveryService, DeliveryFormatter],
})
export class AgentMessageDeliveryModule {}
