import { getHeaderTokens, getHeaderInputTotal, type HeaderTokenChunk } from './ai-group-enhancer';

// ---------------------------------------------------------------------------
// getHeaderInputTotal
// ---------------------------------------------------------------------------

describe('getHeaderInputTotal', () => {
  it('returns sum of input + cacheRead + cacheCreation from message.usage', () => {
    const chunk: HeaderTokenChunk = {
      messages: [
        {
          role: 'assistant',
          usage: { input: 10_000, output: 2_000, cacheRead: 5_000, cacheCreation: 3_000 },
        },
      ],
    };

    expect(getHeaderInputTotal(chunk)).toBe(18_000); // 10k + 5k + 3k
  });

  it('returns null when no assistant usage and no chunk.metrics', () => {
    const chunk: HeaderTokenChunk = {
      messages: [{ role: 'user' }],
    };

    expect(getHeaderInputTotal(chunk)).toBeNull();
  });

  it('falls back to chunk.metrics when no message.usage (metrics-fallback regression)', () => {
    const chunk: HeaderTokenChunk = {
      messages: [
        { role: 'assistant' }, // no usage field
      ],
      metrics: {
        inputTokens: 8_000,
        outputTokens: 1_500,
        cacheReadTokens: 4_000,
        cacheCreationTokens: 2_000,
      },
    };

    // Should use metrics: 8k + 4k + 2k = 14k
    expect(getHeaderInputTotal(chunk)).toBe(14_000);

    // Also verify getHeaderTokens returns the metrics-based values
    const tokens = getHeaderTokens(chunk);
    expect(tokens).toEqual({
      input: 8_000,
      output: 1_500,
      cacheRead: 4_000,
      cacheCreation: 2_000,
    });
  });
});
