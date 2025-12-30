import { Module, forwardRef } from '@nestjs/common';
import { HealthController } from './controllers/health.controller';
import { PreflightController } from './controllers/preflight.controller';
import { PreflightService } from './services/preflight.service';
import { StorageModule } from '../storage/storage.module';
import { McpModule } from '../mcp/mcp.module';

@Module({
  imports: [StorageModule, forwardRef(() => McpModule)],
  controllers: [HealthController, PreflightController],
  providers: [PreflightService],
  exports: [PreflightService],
})
export class CoreModule {}
