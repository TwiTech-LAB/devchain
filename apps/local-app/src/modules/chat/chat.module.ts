import { Module, forwardRef } from '@nestjs/common';
import { ChatService } from './services/chat.service';
import { ChatController } from './controllers/chat.controller';
import { ChatSettingsController } from './controllers/chat-settings.controller';
import { ChatSettingsService } from './services/chat-settings.service';
import { StorageModule } from '../storage/storage.module';
import { SessionsModule } from '../sessions/sessions.module';

@Module({
  imports: [StorageModule, forwardRef(() => SessionsModule)],
  controllers: [ChatController, ChatSettingsController],
  providers: [ChatService, ChatSettingsService],
  exports: [ChatService],
})
export class ChatModule {}
