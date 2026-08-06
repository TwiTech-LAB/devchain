import { Module, forwardRef } from '@nestjs/common';
import { McpService } from './services/mcp.service';
import { McpServerService } from './services/mcp-server.service';
import { McpGateway } from './gateways/mcp.gateway';
import { StorageModule } from '../storage/storage.module';
import { EventsCoreModule } from '../events/events-core.module';
import { ChatModule } from '../chat/chat.module';
import { SessionsModule } from '../sessions/sessions.module';
import { TerminalModule } from '../terminal/terminal.module';
import { EpicsModule } from '../epics/epics.module';
import { SettingsModule } from '../settings/settings.module';
import { GuestsModule } from '../guests/guests.module';
import { ReviewsModule } from '../reviews/reviews.module';
import { SkillsModule } from '../skills/skills.module';
import { TeamsModule } from '../teams/teams.module';
import { AgentMessageDeliveryModule } from '../agent-message-delivery/agent-message-delivery.module';
import { McpHttpController } from './controllers/mcp-http.controller';
import { McpSdkController } from './controllers/mcp-sdk.controller';
import { McpTestController } from './controllers/mcp-test.controller';
import { RealtimeBroadcastModule } from '../realtime/realtime-broadcast.module';
import { ProjectCommunicationModule } from '../project-communication/project-communication.module';

@Module({
  imports: [
    StorageModule,
    EventsCoreModule,
    RealtimeBroadcastModule,
    forwardRef(() => ChatModule),
    forwardRef(() => SessionsModule),
    TerminalModule,
    forwardRef(() => EpicsModule),
    forwardRef(() => SettingsModule),
    forwardRef(() => GuestsModule),
    forwardRef(() => ReviewsModule),
    SkillsModule,
    forwardRef(() => TeamsModule),
    forwardRef(() => AgentMessageDeliveryModule),
    ProjectCommunicationModule,
  ],
  controllers: [McpHttpController, McpSdkController, McpTestController],
  providers: [McpService, McpServerService, McpGateway],
  exports: [McpService],
})
export class McpFullModule {}
