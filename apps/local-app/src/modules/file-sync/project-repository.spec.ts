// Filesystem unit tests distinguish repository layouts without starting Git or Syncthing.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectRepository } from './project-repository';

describe('projectRepository', () => {
  it.each([
    ['missing', 'missing'],
    ['empty', 'missing'],
    ['partial', 'missing'],
    ['repository', 'repository'],
    ['linked objects', 'repository'],
    ['worktree', 'worktree'],
    ['linked .git', 'worktree'],
  ] as const)('classifies %s as %s', async (layout, expected) => {
    const root = mkdtempSync(join(tmpdir(), 'project-repository-'));
    const git = join(root, '.git');
    try {
      if (['empty', 'partial', 'repository', 'linked objects'].includes(layout)) mkdirSync(git);
      // `partial` is what a failed git init leaves: HEAD and refs/, but no objects/.
      if (['partial', 'repository', 'linked objects'].includes(layout)) {
        writeFileSync(join(git, 'HEAD'), 'ref: refs/heads/main\n');
        mkdirSync(join(git, 'refs'));
      }
      if (layout === 'repository') mkdirSync(join(git, 'objects'));
      // Links point inside the temporary root, so cleanup never follows them out.
      if (layout.startsWith('linked')) mkdirSync(join(root, 'store'));
      if (layout === 'linked objects') symlinkSync(join(root, 'store'), join(git, 'objects'));
      if (layout === 'worktree') writeFileSync(git, 'gitdir: /other/worktree');
      if (layout === 'linked .git') symlinkSync(join(root, 'store'), git);
      expect(await projectRepository(root)).toBe(expected);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
