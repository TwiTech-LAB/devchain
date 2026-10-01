import { Module } from '@nestjs/common';
import { SessionsModule } from './sessions.module';
import { SessionLifecycleFacade } from './services/session-lifecycle-facade.service';
import { ProjectWriteAdmissionModule } from '../remotes/admission/project-write-admission.module';

/**
 * Narrow facade module exposing session lifecycle (launch/restart/restore/
 * terminate) to consumers that must not pull the broad SessionsModule directly
 * (e.g. CloudTunnelModule / mobile chat).
 */
@Module({
  imports: [SessionsModule, ProjectWriteAdmissionModule],
  providers: [SessionLifecycleFacade],
  exports: [SessionLifecycleFacade],
})
export class SessionsLifecycleModule {}
