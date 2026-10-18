import { PROVIDER_USAGE_SETTINGS_DEFAULTS, type ProviderUsageSettings } from '@devchain/shared';
import type { EventsService } from '../../events/services/events.service';
import type { SettingsService } from '../../settings/services/settings.service';
import type { SessionRowStore } from '../../storage/sessions/session-row.store';
import type {
  ProviderUsageAccount,
  ProviderUsageChecker,
  ProviderUsageCheckerKind,
  ProviderUsageCheckResult,
} from '../provider-usage.types';
import type {
  ProviderUsageAccountsService,
  ResolvedUsageAccount,
} from './provider-usage-accounts.service';
import { PROVIDER_USAGE_TICK_MS, ProviderUsageService } from './provider-usage.service';

// Layer: service unit with fake checkers, accounts and sessions. The refresh rules
// are timing and concurrency decisions inside this service; deferred fake checks and
// fake timers make each decision observable without spawning a CLI.
const NOW = Date.parse('2026-10-17T12:00:00.000Z');
const FAKE_TOKEN = 'sk-ant-oat01-FAKE-TOKEN-VALUE';

const LOGIN = account('claude:login:/home/dev/.claude', 'claude-login');
const TOKEN = account('claude:token:abc123abc123', 'claude-token');
const CODEX = account('codex:/home/dev/.codex:none', 'codex');
const AGY = account('agy:/home/dev', 'agy');

const OK: ProviderUsageCheckResult = {
  kind: 'ok',
  windows: [{ id: '5h', label: '5 h', kind: '5h', usedPercent: 40, resetsAt: NOW / 1000 + 600 }],
  extras: [],
  plan: 'max',
  source: 'cli',
};

function account(key: string, kind: ProviderUsageCheckerKind): ProviderUsageAccount {
  const provider = kind.startsWith('claude') ? 'claude' : (kind as 'codex' | 'agy');
  return { key, provider, kind, label: key };
}

function resolved(target: ProviderUsageAccount): ResolvedUsageAccount {
  return {
    account: target,
    env: { HOME: '/home/dev', CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN },
    binPath: '/usr/bin/cli',
  };
}

/** A checker whose checks finish only when the test settles them. */
class DeferredChecker implements ProviderUsageChecker {
  readonly calls: string[] = [];
  private readonly pending: Array<{
    resolve: (result: ProviderUsageCheckResult) => void;
    reject: (error: Error) => void;
  }> = [];

  constructor(readonly kind: ProviderUsageCheckerKind) {}

  check(target: ProviderUsageAccount): Promise<ProviderUsageCheckResult> {
    this.calls.push(target.key);
    return new Promise((resolve, reject) => this.pending.push({ resolve, reject }));
  }

  settle(result: ProviderUsageCheckResult = OK): void {
    this.pending.shift()?.resolve(result);
  }

