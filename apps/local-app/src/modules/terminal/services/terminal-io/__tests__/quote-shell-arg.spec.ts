import { quoteShellArg } from '../quote-shell-arg';

describe('quoteShellArg', () => {
  it.each([
    { input: 'hello', expected: "'hello'" },
    { input: 'hello world', expected: "'hello world'" },
    { input: "it's", expected: "'it'\\''s'" },
    { input: "it's a 'test'", expected: "'it'\\''s a '\\''test'\\'''" },
    { input: '', expected: "''" },
    { input: 'say "hi"', expected: '\'say "hi"\'' },
    { input: 'path\\to\\file', expected: "'path\\to\\file'" },
    { input: 'line1\nline2', expected: "'line1\nline2'" },
  ])('quotes shell argument $input', ({ input, expected }) => {
    expect(quoteShellArg(input)).toBe(expected);
  });

  it('wraps shell metachars safely', () => {
    expect(quoteShellArg('$(ls)')).toBe("'$(ls)'");
    expect(quoteShellArg('`whoami`')).toBe("'`whoami`'");
    expect(quoteShellArg('${HOME}')).toBe("'${HOME}'");
    expect(quoteShellArg('a;b')).toBe("'a;b'");
    expect(quoteShellArg('a|b')).toBe("'a|b'");
    expect(quoteShellArg('a&b')).toBe("'a&b'");
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
