import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type {
  ProviderUsageResponse,
  ProviderUsageSettings,
  UsageSnapshot,
  UsageSnapshotState,
  UsageWindow,
} from '@devchain/shared';
import { createLogger } from '../../../common/logging/logger';
import { EventsService } from '../../events/services/events.service';
import { SettingsService } from '../../settings/services/settings.service';
import { SessionRowStore } from '../../storage/sessions/session-row.store';
import {
  PROVIDER_USAGE_CHECKERS,
  type ProviderUsageAccount,
  type ProviderUsageChecker,
  type ProviderUsageCheckerKind,
  type ProviderUsageCheckResult,
} from '../provider-usage.types';
import {
  createMemo,
  ProviderUsageAccountsService,
  type ResolvedUsageAccount,
  type ResolveMemo,
} from './provider-usage-accounts.service';

const logger = createLogger('ProviderUsageService');

export const PROVIDER_USAGE_TICK_MS = 60_000;
export const PROVIDER_USAGE_MAX_PARALLEL_CHECKS = 2;
export const PROVIDER_USAGE_CHECK_TIMEOUT_MS = 60_000;
const MAX_ERROR_LENGTH = 300;
/** Shorter env values (flags, ports) would redact ordinary words in an error. */
const MIN_REDACTED_VALUE_LENGTH = 8;

type UsageData = Pick<UsageSnapshot, 'windows' | 'extras' | 'plan' | 'source' | 'fetchedAt'>;

interface CacheEntry extends UsageData {
  /** Null until the first check finishes. */
  state: Exclude<UsageSnapshotState, 'stale'> | null;
  error: string | null;
  /** Epoch ms of the last finished check, failed or not. Drives the refresh rules. */
  checkedAt: number | null;
  inflight: Promise<void> | null;
}

/**
 * Usage snapshots of this machine's accounts, shared by all its projects. Token accounts
 * are checked only by the timer, while one of their sessions runs: their check spends tokens.
 */
@Injectable()
export class ProviderUsageService implements OnModuleInit, OnModuleDestroy {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly checkers: ReadonlyMap<ProviderUsageCheckerKind, ProviderUsageChecker>;
  private readonly waitingForSlot: Array<() => void> = [];
  private activeChecks = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(
    private readonly accounts: ProviderUsageAccountsService,
    private readonly settings: SettingsService,
    private readonly sessionRows: SessionRowStore,
    private readonly events: EventsService,
    @Inject(PROVIDER_USAGE_CHECKERS) checkers: ProviderUsageChecker[],
  ) {
    this.checkers = new Map(checkers.map((checker) => [checker.kind, checker]));
  }

