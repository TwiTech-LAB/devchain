import { Module, forwardRef } from '@nestjs/common';
import { TmuxService } from './services/tmux.service';
import { TerminalSendCoordinatorService } from './services/terminal-send-coordinator.service';
import { TerminalStreamService } from './services/terminal-stream.service';
import { PtyService } from './services/pty.service';
import { TerminalGateway } from './gateways/terminal.gateway';
import { McpModule } from '../mcp/mcp.module';
import { EventsModule } from '../events/events.module';
import { SettingsModule } from '../settings/settings.module';
import { TerminalSeedService } from './services/terminal-seed.service';

@Module({
  imports: [forwardRef(() => EventsModule), forwardRef(() => McpModule), SettingsModule],
  providers: [
    TmuxService,
    TerminalStreamService,
    PtyService,
    TerminalGateway,
    TerminalSendCoordinatorService,
    TerminalSeedService,
  ],
  exports: [
    TmuxService,
    TerminalStreamService,
    PtyService,
    TerminalGateway,
    TerminalSendCoordinatorService,
    TerminalSeedService,
  ],
})
export class TerminalModule {}
