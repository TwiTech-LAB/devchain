import { RemoteApiKeyModule } from '../remotes/auth/remote-api-key.module';
import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { ProviderAdaptersModule } from '../providers/adapters/provider-adapters.module';
import { ProviderAuthController } from './provider-auth.controller';
import { ProviderAuthVaultService } from './provider-auth-vault.service';
import { ProviderAuthGeneratorService } from './provider-auth-generator.service';
import { ProviderAuthWatcherService } from './provider-auth-watcher.service';
import { ProviderAuthWritebackService } from './provider-auth-writeback.service';
import { ProviderAuthReleaseService } from './provider-auth-release.service';
import { TerminalModule } from '../terminal/terminal.module';
import { ProcessExecutorModule } from '../terminal/services/process-executor/process-executor.module';

@Module({
  imports: [
    RemoteApiKeyModule,
    StorageModule,
    ProviderAdaptersModule,
    TerminalModule,
    ProcessExecutorModule,
  ],
  controllers: [ProviderAuthController],
  providers: [
    ProviderAuthVaultService,
    ProviderAuthGeneratorService,
    ProviderAuthWatcherService,
    ProviderAuthWritebackService,
    ProviderAuthReleaseService,
  ],
  exports: [
    ProviderAuthVaultService,
    ProviderAuthGeneratorService,
    // The watcher backs the host's families route (remotes module) and the
    // writeback service is injected by the health poll and the remote delete.
    ProviderAuthWatcherService,
    ProviderAuthWritebackService,
  ],
})
export class ProviderAuthModule {}
