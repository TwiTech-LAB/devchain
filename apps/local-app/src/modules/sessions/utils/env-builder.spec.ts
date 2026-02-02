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

  it('rejects empty keys', () => {
    expect(() => validateEnvKey('')).toThrow(EnvBuilderError);
  });

  it('rejects keys starting with numbers', () => {
    expect(() => validateEnvKey('123VAR')).toThrow(EnvBuilderError);
    expect(() => validateEnvKey('9_INVALID')).toThrow(EnvBuilderError);
  });

  it('rejects keys with special characters', () => {
    expect(() => validateEnvKey('MY-VAR')).toThrow(EnvBuilderError);
    expect(() => validateEnvKey('MY.VAR')).toThrow(EnvBuilderError);
    expect(() => validateEnvKey('MY VAR')).toThrow(EnvBuilderError);
    expect(() => validateEnvKey('MY$VAR')).toThrow(EnvBuilderError);
  });

  it('rejects excessively long keys', () => {
    const longKey = 'A'.repeat(256);
    expect(() => validateEnvKey(longKey)).toThrow(EnvBuilderError);
  });
});

describe('validateEnvValue', () => {
  it('accepts normal values', () => {
    expect(() => validateEnvValue('KEY', 'simple value')).not.toThrow();
    expect(() => validateEnvValue('KEY', '/path/to/file')).not.toThrow();
    expect(() => validateEnvValue('KEY', 'value with "quotes"')).not.toThrow();
    expect(() => validateEnvValue('KEY', '')).not.toThrow();
  });

  it('rejects values with newlines', () => {
    expect(() => validateEnvValue('KEY', 'line1\nline2')).toThrow(EnvBuilderError);
    expect(() => validateEnvValue('KEY', 'line1\rline2')).toThrow(EnvBuilderError);
  });

  it('rejects values with control characters', () => {
    expect(() => validateEnvValue('KEY', 'has\x00null')).toThrow(EnvBuilderError);
    expect(() => validateEnvValue('KEY', 'has\x07bell')).toThrow(EnvBuilderError);
    expect(() => validateEnvValue('KEY', 'has\ttab')).toThrow(EnvBuilderError);
  });

  it('rejects excessively long values', () => {
    const longValue = 'x'.repeat(32769);
    expect(() => validateEnvValue('KEY', longValue)).toThrow(EnvBuilderError);
  });
});

describe('quoteEnvValue', () => {
  it('quotes empty string', () => {
    expect(quoteEnvValue('')).toBe("''");
  });

  it('quotes simple values', () => {
    expect(quoteEnvValue('simple')).toBe("'simple'");
  });

  it('escapes single quotes', () => {
    expect(quoteEnvValue("it's")).toBe("'it'\\''s'");
    expect(quoteEnvValue("'quoted'")).toBe("''\\''quoted'\\'''");
  });

  it('handles special shell characters safely', () => {
    expect(quoteEnvValue('$HOME')).toBe("'$HOME'");
    expect(quoteEnvValue('a && b')).toBe("'a && b'");
    expect(quoteEnvValue('$(whoami)')).toBe("'$(whoami)'");
  });
});

describe('buildEnvArgs', () => {
  it('returns empty array for null/undefined/empty env', () => {
    expect(buildEnvArgs(null)).toEqual([]);
    expect(buildEnvArgs(undefined)).toEqual([]);
    expect(buildEnvArgs({})).toEqual([]);
  });

  it('builds single env var (unquoted)', () => {
    // Values are NOT quoted - sendCommandArgs handles shell quoting
    expect(buildEnvArgs({ HOME: '/home/user' })).toEqual(['HOME=/home/user']);
  });

  it('builds multiple env vars (unquoted)', () => {
    const result = buildEnvArgs({ FOO: 'bar', BAZ: 'qux' });
    expect(result).toHaveLength(2);
    expect(result).toContain('FOO=bar');
    expect(result).toContain('BAZ=qux');
  });

  it('does NOT quote values with special characters (sendCommandArgs handles quoting)', () => {
    // Special chars are preserved as-is; sendCommandArgs will quote the entire argv element
    expect(buildEnvArgs({ API_KEY: 'abc$123' })).toEqual(['API_KEY=abc$123']);
  });

  it('preserves values with spaces (sendCommandArgs handles quoting)', () => {
    expect(buildEnvArgs({ MSG: 'hello world' })).toEqual(['MSG=hello world']);
  });

  it('throws for invalid keys', () => {
    expect(() => buildEnvArgs({ 'INVALID-KEY': 'value' })).toThrow(EnvBuilderError);
  });

  it('throws for invalid values', () => {
    expect(() => buildEnvArgs({ KEY: 'bad\nvalue' })).toThrow(EnvBuilderError);
  });
});

