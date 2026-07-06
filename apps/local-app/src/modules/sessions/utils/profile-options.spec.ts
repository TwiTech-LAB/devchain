import {
  parseProfileOptions,
  ProfileOptionsError,
  injectModelOverride,
  rewriteModelTo1m,
  extractModelFromArgs,
  stripFlag,
} from './profile-options';

describe('parseProfileOptions', () => {
  it('returns empty array for empty input', () => {
    expect(parseProfileOptions(undefined)).toEqual([]);
    expect(parseProfileOptions(null)).toEqual([]);
    expect(parseProfileOptions('')).toEqual([]);
  });

  it('splits on whitespace', () => {
    expect(parseProfileOptions('--model sonnet --max-tokens 4000')).toEqual([
      '--model',
      'sonnet',
      '--max-tokens',
      '4000',
    ]);
  });

  it('honors quoted arguments', () => {
    expect(parseProfileOptions('--prompt \'Hello World\' "quoted value"')).toEqual([
      '--prompt',
      'Hello World',
      'quoted value',
    ]);
  });

  it('allows escaped spaces and quotes', () => {
    expect(parseProfileOptions('--flag\\ value "double\\"quote"')).toEqual([
      '--flag value',
      'double"quote',
    ]);
  });

  it('rejects control characters', () => {
    expect(() => parseProfileOptions('bad\nvalue')).toThrow(ProfileOptionsError);
  });

  it('rejects unterminated quotes', () => {
    expect(() => parseProfileOptions("--model 'unfinished")).toThrow(ProfileOptionsError);
  });
});

describe('stripFlag', () => {
  it('removes the two-token `--flag value` form', () => {
    expect(stripFlag(['--effort', 'high', '--verbose'], '--effort')).toEqual(['--verbose']);
  });

  it('removes the single-token `--flag=value` form', () => {
    expect(stripFlag(['--effort=high', '--verbose'], '--effort')).toEqual(['--verbose']);
  });

  it('removes every occurrence (both forms) in one pass', () => {
    expect(
      stripFlag(['--effort', 'low', '-x', '--effort=high', '--effort', 'max'], '--effort'),
    ).toEqual(['-x']);
  });

  it('leaves args untouched when the flag is absent (byte-identical)', () => {
    const args = ['--model', 'opus', '--verbose'];
    expect(stripFlag(args, '--effort')).toEqual(args);
  });

  it('does not strip flags that merely share a prefix', () => {
    // `--effort-budget` must survive a strip of `--effort`.
    expect(stripFlag(['--effort-budget', '5', '--effort', 'high'], '--effort')).toEqual([
      '--effort-budget',
      '5',
    ]);
  });

  it('drops a dangling flag with no following value', () => {
    expect(stripFlag(['--verbose', '--effort'], '--effort')).toEqual(['--verbose']);
  });
});

describe('injectModelOverride', () => {
  it.each([
    {
      args: [] as string[],
      model: 'openai/gpt-4.1',
      expected: ['--model', 'openai/gpt-4.1'],
    },
    {
      args: ['--verbose'],
      model: 'openai/gpt-4.1',
      expected: ['--model', 'openai/gpt-4.1', '--verbose'],
    },
    {
      args: ['--model', 'old'],
      model: 'new',
      expected: ['--model', 'new'],
    },
    {
      args: ['-m', 'old'],
      model: 'new',
      expected: ['--model', 'new'],
    },
    {
      args: ['--model=old'],
      model: 'new',
      expected: ['--model', 'new'],
    },
    {
      args: ['-m=old'],
      model: 'new',
      expected: ['--model', 'new'],
    },
    {
      args: ['--model', 'a', '-m', 'b'],
      model: 'c',
      expected: ['--model', 'c'],
    },
    {
      args: ['--verbose', '--model', 'old', '--flag'],
      model: 'new',
      expected: ['--model', 'new', '--verbose', '--flag'],
    },
  ])('rewrites model flags for $args with override $model', ({ args, model, expected }) => {
    expect(injectModelOverride(args, model)).toEqual(expected);
  });

  it('handles model flag without trailing value', () => {
    expect(injectModelOverride(['--verbose', '-m'], 'new-model')).toEqual([
      '--model',
      'new-model',
      '--verbose',
    ]);
  });

  it('does not mutate input array', () => {
    const args = ['--model', 'old-model', '--foo', 'bar'];
    const snapshot = [...args];

    const result = injectModelOverride(args, 'new-model');

    expect(args).toEqual(snapshot);
    expect(result).not.toBe(args);
  });
});

