// Pure parsing tests preserve filename boundaries without starting Git.
import {
  conflictMarkerFiles,
  parseMergeTreeConflicts,
  parsePorcelain,
  parseUnmergedFiles,
} from './git-output';

describe('Git lane output parsing', () => {
  it('preserves NUL-delimited names and consumes rename sources before the next file', () => {
    expect(parsePorcelain('R  new name\0old\nname\0 M tracked\0?? untracked\nfile\0')).toEqual([
      { status: 'R ', path: 'new name', originalPath: 'old\nname' },
      { status: ' M', path: 'tracked' },
      { status: '??', path: 'untracked\nfile' },
    ]);
  });

  it('reads only conflict paths and excludes merge-tree informational records', () => {
    expect(
      parseMergeTreeConflicts(
        'treeoid\0first\nfile\0second\0\0' + '1\0first\nfile\0CONFLICT (contents)\0human message\0',
      ),
    ).toEqual(['first\nfile', 'second']);
    expect(parseMergeTreeConflicts('treeoid\0')).toEqual([]);
  });

  it('deduplicates unmerged stages without splitting filenames at newlines', () => {
    expect(
      parseUnmergedFiles(
        '100644 abc 1\todd\nfile\0' + '100644 def 2\todd\nfile\0' + '100644 ghi 3\tother\0',
      ),
    ).toEqual(['odd\nfile', 'other']);
  });

  it('finds marker diagnostics for exact staged paths and ignores whitespace findings', () => {
    expect(
      conflictMarkerFiles(
        'odd\nfile:part.txt:1: leftover conflict marker\n' +
          'odd\nfile:part.txt:3: leftover conflict marker\n' +
          'safe.txt:1: trailing whitespace.\n+text with spaces   \n',
        ['odd\nfile:part.txt', 'file:part.txt', 'safe.txt'],
      ),
    ).toEqual(['odd\nfile:part.txt']);
  });
});
