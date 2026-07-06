import { Module } from '@nestjs/common';
import { SessionsModule } from './sessions.module';
import { SessionsMessageLogReadFacade } from './services/sessions-message-log-read.facade';

/**
 * NARROW read facade module for the in-memory message log. Imports
 * `SessionsModule` (for `SessionsMessagePoolService`) but exports ONLY
 * {@link SessionsMessageLogReadFacade} — the pool service is deliberately NOT
 * re-exported (a guard spec asserts this).
 *
 * `CloudTunnelModule` imports THIS module — not `SessionsModule` wholesale — so
 * the tunnel gains pending-message reads without depending on the heavy pool
 * service, mirroring `SessionsDeliveryModule` / `TerminalViewportModule`.
 */
@Module({
  imports: [SessionsModule],
  providers: [SessionsMessageLogReadFacade],
  exports: [SessionsMessageLogReadFacade],
})
export class SessionsMessageLogReadModule {}
