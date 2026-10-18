import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProductionFileSyncPaths } from '../../file-sync/file-sync-paths';
import type { FileSyncService } from '../../file-sync/file-sync.service';
import { ChildProcessExecutor } from '../../terminal/services/process-executor/child-process-executor';
import { GitCoordinatorIndexService } from './git-coordinator-index.service';

describe('GitCoordinatorIndexService', () => {
  const originalPath = process.env.PATH;
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'git-coordinator-index-'));
  });
  afterEach(async () => {
    process.env.PATH = originalPath;
    await rm(directory, { recursive: true, force: true });
  });

  // The executor replaces the environment; a git outside /usr/bin:/bin (a source build in
  // /usr/local/bin, Homebrew) is found only when PATH comes along.
  it('lists linked worktree branches with the git found on PATH', async () => {
    const bin = join(directory, 'bin');
    await mkdir(bin);
    await writeFile(
      join(bin, 'git'),
      "#!/bin/sh\nprintf 'worktree /p\\nHEAD a\\nbranch refs/heads/main\\n\\nworktree /lane\\nHEAD b\\nbranch refs/heads/lane-1\\n'\n",
    );
    await chmod(join(bin, 'git'), 0o755);
    process.env.PATH = `${bin}:${originalPath}`;
    const files = {
      folderPath: jest.fn().mockResolvedValue(directory),
    } as unknown as FileSyncService;
    const service = new GitCoordinatorIndexService(
      createProductionFileSyncPaths(directory),
      files,
      new ChildProcessExecutor(),
    );

    await expect(service.worktreeBranches('p')).resolves.toEqual(['refs/heads/lane-1']);
  });
});
