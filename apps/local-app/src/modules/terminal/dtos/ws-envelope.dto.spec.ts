import {
  FullHistoryPayloadSchema,
  SubscribedPayloadSchema,
  TerminalResyncAbortPayloadSchema,
  TerminalResyncCompletePayloadSchema,
  TerminalResyncRequestPayloadSchema,
  TerminalSeedPayloadSchema,
  type TerminalResyncAbortPayload,
  type TerminalResyncCompletePayload,
  type TerminalResyncRequestPayload,
} from './ws-envelope.dto';

describe('terminal subscribe/full_history domain contract', () => {
  it('requires the subscribed ack to carry a non-empty sequence-domain epoch', () => {
    const base = {
      sessionId: 'session-a',
      currentSequence: 12,
      replayStatus: 'covered' as const,
      historyRefreshable: true,
    };
    expect(SubscribedPayloadSchema.safeParse({ ...base, sequenceEpoch: 'epoch-a' }).success).toBe(
      true,
    );
    expect(SubscribedPayloadSchema.safeParse(base).success).toBe(false);
    expect(SubscribedPayloadSchema.safeParse({ ...base, sequenceEpoch: '' }).success).toBe(false);
  });

  it('carries the sequence-domain epoch on full_history and rejects an empty one', () => {
    expect(
      FullHistoryPayloadSchema.safeParse({
        history: 'output',
        capturedSequence: 5,
        sequenceEpoch: 'epoch-a',
      }).success,
    ).toBe(true);
    // Optional on the wire (older snapshots omit it), but never empty when present.
    expect(FullHistoryPayloadSchema.safeParse({ history: 'output' }).success).toBe(true);
    expect(
      FullHistoryPayloadSchema.safeParse({ history: 'output', sequenceEpoch: '' }).success,
    ).toBe(false);
  });
});

describe('terminal resync request contract', () => {
  it('accepts the one client-overflow request shape shared by UI and gateway', () => {
    const payload = {
      sessionId: 'session-a',
      reason: 'client_write_overflow',
    } satisfies TerminalResyncRequestPayload;

    expect(TerminalResyncRequestPayloadSchema.parse(payload)).toEqual(payload);
  });

  it('rejects client-invented recovery metadata and unknown reasons', () => {
    expect(
      TerminalResyncRequestPayloadSchema.safeParse({
        sessionId: 'session-a',
        reason: 'client_write_overflow',
        recoveryEpoch: 7,
      }).success,
    ).toBe(false);
    expect(
      TerminalResyncRequestPayloadSchema.safeParse({
        sessionId: 'session-a',
        reason: 'transport_gap',
      }).success,
    ).toBe(false);
  });
});

describe('terminal recovery watermark contract', () => {
  const seedBase = { data: 'seed', chunk: 0, totalChunks: 1 };

  it('accepts the full domain-scoped seed watermark triple', () => {
    expect(
      TerminalSeedPayloadSchema.safeParse({
        ...seedBase,
        sequenceEpoch: 'epoch-a',
        recoveryEpoch: 3,
        capturedSequence: 19,
      }).success,
    ).toBe(true);
  });

  it('accepts a non-recovery seed carrying none of the watermark fields', () => {
    expect(TerminalSeedPayloadSchema.safeParse(seedBase).success).toBe(true);
  });

  it('rejects any partial watermark — the epoch/recovery/captured triple is all-or-nothing', () => {
    const partials = [
      { recoveryEpoch: 3, capturedSequence: 19 }, // missing sequenceEpoch
      { sequenceEpoch: 'epoch-a', capturedSequence: 19 }, // missing recoveryEpoch
      { sequenceEpoch: 'epoch-a', recoveryEpoch: 3 }, // missing capturedSequence
      { sequenceEpoch: 'epoch-a' },
      { recoveryEpoch: 3 },
    ];
    for (const partial of partials) {
      expect(TerminalSeedPayloadSchema.safeParse({ ...seedBase, ...partial }).success).toBe(false);
    }
  });

  it('keeps resync completion strict and accepts the optional domain epoch', () => {
    const payload = {
      sessionId: 'session-a',
      sequenceEpoch: 'epoch-a',
      recoveryEpoch: 3,
      capturedSequence: 19,
    } satisfies TerminalResyncCompletePayload;

    expect(TerminalResyncCompletePayloadSchema.parse(payload)).toEqual(payload);
    // sequenceEpoch is optional on the wire (the gateway enforces the pair); the base still parses.
    expect(
      TerminalResyncCompletePayloadSchema.safeParse({
        sessionId: 'session-a',
        recoveryEpoch: 3,
        capturedSequence: 19,
      }).success,
    ).toBe(true);
    expect(
      TerminalResyncCompletePayloadSchema.safeParse({ ...payload, acknowledgedFrames: 4 }).success,
    ).toBe(false);
    expect(
      TerminalResyncCompletePayloadSchema.safeParse({ ...payload, sequenceEpoch: '' }).success,
    ).toBe(false);
  });
});

describe('terminal recovery abort contract', () => {
  it('accepts a session-scoped nonnegative recovery epoch with the optional domain epoch', () => {
    const payload = {
      sessionId: 'session-a',
      sequenceEpoch: 'epoch-a',
      recoveryEpoch: 3,
    } satisfies TerminalResyncAbortPayload;

    expect(TerminalResyncAbortPayloadSchema.parse(payload)).toEqual(payload);
    // sequenceEpoch is optional on the wire (the gateway enforces the pair); the base still parses.
    expect(
      TerminalResyncAbortPayloadSchema.safeParse({ sessionId: 'session-a', recoveryEpoch: 3 })
        .success,
    ).toBe(true);
    expect(
      TerminalResyncAbortPayloadSchema.safeParse({ ...payload, capturedSequence: 19 }).success,
    ).toBe(false);
    expect(
      TerminalResyncAbortPayloadSchema.safeParse({ ...payload, recoveryEpoch: -1 }).success,
    ).toBe(false);
    expect(TerminalResyncAbortPayloadSchema.safeParse({ ...payload, sessionId: '' }).success).toBe(
      false,
    );
  });
});
