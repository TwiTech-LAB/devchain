import { Module } from '@nestjs/common';
import { ClaudeAdapter } from './claude.adapter';
import { CodexAdapter } from './codex.adapter';
import { GeminiAdapter } from './gemini.adapter';
import { ProviderAdapterFactory } from './provider-adapter.factory';

/**
 * ProviderAdaptersModule
 *
 * Encapsulates provider adapters and factory to break the circular dependency
 * between CoreModule and ProvidersModule. Both modules can import this module
 * without creating a dependency cycle.
 */
@Module({
  providers: [ClaudeAdapter, CodexAdapter, GeminiAdapter, ProviderAdapterFactory],
  exports: [ProviderAdapterFactory],
})
export class ProviderAdaptersModule {}
