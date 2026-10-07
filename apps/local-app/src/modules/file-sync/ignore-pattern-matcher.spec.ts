import { compileIgnorePattern, firstMatch, ignorePatternProblem } from './ignore-pattern-matcher';

// Pure unit tests are the cheapest layer for the shared UI/backend matching contract.
describe('Syncthing ignore patterns', () => {
  // Cases adapted from v2.1.5 lib/ignore/ignore_test.go: TestExcludes,
  // TestFlagOrder, TestDeletables, TestIssue3674, TestGobwasGlobIssue18 and TestRoot.
  it.each([
    ['a*b', 'ab', true],
    ['/afile', 'afile\n', false],
    ['#snapshot', '#snapshot/foo', true],
    ['{afile,bfile', 'bfile', true],
    ['afile\\', 'afile', true],
    ['a*b', 'asdfb', true],
    ['a*b', 'as/db', false],
    ['a**c', 'as/dc', true],
    ['a?b', 'ab', false],
    ['a?b', 'acb', true],
    ['a?b', 'asdb', false],
    ['a?b', 'a/b', false],
    ['bb?', 'bbaa', false],
    ['[ab]file', 'afile', true],
    ['[ab]file', 'cfile', false],
    ['[a-c]file', 'bfile', true],
    ['[!ab]file', 'cfile', true],
    ['[!ab]file', 'afile', false],
    ['{afile,bfile}', 'bfile', true],
    ['{afile,bfile}', 'cfile', false],
    ['{a,{b,c}}file', 'cfile', true],
    [String.raw`a\*b`, 'a*b', true],
    [String.raw`a\*b`, 'asdfb', false],
    [String.raw`\[ab\]`, '[ab]', true],
    [String.raw`a\\b`, 'a\\b', true],
    ['**/efile', 'efile', true],
    ['**/efile', 'dir1/efile', true],
    ['/efile', 'dir1/efile', false],
    ['/efile', 'efile', true],
    ['ign1', 'foo/bar/ign1', true],
    ['ign1', 'ign1/ign', true],
    ['foo/', 'foo', false],
    ['foo/', 'foo/bar', true],
    ['foo/**', 'foo', false],
    ['foo/**', 'foo/bar', true],
    ['/foo/**', 'dir/foo/bar', false],
    ['(?i)ign1', 'IGN1', true],
    ['ign1', 'IGN1', false],
    ['(?d)ign1', 'ign1', true],
    ['!!(?i)(?d)ign7', 'ign7', false],
    ['(?d)(?d)!ign10', '(?d)!ign10', true],
    ['(?i)café', 'CAFE\u0301', true],
    ['a?b', 'a😀b', true],
  ])('matches %s against %s as %s', (line, path, expected) => {
    const compiled = compileIgnorePattern(line);
    expect(compiled.kind).toBe('pattern');
    if (compiled.kind === 'pattern') expect(compiled.matches(path)).toBe(expected);
  });

  it.each(['(?i)(?d)!', '(?d)(?i)!', '(?i)!(?d)', '(?d)!(?i)', '!(?i)(?d)', '!(?d)(?i)'])(
    'accepts prefix order %s and keeps matching paths',
    (prefix) => {
      expect(firstMatch([prefix + 'ign1'], 'IGN1')).toEqual({
        kind: 'matched',
        index: 0,
        ignored: false,
        deletable: false,
      });
    },
  );

  it.each([
    [['!ign1/ex', 'ign1'], 'ign1/ex', 0, false],
    [['i*2', '!ign2'], 'ign2', 0, true],
    [['// comment', '', '(?d)ign1'], 'ign1', 2, true],
  ])('uses the first decision in %s', (lines, path, index, ignored) => {
    expect(firstMatch(lines, path)).toEqual({
      kind: 'matched',
      index,
      ignored,
      deletable: lines[index].startsWith('(?d)'),
    });
  });

  it.each([
    [['#include other', '!afile'], 'afile', { kind: 'unknown', index: 0, reason: 'include' }],
    [
      ['!afile', '#include other'],
      'afile',
      { kind: 'matched', index: 0, ignored: false, deletable: false },
    ],
    [['afile', '#include other'], 'bfile', { kind: 'unknown', index: 1, reason: 'include' }],
    [['// comment', 'afile'], 'bfile', { kind: 'none' }],
  ])('reports undecidable paths without guessing for %s', (lines, path, expected) => {
    expect(firstMatch(lines, path)).toEqual(expected);
  });

  it.each(['[', '/[', '**/[', '[]', '[!]', '[z-a]', '[a-zA-Z]', '!', '(?i)(?d)', '#include'])(
    'reports syntax errors for %s',
    (line) => {
      expect(compileIgnorePattern(line)).toEqual({
        kind: 'error',
        error: expect.stringContaining('Invalid ignore pattern:'),
      });
      expect(firstMatch([line, '*'], 'afile')).toEqual({
        kind: 'unknown',
        index: 0,
        reason: 'syntax',
        error: expect.any(String),
      });
    },
  );

  it.each([
    [[], ' ', 'Enter a pattern.'],
    [['tmp'], ' tmp ', 'tmp is already in the list.'],
    [[], 'x'.repeat(257), 'A pattern can have at most 256 characters.'],
    [
      Array.from({ length: 200 }, (_, i) => String(i)),
      'tmp',
      'The list can hold at most 200 patterns.',
    ],
    [[], '[', 'Invalid ignore pattern: Expected a nonempty character class and closing bracket.'],
    [[], 'x'.repeat(256), null],
    [Array.from({ length: 199 }, (_, i) => String(i)), 'tmp', null],
    [[], ' (?d)*.egg-info ', null],
    [[], '#include other', null],
  ])('validates editor additions to %s', (list, pattern, expected) => {
    expect(ignorePatternProblem(list, pattern)).toBe(expected);
  });
});
