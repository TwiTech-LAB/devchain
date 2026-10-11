import type { ProcessExecutor } from '../process-executor/process-executor.port';
import type { SessionTarget, HealthResult, WaitForOutputOptions } from './types';
import { captureHistory } from './capture';
import { readForegroundState } from './foreground';

export async function readCliState(
  executor: ProcessExecutor,
  target: SessionTarget,
  options: { checkSuspended: boolean },
): Promise<'program' | 'shell' | 'unknown'> {
  const foreground = await readForegroundState(executor, target);
  if (!foreground) return 'unknown';
  if (!foreground.shellInFront) return 'program';
  // A caller that has not seen the program yet ignores shell readings, so skip the process scan.
  if (!options.checkSuspended) return 'shell';

  try {
    // Read the process table once: Ctrl+Z returns the shell to the foreground without exiting the CLI.
    const result = await executor.run({
      argv: ['ps', '-e', '-o', 'ppid=,stat='],
      mode: 'pipe',
      timeout: 2000,
      outputLimits: { maxBytes: 1024 * 1024 },
    });
    const stdout = result.stdout.trim();
    if (!result.success || result.timedOut || result.truncated || !stdout) return 'unknown';
    for (const line of stdout.split('\n')) {
      const match = /^\s*(\d+)\s+([A-Za-z+<]+)\s*$/.exec(line);
      if (!match) return 'unknown';
      const parentPid = Number(match[1]);
      if (!Number.isSafeInteger(parentPid)) return 'unknown';
      if (parentPid === foreground.panePid && match[2].startsWith('T')) return 'unknown';
    }
    return 'shell';
  } catch {
    return 'unknown';
  }
}

export async function healthCheck(
  executor: ProcessExecutor,
  target: SessionTarget,
): Promise<HealthResult> {
  const result = await executor.run({
    argv: ['tmux', 'has-session', '-t', `=${target.name}`],
    mode: 'pipe',
  });

  return { alive: result.success };
}

export async function waitForOutput(
  executor: ProcessExecutor,
  target: SessionTarget,
  predicate: (output: string) => boolean,
  options?: WaitForOutputOptions,
): Promise<boolean> {
  const pollIntervalMs = Math.max(1, Math.floor(options?.pollIntervalMs ?? 500));
  const timeoutMs = Math.max(1, Math.floor(options?.timeoutMs ?? 30_000));
  const settleMs = Math.max(0, Math.floor(options?.settleMs ?? 1_000));
  const lines = Math.max(1, Math.floor(options?.lines ?? 150));
  const startedAt = Date.now();

  const baselineResult = await captureHistory(executor, target, lines, false);
  let previous = baselineResult.output;
  let skipFirstPoll = true;
  let outputDetected = false;
  let lastContentChangeAt = 0;

  while (true) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, pollIntervalMs);
    });

    const elapsedAfterSleep = Date.now() - startedAt;
    if (elapsedAfterSleep >= timeoutMs) {
      return false;
    }

    const currentResult = await captureHistory(executor, target, lines, false);
    const current = currentResult.output;

    if (current === '' && previous !== '') {
      continue;
    }

    if (predicate(current)) {
      return true;
    }

    if (skipFirstPoll) {
      skipFirstPoll = false;
      previous = current;
      continue;
    }

    if (!outputDetected) {
      const hasNonEmptyChange = current !== baselineResult.output && current.trim().length > 0;
      if (hasNonEmptyChange) {
        outputDetected = true;
        lastContentChangeAt = Date.now();
      }
      previous = current;
      continue;
    }

    if (current !== previous) {
      previous = current;
      lastContentChangeAt = Date.now();
      continue;
    }

    const settledForMs = Date.now() - lastContentChangeAt;
    if (settledForMs >= settleMs) {
      return false;
    }
  }
}
