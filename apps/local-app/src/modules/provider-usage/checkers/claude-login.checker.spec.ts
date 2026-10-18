import { mkdtemp, mkdir, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { FakeProcessExecutor } from '../../terminal/services/process-executor/fake-process-executor';
import type {
  ExecutorResult,
  ProcessExecutorOptions,
} from '../../terminal/services/process-executor/process-executor.port';
import type { ProviderUsageAccount } from '../provider-usage.types';
import {
  CLAUDE_USAGE_MAX_OUTPUT_BYTES,
  CLAUDE_USAGE_TIMEOUT_MS,
  ClaudeLoginChecker,
} from './claude-login.checker';

const SAMPLE = `You are currently using your subscription to power your Claude Code usage

Current session: 0% used · resets Oct 17, 4:30pm (Europe/Madrid)
Current week (all models): 12% used · resets Oct 23, 12am (Europe/Madrid)
`;

const TOKEN_SECRET = 'sk-ant-oat01-super-secret-access-token';
const REFRESH_SECRET = 'sk-ant-ort01-super-secret-refresh-token';

const account: ProviderUsageAccount = {
  key: 'claude:login:/x/.claude',
  provider: 'claude',
  kind: 'claude-login',
  label: 'Claude',
};

/** The fake records argv, cwd and env; this also keeps the timeout and stdin input. */
class RecordingExecutor extends FakeProcessExecutor {
  readonly options: ProcessExecutorOptions[] = [];

  override run(options: ProcessExecutorOptions): Promise<ExecutorResult> {
    this.options.push(options);
    return super.run(options);
  }
}

describe('ClaudeLoginChecker', () => {
  let root: string;
  let configDir: string;
  let executor: RecordingExecutor;
  let checker: ClaudeLoginChecker;
  let originalDbPath: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'claude-login-checker-'));
    configDir = join(root, 'claude-config');
    await mkdir(configDir);
    originalDbPath = process.env.DB_PATH;
    process.env.DB_PATH = join(root, 'data');
    executor = new RecordingExecutor();
    executor.setDefaultResponse({ type: 'success', stdout: SAMPLE });
    checker = new ClaudeLoginChecker(executor);
    jest.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 9, 17, 12, 0, 0));
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    if (originalDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = originalDbPath;
    await rm(root, { recursive: true, force: true });
  });

  const env = (extra: Record<string, string> = {}) => ({
    PATH: '/usr/bin',
    HOME: root,
    CLAUDE_CONFIG_DIR: configDir,
    ...extra,
  });

  it('runs /usage with the no-update env, closed stdin and a private cwd', async () => {
    const result = await checker.check(
      account,
      env({ CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_SESSION: 'abc' }),
      '/opt/bin/claude',
    );

    expect(result).toMatchObject({ kind: 'ok', source: 'cli', plan: null });
    expect(executor.calls).toHaveLength(1);
    const call = executor.options[0];
    expect(call.argv).toEqual(['/opt/bin/claude', '-p', '/usage', '--no-session-persistence']);
    expect(call.mode).toBe('pipe');
    expect(call.input).toBeUndefined();
    expect(call.timeout).toBe(CLAUDE_USAGE_TIMEOUT_MS);
    expect(call.outputLimits).toEqual({ maxBytes: CLAUDE_USAGE_MAX_OUTPUT_BYTES });
    expect(call.env).toMatchObject({
      DISABLE_AUTOUPDATER: '1',
      PATH: '/usr/bin',
      CLAUDE_CONFIG_DIR: configDir,
    });
    expect(Object.keys(call.env ?? {})).not.toContain('CLAUDECODE');
    expect(Object.keys(call.env ?? {}).filter((key) => key.startsWith('CLAUDE_CODE_'))).toEqual([]);
    expect(call.cwd).toBe(join(root, 'data', 'provider-usage', 'claude-cwd'));
    expect((await stat(call.cwd as string)).isDirectory()).toBe(true);
  });

  it('adds the plan label from the credentials file and never returns its tokens', async () => {
    await writeFile(
      join(configDir, '.credentials.json'),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: TOKEN_SECRET,
          refreshToken: REFRESH_SECRET,
          subscriptionType: 'max',
          rateLimitTier: 'default_claude_max_5x',
        },
      }),
    );

    const result = await checker.check(account, env(), 'claude');

    expect(result).toMatchObject({ kind: 'ok', plan: 'Max 5x' });
    const serialized = JSON.stringify(result) + JSON.stringify(executor.calls);
    expect(serialized).not.toContain(TOKEN_SECRET);
    expect(serialized).not.toContain(REFRESH_SECRET);
  });

  it.each([
    [{ subscriptionType: 'pro', rateLimitTier: 'default_claude_ai' }, 'Pro'],
    [{ subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' }, 'Max 20x'],
    [{ subscriptionType: 'has spaces and a token sk-ant-xyz' }, null],
    [{ rateLimitTier: 'default_claude_max_5x' }, null],
  ])('derives the plan from %j as %j', async (oauth, plan) => {
    await writeFile(join(configDir, '.credentials.json'), JSON.stringify({ claudeAiOauth: oauth }));
    await expect(checker.check(account, env(), 'claude')).resolves.toMatchObject({ plan });
  });

  it('leaves the plan null when the credentials file is not JSON', async () => {
    await writeFile(join(configDir, '.credentials.json'), `not json ${TOKEN_SECRET}`);
    await expect(checker.check(account, env(), 'claude')).resolves.toMatchObject({ plan: null });
  });

  it('reads the credentials from ~/.claude when no config dir is set', async () => {
    await mkdir(join(root, '.claude'));
    await writeFile(
      join(root, '.claude', '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { subscriptionType: 'pro' } }),
    );
    const { CLAUDE_CONFIG_DIR: _omitted, ...withoutConfigDir } = env();
    await expect(checker.check(account, withoutConfigDir, 'claude')).resolves.toMatchObject({
      plan: 'Pro',
    });
  });

  it('reports an API-key account and a logged-out account as not-available', async () => {
    executor.enqueueResponse({ type: 'success', stdout: 'Total cost: $0.0000\n' });
    await expect(checker.check(account, env(), 'claude')).resolves.toEqual({
      kind: 'not-available',
      error: 'Not a subscription login',
    });

    executor.enqueueResponse({ type: 'failure', stderr: 'Not logged in · Please run /login' });
    await expect(checker.check(account, env(), 'claude')).resolves.toEqual({
      kind: 'not-available',
      error: 'Not logged in',
    });
  });

  it('throws for unrecognized output, a failed run and a timeout', async () => {
    executor.enqueueResponse({ type: 'success', stdout: 'garbage' });
    await expect(checker.check(account, env(), 'claude')).rejects.toThrow(
      'usage format not recognized',
    );

    executor.enqueueResponse({ type: 'failure', exitCode: 3 });
    await expect(checker.check(account, env(), 'claude')).rejects.toThrow('exit 3');

    executor.enqueueResponse({ type: 'timeout' });
    await expect(checker.check(account, env(), 'claude')).rejects.toThrow('timed out');
  });
});
