import { Module } from '@nestjs/common';
import { ClaudeAdapter } from './claude.adapter';
import { CodexAdapter } from './codex.adapter';
import { OpencodeAdapter } from './opencode.adapter';
import { AntigravityAdapter } from './antigravity.adapter';
import { CopilotAdapter } from './copilot.adapter';
import { ProviderAdapterFactory } from './provider-adapter.factory';
import { StorageModule } from '../../storage/storage.module';
import { AntigravityTrustedWorkspacesModule } from '../../core/services/antigravity-trusted-workspaces.module';
import { CopilotTrustedFoldersModule } from '../../core/services/copilot-trusted-folders.module';
import { CopilotAuthProbeModule } from '../../core/services/copilot-auth-probe.module';

@Module({
  imports: [
    StorageModule,
    AntigravityTrustedWorkspacesModule,
    CopilotTrustedFoldersModule,
    CopilotAuthProbeModule,
  ],
  providers: [
    ClaudeAdapter,
    CodexAdapter,
    OpencodeAdapter,
    AntigravityAdapter,
    CopilotAdapter,
    ProviderAdapterFactory,
  ],
  exports: [ProviderAdapterFactory],
})
export class ProviderAdaptersModule {}
