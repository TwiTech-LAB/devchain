import { Module, OnModuleInit } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { EventsCoreModule } from '../events/events-core.module';
import { SessionsModule } from '../sessions/sessions.module';
import { ProviderAdaptersModule } from '../providers/adapters';
import { SessionReaderAdapterFactory } from './adapters/session-reader-adapter.factory';
import { TranscriptPathValidator } from './services/transcript-path-validator.service';
import { TranscriptPersistenceListener } from './services/transcript-persistence.listener';
import { ClaudeSessionReaderAdapter } from './adapters/claude-session-reader.adapter';
import { CodexSessionReaderAdapter } from './adapters/codex-session-reader.adapter';
import { OpenCodeSessionReaderAdapter } from './adapters/opencode-session-reader.adapter';
import { AntigravitySessionReaderAdapter } from './adapters/antigravity-session-reader.adapter';
import { CopilotSessionReaderAdapter } from './adapters/copilot-session-reader.adapter';
import { PRICING_SERVICE } from './services/pricing.interface';
import { PricingService } from './services/pricing.service';
import { SessionReaderService } from './services/session-reader.service';
import {
  getTranscriptCacheConfig,
  SessionCacheService,
  TRANSCRIPT_CACHE_CONFIG,
} from './services/session-cache.service';
import { TranscriptWatcherService } from './services/transcript-watcher.service';
import { TranscriptWatcherRehydrator } from './services/transcript-watcher-rehydrator.service';
import { SubagentLocator } from './services/subagent-locator.service';
import { SubagentResolver } from './services/subagent-resolver.service';
import { SessionReaderController } from './controllers/session-reader.controller';
import { CodexProviderSessionIdBackfillService } from './services/codex-provider-session-id-backfill.service';
import { MetricsModule } from '../metrics/metrics.module';

@Module({
  imports: [StorageModule, EventsCoreModule, SessionsModule, ProviderAdaptersModule, MetricsModule],
  providers: [
    SessionReaderAdapterFactory,
    TranscriptPathValidator,
    TranscriptPersistenceListener,
    CodexProviderSessionIdBackfillService,
    ClaudeSessionReaderAdapter,
    CodexSessionReaderAdapter,
    OpenCodeSessionReaderAdapter,
    AntigravitySessionReaderAdapter,
    CopilotSessionReaderAdapter,
    { provide: PRICING_SERVICE, useClass: PricingService },
    SessionReaderService,
    { provide: TRANSCRIPT_CACHE_CONFIG, useFactory: getTranscriptCacheConfig },
    SessionCacheService,
    TranscriptWatcherService,
    TranscriptWatcherRehydrator,
    SubagentLocator,
    SubagentResolver,
  ],
  controllers: [SessionReaderController],
  exports: [
    SessionReaderAdapterFactory,
    TranscriptPathValidator,
    CodexProviderSessionIdBackfillService,
    ClaudeSessionReaderAdapter,
    CodexSessionReaderAdapter,
    OpenCodeSessionReaderAdapter,
    AntigravitySessionReaderAdapter,
    CopilotSessionReaderAdapter,
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
    private readonly opencodeAdapter: OpenCodeSessionReaderAdapter,
    private readonly antigravityAdapter: AntigravitySessionReaderAdapter,
    private readonly copilotAdapter: CopilotSessionReaderAdapter,
  ) {}

  onModuleInit() {
    this.adapterFactory.registerAdapter(this.claudeAdapter);
    this.adapterFactory.registerAdapter(this.codexAdapter);
    this.adapterFactory.registerAdapter(this.opencodeAdapter);
    this.adapterFactory.registerAdapter(this.antigravityAdapter);
    this.adapterFactory.registerAdapter(this.copilotAdapter);
  }
}
