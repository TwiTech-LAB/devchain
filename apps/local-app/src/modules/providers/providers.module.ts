import { Module } from '@nestjs/common';
import { ProvidersController } from './controllers/providers.controller';
import { ProviderModelsController } from './controllers/provider-models.controller';
import { StorageModule } from '../storage/storage.module';
import { McpModule } from '../mcp/mcp.module';
import { CoreNormalModule } from '../core/core-normal.module';
import { ProviderAdaptersModule } from './adapters';

@Module({
  imports: [StorageModule, McpModule, CoreNormalModule, ProviderAdaptersModule],
  controllers: [ProvidersController, ProviderModelsController],
})
export class ProvidersModule {}
