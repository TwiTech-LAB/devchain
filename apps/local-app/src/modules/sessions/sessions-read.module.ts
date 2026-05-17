import { Module } from '@nestjs/common';
import { DbModule } from '../storage/db/db.module';
import { ActiveSessionLookup } from './services/active-session-lookup.service';

@Module({
  imports: [DbModule],
  providers: [ActiveSessionLookup],
  exports: [ActiveSessionLookup],
})
export class SessionsReadModule {}
