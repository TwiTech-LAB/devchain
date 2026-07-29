import {
  parseProfileOptions,
  ProfileOptionsError,
  hasFlagOccurrence,
  injectModelOverride,
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

describe('hasFlagOccurrence', () => {
  it('detects two-token, equals, empty, and ambiguous trailing forms', () => {
    expect(hasFlagOccurrence(['--settings', 'file.json'], '--settings')).toBe(true);
    expect(hasFlagOccurrence(['--settings=file.json'], '--settings')).toBe(true);
    expect(hasFlagOccurrence(['--settings='], '--settings')).toBe(true);
    expect(hasFlagOccurrence(['--verbose', '--settings'], '--settings')).toBe(true);
  });

  it('does not match prefixes or unrelated flags', () => {
    expect(hasFlagOccurrence(['--settings-file', 'x', '--verbose'], '--settings')).toBe(false);
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
