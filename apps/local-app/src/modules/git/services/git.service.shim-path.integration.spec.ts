import { execFileSync } from 'child_process';
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
import { delimiter, join } from 'path';
import { removeGitShimFromPath } from '../../../common/git-shim-paths';
import { ChildProcessExecutor } from '../../terminal/services/process-executor/child-process-executor';
import type {
  ExecutorResult,
  ProcessExecutorOptions,
} from '../../terminal/services/process-executor/process-executor.port';
import { GitService } from './git.service';

// Jest hands tests a copy of process.env, so a child spawned with no env still gets the real
// one. Passing PATH explicitly gives the child the PATH the app edited.
class AppPathExecutor extends ChildProcessExecutor {
  run(options: ProcessExecutorOptions): Promise<ExecutorResult> {
    return super.run({ ...options, env: { PATH: process.env.PATH ?? '' } });
  }
}

// DevChain's own Git must never reach the shim: the shim classes
// `git read-tree HEAD` as a write and hands Git to the supervisor.
describe('GitService with a shim first on PATH', () => {
  const originalPath = process.env.PATH;
  let sandbox: string;
  let repo: string;
  let shimBin: string;
  let calls: string;

  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, PATH: originalPath },
    });

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'git-shim-path-'));
    repo = join(sandbox, 'repo');
    shimBin = join(sandbox, 'shim', 'bin');
    calls = join(sandbox, 'shim-calls.log');
    mkdirSync(repo);
    mkdirSync(shimBin, { recursive: true });
    writeFileSync(join(shimBin, 'git'), `#!/bin/sh\necho "$@" >> '${calls}'\nexit 1\n`);
    chmodSync(join(shimBin, 'git'), 0o755);

    git('init', '-q');
    writeFileSync(join(repo, 'a.txt'), 'a\n');
    git('add', 'a.txt');
    git('commit', '-q', '-m', 'init');
    rmSync(join(repo, '.git', 'index'));
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('rebuilds the index without running the shim once the startup filter has run', async () => {
    process.env.PATH = `${shimBin}/${delimiter}${originalPath}`;
    removeGitShimFromPath(process.env, shimBin);
    const service = new GitService({ getProject: jest.fn() } as never, new AppPathExecutor());

    await service.refreshIndexFromHead('project-1', repo);

    expect(git('ls-files').trim()).toBe('a.txt');
    expect(existsSync(calls) ? readFileSync(calls, 'utf8') : '').toBe('');
  });
});
