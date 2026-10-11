import { SessionRowsModule } from '../storage/sessions/session-rows.module';
import { Module } from '@nestjs/common';
import { ActiveSessionLookup } from './services/active-session-lookup.service';

@Module({
  imports: [SessionRowsModule],
  providers: [ActiveSessionLookup],
  exports: [ActiveSessionLookup],
})
export class SessionsReadModule {}
