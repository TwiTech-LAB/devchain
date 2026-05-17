import { Module } from '@nestjs/common';
import { PreflightController } from './controllers/preflight.controller';
import { PreflightService } from './services/preflight.service';
import { GeminiTrustedFoldersModule } from './services/gemini-trusted-folders.module';
import { StorageModule } from '../storage/storage.module';
import { ProvidersModule } from '../providers/providers.module';
import { ProviderAdaptersModule } from '../providers/adapters';
import { ProcessExecutorModule } from '../terminal/services/process-executor/process-executor.module';

@Module({
  imports: [
    StorageModule,
    ProvidersModule,
    ProviderAdaptersModule,
    ProcessExecutorModule,
    GeminiTrustedFoldersModule,
  ],
  controllers: [PreflightController],
  providers: [PreflightService],
  exports: [PreflightService, GeminiTrustedFoldersModule],
})
export class CoreNormalModule {}
