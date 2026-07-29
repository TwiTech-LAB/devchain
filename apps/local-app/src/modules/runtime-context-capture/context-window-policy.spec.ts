import {
  CONTEXT_WINDOW_ENV_KEY,
  parseContextWindowEnv,
  resolveContextWindow,
} from './context-window-policy';

describe('context-window policy', () => {
  describe('parseContextWindowEnv', () => {
    it.each([undefined, null])('returns absent for %s', (value) => {
      expect(parseContextWindowEnv(value)).toEqual({ kind: 'absent' });
    });

    it.each([
      ['1', 1],
      ['001000000', 1_000_000],
      ['10000000', 10_000_000],
    ])('parses bounded positive integer %s', (value, contextWindowTokens) => {
      expect(parseContextWindowEnv(value)).toEqual({
        kind: 'valid',
        contextWindowTokens,
      });
    });

    it.each(['', '0', '-1', '+1', '1.5', '1e6', ' 1000000', '1000000 '])(
      'rejects malformed or non-positive value %j',
      (value) => {
        expect(parseContextWindowEnv(value)).toEqual({
          kind: 'invalid',
          reason: 'not-positive-integer',
        });
      },
    );

    it.each(['10000001', '9007199254740992'])('rejects overflow value %s', (value) => {
      expect(parseContextWindowEnv(value)).toMatchObject({ kind: 'invalid' });
    });

    it('uses the canonical singular token key', () => {
      expect(CONTEXT_WINDOW_ENV_KEY).toBe('DEVCHAIN_CONTEXT_WINDOW_TOKENS');
    });
  });

  describe('resolveContextWindow', () => {
    const base = {
      primaryModel: 'claude-sonnet-4-6',
      configuredOverride: null,
      claudeCapture: null,
      providerReportedContextWindowTokens: null,
      catalogContextWindowTokens: 1_000_000,
    };

    it('uses an exact model-matched configured override before every other source', () => {
      expect(
        resolveContextWindow({
          ...base,
          configuredOverride: {
            modelId: 'claude-sonnet-4-6',
            contextWindowTokens: 750_000,
          },
          claudeCapture: {
            modelId: 'claude-sonnet-4-6',
            contextWindowTokens: 900_000,
          },
        }),
      ).toEqual({ source: 'configured', contextWindowTokens: 750_000 });
    });

    it.each([
      ['opus', 'claude-opus-5'],
      ['sonnet[1m]', 'claude-sonnet-4-6'],
      ['anthropic/haiku', 'claude-haiku-4-5'],
      ['anthropic/claude-opus-5', 'claude-opus-5'],
    ])(
      'matches configured selector %s to provider-resolved primary model %s',
      (configuredModel, primaryModel) => {
        expect(
          resolveContextWindow({
            ...base,
            primaryModel,
            configuredOverride: {
              modelId: configuredModel,
              contextWindowTokens: 500_000,
            },
            claudeCapture: {
              modelId: primaryModel,
              contextWindowTokens: 1_000_000,
            },
          }),
        ).toEqual({ source: 'configured', contextWindowTokens: 500_000 });
      },
    );

    it('falls through a configured-model mismatch to exact Claude capture', () => {
      expect(
        resolveContextWindow({
          ...base,
          configuredOverride: {
            modelId: 'claude-opus-4-6',
            contextWindowTokens: 750_000,
          },
          claudeCapture: {
            modelId: 'claude-sonnet-4-6',
            contextWindowTokens: 900_000,
          },
        }),
      ).toEqual({ source: 'claude-capture', contextWindowTokens: 900_000 });
    });

    it('uses a provider-reported window before the model catalog', () => {
      expect(
        resolveContextWindow({
          ...base,
          primaryModel: 'gpt-5.6-sol',
          providerReportedContextWindowTokens: 258_400,
          catalogContextWindowTokens: 1_050_000,
        }),
      ).toEqual({ source: 'provider-reported', contextWindowTokens: 258_400 });
    });

    it('keeps an exact configured override above a provider-reported window', () => {
      expect(
        resolveContextWindow({
          ...base,
          primaryModel: 'gpt-5.6-sol',
          configuredOverride: {
            modelId: 'gpt-5.6-sol',
            contextWindowTokens: 500_000,
          },
          providerReportedContextWindowTokens: 258_400,
          catalogContextWindowTokens: 1_050_000,
        }),
      ).toEqual({ source: 'configured', contextWindowTokens: 500_000 });
    });

    it('falls through mismatched live values to the catalog', () => {
      expect(
        resolveContextWindow({
          ...base,
          claudeCapture: {
            modelId: 'claude-opus-4-6',
            contextWindowTokens: 900_000,
          },
        }),
      ).toEqual({ source: 'catalog', contextWindowTokens: 1_000_000 });
    });

    it('uses the conservative fallback only when the model is unknown', () => {
      expect(
        resolveContextWindow({
          ...base,
          primaryModel: 'custom/new-model',
          catalogContextWindowTokens: null,
        }),
      ).toEqual({ source: 'unknown-fallback', contextWindowTokens: 200_000 });
    });
  });
});
