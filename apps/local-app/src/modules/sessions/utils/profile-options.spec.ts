import { parseProfileOptions, ProfileOptionsError, injectModelOverride } from './profile-options';

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
