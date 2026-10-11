import { SessionRowsModule } from '../storage/sessions/session-rows.module';
import { Module } from '@nestjs/common';
import { ProviderAdaptersModule } from '../providers/adapters/provider-adapters.module';
import { RuntimeContextCaptureModule } from '../runtime-context-capture/runtime-context-capture.module';
import { DbModule } from '../storage/db/db.module';
import { SessionTerminalRuntimeService } from './session-terminal-runtime.service';

@Module({
  imports: [SessionRowsModule, DbModule, ProviderAdaptersModule, RuntimeContextCaptureModule],
  providers: [SessionTerminalRuntimeService],
  exports: [SessionTerminalRuntimeService],
})
export class SessionTerminalRuntimeModule {}
