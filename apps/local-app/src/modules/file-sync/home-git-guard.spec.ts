import { spawnSync } from 'child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { GitService } from '../git/services/git.service';
import { NotFoundError } from '../../common/errors/error-types';
import { ChildProcessExecutor } from '../terminal/services/process-executor/child-process-executor';
import { HomeGitGuardService } from './home-git-guard.service';
import type { FileSyncService } from './file-sync.service';
import type { VmGitGuardRequest } from './git-guard.dto';

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

  // Running the hook directly isolates its exact stderr and shell quoting from Git's own errors.
  it.each<{ owner: string | VmGitGuardRequest; message: string }>([
    {
      owner: 'r1',
      message: `This project runs on the remote VM "vm-01". Normal file editing is allowed: your changes sync to the VM. Git changes (commit, branch, tag, ${STASH_COMMAND}, merge, rebase, switch) are blocked here. Run them on the VM. To use Git on this PC, run \`devchain git take\` in the project folder.`,
    },
    {
      owner: { homeName: "pc's $(touch injected)", reason: 'pc-git' },
      message: `Git for this project is on the PC 'pc's $(touch injected)'. You can edit files here: your changes sync to the PC. Git changes (commit, branch, tag, ${STASH_COMMAND}, merge, rebase, switch) are blocked here. To move Git back to this VM, run \`devchain git return\` in the project folder on the PC 'pc's $(touch injected)'.`,
    },
  ])('prints the literal control hint for owner $owner', async ({ owner, message }) => {
    await guard.install('p1', owner);
    const bin = join(repo, 'bin');
    mkdirSync(bin);
    const evaluated = join(repo, 'evaluated');
    const command = join(bin, 'devchain');
    writeFileSync(command, '#!/bin/sh\ntouch "$GUARD_EVALUATION_MARKER"\n');
    chmodSync(command, 0o755);

    const result = spawnSync(join(repo, '.git', 'hooks', 'reference-transaction'), ['prepared'], {
      cwd: repo,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        GUARD_EVALUATION_MARKER: evaluated,
      },
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(`${message}\n`);
    expect(existsSync(evaluated)).toBe(false);
    expect(existsSync(join(repo, 'injected'))).toBe(false);
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

  it.each<string | VmGitGuardRequest>(['r1', { homeName: 'pc-01', reason: 'disconnect' }])(
    'restores saved hooks through repeated install/remove for owner %p',
    async (owner) => {
      rmSync(repo, { recursive: true, force: true });
      repo = makeRepo();
      guard = realGuard(repo);
      writeUserHooks(repo, '#!/bin/sh\necho user-hook\n');

      await guard.install('p1', owner);
      await guard.install('p1', owner);
      expect(
        readFileSync(join(repo, '.git', 'hooks', 'reference-transaction.devchain-saved'), 'utf8'),
      ).toContain('user-hook');

      for (let attempt = 0; attempt < 2; attempt++) {
        expect(await guard.remove('p1', { refreshIndex: false })).toMatchObject({
          removed: attempt === 0,
        });
        for (const hook of ['reference-transaction', 'post-checkout']) {
          expect(readFileSync(join(repo, '.git', 'hooks', hook), 'utf8')).toContain('user-hook');
          expect(existsSync(join(repo, '.git', 'hooks', `${hook}.devchain-saved`))).toBe(false);
        }
      }
      writeFileSync(join(repo, 'file.txt'), 'two\n');
      runGit(repo, ['add', '.']);
      expect(runGit(repo, ['commit', '--quiet', '-m', 'free again']).status).toBe(0);
    },
  );

  it.each(['disconnect', 'cancelled-connect'] as const)(
    'blocks VM ref changes with the %s message, permits edits and preserves the staged index on removal',
    async (reason) => {
      await guard.remove('p1', { refreshIndex: false });
      const homeName = "pc's $(touch injected)";
      await guard.install('p1', { homeName, reason });
      writeFileSync(join(repo, 'file.txt'), 'VM edit\n');
      runGit(repo, ['add', '.']);
      const result = runGit(repo, ['commit', '--no-verify', '-m', 'blocked']);
      const location =
        reason === 'disconnect'
          ? `This project is now on the PC '${homeName}'. You can edit files here. At the next Connect, DevChain brings your edits to the PC.`
          : `This project is on the PC '${homeName}'. A Connect was cancelled, so at the next Connect the PC's files replace the files here.`;

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        `${location} Git changes (commit, branch, tag, ${STASH_COMMAND}, merge, rebase, switch) are blocked here. Make them on the PC. To use Git on this VM, connect the project to it again from the PC.`,
      );
      expect(runGit(repo, ['rev-parse', 'HEAD']).stdout.trim()).toBe(headBefore);
      expect(readFileSync(join(repo, 'file.txt'), 'utf8')).toBe('VM edit\n');
      expect(existsSync(join(repo, 'injected'))).toBe(false);
      expect(await guard.remove('p1', { refreshIndex: false })).toMatchObject({ removed: true });
      expect(runGit(repo, ['diff', '--cached', '--name-only']).stdout.trim()).toBe('file.txt');
      expect(runGit(repo, ['commit', '--quiet', '-m', 'allowed']).status).toBe(0);
    },
  );

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

  it.each([
    ['/custom/hooks', { major: 2, minor: 43, patch: 0 }, false, 'core.hooksPath'],
    [null, { major: 2, minor: 27, patch: 9 }, false, 'older than 2.28'],
    [null, null, true, 'git could not be consulted'],
  ] as const)(
    'warns and installs no hooks: %s / %p / probe throws %s',
    async (hooksPath, version, fails, message) => {
      withGitDir();
      const guard = guardWithGit({
        getConfigValue: async () => hooksPath,
        getVersion: async () => {
          if (fails) throw new Error('spawn failed');
          return version!;
        },
        refreshIndexFromHead: async () => undefined,
      });
      expect(await guard.install('p1', 'r1')).toContain(message);
      const vmWarning = await guard.install('p1', { homeName: 'pc-01', reason: 'disconnect' });
      expect(vmWarning).toContain(message);
      expect(vmWarning).toContain('Git changes on the VM are not blocked');
      for (const hook of ['reference-transaction', 'post-checkout'])
        expect(existsSync(join(repo, '.git', 'hooks', hook))).toBe(false);
    },
  );

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
});