describe('buildSessionCommand', () => {
  it('builds command without env vars', () => {
    expect(buildSessionCommand(null, '/usr/bin/claude', ['--model', 'opus'])).toEqual([
      '/usr/bin/claude',
      '--model',
      'opus',
    ]);
  });

  it('builds command with empty env', () => {
    expect(buildSessionCommand({}, '/usr/bin/claude', [])).toEqual(['/usr/bin/claude']);
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

  it('builds command with multiple env vars (unquoted)', () => {
    const result = buildSessionCommand({ KEY1: 'val1', KEY2: 'val2' }, '/usr/bin/provider', []);
    expect(result[0]).toBe('env');
    expect(result).toContain('KEY1=val1');
    expect(result).toContain('KEY2=val2');
    expect(result[result.length - 1]).toBe('/usr/bin/provider');
  });

  it('throws for invalid env', () => {
    expect(() => buildSessionCommand({ INVALID: 'has\nnewline' }, '/usr/bin/provider', [])).toThrow(
      EnvBuilderError,
    );
  });
});

/**
 * Regression test: Simulates TmuxService.sendCommandArgs() quoting behavior.
 * This ensures env values don't get double-quoted when passed through tmux.
 */
describe('tmux quoting simulation (regression)', () => {
  /**
   * Simulates how TmuxService.sendCommandArgs() quotes argv elements.
   * Each element is wrapped in single quotes with internal quotes escaped.
   */
  function simulateSendCommandArgsQuoting(argv: string[]): string {
    return argv
      .map((arg) => {
        if (arg.length === 0) {
          return "''";
        }
        return `'${arg.replace(/'/g, "'\\''")}'`;
      })
      .join(' ');
  }

  /**
   * Simulates shell unquoting of single-quoted strings.
   * Returns the literal value after shell interpretation.
   */
  function simulateShellUnquote(quoted: string): string[] {
    const result: string[] = [];
    let current = '';
    let inSingleQuote = false;
    let i = 0;

    while (i < quoted.length) {
      const char = quoted[i];

      if (inSingleQuote) {
        if (char === "'") {
          inSingleQuote = false;
        } else {
          current += char;
        }
        i++;
      } else if (char === "'") {
        inSingleQuote = true;
        i++;
      } else if (char === '\\' && i + 1 < quoted.length && quoted[i + 1] === "'") {
        // Escaped single quote outside of quotes: \'
        current += "'";
        i += 2;
      } else if (char === ' ') {
        if (current.length > 0) {
          result.push(current);
          current = '';
        }
        i++;
      } else {
        current += char;
        i++;
      }
    }

    if (current.length > 0) {
      result.push(current);
    }

    return result;
  }

  it('env vars should NOT have extra quotes after tmux quoting + shell unquoting', () => {
    const argv = buildSessionCommand(
      { API_KEY: 'sk-ant-12345', DEBUG: 'true' },
      '/usr/bin/claude',
      ['--model', 'opus'],
    );

    // Simulate sendCommandArgs quoting
    const quotedCommand = simulateSendCommandArgsQuoting(argv);

    // Simulate shell unquoting (what the shell sees after tmux send-keys)
    const unquotedArgs = simulateShellUnquote(quotedCommand);

    // Verify env command receives correct KEY=value format (no extra quotes)
    expect(unquotedArgs[0]).toBe('env');
    expect(unquotedArgs).toContain('API_KEY=sk-ant-12345');
    expect(unquotedArgs).toContain('DEBUG=true');
    expect(unquotedArgs).toContain('/usr/bin/claude');

    // Critically: values should NOT have quotes around them
    expect(unquotedArgs.some((arg) => arg.includes("'sk-ant-12345'"))).toBe(false);
    expect(unquotedArgs.some((arg) => arg.includes("'true'"))).toBe(false);
  });

  it('env vars with special shell chars should be properly escaped', () => {
    const argv = buildSessionCommand(
      { PATH_VAR: '/usr/bin:$HOME/bin', QUOTED: "it's" },
      '/usr/bin/provider',
      [],
    );

    const quotedCommand = simulateSendCommandArgsQuoting(argv);
    const unquotedArgs = simulateShellUnquote(quotedCommand);

    // Shell special chars preserved correctly
    expect(unquotedArgs).toContain('PATH_VAR=/usr/bin:$HOME/bin');
    expect(unquotedArgs).toContain("QUOTED=it's");
  });
});
