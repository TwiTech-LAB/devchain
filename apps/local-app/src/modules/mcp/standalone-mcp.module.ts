import { Module } from '@nestjs/common';
import { McpService } from './services/mcp.service';
import { McpServerService } from './services/mcp-server.service';
import { McpGateway } from './gateways/mcp.gateway';
import { StorageModule } from '../storage/storage.module';
import { REALTIME_BROADCASTER } from '../realtime/ports/realtime-broadcaster.port';
import { NoopRealtimeBroadcastAdapter } from '../realtime/services/noop-realtime-broadcast.adapter';
import { RealtimeBroadcastModule } from '../realtime/realtime-broadcast.module';
import { McpHttpController } from './controllers/mcp-http.controller';
import { McpSdkController } from './controllers/mcp-sdk.controller';

@Module({
  imports: [StorageModule, RealtimeBroadcastModule],
  controllers: [McpHttpController, McpSdkController],
  providers: [
    McpService,
    McpServerService,
    McpGateway,
    { provide: REALTIME_BROADCASTER, useClass: NoopRealtimeBroadcastAdapter },
  ],
  exports: [McpService],
})
export class StandaloneMcpModule {}