  fail(error: Error): void {
    this.pending.shift()?.reject(error);
  }
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('ProviderUsageService', () => {
  let config: ProviderUsageSettings;
  let projectAccounts: ResolvedUsageAccount[];
  let runningAgents: Record<string, ProviderUsageAccount>;
  let checkers: Record<ProviderUsageCheckerKind, DeferredChecker>;
  let events: { publish: jest.Mock };
  let service: ProviderUsageService;

  function createService(kinds: ProviderUsageCheckerKind[]): ProviderUsageService {
    const accounts = {
      listForProject: jest.fn(async () => projectAccounts),
      resolveForAgent: jest.fn(async (agentId: string) =>
        runningAgents[agentId] ? resolved(runningAgents[agentId]) : null,
      ),
    } as unknown as ProviderUsageAccountsService;
    const settings = { getProviderUsageConfig: () => config } as unknown as SettingsService;
    const sessionRows = {
      listActiveSessions: () => Object.keys(runningAgents).map((agentId) => ({ agentId })),
    } as unknown as SessionRowStore;
    return new ProviderUsageService(
      accounts,
      settings,
      sessionRows,
      events as unknown as EventsService,
      kinds.map((kind) => checkers[kind]),
    );
  }

  beforeEach(() => {
    jest.useFakeTimers({ now: NOW, doNotFake: ['setImmediate'] });
    config = { ...PROVIDER_USAGE_SETTINGS_DEFAULTS };
    projectAccounts = [resolved(LOGIN), resolved(CODEX)];
    runningAgents = {};
    checkers = {
      'claude-login': new DeferredChecker('claude-login'),
      'claude-token': new DeferredChecker('claude-token'),
      codex: new DeferredChecker('codex'),
      agy: new DeferredChecker('agy'),
    };
    events = { publish: jest.fn().mockResolvedValue(null) };
    service = createService(['claude-login', 'claude-token', 'codex', 'agy']);
  });

  afterEach(() => {
    service.onModuleDestroy();
    jest.useRealTimers();
  });

  it('returns the cache at once and checks only accounts older than maxAgeSec', async () => {
    const first = await service.getProjectUsage('p1', 60);
    expect(first.accounts.map((a) => [a.accountKey, a.state])).toEqual([
      [LOGIN.key, 'stale'],
      [CODEX.key, 'stale'],
    ]);
    expect(checkers['claude-login'].calls).toEqual([LOGIN.key]);

    checkers['claude-login'].settle();
    await flush();
    const second = await service.getProjectUsage('p1', 60);
    expect(second.accounts[0]).toMatchObject({ state: 'ok', plan: 'max', windows: OK.windows });
    expect(checkers['claude-login'].calls).toHaveLength(1);
    expect(events.publish).toHaveBeenCalledWith('provider-usage.updated', {
      accountKey: LOGIN.key,
    });

    jest.advanceTimersByTime(60_000);
    await service.getProjectUsage('p1', 60);
    expect(checkers['claude-login'].calls).toHaveLength(2);
  });

  it('checks nothing on a GET without maxAgeSec', async () => {
    await service.getProjectUsage('p1');
    expect(checkers['claude-login'].calls).toEqual([]);
  });

  it('runs one check per account at a time', async () => {
    const first = service.requestCheck(resolved(LOGIN));
    const second = service.requestCheck(resolved(LOGIN));
    expect(second).toBe(first);
    await flush();
    expect(checkers['claude-login'].calls).toEqual([LOGIN.key]);
  });

  it('runs at most two checks in parallel on the machine', async () => {
    void service.requestCheck(resolved(LOGIN));
    void service.requestCheck(resolved(CODEX));
    void service.requestCheck(resolved(AGY));
    await flush();
    expect(checkers.agy.calls).toEqual([]);

    checkers.codex.settle();
    await flush();
    expect(checkers.agy.calls).toEqual([AGY.key]);
  });

  it('checks the accounts of running sessions older than runningMaxAgeMin', async () => {
    runningAgents = { a1: LOGIN };
    await service.tick();
    expect(checkers['claude-login'].calls).toEqual([LOGIN.key]);
    expect(checkers.codex.calls).toEqual([]);
    checkers['claude-login'].settle();
    await flush();

    jest.advanceTimersByTime((config.runningMaxAgeMin * 60_000) / 2);
    await service.tick();
    expect(checkers['claude-login'].calls).toHaveLength(1);

    jest.advanceTimersByTime((config.runningMaxAgeMin * 60_000) / 2);
    await service.tick();
    expect(checkers['claude-login'].calls).toHaveLength(2);
  });

  it('runs the tick every minute once the module starts', async () => {
    runningAgents = { a1: LOGIN };
    service.onModuleInit();
    jest.advanceTimersByTime(PROVIDER_USAGE_TICK_MS);
    await flush();
    expect(checkers['claude-login'].calls).toEqual([LOGIN.key]);
  });

  it('never checks a token account from a GET', async () => {
    projectAccounts = [resolved(TOKEN)];
    await service.getProjectUsage('p1', 15);
    expect(checkers['claude-token'].calls).toEqual([]);
  });

  it('checks a running token account at most every tokenCheckMinutes', async () => {
    runningAgents = { a1: TOKEN };
    await service.tick();
    checkers['claude-token'].settle();
    await flush();

    jest.advanceTimersByTime(config.runningMaxAgeMin * 60_000);
    await service.tick();
    expect(checkers['claude-token'].calls).toHaveLength(1);

    jest.advanceTimersByTime((config.tokenCheckMinutes - config.runningMaxAgeMin) * 60_000);
    await service.tick();
    expect(checkers['claude-token'].calls).toHaveLength(2);
  });

  it('stops token checks when tokenCheckMinutes is 0', async () => {
    config = { ...config, tokenCheckMinutes: 0 };
    runningAgents = { a1: TOKEN };
    await service.tick();
    expect(checkers['claude-token'].calls).toEqual([]);
  });

  it('checks nothing and returns no accounts when disabled', async () => {
    config = { ...config, enabled: false };
    runningAgents = { a1: LOGIN };
    await service.tick();
    expect(await service.getProjectUsage('p1', 15)).toEqual({ accounts: [], config });
    expect(checkers['claude-login'].calls).toEqual([]);
  });

  it('reports 0% and no reset time once a window reset has passed', async () => {
    void service.requestCheck(resolved(LOGIN));
    await flush();
    checkers['claude-login'].settle();
    await flush();

    jest.advanceTimersByTime(600_000);
    const { accounts } = await service.getProjectUsage('p1');
    expect(accounts[0].windows[0]).toMatchObject({ usedPercent: 0, resetsAt: null });
  });

  it('keeps the last good windows on a failure and redacts env values', async () => {
    void service.requestCheck(resolved(LOGIN));
    await flush();
    checkers['claude-login'].settle();
    await flush();

    jest.advanceTimersByTime(60_000);
    void service.getProjectUsage('p1', 15);
    await flush();
    checkers['claude-login'].fail(new Error(`401 for Bearer ${FAKE_TOKEN}`));
    await flush();

    const response = await service.getProjectUsage('p1');
    expect(response.accounts[0]).toMatchObject({
      state: 'error',
      windows: OK.windows,
      error: '401 for Bearer [redacted]',
    });
    expect(JSON.stringify(response)).not.toContain(FAKE_TOKEN);
  });

  it('reports an account without a checker as unsupported and never checks it', async () => {
    service = createService(['claude-login']);
    const { accounts } = await service.getProjectUsage('p1', 15);
    expect(accounts[1]).toMatchObject({ accountKey: CODEX.key, state: 'unsupported' });
    expect(checkers.codex.calls).toEqual([]);
  });

  it('reports a checker that finds the CLI unsupported and drops the last good windows', async () => {
    void service.requestCheck(resolved(LOGIN));
    await flush();
    checkers['claude-login'].settle();
    await flush();

    jest.advanceTimersByTime(60_000);
    void service.getProjectUsage('p1', 15);
    await flush();
    checkers['claude-login'].settle({ kind: 'unsupported', error: 'CLI too old' });
    await flush();

    const { accounts } = await service.getProjectUsage('p1');
    expect(accounts[0]).toMatchObject({
      state: 'unsupported',
      error: 'CLI too old',
      windows: [],
      fetchedAt: null,
    });
  });
});
