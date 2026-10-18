import { Injectable } from '@nestjs/common';
import type { UsageWindow } from '@devchain/shared';
import { applyProviderCliNoUpdate } from '../../providers/adapters/provider-cli-policy';
import { ProviderCliVersionProbe } from '../../providers/services/provider-cli-version-probe.service';
import { ProcessExecutor } from '../../terminal/services/process-executor/process-executor.port';
import type {
  ProviderUsageAccount,
  ProviderUsageChecker,
  ProviderUsageCheckResult,
} from '../provider-usage.types';
import { isObject, type JsonObject } from './checker-helpers';
import { ensureUsageCheckCwd } from './private-cwd';

export const AGY_USAGE_TIMEOUT_MS = 20_000;
export const AGY_USAGE_MAX_OUTPUT_BYTES = 64 * 1024;
/** Older agy builds send `-p /usage` to the model as a paid prompt. */
export const AGY_MIN_VERSION = [1, 2, 8] as const;

/**
 * Reads an agy login through `agy -p /usage --output-format json`. The command is free only
 * where `/usage` is a built-in command, so the version is checked first and the answer must
 * be the `usage` command with zero model turns; anything else stops the checks of that account
 * until the app restarts.
 */
@Injectable()
export class AgyChecker implements ProviderUsageChecker {
  readonly kind = 'agy' as const;
  private readonly versionVerified = new Set<string>();
  private readonly blocked = new Map<string, string>();

  constructor(
    private readonly executor: ProcessExecutor,
    private readonly versionProbe: ProviderCliVersionProbe,
  ) {}

  async check(
    account: ProviderUsageAccount,
    env: Readonly<Record<string, string>>,
    binPath: string,
  ): Promise<ProviderUsageCheckResult> {
    const blockedReason = this.blocked.get(account.key);
    if (blockedReason !== undefined) return { kind: 'unsupported', error: blockedReason };

    if (!this.versionVerified.has(account.key)) {
      const version = parseVersion(await this.versionProbe.probe('agy', binPath));
      if (version === null) throw new Error('agy version not recognized');
      if (compareVersions(version, AGY_MIN_VERSION) < 0) {
        return {
          kind: 'unsupported',
          error: `agy ${AGY_MIN_VERSION.join('.')} or newer is required`,
        };
      }
      this.versionVerified.add(account.key);
    }

    const command = applyProviderCliNoUpdate(
      'agy',
      [binPath, '-p', '/usage', '--output-format', 'json'],
      env,
    );
    const result = await this.executor.run({
      argv: command.argv,
      mode: 'pipe',
      cwd: await ensureUsageCheckCwd('agy-cwd'),
      env: command.env,
      timeout: AGY_USAGE_TIMEOUT_MS,
      outputLimits: { maxBytes: AGY_USAGE_MAX_OUTPUT_BYTES },
    });
    if (result.timedOut) throw new Error('agy /usage timed out');

    const usage = parseUsageCommand(result.stdout);
    if (usage === null) {
      if (!result.success) throw new Error(`agy /usage failed (exit ${result.exitCode})`);
      const reason = 'agy did not answer /usage as a command';
      this.blocked.set(account.key, reason);
      return { kind: 'unsupported', error: reason };
    }

    const groups = mapGroups(usage);
    if (groups === null) throw new Error('usage format not recognized');
    return { kind: 'ok', windows: [], extras: groups, plan: null, source: 'cli' };
  }
}

/** The `command.data` object, only when the answer is the `usage` command that used no model turn. */
function parseUsageCommand(stdout: string): JsonObject | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!isObject(parsed) || parsed.num_turns !== 0 || !isObject(parsed.command)) return null;
  if (parsed.command.name !== 'usage') return null;
  return isObject(parsed.command.data) ? parsed.command.data : {};
}

/** One window per bucket, labelled with its group; null when no bucket parses. */
function mapGroups(data: JsonObject): UsageWindow[] | null {
  if (!Array.isArray(data.groups)) return null;
  const windows: UsageWindow[] = [];
  data.groups.forEach((group: unknown, groupIndex: number) => {
    if (!isObject(group) || typeof group.name !== 'string' || !Array.isArray(group.buckets)) return;
    group.buckets.forEach((bucket: unknown, bucketIndex: number) => {
      if (!isObject(bucket)) return;
      const { id, window, remaining_fraction: remaining, reset_time: resetTime } = bucket;
      if (typeof remaining !== 'number' || !Number.isFinite(remaining)) return;
      const resetMs = typeof resetTime === 'string' ? Date.parse(resetTime) : NaN;
      windows.push({
        id: typeof id === 'string' && id ? id : `group-${groupIndex}-${bucketIndex}`,
        label: group.name as string,
        kind: window === 'weekly' ? 'weekly' : 'other',
        usedPercent: Math.max(0, Math.round((1 - remaining) * 1000) / 10),
        resetsAt: Number.isNaN(resetMs) ? null : Math.floor(resetMs / 1000),
      });
    });
  });
  return windows.length > 0 ? windows : null;
}

function parseVersion(text: string): [number, number, number] | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compareVersions(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}
