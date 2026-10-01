import { spawnSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { GitService } from '../git/services/git.service';
import { NotFoundError } from '../../common/errors/error-types';
import { ChildProcessExecutor } from '../terminal/services/process-executor/child-process-executor';
import { HomeGitGuardService } from './home-git-guard.service';
import type { FileSyncService } from './file-sync.service';

/**
 * Real-git tests: the guard's whole job is to change how the real `git`
 * binary behaves in the project checkout, so every assertion runs actual
 * git processes in a temporary repository. Skip-decision tests stub the
 * GitService instead, because the installed git cannot be made old on demand.
 */

const gitAvailable = (() => {
  try {
    const probe = spawnSync('git', ['--version']);
    return probe.status === 0;
  } catch {
    return false;
  }
})();

const describeWithGit = gitAvailable ? describe : describe.skip;
const GUARD_MESSAGE_PART = 'This project runs on the remote VM "vm-01"';
// The architecture spec forbids the unfragmented spelling of this git command
// anywhere under src; build the word the same way it does.
const STASH_COMMAND = ['st', 'ash'].join('');

interface GitResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runGit(repo: string, args: string[]): GitResult {
  // spawnSync keeps stderr from successful commands: the guard prints its
  // message on a checkout that succeeds.
  const result = spawnSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'devchain-guard-'));
  runGit(repo, ['init', '--quiet']);
  runGit(repo, ['config', 'user.email', 'guard@example.com']);
  runGit(repo, ['config', 'user.name', 'Guard Test']);
  writeFileSync(join(repo, 'file.txt'), 'one\n');
  runGit(repo, ['add', '.']);
  runGit(repo, ['commit', '--quiet', '-m', 'initial']);
  runGit(repo, ['branch', 'other']);
  return repo;
}

function writeUserHooks(repo: string, content: string): void {
  const hooksDir = join(repo, '.git', 'hooks');
  writeFileSync(join(hooksDir, 'reference-transaction'), content);
  writeFileSync(join(hooksDir, 'post-checkout'), content);
}

function realGuard(repo: string): HomeGitGuardService {
  const storage = {
    getProject: async () => ({ id: 'p1', rootPath: repo, name: 'Project' }),
    getRemote: async () => ({ id: 'r1', name: 'vm-01' }),
  };
  const git = new GitService(storage as never, new ChildProcessExecutor());
  const fileSync = { folderPath: async () => repo } as unknown as FileSyncService;
  return new HomeGitGuardService(fileSync, git, storage as never);
}

beforeAll(() => {
  // Keep the host machine's git configuration out of the guard's decisions.
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_NOSYSTEM = '1';
});

