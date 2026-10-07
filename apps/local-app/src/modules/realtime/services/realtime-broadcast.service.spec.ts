import { RealtimeBroadcastService } from './realtime-broadcast.service';

describe('RealtimeBroadcastService', () => {
  let service: RealtimeBroadcastService;

  beforeEach(() => {
    service = new RealtimeBroadcastService();
  });

  it('does not throw when broadcastEvent is called before setServer', () => {
    expect(() => service.broadcastEvent('topic', 'type', {})).not.toThrow();
  });

  it('emits envelope via server.emit after setServer', () => {
    const mockServer = { emit: jest.fn() };
    service.setServer(mockServer as never);

    service.broadcastEvent('session/s1', 'activity', { state: 'busy' });

    expect(mockServer.emit).toHaveBeenCalledTimes(1);
    expect(mockServer.emit).toHaveBeenCalledWith(
      'message',
      expect.objectContaining({
        topic: 'session/s1',
        type: 'activity',
        payload: { state: 'busy' },
        ts: expect.any(String),
      }),
    );
    const [, envelope] = mockServer.emit.mock.calls[0];
    expect(() => new Date(envelope.ts).toISOString()).not.toThrow();
  });
});
