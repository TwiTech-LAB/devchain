import {
  parseProfileOptions,
  ProfileOptionsError,
  hasFlagOccurrence,
  injectModelOverride,
  extractModelFromArgs,
  stripFlag,
  hasCodexProfileSelector,
} from './profile-options';

describe('parseProfileOptions', () => {
  it.each([
    { label: 'empty', inputs: [undefined, null, ''], expected: [] },
    {
      label: 'whitespace',
      inputs: ['--model sonnet --max-tokens 4000'],
      expected: ['--model', 'sonnet', '--max-tokens', '4000'],
    },
    {
      label: 'quoted',
      inputs: ['--prompt \'Hello World\' "quoted value"'],
      expected: ['--prompt', 'Hello World', 'quoted value'],
    },
    {
      label: 'escaped',
      inputs: ['--flag\\ value "double\\"quote"'],
      expected: ['--flag value', 'double"quote'],
    },
  ])('parses $label arguments', ({ inputs, expected }) => {
    for (const input of inputs) expect(parseProfileOptions(input)).toEqual(expected);
  });

  it.each(['bad\nvalue', "--model 'unfinished"])(
    'rejects malformed profile options %j',
    (options) => {
      expect(() => parseProfileOptions(options)).toThrow(ProfileOptionsError);
    },
  );
});

describe('stripFlag', () => {
  it.each([
    { args: ['--effort', 'high', '--verbose'], expected: ['--verbose'] },
    { args: ['--effort=high', '--verbose'], expected: ['--verbose'] },
    { args: ['--effort', 'low', '-x', '--effort=high', '--effort', 'max'], expected: ['-x'] },
    { args: ['--model', 'opus', '--verbose'], expected: ['--model', 'opus', '--verbose'] },
    { args: ['--effort-budget', '5', '--effort', 'high'], expected: ['--effort-budget', '5'] },
    { args: ['--verbose', '--effort'], expected: ['--verbose'] },
  ])('strips effort flags from $args', ({ args, expected }) => {
    expect(stripFlag(args, '--effort')).toEqual(expected);
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

describe('hasCodexProfileSelector', () => {
  it.each([
    [['-p', 'managed']],
    [['-pmanaged']],
    [['-p=managed']],
    [['--profile', 'managed']],
    [['--profile=managed']],
    [['-p']],
    [['--profile']],
    [['--profile=']],
  ])('detects owned selector form %p', (args) => {
    expect(hasCodexProfileSelector(args)).toBe(true);
  });

  it.each([[[]], [['--profiles', 'x']], [['--model', 'x']]])(
    'ignores unrelated form %p',
    (args) => {
      expect(hasCodexProfileSelector(args)).toBe(false);
    },
  );
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
    {
      args: ['--verbose', '-m'],
      model: 'new-model',
      expected: ['--model', 'new-model', '--verbose'],
    },
  ])('rewrites model flags for $args with override $model', ({ args, model, expected }) => {
    expect(injectModelOverride(args, model)).toEqual(expected);
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
  it.each([
    { args: ['--model', 'opus'], expected: 'opus' },
    { args: ['-m', 'sonnet'], expected: 'sonnet' },
    { args: ['--model=haiku'], expected: 'haiku' },
    { args: ['-m=opus[1m]'], expected: 'opus[1m]' },
    { args: ['--dangerously-skip-permissions'], expected: null },
    { args: ['--model'], expected: null },
  ])('extracts model from $args', ({ args, expected }) => {
    expect(extractModelFromArgs(args)).toBe(expected);
  });
});
