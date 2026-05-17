import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { RealtimeBroadcastModule } from './realtime-broadcast.module';
import { REALTIME_BROADCASTER, type RealtimeBroadcaster } from './ports/realtime-broadcaster.port';
import { RealtimeBroadcastService } from './services/realtime-broadcast.service';

@Injectable()
class RealtimeServerBinderProbe {
  constructor(readonly realtimeBroadcast: RealtimeBroadcastService) {}
}

describe('RealtimeBroadcastModule', () => {
  it('compiles standalone and resolves REALTIME_BROADCASTER', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [RealtimeBroadcastModule],
    }).compile();

    const broadcaster = moduleRef.get<RealtimeBroadcaster>(REALTIME_BROADCASTER);
    expect(broadcaster).toBeInstanceOf(RealtimeBroadcastService);

    await moduleRef.close();
  });

  it('exports the concrete service for gateway server binding', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [RealtimeBroadcastModule],
      providers: [RealtimeServerBinderProbe],
    }).compile();

    const probe = moduleRef.get(RealtimeServerBinderProbe);
    const emit = jest.fn();
    probe.realtimeBroadcast.setServer({ emit } as unknown as Parameters<
      RealtimeBroadcastService['setServer']
    >[0]);
    probe.realtimeBroadcast.broadcastEvent('events/log', 'event.created', { ok: true });

    expect(emit).toHaveBeenCalledWith(
      'message',
      expect.objectContaining({
        topic: 'events/log',
        type: 'event.created',
        payload: { ok: true },
      }),
    );

    await moduleRef.close();
  });
});
