import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildClaudeUserInstructionsFile } from './claude-user-instructions';

describe('buildClaudeUserInstructionsFile', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'claude-instructions-'));
    await mkdir(join(home, '.claude'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('returns null when the file does not exist', async () => {
    expect(await buildClaudeUserInstructionsFile(home)).toBeNull();
  });

  it('sends the file as ~/.claude/CLAUDE.md with mode 0600, following a symlink', async () => {
    await writeFile(join(home, 'shared.md'), '# Rules\n');
    await symlink(join(home, 'shared.md'), join(home, '.claude', 'CLAUDE.md'));

    expect(await buildClaudeUserInstructionsFile(home)).toEqual({
      path: `${home}/.claude/CLAUDE.md`,
      mode: '0600',
      contentBase64: Buffer.from('# Rules\n', 'utf8').toString('base64'),
    });
  });

  it('sends an empty file as is', async () => {
    await writeFile(join(home, '.claude', 'CLAUDE.md'), '');

    expect(await buildClaudeUserInstructionsFile(home)).toMatchObject({ contentBase64: '' });
  });

  it('accepts a file at the VM limit', async () => {
    await writeFile(join(home, '.claude', 'CLAUDE.md'), 'a'.repeat(256 * 1024));

    expect(await buildClaudeUserInstructionsFile(home)).not.toBeNull();
  });

  it('refuses a file over the VM limit', async () => {
    await writeFile(join(home, '.claude', 'CLAUDE.md'), 'a'.repeat(256 * 1024 + 1));

    await expect(buildClaudeUserInstructionsFile(home)).rejects.toThrow(
      '~/.claude/CLAUDE.md is larger than 256 KiB',
    );
  });

  it('lets any other read error propagate', async () => {
    await mkdir(join(home, '.claude', 'CLAUDE.md'));

    await expect(buildClaudeUserInstructionsFile(home)).rejects.toMatchObject({ code: 'EISDIR' });
  });
});
