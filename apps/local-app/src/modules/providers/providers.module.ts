import { Module } from '@nestjs/common';
import { ProvidersController } from './controllers/providers.controller';
import { StorageModule } from '../storage/storage.module';
import { McpModule } from '../mcp/mcp.module';
import { CoreModule } from '../core/core.module';
import { ProviderAdapterFactory } from './adapters';

@Module({
  imports: [StorageModule, McpModule, CoreModule],
  controllers: [ProvidersController],
  providers: [ProviderAdapterFactory],
  exports: [ProviderAdapterFactory],
})
export class ProvidersModule {}
