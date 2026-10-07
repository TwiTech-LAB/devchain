import { sessionStoppedEvent } from './session.stopped';

describe('session.stopped event contract', () => {
  it('accepts the approved source and reason values', () => {
    expect(
      sessionStoppedEvent.schema.safeParse({
        sessionId: 'session-1',
        source: 'mobile-rpc',
        reason: 'restart',
      }).success,
    ).toBe(true);
  });
});
