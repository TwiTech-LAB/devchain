import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { ValidationError } from '../../../common/errors/error-types';
import { ChildProcessExecutor } from '../../terminal/services/process-executor/child-process-executor';
import { FakeProcessExecutor } from '../../terminal/services/process-executor/fake-process-executor';
import {
  PROVIDER_CLI_VERSION_PROBE_TTL_MS,
  ProviderCliVersionProbe,
} from './provider-cli-version-probe.service';

describe('ProviderCliVersionProbe', () => {
  let dir: string;
  let bin: string;
  let executor: FakeProcessExecutor;
  let probe: ProviderCliVersionProbe;
  let now: jest.SpyInstance;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'version-probe-'));
    bin = join(dir, 'opencode');
    await writeFile(bin, '#!/bin/sh\n', { mode: 0o755 });
    executor = new FakeProcessExecutor();
    executor.setDefaultResponse({ type: 'success', stdout: 'opencode v2.0.31\n' });
    probe = new ProviderCliVersionProbe(executor);
    now = jest.spyOn(Date, 'now');
  });

  afterEach(async () => {
    now.mockRestore();
    await rm(dir, { recursive: true, force: true });
  });

  it('runs --version with the no-update env and returns trimmed stdout', async () => {
    await expect(probe.probe('opencode', bin)).resolves.toBe('opencode v2.0.31');
    expect(executor.calls[0].argv).toEqual([expect.stringContaining('opencode'), '--version']);
    expect(executor.calls[0].env).toMatchObject({ OPENCODE_DISABLE_AUTOUPDATE: 'true' });
  });

  it('reuses the cache within the TTL and re-probes after an mtime change or the TTL', async () => {
    now.mockReturnValue(1_000_000);
    await probe.probe('opencode', bin);
    await probe.probe('opencode', bin);
    expect(executor.calls).toHaveLength(1);

    await utimes(bin, new Date(1_000), new Date(2_000));
    await probe.probe('opencode', bin);
    expect(executor.calls).toHaveLength(2);

    now.mockReturnValue(1_000_000 + PROVIDER_CLI_VERSION_PROBE_TTL_MS + 1);
    await probe.probe('opencode', bin);
    expect(executor.calls).toHaveLength(3);
  });

  // A temporary launcher at the probe service boundary is the smallest test that
  // observes the real invocation name, environment, and working directory.
  it('reuses fork versions only for the same invocation path and helper context', async () => {
    now.mockReturnValue(1_000_000);
    const oldProject = join(dir, 'old-project');
    const alternateEntry = join(dir, 'other-launcher');
    await mkdir(oldProject);
    await writeFile(join(oldProject, 'use-old-cli'), '');
    await writeFile(
      bin,
      [
        '#!/bin/sh',
        'if [ "${0##*/}" != opencode ] || [ -f use-old-cli ]; then',
        '  printf "opencode v1.19.0\\n"',
        'else',
        '  printf "opencode v%s\\n" "$TEST_FORK_CLI_VERSION"',
        'fi',
      ].join('\n'),
      { mode: 0o755 },
    );
    await symlink(bin, alternateEntry);
    const runner = new ChildProcessExecutor();
    const run = jest.spyOn(runner, 'run');
    const forkProbe = new ProviderCliVersionProbe(runner);
    const helperEnv = { PATH: dir, TEST_FORK_CLI_VERSION: '2.0.31' };

    await expect(forkProbe.probeForFork('opencode', bin, helperEnv, dir)).resolves.toMatchObject({
      cliVersion: 'opencode v2.0.31',
    });
    await expect(
      forkProbe.probeForFork('opencode', bin, { TEST_FORK_CLI_VERSION: '2.0.31', PATH: dir }, dir),
    ).resolves.toMatchObject({ cliVersion: 'opencode v2.0.31' });
    expect(run).toHaveBeenCalledTimes(1);

    await expect(
      forkProbe.probeForFork(
        'opencode',
        bin,
        { ...helperEnv, TEST_FORK_CLI_VERSION: '1.19.0' },
        dir,
      ),
    ).resolves.toMatchObject({ cliVersion: 'opencode v1.19.0' });
    await expect(
      forkProbe.probeForFork('opencode', bin, helperEnv, oldProject),
    ).resolves.toMatchObject({ cliVersion: 'opencode v1.19.0' });
    await expect(
      forkProbe.probeForFork('opencode', alternateEntry, helperEnv, dir),
    ).resolves.toEqual({ providerBinPath: alternateEntry, cliVersion: 'opencode v1.19.0' });
    expect(run).toHaveBeenCalledTimes(4);
  });

  it('rejects a missing binary and does not cache a failed probe', async () => {
    await expect(probe.probe('opencode', join(dir, 'missing'))).rejects.toThrow(ValidationError);

    executor.enqueueResponse({ type: 'failure', stderr: 'boom' });
    await expect(probe.probe('opencode', bin)).rejects.toThrow(ValidationError);
    executor.enqueueResponse({ type: 'success', stdout: ' \n' });
    await expect(probe.probe('opencode', bin)).rejects.toThrow(ValidationError);
    executor.enqueueResponse({ type: 'timeout' });
    await expect(probe.probe('opencode', bin)).rejects.toMatchObject({
      details: { reason: 'version_probe_timeout' },
    });
    await expect(probe.probe('opencode', bin)).resolves.toBe('opencode v2.0.31');
  });
});
