import { Module } from '@nestjs/common';
import { SessionsModule } from './sessions.module';
import { SessionLifecycleFacade } from './services/session-lifecycle-facade.service';
import { StorageModule } from '../storage/storage.module';

/**
 * Narrow facade module exposing session lifecycle (launch/restart/restore/
 * terminate) to consumers that must not pull the broad SessionsModule directly
 * (e.g. CloudTunnelModule / mobile chat).
 */
@Module({
  imports: [SessionsModule, StorageModule],
  providers: [SessionLifecycleFacade],
  exports: [SessionLifecycleFacade],
})
export class SessionsLifecycleModule {}
