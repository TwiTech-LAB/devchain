import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { promisify } from 'util';
import { GitWorktreeService } from './git-worktree.service';
import { resetEnvConfig } from '../../../../common/config/env.config';

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 10 * 1024 * 1024;

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    maxBuffer: MAX_BUFFER,
  });
  return stdout?.toString() ?? '';
}

describe('GitWorktreeService', () => {
  const originalEnv = process.env;
  let tempRoot: string;
  let repoPath: string;
  let service: GitWorktreeService;

  beforeEach(async () => {
    process.env = { ...originalEnv };
    delete process.env.DEVCHAIN_MODE;
    delete process.env.DATABASE_URL;
    delete process.env.REPO_ROOT;
    delete process.env.WORKTREES_ROOT;
    delete process.env.WORKTREES_DATA_ROOT;
    resetEnvConfig();

    tempRoot = await mkdtemp(join(tmpdir(), 'git-worktree-service-'));
    repoPath = join(tempRoot, 'repo');
    await mkdir(repoPath, { recursive: true });

    await git(repoPath, ['init']);
    await git(repoPath, ['config', 'user.name', 'DevChain Test']);
    await git(repoPath, ['config', 'user.email', 'devchain-test@example.com']);

    await writeFile(join(repoPath, 'README.md'), '# test\n');
    await git(repoPath, ['add', '.']);
    await git(repoPath, ['commit', '-m', 'initial commit']);
    await git(repoPath, ['branch', '-M', 'main']);

    service = new GitWorktreeService();
  });

  afterEach(async () => {
    process.env = originalEnv;
    resetEnvConfig();
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('creates, lists, and removes a worktree', async () => {
    const worktreePath = join(repoPath, '.devchain', 'worktrees', 'feature-auth');

    const created = await service.createWorktree({
      name: 'feature-auth',
      branchName: 'feature/auth',
      baseBranch: 'main',
      repoPath,
      worktreePath,
    });

    expect(created.path).toBe(worktreePath);
    expect(created.branch).toBe('feature/auth');
    expect(existsSync(worktreePath)).toBe(true);

    const worktrees = await service.listWorktrees(repoPath);
    const featureWorktree = worktrees.find((worktree) => worktree.path === worktreePath);
    expect(featureWorktree).toBeDefined();
    expect(featureWorktree?.branch).toBe('feature/auth');

    await service.removeWorktree('feature-auth', repoPath);

    const afterRemove = await service.listWorktrees(repoPath);
    expect(afterRemove.find((worktree) => worktree.path === worktreePath)).toBeUndefined();
    expect(existsSync(worktreePath)).toBe(false);
  });

  it('lists local branches from the repository', async () => {
    await git(repoPath, ['checkout', '-b', 'feature/list-branches']);
    await git(repoPath, ['checkout', 'main']);

    const branches = await service.listBranches(repoPath);

    expect(branches).toEqual(expect.arrayContaining(['main', 'feature/list-branches']));
  });

  it('deletes branch with -- separator and force flag', async () => {
    const runner = jest.fn(async () => ({ stdout: '', stderr: '' }));
    const branchService = new GitWorktreeService(runner);

    await branchService.deleteBranch('-feature/delete-me', '/tmp/repo-branches', true);

    expect(runner).toHaveBeenCalledWith('/tmp/repo-branches', [
      'branch',
      '-D',
      '--',
      '-feature/delete-me',
    ]);
  });

  it('uses safe delete when force is false', async () => {
    const runner = jest.fn(async () => ({ stdout: '', stderr: '' }));
    const branchService = new GitWorktreeService(runner);

    await branchService.deleteBranch('feature/delete-me', '/tmp/repo-branches', false);

    expect(runner).toHaveBeenCalledWith('/tmp/repo-branches', [
      'branch',
      '-d',
      '--',
      'feature/delete-me',
    ]);
  });

  it('returns empty array for a repository with no commits', async () => {
    const emptyRepoPath = join(tempRoot, 'empty-repo');
    await mkdir(emptyRepoPath, { recursive: true });
    await git(emptyRepoPath, ['init']);

    await expect(service.listBranches(emptyRepoPath)).resolves.toEqual([]);
  });

  it('reports ahead/behind and change summary', async () => {
    const worktreePath = join(repoPath, '.devchain', 'worktrees', 'feature-status');

    await service.createWorktree({
      name: 'feature-status',
      branchName: 'feature/status',
      baseBranch: 'main',
      repoPath,
      worktreePath,
    });

    await writeFile(join(worktreePath, 'feature.txt'), 'feature work\n');
    await git(worktreePath, ['add', 'feature.txt']);
    await git(worktreePath, ['commit', '-m', 'feature commit']);

    const statusBeforeMainUpdate = await service.getBranchStatus(
      repoPath,
      'main',
      'feature/status',
    );
    expect(statusBeforeMainUpdate.commitsAhead).toBe(1);
    expect(statusBeforeMainUpdate.commitsBehind).toBe(0);

    await writeFile(join(repoPath, 'main.txt'), 'main update\n');
    await git(repoPath, ['add', 'main.txt']);
    await git(repoPath, ['commit', '-m', 'main commit']);

    const statusAfterMainUpdate = await service.getBranchStatus(repoPath, 'main', 'feature/status');
    expect(statusAfterMainUpdate.commitsAhead).toBe(1);
    expect(statusAfterMainUpdate.commitsBehind).toBe(1);

    await appendFile(join(worktreePath, 'feature.txt'), 'uncommitted change\n');
    const summary = await service.getChangeSummary(worktreePath);
    expect(summary.filesChanged).toBeGreaterThanOrEqual(1);
    expect(summary.raw).toContain('feature.txt');
  });

  it('previews merge conflicts via merge-tree', async () => {
    await writeFile(join(repoPath, 'conflict.txt'), 'base\n');
    await git(repoPath, ['add', 'conflict.txt']);
    await git(repoPath, ['commit', '-m', 'add conflict file']);

    await git(repoPath, ['checkout', '-b', 'feature/conflict']);
    await writeFile(join(repoPath, 'conflict.txt'), 'feature change\n');
    await git(repoPath, ['add', 'conflict.txt']);
    await git(repoPath, ['commit', '-m', 'feature change']);

    await git(repoPath, ['checkout', 'main']);
    await writeFile(join(repoPath, 'conflict.txt'), 'main change\n');
    await git(repoPath, ['add', 'conflict.txt']);
    await git(repoPath, ['commit', '-m', 'main change']);

    const preview = await service.previewMerge(repoPath, 'feature/conflict', 'main');
    expect(preview.hasConflicts).toBe(true);
    expect(preview.output.length).toBeGreaterThan(0);
    expect(preview.conflicts.length).toBeGreaterThan(0);
  });

  it('executes merge with --no-ff and creates a merge commit', async () => {
    await git(repoPath, ['checkout', '-b', 'feature/merge']);
    await writeFile(join(repoPath, 'merge-file.txt'), 'hello\n');
    await git(repoPath, ['add', 'merge-file.txt']);
    await git(repoPath, ['commit', '-m', 'feature merge commit']);
    await git(repoPath, ['checkout', 'main']);

    const mergeResult = await service.executeMerge(repoPath, 'feature/merge', 'main');
    expect(mergeResult.success).toBe(true);
    expect(mergeResult.mergeCommit).toBeDefined();

    const parents = (await git(repoPath, ['rev-list', '--parents', '-n', '1', 'HEAD']))
      .trim()
      .split(/\s+/);
    expect(parents.length).toBe(3);

    const mergeSubject = (await git(repoPath, ['log', '-1', '--pretty=%s'])).trim();
    expect(mergeSubject).toBe('Merge feature/merge');
  });

  it('reports working tree cleanliness', async () => {
    const clean = await service.getWorkingTreeStatus(repoPath);
    expect(clean.clean).toBe(true);

    await writeFile(join(repoPath, 'dirty.txt'), 'dirty\n');
    const dirty = await service.getWorkingTreeStatus(repoPath);
    expect(dirty.clean).toBe(false);
    expect(dirty.output).toContain('dirty.txt');
  });

  it('executes rebase and returns success when branch can be rebased cleanly', async () => {
    await git(repoPath, ['checkout', '-b', 'feature/rebase']);
    await writeFile(join(repoPath, 'feature-rebase.txt'), 'feature\n');
    await git(repoPath, ['add', 'feature-rebase.txt']);
    await git(repoPath, ['commit', '-m', 'feature rebase commit']);

    await git(repoPath, ['checkout', 'main']);
    await writeFile(join(repoPath, 'main-rebase.txt'), 'main\n');
    await git(repoPath, ['add', 'main-rebase.txt']);
    await git(repoPath, ['commit', '-m', 'main commit before rebase']);

    const result = await service.executeRebase(repoPath, 'feature/rebase', 'main');
    expect(result.success).toBe(true);
    expect(result.conflicts).toEqual([]);
  });

  it('returns rebase conflicts and aborts active rebase on failure', async () => {
    await writeFile(join(repoPath, 'rebase-conflict.txt'), 'base\n');
    await git(repoPath, ['add', 'rebase-conflict.txt']);
    await git(repoPath, ['commit', '-m', 'add rebase conflict file']);

    await git(repoPath, ['checkout', '-b', 'feature/rebase-conflict']);
    await writeFile(join(repoPath, 'rebase-conflict.txt'), 'feature change\n');
    await git(repoPath, ['add', 'rebase-conflict.txt']);
    await git(repoPath, ['commit', '-m', 'feature rebase change']);

    await git(repoPath, ['checkout', 'main']);
    await writeFile(join(repoPath, 'rebase-conflict.txt'), 'main change\n');
    await git(repoPath, ['add', 'rebase-conflict.txt']);
    await git(repoPath, ['commit', '-m', 'main rebase change']);

    const result = await service.executeRebase(repoPath, 'feature/rebase-conflict', 'main');
    expect(result.success).toBe(false);
    expect(result.conflicts).toContain('rebase-conflict.txt');
  });

  it('rejects invalid branch names before invoking git command', async () => {
    const runner = jest.fn(async () => ({ stdout: '', stderr: '' }));
    const validatingService = new GitWorktreeService(runner);

    await expect(
      validatingService.createWorktree({
        name: 'feature-auth',
        branchName: 'feature .. bad',
        baseBranch: 'main',
        repoPath,
      }),
    ).rejects.toThrow('Invalid branch name');

    await expect(
      validatingService.createWorktree({
        name: 'feature-auth',
        branchName: 'feature/auth',
        baseBranch: 'main..bad',
        repoPath,
      }),
    ).rejects.toThrow('Invalid base branch name');

    expect(runner).not.toHaveBeenCalled();
  });

  it.each(['main'] as const)('uses REPO_ROOT when repoPath is omitted in %s mode', async (mode) => {
    process.env.DEVCHAIN_MODE = mode;
    process.env.DATABASE_URL = 'postgres://postgres:postgres@localhost:5432/devchain';
    process.env.REPO_ROOT = repoPath;
    resetEnvConfig();

    const runner = jest.fn(async () => ({ stdout: '', stderr: '' }));
    const envAwareService = new GitWorktreeService(runner);

    await envAwareService.listWorktrees();
    await envAwareService.listBranches();

    expect(runner).toHaveBeenCalledWith(repoPath, ['worktree', 'list', '--porcelain']);
    expect(runner).toHaveBeenCalledWith(repoPath, [
      'branch',
      '--list',
      '--format=%(refname:short)',
    ]);
  });

  it('uses WORKTREES_ROOT when resolving default worktree paths', async () => {
    process.env.DEVCHAIN_MODE = 'main';
    process.env.DATABASE_URL = 'postgres://postgres:postgres@localhost:5432/devchain';
    process.env.REPO_ROOT = repoPath;
    process.env.WORKTREES_ROOT = join(tempRoot, 'custom-worktrees');
    resetEnvConfig();

    const runner = jest.fn(async () => ({ stdout: '', stderr: '' }));
    const envAwareService = new GitWorktreeService(runner);

    await envAwareService.createWorktree({
      name: 'feature-paths',
      branchName: 'feature/paths',
      baseBranch: 'main',
      repoPath,
    });
    await envAwareService.removeWorktree('feature-paths', repoPath);

    const expectedWorktreePath = join(tempRoot, 'custom-worktrees', 'feature-paths');
    expect(runner).toHaveBeenCalledWith(repoPath, [
      'worktree',
      'add',
      expectedWorktreePath,
      '-b',
      'feature/paths',
      'main',
    ]);
    expect(runner).toHaveBeenCalledWith(repoPath, ['worktree', 'remove', expectedWorktreePath]);
  });

  it('returns empty branch list when git reports no local branches', async () => {
    const runner = jest.fn(async () => ({ stdout: '\n', stderr: '' }));
    const branchService = new GitWorktreeService(runner);

    const branches = await branchService.listBranches('/tmp/repo-empty');

    expect(branches).toEqual([]);
    expect(runner).toHaveBeenCalledWith('/tmp/repo-empty', [
      'branch',
      '--list',
      '--format=%(refname:short)',
    ]);
  });

  it('trims branch output and removes empty lines', async () => {
    const runner = jest.fn(async () => ({
      stdout: '  main  \n\n feature/login \n\trelease/1.0\t\n',
      stderr: '',
    }));
    const branchService = new GitWorktreeService(runner);

    const branches = await branchService.listBranches('/tmp/repo-branches');

    expect(branches).toEqual(['main', 'feature/login', 'release/1.0']);
    expect(runner).toHaveBeenCalledWith('/tmp/repo-branches', [
      'branch',
      '--list',
      '--format=%(refname:short)',
    ]);
  });

  it('serializes git operations to avoid concurrent execution', async () => {
    let activeOps = 0;
    let maxActiveOps = 0;
    const runner = jest.fn(async (_cwd: string, _args: string[]) => {
      activeOps += 1;
      maxActiveOps = Math.max(maxActiveOps, activeOps);
      await new Promise((resolve) => setTimeout(resolve, 25));
      activeOps -= 1;
      return { stdout: '', stderr: '' };
    });

    const serializedService = new GitWorktreeService(runner);
    await Promise.all([
      serializedService.listWorktrees('/tmp/repo-a'),
      serializedService.listWorktrees('/tmp/repo-b'),
      serializedService.listWorktrees('/tmp/repo-c'),
    ]);

    expect(maxActiveOps).toBe(1);
    expect(runner).toHaveBeenCalledTimes(3);
  });
});
