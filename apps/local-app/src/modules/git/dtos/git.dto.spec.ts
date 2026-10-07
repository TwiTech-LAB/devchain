import { CommitShaParamSchema } from './git.dto';

// Schema-level tests directly protect the custom regex used before invoking git.
describe('CommitShaParamSchema', () => {
  it.each([
    ['abcd', true],
    ['ABCDEF0123456789', true],
    ['a'.repeat(40), true],
    ['abc', false],
    ['a'.repeat(41), false],
    ['abcdg', false],
    ['abcd;id', false],
    ['--help', false],
    ['abcd\n', false],
    [' abcd', false],
  ])('validates the git SHA boundary for %j', (sha, accepted) => {
    expect(CommitShaParamSchema.safeParse({ sha }).success).toBe(accepted);
  });
});
