import { EventEmitter } from 'events';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { PassThrough } from 'stream';
import type { ProviderUsageAccount } from '../provider-usage.types';
import {
  CODEX_USAGE_MAX_OUTPUT_BYTES,
  CODEX_USAGE_TIMEOUT_MS,
  CodexChecker,
} from './codex.checker';

// Layer: unit with a fake child process. The protocol order (stdin stays open, follow-up
// requests only after the initialize reply, kill on the final reply) is the behavior under test.
class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly kill = jest.fn((signal?: string) => {
    if (signal === 'SIGTERM' && this.exitOnTerm) this.exit();
    return true;
  });
  exitOnTerm = true;
  readonly written: Array<Record<string, unknown>> = [];

  constructor() {
    super();
    this.stdin.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n').filter(Boolean)) {
        this.written.push(JSON.parse(line));
      }
    });
  }

  reply(message: unknown): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  exit(): void {
    this.emit('close', 0, null);
  }
}

const spawnMock = jest.fn();
jest.mock('child_process', () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }));

const account: ProviderUsageAccount = {
  key: 'codex:/h/.codex:none',
  provider: 'codex',
  kind: 'codex',
  label: 'Codex',
};
const SECRET = 'sk-codex-secret-key-value';
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
/** The checker creates its working directory first, so the spawn comes a few I/O turns later. */
async function started(): Promise<void> {
  while (spawnMock.mock.calls.length === 0) await flush();
}

const PLUS = {
  primary: { usedPercent: 24, windowDurationMins: 300, resetsAt: 1792000000 },
  secondary: { usedPercent: 60, windowDurationMins: 10080, resetsAt: 1792500000 },
  planType: 'plus',
  accountId: 'acct-1',
  rateLimitResetCredits: 3,
};

