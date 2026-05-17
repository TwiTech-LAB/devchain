import { Module } from '@nestjs/common';
import { ClaudeAdapter } from './claude.adapter';
import { CodexAdapter } from './codex.adapter';
import { GeminiAdapter } from './gemini.adapter';
import { OpencodeAdapter } from './opencode.adapter';
import { ProviderAdapterFactory } from './provider-adapter.factory';
import { StorageModule } from '../../storage/storage.module';
import { GeminiTrustedFoldersModule } from '../../core/services/gemini-trusted-folders.module';

@Module({
  imports: [StorageModule, GeminiTrustedFoldersModule],
  providers: [ClaudeAdapter, CodexAdapter, GeminiAdapter, OpencodeAdapter, ProviderAdapterFactory],
  exports: [ProviderAdapterFactory],
})
export class ProviderAdaptersModule {}
