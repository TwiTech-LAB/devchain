import { Module } from '@nestjs/common';
import { ProvidersController } from './controllers/providers.controller';
import { StorageModule } from '../storage/storage.module';
import { McpModule } from '../mcp/mcp.module';
import { CoreModule } from '../core/core.module';
import { ProviderAdaptersModule } from './adapters';

@Module({
  imports: [StorageModule, McpModule, CoreModule, ProviderAdaptersModule],
  controllers: [ProvidersController],
})
export class ProvidersModule {}
