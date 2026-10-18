import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ProviderCliVersionProbe } from '../../providers/services/provider-cli-version-probe.service';
import { FakeProcessExecutor } from '../../terminal/services/process-executor/fake-process-executor';
import type { ProviderUsageAccount } from '../provider-usage.types';
import { AgyChecker } from './agy.checker';

const AGY_OUTPUT = JSON.stringify({
  status: 'SUCCESS',
  num_turns: 0,
  command: {
    name: 'usage',
    data: {
      groups: [
        {
          name: 'Gemini Models',
          buckets: [
            {
              id: 'gemini-weekly',
              window: 'weekly',
              remaining_fraction: 1,
              reset_time: '2026-10-24T09:34:15Z',
            },
          ],
        },
        {
          name: 'Claude and GPT models',
          buckets: [
            {
              id: '3p-weekly',
              window: 'weekly',
              remaining_fraction: 0.75,
              reset_time: '2026-10-24T09:34:15Z',
            },
          ],
        },
      ],
    },
  },
});
const RESET = Date.parse('2026-10-24T09:34:15Z') / 1000;

const account: ProviderUsageAccount = { key: 'agy:/h', provider: 'agy', kind: 'agy', label: 'agy' };

describe('AgyChecker', () => {
  let executor: FakeProcessExecutor;
  let probe: { probe: jest.Mock };
  let checker: AgyChecker;
  let dataRoot: string;
  let originalDbPath: string | undefined;

  beforeEach(async () => {
    dataRoot = await mkdtemp(join(tmpdir(), 'agy-checker-'));
    originalDbPath = process.env.DB_PATH;
    process.env.DB_PATH = dataRoot;
    executor = new FakeProcessExecutor();
    executor.setDefaultResponse({ type: 'success', stdout: AGY_OUTPUT });
    probe = { probe: jest.fn().mockResolvedValue('agy 1.2.8') };
    checker = new AgyChecker(executor, probe as unknown as ProviderCliVersionProbe);
  });

  afterEach(async () => {
    if (originalDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = originalDbPath;
    await rm(dataRoot, { recursive: true, force: true });
  });

  it('maps each bucket to a weekly window labelled with its group', async () => {
    const result = await checker.check(account, { PATH: '/usr/bin' }, '/opt/agy');

    expect(result).toEqual({
      kind: 'ok',
      source: 'cli',
      plan: null,
      windows: [],
      extras: [
        {
          id: 'gemini-weekly',
          label: 'Gemini Models',
          kind: 'weekly',
          usedPercent: 0,
          resetsAt: RESET,
        },
        {
          id: '3p-weekly',
          label: 'Claude and GPT models',
          kind: 'weekly',
          usedPercent: 25,
          resetsAt: RESET,
        },
      ],
    });
  });

  it('runs /usage in a private cwd with the no-update env', async () => {
    await checker.check(account, { PATH: '/usr/bin' }, '/opt/agy');

    expect(executor.calls).toHaveLength(1);
    expect(executor.calls[0]).toMatchObject({
      argv: ['/opt/agy', '-p', '/usage', '--output-format', 'json'],
      mode: 'pipe',
      cwd: join(dataRoot, 'provider-usage', 'agy-cwd'),
      env: { PATH: '/usr/bin', AGY_CLI_DISABLE_AUTO_UPDATE: 'true' },
    });
    expect(executor.calls[0].outputLimits).toEqual({ maxBytes: 64 * 1024 });
    expect(probe.probe).toHaveBeenCalledWith('agy', '/opt/agy');
  });

  it('is unsupported below 1.2.8 and runs nothing, then recovers after an upgrade', async () => {
    probe.probe.mockResolvedValue('1.2.7');
    await expect(checker.check(account, {}, '/opt/agy')).resolves.toMatchObject({
      kind: 'unsupported',
    });
    expect(executor.calls).toHaveLength(0);

    probe.probe.mockResolvedValue('1.10.0');
    await expect(checker.check(account, {}, '/opt/agy')).resolves.toMatchObject({ kind: 'ok' });
  });

  it('probes the version once per account after it passes', async () => {
    await checker.check(account, {}, '/opt/agy');
    await checker.check(account, {}, '/opt/agy');

    expect(probe.probe).toHaveBeenCalledTimes(1);
    expect(executor.calls).toHaveLength(2);
  });

  it('fails when the version is not readable', async () => {
    probe.probe.mockResolvedValue('dev build');

    await expect(checker.check(account, {}, '/opt/agy')).rejects.toThrow('version not recognized');
    expect(executor.calls).toHaveLength(0);
  });

  it.each([
    ['a different command', { status: 'SUCCESS', num_turns: 0, command: { name: 'help' } }],
    ['a model turn', { status: 'SUCCESS', num_turns: 1, command: { name: 'usage', data: {} } }],
    ['no command', { status: 'SUCCESS', num_turns: 0, result: 'hello' }],
  ])('stops the account until restart after %s', async (_label, output) => {
    executor.enqueueResponse({ type: 'success', stdout: JSON.stringify(output) });

    await expect(checker.check(account, {}, '/opt/agy')).resolves.toMatchObject({
      kind: 'unsupported',
    });
    await expect(checker.check(account, {}, '/opt/agy')).resolves.toMatchObject({
      kind: 'unsupported',
    });
    expect(executor.calls).toHaveLength(1);

    const other = { ...account, key: 'agy:/other' };
    await expect(checker.check(other, {}, '/opt/agy')).resolves.toMatchObject({ kind: 'ok' });
  });

  it('throws for a usage answer without readable groups, a failed run and a timeout', async () => {
    executor.enqueueResponse({
      type: 'success',
      stdout: JSON.stringify({ num_turns: 0, command: { name: 'usage', data: { groups: [] } } }),
    });
    await expect(checker.check(account, {}, '/opt/agy')).rejects.toThrow(
      'usage format not recognized',
    );

    executor.enqueueResponse({ type: 'failure', exitCode: 2, stdout: 'oops' });
    await expect(checker.check(account, {}, '/opt/agy')).rejects.toThrow('exit 2');

    executor.enqueueResponse({ type: 'timeout' });
    await expect(checker.check(account, {}, '/opt/agy')).rejects.toThrow('timed out');

    // None of the transient failures blocks the account.
    await expect(checker.check(account, {}, '/opt/agy')).resolves.toMatchObject({ kind: 'ok' });
  });
});
