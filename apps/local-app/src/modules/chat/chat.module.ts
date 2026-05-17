import { Module } from '@nestjs/common';
import { ChatService } from './services/chat.service';
import { ChatController } from './controllers/chat.controller';
import { ChatSettingsController } from './controllers/chat-settings.controller';
import { ChatSettingsService } from './services/chat-settings.service';
import { ChatSessionInviteService } from './services/chat-session-invite.service';
import { StorageModule } from '../storage/storage.module';
import { SettingsModule } from '../settings/settings.module';
import { SessionsReadModule } from '../sessions/sessions-read.module';
import { SessionsDeliveryModule } from '../sessions/sessions-delivery.module';
import { EventsCoreModule } from '../events/events-core.module';

@Module({
  imports: [
    EventsCoreModule,
    StorageModule,
    SettingsModule,
    SessionsReadModule,
    SessionsDeliveryModule,
  ],
  controllers: [ChatController, ChatSettingsController],
  providers: [ChatService, ChatSettingsService, ChatSessionInviteService],
  exports: [ChatService, ChatSettingsService, ChatSessionInviteService],
})
export class ChatModule {}
