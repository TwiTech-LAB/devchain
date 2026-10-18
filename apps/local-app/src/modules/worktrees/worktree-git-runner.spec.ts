// The ProcessExecutor boundary is sufficient to prove argv, timeout and exit-code contracts.
import { Test } from '@nestjs/testing';
import { FakeProcessExecutor } from '../terminal/services/process-executor/fake-process-executor';
import { ProcessExecutor } from '../terminal/services/process-executor/process-executor.port';
import { WorktreeGitRunner } from './worktree-git-runner';

describe('WorktreeGitRunner', () => {
  let runner: WorktreeGitRunner;
  let executor: FakeProcessExecutor;

  beforeEach(async () => {
    executor = new FakeProcessExecutor();
    const module = await Test.createTestingModule({
      providers: [WorktreeGitRunner, { provide: ProcessExecutor, useValue: executor }],
    }).compile();
    runner = module.get(WorktreeGitRunner);
  });

  it('uses pipe argv and disables prompts without evaluating shell metacharacters', async () => {
    const run = jest.spyOn(executor, 'run');
    executor.enqueueResponse({
      type: 'failure',
      exitCode: 1,
      stdout: 'conflict paths',
      stderr: 'conflict',
    });
    const result = await runner.run('/tmp/path with spaces', ['merge-tree', '$(touch marker)']);
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        argv: ['git', '-C', '/tmp/path with spaces', 'merge-tree', '$(touch marker)'],
        mode: 'pipe',
        timeout: 30_000,
        env: expect.objectContaining({ GIT_TERMINAL_PROMPT: '0', PATH: process.env.PATH }),
      }),
    );
    expect(result).toMatchObject({ exitCode: 1, stdout: 'conflict paths', stderr: 'conflict' });
  });

  it('scopes temporary-index overrides to one Git call without changing process environment', async () => {
    const before = process.env.GIT_INDEX_FILE;
    await runner.require('/tmp/repo', ['add', '-A'], {
      env: { GIT_INDEX_FILE: '/tmp/copied-index' },
    });
    await runner.run('/tmp/repo', ['status']);
    expect(executor.calls.map((call) => call.env?.GIT_INDEX_FILE)).toEqual([
      '/tmp/copied-index',
      before,
    ]);
    expect(process.env.GIT_INDEX_FILE).toBe(before);
  });

  it.each([
    { exitCode: null, timedOut: true, truncated: false },
    { exitCode: 0, timedOut: false, truncated: true },
    { exitCode: 128, timedOut: false, truncated: false },
  ])('refuses incomplete or failed output: %j', async (flags) => {
    jest
      .spyOn(executor, 'run')
      .mockResolvedValue({ success: false, stdout: '', stderr: 'git diagnostic', ...flags });
    await expect(runner.require('/tmp/repo', ['status'])).rejects.toMatchObject({
      code: 'WORKTREE_GIT_FAILED',
      details: { stderr: 'git diagnostic', ...flags },
    });
  });
});
