import { Injectable } from '@nestjs/common';
import {
  ProcessExecutor,
  type ExecutorResult,
} from '../terminal/services/process-executor/process-executor.port';
import { WorktreeError } from './worktrees.errors';

type GitRunOptions = { env?: Readonly<Record<string, string>> };

/** True when Git timed out, overflowed its output limit, or exited with a code outside `allowed`. */
export function gitFailed(result: ExecutorResult, allowed: readonly number[] = [0]): boolean {
  return (
    result.timedOut ||
    result.truncated ||
    result.exitCode === null ||
    !allowed.includes(result.exitCode)
  );
}

@Injectable()
export class WorktreeGitRunner {
  constructor(private readonly executor: ProcessExecutor) {}

  async run(
    rootPath: string,
    args: readonly string[],
    options?: GitRunOptions,
  ): Promise<ExecutorResult> {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    return this.executor.run({
      argv: ['git', '-C', rootPath, ...args],
      mode: 'pipe',
      cwd: rootPath,
      // Lane Git already runs under a coordinator permit; the shim must not acquire it again.
      env: { ...env, ...options?.env, GIT_TERMINAL_PROMPT: '0', DEVCHAIN_GIT_BYPASS: '1' },
      timeout: 30_000,
      outputLimits: { maxBytes: 10 * 1024 * 1024 },
    });
  }

  async require(
    rootPath: string,
    args: readonly string[],
    options?: GitRunOptions,
  ): Promise<string> {
    const result = await this.run(rootPath, args, options);
    if (gitFailed(result)) {
      throw new WorktreeError('WORKTREE_GIT_FAILED', 'Git command failed.', 500, {
        exitCode: result.exitCode,
        stderr: result.stderr,
        timedOut: result.timedOut,
        truncated: result.truncated,
      });
    }
    return result.stdout;
  }
}
