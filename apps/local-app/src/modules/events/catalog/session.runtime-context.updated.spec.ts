import { sessionRuntimeContextUpdatedEvent } from './session.runtime-context.updated';

describe('session.runtime-context.updated catalog entry', () => {
  it('accepts only content-free session routing metadata', () => {
    expect(sessionRuntimeContextUpdatedEvent.schema.parse({ sessionId: 'session-1' })).toEqual({
      sessionId: 'session-1',
    });

    expect(() =>
      sessionRuntimeContextUpdatedEvent.schema.parse({
        sessionId: 'session-1',
        modelId: 'claude-sonnet-4-6',
        contextWindowTokens: 1_000_000,
      }),
    ).toThrow();
  });
});
