import {
  validateEnvKey,
  validateEnvValue,
  quoteEnvValue,
  buildEnvArgs,
  buildSessionCommand,
  EnvBuilderError,
} from './env-builder';

describe('validateEnvKey', () => {
  it('accepts valid keys', () => {
    expect(() => validateEnvKey('HOME')).not.toThrow();
    expect(() => validateEnvKey('MY_VAR')).not.toThrow();
    expect(() => validateEnvKey('_PRIVATE')).not.toThrow();
    expect(() => validateEnvKey('var123')).not.toThrow();
    expect(() => validateEnvKey('A')).not.toThrow();
  });

  it.each([
    { label: 'empty', keys: [''] },
    { label: 'leading digit', keys: ['123VAR', '9_INVALID'] },
    { label: 'special characters', keys: ['MY-VAR', 'MY.VAR', 'MY VAR', 'MY$VAR'] },
    { label: 'too long', keys: ['A'.repeat(256)] },
  ])('rejects env keys: $label', ({ keys }) => {
    for (const key of keys) expect(() => validateEnvKey(key)).toThrow(EnvBuilderError);
  });
});

describe('validateEnvValue', () => {
  it('accepts normal values', () => {
    expect(() => validateEnvValue('KEY', 'simple value')).not.toThrow();
    expect(() => validateEnvValue('KEY', '/path/to/file')).not.toThrow();
    expect(() => validateEnvValue('KEY', 'value with "quotes"')).not.toThrow();
    expect(() => validateEnvValue('KEY', '')).not.toThrow();
  });

  it.each([
    { label: 'newlines', values: ['line1\nline2', 'line1\rline2'] },
    { label: 'controls', values: ['has\x00null', 'has\x07bell', 'has\ttab'] },
    { label: 'too long', values: ['x'.repeat(32769)] },
  ])('rejects env values: $label', ({ values }) => {
    for (const value of values)
      expect(() => validateEnvValue('KEY', value)).toThrow(EnvBuilderError);
  });
});

describe('quoteEnvValue', () => {
  it.each([
    { label: 'empty', pairs: [['', "''"]] },
    { label: 'simple', pairs: [['simple', "'simple'"]] },
    {
      label: 'single quotes',
      pairs: [
        ["it's", "'it'\\''s'"],
        ["'quoted'", "''\\''quoted'\\'''"],
      ],
    },
    {
      label: 'shell characters',
      pairs: [
        ['$HOME', "'$HOME'"],
        ['a && b', "'a && b'"],
        ['$(whoami)', "'$(whoami)'"],
      ],
    },
  ])('quotes env values: $label', ({ pairs }) => {
    for (const [value, expected] of pairs) expect(quoteEnvValue(value)).toBe(expected);
  });
});

describe('buildEnvArgs', () => {
  it('returns empty array for null/undefined/empty env', () => {
    expect(buildEnvArgs(null)).toEqual([]);
    expect(buildEnvArgs(undefined)).toEqual([]);
    expect(buildEnvArgs({})).toEqual([]);
  });

  it.each([
    { key: 'HOME', value: '/home/user', expected: 'HOME=/home/user' },
    { key: 'API_KEY', value: 'abc$123', expected: 'API_KEY=abc$123' },
    { key: 'MSG', value: 'hello world', expected: 'MSG=hello world' },
  ])('builds raw env argument $key', ({ key, value, expected }) => {
    expect(buildEnvArgs({ [key]: value })).toEqual([expected]);
  });

  it('builds multiple env vars (unquoted)', () => {
    const result = buildEnvArgs({ FOO: 'bar', BAZ: 'qux' });
    expect(result).toHaveLength(2);
    expect(result).toContain('FOO=bar');
    expect(result).toContain('BAZ=qux');
  });

  it.each<Record<string, string>>([{ 'INVALID-KEY': 'value' }, { KEY: 'bad\nvalue' }])(
    'rejects invalid env arguments %j',
    (env) => {
      expect(() => buildEnvArgs(env)).toThrow(EnvBuilderError);
    },
  );
});

describe('buildSessionCommand', () => {
  it('builds command without env vars', () => {
    expect(buildSessionCommand(null, '/usr/bin/claude', ['--model', 'opus'])).toEqual([
      '/usr/bin/claude',
      '--model',
      'opus',
    ]);
  });

  it('builds command with env vars using env prefix (unquoted)', () => {
    const result = buildSessionCommand({ ANTHROPIC_API_KEY: 'sk-123' }, '/usr/bin/claude', [
      '--model',
      'opus',
    ]);
    expect(result[0]).toBe('env');
    // Env var is NOT quoted here - sendCommandArgs handles shell quoting
    expect(result[1]).toBe('ANTHROPIC_API_KEY=sk-123');
    expect(result[2]).toBe('/usr/bin/claude');
    expect(result[3]).toBe('--model');
    expect(result[4]).toBe('opus');
  });
});
