import { sessionTranscriptUpdatedEvent } from './session.transcript.updated';

const metrics = {
  totalTokens: 10,
  inputTokens: 4,
  outputTokens: 6,
  costUsd: 0.01,
  messageCount: 2,
};

describe('session.transcript.updated catalog entry', () => {
  it('accepts a body-bearing incremental delta', () => {
    expect(
      sessionTranscriptUpdatedEvent.schema.parse({
        kind: 'delta',
        sessionId: 'session-1',
        transcriptPath: '/tmp/transcript.jsonl',
        newMessageCount: 1,
        metrics,
        cursor: 'cursor-2',
        prevCursor: 'cursor-1',
        replaceFromChunkIndex: 1,
        newChunkIds: ['chunk-1'],
        totalChunkCount: 2,
        deltaChunks: [{ id: 'chunk-1' }],
        deltaMessages: [{ id: 'message-2' }],
      }),
    ).toMatchObject({ kind: 'delta', cursor: 'cursor-2' });
  });

  it('accepts a cursor-free full-refetch action for an unsafe generation', () => {
    const parsed = sessionTranscriptUpdatedEvent.schema.parse({
      kind: 'full-refetch-required',
      sessionId: 'session-1',
      transcriptPath: '/tmp/transcript.jsonl',
      sourceChangeKind: 'file-replacement',
    });

    expect(parsed).toEqual({
      kind: 'full-refetch-required',
      sessionId: 'session-1',
      transcriptPath: '/tmp/transcript.jsonl',
      sourceChangeKind: 'file-replacement',
    });
    expect(parsed).not.toHaveProperty('cursor');
    expect(parsed).not.toHaveProperty('deltaChunks');
    expect(parsed).not.toHaveProperty('deltaMessages');
  });

  it('rejects a full-refetch action that carries a cursor or partial body', () => {
    expect(() =>
      sessionTranscriptUpdatedEvent.schema.parse({
        kind: 'full-refetch-required',
        sessionId: 'session-1',
        transcriptPath: '/tmp/transcript.jsonl',
        sourceChangeKind: 'same-file-rewrite',
        cursor: 'must-not-be-adopted',
        deltaChunks: [],
      }),
    ).toThrow();
  });
});
