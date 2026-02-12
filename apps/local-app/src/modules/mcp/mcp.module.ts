import { Module, forwardRef } from '@nestjs/common';
import { McpService } from './services/mcp.service';
import { McpServerService } from './services/mcp-server.service';
import { McpProviderRegistrationService } from './services/mcp-provider-registration.service';
import { TerminalActivityService } from './services/terminal-activity.service';
import { McpGateway } from './gateways/mcp.gateway';
import { StorageModule } from '../storage/storage.module';
import { EventsModule } from '../events/events.module';
import { ChatModule } from '../chat/chat.module';
import { SessionsModule } from '../sessions/sessions.module';
import { TerminalModule } from '../terminal/terminal.module';
import { EpicsModule } from '../epics/epics.module';
import { SettingsModule } from '../settings/settings.module';
import { GuestsModule } from '../guests/guests.module';
import { ReviewsModule } from '../reviews/reviews.module';
import { ProviderAdaptersModule } from '../providers/adapters';
import { SkillsModule } from '../skills/skills.module';
import { McpHttpController } from './controllers/mcp-http.controller';
import { McpSdkController } from './controllers/mcp-sdk.controller';
import { McpTestController } from './controllers/mcp-test.controller';

@Module({
  imports: [
    StorageModule,
    forwardRef(() => EventsModule),
    forwardRef(() => ChatModule),
    forwardRef(() => SessionsModule),
    forwardRef(() => TerminalModule),
    forwardRef(() => EpicsModule),
    forwardRef(() => SettingsModule),
    forwardRef(() => GuestsModule),
    forwardRef(() => ReviewsModule),
    SkillsModule,
    ProviderAdaptersModule,
  ],
  controllers: [McpHttpController, McpSdkController, McpTestController],
  providers: [
    McpService,
    McpServerService,
    TerminalActivityService,
    McpGateway,
    McpProviderRegistrationService,
  ],
  exports: [McpService, TerminalActivityService, McpProviderRegistrationService],
})
export class McpModule {}