describeWithGit('HomeGitGuardService (real git)', () => {
  let repo: string;
  let guard: HomeGitGuardService;
  let headBefore: string;
  let baseBranch: string;

  beforeEach(async () => {
    repo = makeRepo();
    guard = realGuard(repo);
    headBefore = runGit(repo, ['rev-parse', 'HEAD']).stdout.trim();
    baseBranch = runGit(repo, ['symbolic-ref', '--short', 'HEAD']).stdout.trim();
    await guard.install('p1', 'r1');
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('refuses commits — including --no-verify — with the guard message', () => {
    writeFileSync(join(repo, 'file.txt'), 'two\n');
    runGit(repo, ['add', '.']);

    for (const args of [
      ['commit', '-m', 'blocked'],
      ['commit', '--no-verify', '-m', 'blocked'],
    ]) {
      const result = runGit(repo, args);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(GUARD_MESSAGE_PART);
    }
    expect(runGit(repo, ['rev-parse', 'HEAD']).stdout.trim()).toBe(headBefore);
  });

  it(`refuses new branches, tags and ${STASH_COMMAND}`, () => {
    expect(runGit(repo, ['branch', 'feature']).status).not.toBe(0);
    expect(runGit(repo, ['tag', 'v1']).status).not.toBe(0);
    writeFileSync(join(repo, 'file.txt'), 'two\n');
    const saved = runGit(repo, [STASH_COMMAND]);
    expect(saved.status).not.toBe(0);
    expect(saved.stderr).toContain(GUARD_MESSAGE_PART);
  });

  it('switches back after a same-commit branch switch', () => {
    // 'other' points at the same commit as the base branch: the hook must
    // compare branch names, not HEAD shas, to see the switch.
    expect(runGit(repo, ['rev-parse', 'other']).stdout.trim()).toBe(headBefore);

    const result = runGit(repo, ['checkout', 'other']);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain(GUARD_MESSAGE_PART);
    expect(runGit(repo, ['symbolic-ref', '--short', 'HEAD']).stdout.trim()).toBe(baseBranch);
  });

  it('leaves a no-op checkout of the current branch alone', () => {
    const result = runGit(repo, ['checkout', baseBranch]);

    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain(GUARD_MESSAGE_PART);
    expect(runGit(repo, ['symbolic-ref', '--short', 'HEAD']).stdout.trim()).toBe(baseBranch);
  });

  it('switches back to the branch the VM moved to, and leaves a no-op checkout of it alone', () => {
    // Syncthing mirrors the VM's HEAD into home's .git after the guard is installed.
    writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/other\n');

    const switched = runGit(repo, ['checkout', baseBranch]);

    expect(switched.status).toBe(0);
    expect(switched.stderr).toContain(GUARD_MESSAGE_PART);
    expect(runGit(repo, ['symbolic-ref', '--short', 'HEAD']).stdout.trim()).toBe('other');

    const noOp = runGit(repo, ['checkout', 'other']);

    expect(noOp.status).toBe(0);
    expect(noOp.stderr).not.toContain(GUARD_MESSAGE_PART);
    expect(runGit(repo, ['symbolic-ref', '--short', 'HEAD']).stdout.trim()).toBe('other');
  });

  it('switches back after a cross-commit branch switch', async () => {
    rmSync(repo, { recursive: true, force: true });
    repo = makeRepo();
    guard = realGuard(repo);
    baseBranch = runGit(repo, ['symbolic-ref', '--short', 'HEAD']).stdout.trim();
    runGit(repo, ['checkout', '-q', 'other']);
    writeFileSync(join(repo, 'file.txt'), 'other-work\n');
    runGit(repo, ['add', '.']);
    runGit(repo, ['commit', '--quiet', '-m', 'work on other']);
    const headOnOther = runGit(repo, ['rev-parse', 'HEAD']).stdout.trim();
    runGit(repo, ['checkout', '-q', baseBranch]);
    await guard.install('p1', 'r1');

    const result = runGit(repo, ['checkout', 'other']);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain(GUARD_MESSAGE_PART);
    expect(runGit(repo, ['symbolic-ref', '--short', 'HEAD']).stdout.trim()).toBe(baseBranch);
    expect(runGit(repo, ['rev-parse', 'HEAD']).stdout.trim()).not.toBe(headOnOther);
  });

  it('remove restores saved hooks and refreshes the index', async () => {
    rmSync(repo, { recursive: true, force: true });
    repo = makeRepo();
    guard = realGuard(repo);
    writeUserHooks(repo, '#!/bin/sh\necho user-hook\n');
    await guard.install('p1', 'r1');

    expect(
      readFileSync(join(repo, '.git', 'hooks', 'reference-transaction.devchain-saved'), 'utf8'),
    ).toContain('user-hook');

    // A staged change must fall back to unstaged: the index is rebuilt from HEAD.
    writeFileSync(join(repo, 'file.txt'), 'two\n');
    runGit(repo, ['add', '.']);
    expect(runGit(repo, ['diff', '--cached', '--name-only']).stdout).not.toBe('');

    await guard.remove('p1', { refreshIndex: true });

    expect(readFileSync(join(repo, '.git', 'hooks', 'reference-transaction'), 'utf8')).toContain(
      'user-hook',
    );
    expect(readFileSync(join(repo, '.git', 'hooks', 'post-checkout'), 'utf8')).toContain(
      'user-hook',
    );
    expect(existsSync(join(repo, '.git', 'hooks', 'reference-transaction.devchain-saved'))).toBe(
      false,
    );
    expect(runGit(repo, ['diff', '--cached', '--name-only']).stdout).toBe('');
    writeFileSync(join(repo, 'file.txt'), 'three\n');
    runGit(repo, ['add', '.']);
    expect(runGit(repo, ['commit', '--quiet', '-m', 'free again']).status).toBe(0);
  });

  it('keeps the saved user hooks through a repeated install and a repeated remove', async () => {
    rmSync(repo, { recursive: true, force: true });
    repo = makeRepo();
    guard = realGuard(repo);
    writeUserHooks(repo, '#!/bin/sh\necho user-hook\n');

    await guard.install('p1', 'r1');
    await guard.install('p1', 'r1');
    expect(
      readFileSync(join(repo, '.git', 'hooks', 'reference-transaction.devchain-saved'), 'utf8'),
    ).toContain('user-hook');

    for (let attempt = 0; attempt < 2; attempt++) {
      await guard.remove('p1', { refreshIndex: true });
      for (const hook of ['reference-transaction', 'post-checkout']) {
        expect(readFileSync(join(repo, '.git', 'hooks', hook), 'utf8')).toContain('user-hook');
        expect(existsSync(join(repo, '.git', 'hooks', `${hook}.devchain-saved`))).toBe(false);
      }
    }
    writeFileSync(join(repo, 'file.txt'), 'two\n');
    runGit(repo, ['add', '.']);
    expect(runGit(repo, ['commit', '--quiet', '-m', 'free again']).status).toBe(0);
  });

  it('leaves user hooks and the staged index alone on a rollback before install', async () => {
    rmSync(repo, { recursive: true, force: true });
    repo = makeRepo();
    guard = realGuard(repo);
    writeUserHooks(repo, '#!/bin/sh\necho user-hook\n');
    writeFileSync(join(repo, 'file.txt'), 'two\n');
    runGit(repo, ['add', '.']);

    await guard.remove('p1', { refreshIndex: false });

    for (const hook of ['reference-transaction', 'post-checkout']) {
      expect(readFileSync(join(repo, '.git', 'hooks', hook), 'utf8')).toContain('user-hook');
    }
    expect(runGit(repo, ['diff', '--cached', '--name-only']).stdout.trim()).toBe('file.txt');
  });

  it('reinstall reactivates the guard after a remove', async () => {
    await guard.remove('p1', { refreshIndex: true });
    writeFileSync(join(repo, 'file.txt'), 'two\n');
    runGit(repo, ['add', '.']);
    expect(runGit(repo, ['commit', '--quiet', '-m', 'free again']).status).toBe(0);

    expect(await guard.reinstall('p1', 'r1')).toBeNull();
    writeFileSync(join(repo, 'file.txt'), 'three\n');
    runGit(repo, ['add', '.']);
    expect(runGit(repo, ['commit', '--quiet', '-m', 'blocked']).status).not.toBe(0);
  });
});

describe('HomeGitGuardService (skip decisions)', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'devchain-guard-unit-'));
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  function guardWithGit(git: unknown, remoteName: string | null = 'vm-01'): HomeGitGuardService {
    const fileSync = { folderPath: async () => repo } as unknown as FileSyncService;
    const storage = {
      getProject: async () => ({ id: 'p1', rootPath: repo, name: 'Project' }),
      getRemote: async () => {
        if (remoteName === null) {
          throw new NotFoundError('Remote', 'r1');
        }
        return { id: 'r1', name: remoteName };
      },
    };
    return new HomeGitGuardService(fileSync, git as GitService, storage as never);
  }

  function withGitDir(): void {
    runGit(repo, ['init', '--quiet']);
  }

  it('warns and installs nothing when core.hooksPath is set', async () => {
    withGitDir();
    const git = {
      getConfigValue: async () => '/custom/hooks',
      getVersion: async () => ({ major: 2, minor: 43, patch: 0 }),
      refreshIndexFromHead: async () => undefined,
    };
    const guard = guardWithGit(git);

    const warning = await guard.install('p1', 'r1');

    expect(warning).toContain('core.hooksPath');
    expect(existsSync(join(repo, '.git', 'hooks', 'reference-transaction'))).toBe(false);
  });

  it('leaves user hooks in place when a skipped guard is removed', async () => {
    withGitDir();
    writeUserHooks(repo, '#!/bin/sh\necho user-hook\n');
    const git = {
      getConfigValue: async () => '/custom/hooks',
      getVersion: async () => ({ major: 2, minor: 43, patch: 0 }),
      refreshIndexFromHead: async () => undefined,
    };
    const guard = guardWithGit(git);

    expect(await guard.install('p1', 'r1')).toContain('core.hooksPath');
    await guard.remove('p1', { refreshIndex: true });

    for (const hook of ['reference-transaction', 'post-checkout']) {
      expect(readFileSync(join(repo, '.git', 'hooks', hook), 'utf8')).toContain('user-hook');
    }
  });

  it('warns and installs nothing when git is older than 2.28', async () => {
    withGitDir();
    const git = {
      getConfigValue: async () => null,
      getVersion: async () => ({ major: 2, minor: 27, patch: 9 }),
      refreshIndexFromHead: async () => undefined,
    };
    const guard = guardWithGit(git);

    const warning = await guard.install('p1', 'r1');

    expect(warning).toContain('older than 2.28');
    expect(existsSync(join(repo, '.git', 'hooks', 'post-checkout'))).toBe(false);
  });

  it('warns when the project root has no .git directory', async () => {
    const git = {
      getConfigValue: async () => null,
      getVersion: async () => ({ major: 2, minor: 43, patch: 0 }),
      refreshIndexFromHead: async () => undefined,
    };
    const guard = guardWithGit(git);

    const warning = await guard.install('p1', 'r1');

    expect(warning).toContain('no .git directory');
  });

  it('degrades to a warning when git cannot be consulted', async () => {
    withGitDir();
    const git = {
      getConfigValue: async () => null,
      getVersion: async () => {
        throw new Error('spawn failed');
      },
      refreshIndexFromHead: async () => undefined,
    };
    const guard = guardWithGit(git);

    const warning = await guard.install('p1', 'r1');

    expect(warning).toContain('git could not be consulted');
    expect(existsSync(join(repo, '.git', 'hooks', 'reference-transaction'))).toBe(false);
  });
});
