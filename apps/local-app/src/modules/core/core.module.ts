import { Module, forwardRef } from '@nestjs/common';
import { HealthController } from './controllers/health.controller';
import { PreflightController } from './controllers/preflight.controller';
import { PreflightService } from './services/preflight.service';
import { ProviderMcpEnsureService } from './services/provider-mcp-ensure.service';
import { StorageModule } from '../storage/storage.module';
import { McpModule } from '../mcp/mcp.module';
import { ProviderAdaptersModule } from '../providers/adapters';

@Module({
  imports: [StorageModule, forwardRef(() => McpModule), ProviderAdaptersModule],
  controllers: [HealthController, PreflightController],
  providers: [PreflightService, ProviderMcpEnsureService],
  exports: [PreflightService, ProviderMcpEnsureService],
})
export class CoreModule {}
