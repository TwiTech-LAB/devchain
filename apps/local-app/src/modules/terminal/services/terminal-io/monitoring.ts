import type { ProcessExecutor } from '../process-executor/process-executor.port';
import type { SessionTarget, HealthResult, WaitForOutputOptions } from './types';
import { captureHistory } from './capture';

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