describe('rewriteModelTo1m', () => {
  it.each([
    {
      desc: 'shorthand opus',
      args: ['--model', 'opus'],
      expected: ['--model', 'opus[1m]'],
    },
    {
      desc: 'shorthand sonnet unchanged',
      args: ['--model', 'sonnet'],
      expected: ['--model', 'sonnet'],
    },
    {
      desc: 'full ID opus',
      args: ['--model', 'claude-opus-4-1'],
      expected: ['--model', 'opus[1m]'],
    },
    {
      desc: 'full ID sonnet unchanged',
      args: ['--model', 'claude-sonnet-4-5'],
      expected: ['--model', 'claude-sonnet-4-5'],
    },
    {
      desc: 'unknown model unchanged',
      args: ['--model', 'mistral-large'],
      expected: ['--model', 'mistral-large'],
    },
    {
      desc: 'no model flag defaults to opus[1m]',
      args: [],
      expected: ['--model', 'opus[1m]'],
    },
    {
      desc: 'no model flag with other args',
      args: ['--verbose', '--flag'],
      expected: ['--model', 'opus[1m]', '--verbose', '--flag'],
    },
    {
      desc: 'short flag -m opus',
      args: ['-m', 'opus'],
      expected: ['--model', 'opus[1m]'],
    },
    {
      desc: 'short flag -m sonnet unchanged',
      args: ['-m', 'claude-sonnet-4-5'],
      expected: ['--model', 'claude-sonnet-4-5'],
    },
    {
      desc: '--model=opus form',
      args: ['--model=opus'],
      expected: ['--model', 'opus[1m]'],
    },
    {
      desc: '-m=sonnet form unchanged',
      args: ['-m=sonnet'],
      expected: ['--model', 'sonnet'],
    },
    {
      desc: 'idempotent opus[1m]',
      args: ['--model', 'opus[1m]'],
      expected: ['--model', 'opus[1m]'],
    },
    {
      desc: 'idempotent sonnet[1m]',
      args: ['--model', 'sonnet[1m]'],
      expected: ['--model', 'sonnet[1m]'],
    },
    {
      desc: 'preserves surrounding args',
      args: ['--verbose', '--model', 'opus', '--flag'],
      expected: ['--verbose', '--model', 'opus[1m]', '--flag'],
    },
    {
      desc: 'preserves claude-opus-4-6[1m] full ID verbatim',
      args: ['--model', 'claude-opus-4-6[1m]'],
      expected: ['--model', 'claude-opus-4-6[1m]'],
    },
    {
      desc: 'preserves claude-opus-4-7[1m] full ID verbatim',
      args: ['--model', 'claude-opus-4-7[1m]'],
      expected: ['--model', 'claude-opus-4-7[1m]'],
    },
    {
      desc: 'preserves claude-sonnet-4-6[1m] full ID verbatim',
      args: ['--model', 'claude-sonnet-4-6[1m]'],
      expected: ['--model', 'claude-sonnet-4-6[1m]'],
    },
    {
      desc: 'preserves claude-opus-4-6[1m] via --model= equals form',
      args: ['--model=claude-opus-4-6[1m]'],
      expected: ['--model', 'claude-opus-4-6[1m]'],
    },
    {
      desc: 'preserves claude-opus-4-6[1m] via -m= equals form',
      args: ['-m=claude-opus-4-6[1m]'],
      expected: ['--model', 'claude-opus-4-6[1m]'],
    },
    {
      desc: 'uppercase [1M] falls through to normalization (not preserved)',
      args: ['--model', 'CLAUDE-OPUS-4-6[1M]'],
      expected: ['--model', 'opus[1m]'],
    },
  ])('$desc: $args', ({ args, expected }) => {
    expect(rewriteModelTo1m(args)).toEqual(expected);
  });

  it('handles model flag without trailing value', () => {
    expect(rewriteModelTo1m(['--verbose', '-m'])).toEqual(['--verbose', '--model', 'opus[1m]']);
  });

  it('does not mutate input array', () => {
    const args = ['--model', 'opus', '--foo', 'bar'];
    const snapshot = [...args];

    const result = rewriteModelTo1m(args);

    expect(args).toEqual(snapshot);
    expect(result).not.toBe(args);
  });
});

describe('extractModelFromArgs', () => {
  it('extracts model from --model X', () => {
    expect(extractModelFromArgs(['--model', 'opus'])).toBe('opus');
  });

  it('extracts model from -m X', () => {
    expect(extractModelFromArgs(['-m', 'sonnet'])).toBe('sonnet');
  });

  it('extracts model from --model=X', () => {
    expect(extractModelFromArgs(['--model=haiku'])).toBe('haiku');
  });

  it('extracts model from -m=X', () => {
    expect(extractModelFromArgs(['-m=opus[1m]'])).toBe('opus[1m]');
  });

  it('returns null when no model flag is present', () => {
    expect(extractModelFromArgs(['--dangerously-skip-permissions'])).toBeNull();
  });

  it('returns null for empty args', () => {
    expect(extractModelFromArgs([])).toBeNull();
  });

  it('returns null when --model flag has no value', () => {
    expect(extractModelFromArgs(['--model'])).toBeNull();
  });
});
