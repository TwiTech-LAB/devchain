import { Module } from '@nestjs/common';
import { REALTIME_BROADCASTER } from './ports/realtime-broadcaster.port';
import { RealtimeBroadcastService } from './services/realtime-broadcast.service';

@Module({
  providers: [
    RealtimeBroadcastService,
    { provide: REALTIME_BROADCASTER, useExisting: RealtimeBroadcastService },
  ],
  exports: [REALTIME_BROADCASTER, RealtimeBroadcastService],
})
export class RealtimeBroadcastModule {}
