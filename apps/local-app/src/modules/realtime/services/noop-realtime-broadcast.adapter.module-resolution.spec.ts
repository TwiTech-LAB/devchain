import { Test } from '@nestjs/testing';
import { NoopRealtimeBroadcastAdapter } from './noop-realtime-broadcast.adapter';
import { REALTIME_BROADCASTER, type RealtimeBroadcaster } from '../ports/realtime-broadcaster.port';
import { TerminalGateway } from '../../terminal/gateways/terminal.gateway';

describe('NoopRealtimeBroadcastAdapter module resolution', () => {
  it('resolves REALTIME_BROADCASTER as NoopRealtimeBroadcastAdapter', async () => {
    const module = await Test.createTestingModule({
      providers: [
        NoopRealtimeBroadcastAdapter,
        { provide: REALTIME_BROADCASTER, useExisting: NoopRealtimeBroadcastAdapter },
      ],
    }).compile();

    const broadcaster = module.get<RealtimeBroadcaster>(REALTIME_BROADCASTER);
    expect(broadcaster).toBeInstanceOf(NoopRealtimeBroadcastAdapter);
  });

  it('TerminalGateway is NOT in the standalone-MCP composition', async () => {
    const module = await Test.createTestingModule({
      providers: [
        NoopRealtimeBroadcastAdapter,
        { provide: REALTIME_BROADCASTER, useExisting: NoopRealtimeBroadcastAdapter },
      ],
    }).compile();

    expect(() => module.get(TerminalGateway)).toThrow();
  });

  it('broadcastEvent does not throw (no-op behavior)', async () => {
    const module = await Test.createTestingModule({
      providers: [
        NoopRealtimeBroadcastAdapter,
        { provide: REALTIME_BROADCASTER, useExisting: NoopRealtimeBroadcastAdapter },
      ],
    }).compile();

    const broadcaster = module.get<RealtimeBroadcaster>(REALTIME_BROADCASTER);
    expect(() => broadcaster.broadcastEvent('topic', 'kind', {})).not.toThrow();
  });
});
