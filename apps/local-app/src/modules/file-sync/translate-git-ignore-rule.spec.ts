// Pure translation tests isolate scope and unsupported syntax without filesystem or transport fixtures.
import { translateGitIgnoreRule } from './translate-git-ignore-rule';

describe('translateGitIgnoreRule', () => {
  it.each([
    ['.gitignore', '*.egg-info/', ['(?d)*.egg-info']],
    ['a/b/.gitignore', '*.egg-info/', ['(?d)/a/b/*.egg-info', '(?d)/a/b/**/*.egg-info']],
    ['a/b/.gitignore', '**/*.egg-info/', ['(?d)/a/b/*.egg-info', '(?d)/a/b/**/*.egg-info']],
    ['a/b/.gitignore', '/cache/', ['(?d)/a/b/cache']],
    ['a/b/.gitignore', 'cache/output?', ['(?d)/a/b/cache/output?']],
    ['.git/info/exclude', '*.egg-info/', ['(?d)*.egg-info']],
    ['/home/alice/.config/git/ignore', '/cache/', ['(?d)/cache']],
    ['a[1]/.gitignore', 'cache', ['(?d)/a\\[1\\]/cache', '(?d)/a\\[1\\]/**/cache']],
    ['.gitignore', 'file[0-9].txt', ['(?d)file[0-9].txt']],
  ])('translates %s rule %s within its Git scope', (source, pattern, expected) => {
    expect(translateGitIgnoreRule({ source, line: 1, pattern })).toEqual(expected);
  });

  it.each(['!keep', 'a/**/b', '[^a]', '{a,b}', '(?i)cache', '[', 'cache\\', '', 'cache\noutput'])(
    'refuses unsupported rule %s',
    (pattern) => {
      expect(translateGitIgnoreRule({ source: '.gitignore', line: 1, pattern })).toBeNull();
    },
  );
});