describe('CodexChecker', () => {
  let child: FakeChild;
  let dataRoot: string;
  let originalDbPath: string | undefined;
  const checker = new CodexChecker();

  /** Runs a check and lets the fake server answer initialize, then the rate-limit read. */
  async function checkWithReply(rateLimits: unknown) {
    const pending = checker.check(
      account,
      { PATH: '/usr/bin', OPENAI_API_KEY: SECRET },
      '/opt/codex',
    );
    await started();
    child.reply({ id: 1, result: { userAgent: 'codex' } });
    await flush();
    child.reply({ id: 2, result: { rateLimits } });
    return pending;
  }

  beforeEach(async () => {
    dataRoot = await mkdtemp(join(tmpdir(), 'codex-checker-'));
    originalDbPath = process.env.DB_PATH;
    process.env.DB_PATH = dataRoot;
    child = new FakeChild();
    spawnMock.mockReset().mockReturnValue(child);
  });

  afterEach(async () => {
    jest.useRealTimers();
    if (originalDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = originalDbPath;
    await rm(dataRoot, { recursive: true, force: true });
  });

  it('sends the follow-up requests only after the initialize reply, keeps stdin open and kills on the last reply', async () => {
    const pending = checker.check(
      account,
      { PATH: '/usr/bin', OPENAI_API_KEY: SECRET },
      '/opt/codex',
    );
    await started();

    expect(child.written).toEqual([
      expect.objectContaining({
        id: 1,
        method: 'initialize',
        params: { clientInfo: { name: 'devchain', version: expect.any(String) } },
      }),
    ]);

    child.reply({ id: 1, result: {} });
    await flush();
    expect(child.written.slice(1)).toEqual([
      { method: 'initialized' },
      { id: 2, method: 'account/rateLimits/read' },
    ]);
    expect(child.stdin.writableEnded).toBe(false);
    expect(child.kill).not.toHaveBeenCalled();

    child.reply({ id: 2, result: { rateLimits: PLUS } });
    await expect(pending).resolves.toMatchObject({ kind: 'ok' });
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(child.stdin.writableEnded).toBe(false);
  });

  it('spawns the binary directly with the no-update policy, the account env and a private cwd', async () => {
    await checkWithReply(PLUS);

    const [file, args, options] = spawnMock.mock.calls[0];
    expect(file).toBe('/opt/codex');
    expect(args).toEqual(['-c', 'check_for_update_on_startup=false', 'app-server']);
    expect(options.shell).toBe(false);
    expect(options.stdio).toEqual(['pipe', 'pipe', 'ignore']);
    expect(options.env).toMatchObject({ PATH: '/usr/bin', OPENAI_API_KEY: SECRET });
    expect(options.cwd).toBe(join(dataRoot, 'provider-usage', 'codex-cwd'));
  });

  it('maps a plus plan to a 5-hour and a weekly window and ignores account details', async () => {
    const result = await checkWithReply(PLUS);

    expect(result).toEqual({
      kind: 'ok',
      source: 'cli',
      plan: 'plus',
      extras: [],
      windows: [
        { id: '5h', label: '5-hour limit', kind: '5h', usedPercent: 24, resetsAt: 1792000000 },
        {
          id: 'weekly',
          label: 'Weekly limit',
          kind: 'weekly',
          usedPercent: 60,
          resetsAt: 1792500000,
        },
      ],
    });
  });

  it('maps a weekly-only plan by window duration, not by position', async () => {
    const result = await checkWithReply({
      primary: { usedPercent: 3, windowDurationMins: 10080, resetsAt: 1792500000 },
      secondary: null,
      planType: 'prolite',
    });

    expect(result).toMatchObject({
      kind: 'ok',
      plan: 'prolite',
      windows: [{ id: 'weekly', kind: 'weekly', usedPercent: 3 }],
    });
    expect((result as { windows: unknown[] }).windows).toHaveLength(1);
  });

  it('labels other durations in hours and tolerates a missing reset', async () => {
    const result = await checkWithReply({
      primary: { usedPercent: 10, windowDurationMins: 90 },
      planType: 'team',
    });

    expect(result).toMatchObject({
      windows: [{ id: 'other-90', kind: 'other', label: '1.5 h limit', resetsAt: null }],
    });
  });

  it('reports no plan and no windows as not-available', async () => {
    await expect(checkWithReply({ primary: null, secondary: null })).resolves.toMatchObject({
      kind: 'not-available',
    });
  });

  it('fails when the reply has no rate limits', async () => {
    await expect(checkWithReply(undefined)).rejects.toThrow('no rate limits');
  });

  it('fails on a JSON-RPC error without echoing the message', async () => {
    const pending = checker.check(account, { OPENAI_API_KEY: SECRET }, '/opt/codex');
    await started();
    child.reply({ id: 1, result: {} });
    await flush();
    child.reply({ id: 2, error: { code: -32601, message: `unknown ${SECRET}` } });

    const error = await pending.catch((e: Error) => e);
    expect((error as Error).message).toBe('codex app-server returned an error');
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('fails when the process exits before the rate-limit reply', async () => {
    const pending = checker.check(account, {}, '/opt/codex');
    await started();
    child.reply({ id: 1, result: {} });
    await flush();
    child.exit();

    await expect(pending).rejects.toThrow('exited before replying');
  });

  it('fails when the binary cannot start', async () => {
    const pending = checker.check(account, {}, '/opt/codex');
    await started();
    child.emit('error', new Error(`spawn ENOENT ${SECRET}`));

    await expect(pending).rejects.toThrow(new Error('codex app-server failed to start'));
  });

  it('ignores notifications and non-JSON lines between replies', async () => {
    const pending = checker.check(account, {}, '/opt/codex');
    await started();
    child.stdout.write('not json\n');
    child.reply({ method: 'thread/started', params: {} });
    child.reply({ id: 1, result: {} });
    await flush();
    child.stdout.write(`${JSON.stringify({ id: 2, result: { rateLimits: PLUS } }).slice(0, 20)}`);
    child.stdout.write(`${JSON.stringify({ id: 2, result: { rateLimits: PLUS } }).slice(20)}\n`);

    await expect(pending).resolves.toMatchObject({ kind: 'ok', plan: 'plus' });
  });

  it('kills the process and fails when the output exceeds the cap', async () => {
    const pending = checker.check(account, {}, '/opt/codex');
    await started();
    child.stdout.write('x'.repeat(CODEX_USAGE_MAX_OUTPUT_BYTES + 1));

    await expect(pending).rejects.toThrow('output too large');
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('kills the process with SIGTERM then SIGKILL and fails on a timeout', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    child.exitOnTerm = false;
    const pending = checker.check(account, {}, '/opt/codex');
    const assertion = expect(pending).rejects.toThrow('timed out');
    await started();

    jest.advanceTimersByTime(CODEX_USAGE_TIMEOUT_MS);
    await assertion;
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(child.kill).not.toHaveBeenCalledWith('SIGKILL');

    jest.advanceTimersByTime(2_000);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });
});
