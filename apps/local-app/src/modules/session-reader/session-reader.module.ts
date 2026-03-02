import { Module, OnModuleInit } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { EventsDomainModule } from '../events/events-domain.module';
import { SessionsModule } from '../sessions/sessions.module';
import { SessionReaderAdapterFactory } from './adapters/session-reader-adapter.factory';
import { TranscriptPathValidator } from './services/transcript-path-validator.service';
import { TranscriptPersistenceListener } from './services/transcript-persistence.listener';
import { ClaudeSessionReaderAdapter } from './adapters/claude-session-reader.adapter';
import { CodexSessionReaderAdapter } from './adapters/codex-session-reader.adapter';
import { GeminiSessionReaderAdapter } from './adapters/gemini-session-reader.adapter';
import { PRICING_SERVICE } from './services/pricing.interface';
import { PricingService } from './services/pricing.service';
import { SessionReaderService } from './services/session-reader.service';
import { SessionCacheService } from './services/session-cache.service';
import { TranscriptWatcherService } from './services/transcript-watcher.service';
import { SubagentLocator } from './services/subagent-locator.service';
import { SubagentResolver } from './services/subagent-resolver.service';
import { SessionReaderController } from './controllers/session-reader.controller';

@Module({
  imports: [StorageModule, EventsDomainModule, SessionsModule],
  providers: [
    SessionReaderAdapterFactory,
    TranscriptPathValidator,
    TranscriptPersistenceListener,
    ClaudeSessionReaderAdapter,
    CodexSessionReaderAdapter,
    GeminiSessionReaderAdapter,
    { provide: PRICING_SERVICE, useClass: PricingService },
    SessionReaderService,
    SessionCacheService,
    TranscriptWatcherService,
    SubagentLocator,
    SubagentResolver,
  ],
  controllers: [SessionReaderController],
  exports: [
    SessionReaderAdapterFactory,
    TranscriptPathValidator,
    ClaudeSessionReaderAdapter,
    CodexSessionReaderAdapter,
    GeminiSessionReaderAdapter,
    PRICING_SERVICE,
    SessionReaderService,
    SessionCacheService,
    TranscriptWatcherService,
    SubagentLocator,
    SubagentResolver,
  ],
})
export class SessionReaderModule implements OnModuleInit {
  constructor(
    private readonly adapterFactory: SessionReaderAdapterFactory,
    private readonly claudeAdapter: ClaudeSessionReaderAdapter,
    private readonly codexAdapter: CodexSessionReaderAdapter,
    private readonly geminiAdapter: GeminiSessionReaderAdapter,
  ) {}

  onModuleInit() {
    this.adapterFactory.registerAdapter(this.claudeAdapter);
    this.adapterFactory.registerAdapter(this.codexAdapter);
    this.adapterFactory.registerAdapter(this.geminiAdapter);
  }
}