  onModuleInit(): void {
    this.timer = setInterval(() => void this.tick(), PROVIDER_USAGE_TICK_MS);
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Returns the cached data at once. With `maxAgeSec`, starts a background check of
   * each non-token account whose last check is older.
   */
  async getProjectUsage(projectId: string, maxAgeSec?: number): Promise<ProviderUsageResponse> {
    const config = this.settings.getProviderUsageConfig();
    if (!config.enabled) return { accounts: [], config };

    const resolved = await this.accounts.listForProject(projectId);
    if (maxAgeSec !== undefined) {
      for (const item of resolved) {
        if (item.account.kind !== 'claude-token' && this.isDue(item.account, maxAgeSec * 1000)) {
          void this.requestCheck(item);
        }
      }
    }
    return {
      accounts: resolved.map((item) => this.toSnapshot(item.account, config)),
      config,
    };
  }

  /** Checks the accounts of running sessions whose data is older than the configured age. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const config = this.settings.getProviderUsageConfig();
      if (!config.enabled) return;

      const agentIds = new Set<string>();
      for (const session of this.sessionRows.listActiveSessions()) {
        if (session.agentId) agentIds.add(session.agentId);
      }
      const memo = createMemo();
      const seen = new Set<string>();
      for (const agentId of agentIds) {
        const resolved = await this.resolveRunningAgent(agentId, memo);
        if (!resolved || seen.has(resolved.account.key)) continue;
        seen.add(resolved.account.key);
        const maxAgeMs = this.runningMaxAgeMs(resolved.account, config);
        if (maxAgeMs !== null && this.isDue(resolved.account, maxAgeMs)) {
          void this.requestCheck(resolved);
        }
      }
    } catch (error) {
      logger.warn({ error: errorName(error) }, 'Provider usage tick failed');
    } finally {
      this.ticking = false;
    }
  }

  /** Single flight per account; at most `PROVIDER_USAGE_MAX_PARALLEL_CHECKS` run at once. */
  requestCheck(resolved: ResolvedUsageAccount): Promise<void> {
    const entry = this.entryFor(resolved.account.key);
    if (entry.inflight) return entry.inflight;
    const checker = this.checkers.get(resolved.account.kind);
    if (!checker) return Promise.resolve();

    entry.inflight = this.runCheck(entry, checker, resolved).finally(() => {
      entry.inflight = null;
    });
    return entry.inflight;
  }

  private async runCheck(
    entry: CacheEntry,
    checker: ProviderUsageChecker,
    { account, env, binPath }: ResolvedUsageAccount,
  ): Promise<void> {
    await this.acquireSlot();
    try {
      const result: ProviderUsageCheckResult = binPath
        ? await withTimeout(checker.check(account, env, binPath), PROVIDER_USAGE_CHECK_TIMEOUT_MS)
        : { kind: 'not-available', error: 'The provider binary path is not set.' };
      if (result.kind === 'ok') {
        entry.windows = result.windows;
        entry.extras = result.extras;
        entry.plan = result.plan;
        entry.source = result.source;
        entry.fetchedAt = new Date().toISOString();
        entry.state = 'ok';
        entry.error = null;
      } else {
        Object.assign(entry, emptyUsage());
        entry.state = result.kind;
        entry.error = redactEnvValues(result.error, env);
      }
    } catch (error) {
      entry.state = 'error';
      entry.error = redactEnvValues(
        error instanceof Error ? error.message : 'The usage check failed.',
        env,
      );
      logger.warn(
        { provider: account.provider, kind: account.kind, error: entry.error },
        'Provider usage check failed',
      );
    } finally {
      entry.checkedAt = Date.now();
      this.releaseSlot();
    }
    await this.publishUpdated(account.key);
  }

  private async acquireSlot(): Promise<void> {
    if (this.activeChecks < PROVIDER_USAGE_MAX_PARALLEL_CHECKS) {
      this.activeChecks++;
      return;
    }
    // The releasing check hands its slot over, so the count stays unchanged.
    await new Promise<void>((resolve) => this.waitingForSlot.push(resolve));
  }

  private releaseSlot(): void {
    const next = this.waitingForSlot.shift();
    if (next) next();
    else this.activeChecks--;
  }

  private async publishUpdated(accountKey: string): Promise<void> {
    try {
      await this.events.publish('provider-usage.updated', { accountKey });
    } catch (error) {
      logger.warn({ error: errorName(error) }, 'Failed to publish provider usage update');
    }
  }

  private async resolveRunningAgent(
    agentId: string,
    memo: ResolveMemo,
  ): Promise<ResolvedUsageAccount | null> {
    try {
      return await this.accounts.resolveForAgent(agentId, memo);
    } catch (error) {
      // A session can outlive its agent row or provider config.
      logger.debug({ error: errorName(error) }, 'Skipping a running session without an account');
      return null;
    }
  }

  private runningMaxAgeMs(
    account: ProviderUsageAccount,
    config: ProviderUsageSettings,
  ): number | null {
    if (account.kind !== 'claude-token') return config.runningMaxAgeMin * 60_000;
    return config.tokenCheckMinutes === 0 ? null : config.tokenCheckMinutes * 60_000;
  }

  private isDue(account: ProviderUsageAccount, maxAgeMs: number): boolean {
    const checkedAt = this.entries.get(account.key)?.checkedAt ?? null;
    return checkedAt === null || Date.now() - checkedAt >= maxAgeMs;
  }

  private entryFor(accountKey: string): CacheEntry {
    let entry = this.entries.get(accountKey);
    if (!entry) {
      entry = { ...emptyUsage(), state: null, error: null, checkedAt: null, inflight: null };
      this.entries.set(accountKey, entry);
    }
    return entry;
  }

  private toSnapshot(account: ProviderUsageAccount, config: ProviderUsageSettings): UsageSnapshot {
    const base = {
      accountKey: account.key,
      provider: account.provider,
      label: account.label,
    };
    if (!this.checkers.has(account.kind)) {
      return { ...base, ...emptyUsage(), state: 'unsupported', error: null };
    }

    const entry = this.entries.get(account.key);
    const nowSec = Date.now() / 1000;
    const fetchedAtMs = entry?.fetchedAt ? Date.parse(entry.fetchedAt) : null;
    const isOld =
      fetchedAtMs === null || Date.now() - fetchedAtMs >= config.openProjectMaxAgeMin * 60_000;
    const state =
      !entry?.state || (entry.state === 'ok' && isOld) ? ('stale' as const) : entry.state;
    return {
      ...base,
      windows: (entry?.windows ?? []).map((window) => expireWindow(window, nowSec)),
      extras: (entry?.extras ?? []).map((window) => expireWindow(window, nowSec)),
      plan: entry?.plan ?? null,
      source: entry?.source ?? null,
      fetchedAt: entry?.fetchedAt ?? null,
      state,
      error: entry?.error ?? null,
    };
  }
}

function emptyUsage(): UsageData {
  return { windows: [], extras: [], plan: null, source: null, fetchedAt: null };
}

/** A window whose reset has passed is empty until a check reads the new window. */
function expireWindow(window: UsageWindow, nowSec: number): UsageWindow {
  return window.resetsAt !== null && window.resetsAt <= nowSec
    ? { ...window, usedPercent: 0, resetsAt: null }
    : window;
}

/** Errors may echo a command line or a request; env values never leave this service. */
function redactEnvValues(message: string, env: Readonly<Record<string, string>>): string {
  const secrets = Object.values(env)
    .filter((value) => value.length >= MIN_REDACTED_VALUE_LENGTH)
    .sort((a, b) => b.length - a.length);
  let redacted = message;
  for (const secret of secrets) {
    if (redacted.includes(secret)) redacted = redacted.split(secret).join('[redacted]');
  }
  return redacted.length > MAX_ERROR_LENGTH ? `${redacted.slice(0, MAX_ERROR_LENGTH)}…` : redacted;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('The usage check timed out.')), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
