import { quoteShellArg } from '../quote-shell-arg';

describe('quoteShellArg', () => {
  it('wraps simple arg in single quotes', () => {
    expect(quoteShellArg('hello')).toBe("'hello'");
  });

  it('wraps arg with space in single quotes', () => {
    expect(quoteShellArg('hello world')).toBe("'hello world'");
  });

  it('escapes single quotes with POSIX close-escape-open pattern', () => {
    expect(quoteShellArg("it's")).toBe("'it'\\''s'");
  });

  it('handles multiple single quotes', () => {
    expect(quoteShellArg("it's a 'test'")).toBe("'it'\\''s a '\\''test'\\'''");
  });

  it('wraps shell metachars safely', () => {
    expect(quoteShellArg('$(ls)')).toBe("'$(ls)'");
    expect(quoteShellArg('`whoami`')).toBe("'`whoami`'");
    expect(quoteShellArg('${HOME}')).toBe("'${HOME}'");
    expect(quoteShellArg('a;b')).toBe("'a;b'");
    expect(quoteShellArg('a|b')).toBe("'a|b'");
    expect(quoteShellArg('a&b')).toBe("'a&b'");
  });

  it('returns empty single-quoted pair for empty string', () => {
    expect(quoteShellArg('')).toBe("''");
  });

  it('handles double quotes inside single quotes', () => {
    expect(quoteShellArg('say "hi"')).toBe('\'say "hi"\'');
  });

  it('handles backslashes', () => {
    expect(quoteShellArg('path\\to\\file')).toBe("'path\\to\\file'");
  });

  it('handles newlines', () => {
    expect(quoteShellArg('line1\nline2')).toBe("'line1\nline2'");
  });

  it('produces correct output for realistic agent CLI invocation', () => {
    const argv = ['claude', '--continue', '--mcp-config', '/path/to/config.json'];
    const result = argv.map(quoteShellArg).join(' ');
    expect(result).toBe("'claude' '--continue' '--mcp-config' '/path/to/config.json'");
  });

  it('matches tmux.service.ts sendCommandArgs quoting behavior', () => {
    const legacyQuote = (arg: string): string => {
      if (arg.length === 0) return "''";
      return `'${arg.replace(/'/g, "'\\''")}'`;
    };

    const testCases = [
      ['hello'],
      ['hello world'],
      ["it's"],
      ['$(ls)'],
      [''],
      ['claude', '--continue', '--mcp-config', '/path/to/config.json'],
      ["it's", 'a', "'test'"],
      ['path with spaces/and-dashes'],
      ['--flag=value'],
    ];

    for (const argv of testCases) {
      const legacyResult = argv.map(legacyQuote).join(' ');
      const newResult = argv.map(quoteShellArg).join(' ');
      expect(newResult).toBe(legacyResult);
    }
  });
});
