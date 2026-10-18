import { Injectable } from '@nestjs/common';
import type { UsageWindow } from '@devchain/shared';
import { spawn } from 'child_process';
import { getAppVersion } from '../../../common/app-version';
import { applyProviderCliNoUpdate } from '../../providers/adapters/provider-cli-policy';
import type {
  ProviderUsageAccount,
  ProviderUsageChecker,
  ProviderUsageCheckResult,
} from '../provider-usage.types';
import { isObject, standardWindow, type JsonObject } from './checker-helpers';
import { ensureUsageCheckCwd } from './private-cwd';

export const CODEX_USAGE_TIMEOUT_MS = 20_000;
export const CODEX_USAGE_MAX_OUTPUT_BYTES = 256 * 1024;
const KILL_GRACE_MS = 2_000;
const PLAN_RE = /^[A-Za-z0-9_-]{1,40}$/;

const INITIALIZE_ID = 1;
const RATE_LIMITS_ID = 2;

/**
 * Reads a Codex login through `codex app-server` (JSON-RPC over stdio, one JSON object per
 * line). The server exits as soon as stdin reaches EOF, so this spawns the process itself and
 * keeps stdin open until the rate-limit reply arrives; `ProcessExecutor.run()` closes stdin.
 */
@Injectable()
export class CodexChecker implements ProviderUsageChecker {
  readonly kind = 'codex' as const;

  async check(
    _account: ProviderUsageAccount,
    env: Readonly<Record<string, string>>,
    binPath: string,
  ): Promise<ProviderUsageCheckResult> {
    const command = applyProviderCliNoUpdate('codex', [binPath, 'app-server'], env);
    const cwd = await ensureUsageCheckCwd('codex-cwd');
    const rateLimits = await readRateLimits(command.argv, command.env, cwd);
    if (!isObject(rateLimits)) throw new Error('codex app-server returned no rate limits');
    return mapCodexRateLimits(rateLimits);
  }
}

/** Plans differ in which windows they report, so the window kind comes from its duration. */
function mapCodexRateLimits(limits: JsonObject): ProviderUsageCheckResult {
  const windows = [limits.primary, limits.secondary].flatMap((raw) => {
    const window = mapWindow(raw);
    return window ? [window] : [];
  });
  const plan =
    typeof limits.planType === 'string' && PLAN_RE.test(limits.planType) ? limits.planType : null;

  if (plan === null && windows.length === 0) {
    return { kind: 'not-available', error: 'No subscription usage' };
  }
  const unique = windows.filter((w, index) => windows.findIndex((o) => o.id === w.id) === index);
  return { kind: 'ok', windows: unique, extras: [], plan, source: 'cli' };
}

function mapWindow(raw: unknown): UsageWindow | null {
  if (!isObject(raw)) return null;
  const { usedPercent, resetsAt, windowDurationMins } = raw;
  if (typeof usedPercent !== 'number' || !Number.isFinite(usedPercent) || usedPercent < 0) {
    return null;
  }
  const reset = typeof resetsAt === 'number' && Number.isFinite(resetsAt) ? resetsAt : null;
  const minutes =
    typeof windowDurationMins === 'number' && windowDurationMins > 0 ? windowDurationMins : null;

  if (minutes === 300) return standardWindow('5h', usedPercent, reset);
  if (minutes === 10080) return standardWindow('weekly', usedPercent, reset);
  const hours = minutes === null ? null : Math.round((minutes / 60) * 10) / 10;
  return {
    id: minutes === null ? 'other' : `other-${minutes}`,
    label: hours === null ? 'Usage limit' : `${hours} h limit`,
    kind: 'other',
    usedPercent,
    resetsAt: reset,
  };
}

function readRateLimits(
  argv: readonly string[],
  env: Record<string, string>,
  cwd: string,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      env,
      shell: false,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let buffer = '';
    let bytes = 0;
    let done = false;
    let exited = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const send = (message: JsonObject): void => {
      child.stdin?.write(`${JSON.stringify(message)}\n`);
    };
    const stop = (): void => {
      clearTimeout(timer);
      if (exited) return;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
      killTimer.unref?.();
    };
    const finish = (outcome: { value: unknown } | { error: string }): void => {
      if (done) return;
      done = true;
      stop();
      if ('error' in outcome) reject(new Error(outcome.error));
      else resolve(outcome.value);
    };
    const timer = setTimeout(
      () => finish({ error: 'codex app-server timed out' }),
      CODEX_USAGE_TIMEOUT_MS,
    );

    const handleLine = (line: string): void => {
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (!isObject(message)) return;
      if (message.id === INITIALIZE_ID) {
        if (message.error !== undefined)
          return finish({ error: 'codex app-server rejected initialize' });
        send({ method: 'initialized' });
        send({ id: RATE_LIMITS_ID, method: 'account/rateLimits/read' });
      } else if (message.id === RATE_LIMITS_ID) {
        if (message.error !== undefined || !isObject(message.result)) {
          return finish({ error: 'codex app-server returned an error' });
        }
        finish({ value: message.result.rateLimits });
      }
    };

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > CODEX_USAGE_MAX_OUTPUT_BYTES) {
        return finish({ error: 'codex app-server output too large' });
      }
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) handleLine(line);
        newline = buffer.indexOf('\n');
      }
    });
    child.stdin?.on('error', () => undefined);
    child.on('error', () => finish({ error: 'codex app-server failed to start' }));
    child.on('close', () => {
      exited = true;
      clearTimeout(killTimer);
      finish({ error: 'codex app-server exited before replying' });
    });

    send({
      id: INITIALIZE_ID,
      method: 'initialize',
      params: { clientInfo: { name: 'devchain', version: getAppVersion() } },
    });
  });
}
