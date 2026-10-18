import { mkdtemp, rm, utimes, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { ValidationError } from '../../../common/errors/error-types';
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

  it('rejects a missing binary and does not cache a failed probe', async () => {
    await expect(probe.probe('opencode', join(dir, 'missing'))).rejects.toThrow(ValidationError);

    executor.enqueueResponse({ type: 'failure', stderr: 'boom' });
    await expect(probe.probe('opencode', bin)).rejects.toThrow(ValidationError);
    await expect(probe.probe('opencode', bin)).resolves.toBe('opencode v2.0.31');
  });
});
