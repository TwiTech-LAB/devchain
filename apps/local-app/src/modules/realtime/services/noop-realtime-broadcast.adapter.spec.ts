import { NoopRealtimeBroadcastAdapter } from './noop-realtime-broadcast.adapter';

describe('NoopRealtimeBroadcastAdapter', () => {
  it('implements broadcastEvent as a no-op', () => {
    const adapter = new NoopRealtimeBroadcastAdapter();
    expect(() => adapter.broadcastEvent('topic', 'type', { data: 'test' })).not.toThrow();
  });

  it('satisfies the RealtimeBroadcaster interface', () => {
    const adapter = new NoopRealtimeBroadcastAdapter();
    expect(typeof adapter.broadcastEvent).toBe('function');
  });
});
