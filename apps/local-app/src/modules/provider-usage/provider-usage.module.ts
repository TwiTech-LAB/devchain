import { Module, type Type } from '@nestjs/common';
import { EventsCoreModule } from '../events/events-core.module';
import { ProviderCliVersionProbeModule } from '../providers/services/provider-cli-version-probe.module';
import { SettingsModule } from '../settings/settings.module';
import { SessionRowsModule } from '../storage/sessions/session-rows.module';
import { StorageModule } from '../storage/storage.module';
import { ProcessExecutorModule } from '../terminal/services/process-executor/process-executor.module';
import { AgyChecker } from './checkers/agy.checker';
import { ClaudeLoginChecker } from './checkers/claude-login.checker';
import { ClaudeTokenChecker } from './checkers/claude-token.checker';
import { CodexChecker } from './checkers/codex.checker';
import { ProviderUsageController } from './controllers/provider-usage.controller';
import { PROVIDER_USAGE_CHECKERS, type ProviderUsageChecker } from './provider-usage.types';
import { ProviderUsageAccountsService } from './services/provider-usage-accounts.service';
import { ProviderUsageService } from './services/provider-usage.service';

/** Add a checker here; an account whose kind has no checker reports `unsupported`. */
const CHECKERS: Type<ProviderUsageChecker>[] = [
  ClaudeLoginChecker,
  ClaudeTokenChecker,
  CodexChecker,
  AgyChecker,
];

@Module({
  imports: [
    StorageModule,
    SettingsModule,
    SessionRowsModule,
    ProcessExecutorModule,
    ProviderCliVersionProbeModule,
    EventsCoreModule,
  ],
  controllers: [ProviderUsageController],
  exports: [ProviderUsageService],
  providers: [
    ...CHECKERS,
    {
      provide: PROVIDER_USAGE_CHECKERS,
      useFactory: (...checkers: ProviderUsageChecker[]) => checkers,
      inject: CHECKERS,
    },
    ProviderUsageAccountsService,
    ProviderUsageService,
  ],
})
export class ProviderUsageModule {}
