import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import {
  startTwoInstances,
  waitForValue,
  type TwoInstances,
} from '../../common/test/two-instance.fixture';
import { getAppVersion } from '../../common/app-version';
import { ProcessExecutor } from '../terminal/services/process-executor/process-executor.port';
import type { RemoteOperation } from '../storage/models/domain.models';
import { HostHelperService } from './host/host-helper.service';
import { parseHostEnvFile, renderHostEnvFile } from './host/host-provider-auth.service';
import { RemoteOperationRunner } from './operations/remote-operation.runner';
import { homeIdentity } from './home-identity';

jest.mock('node:os', () => {
  const os = jest.requireActual('node:os');
  const fs = jest.requireActual('node:fs');
  const path = jest.requireActual('node:path');
  const bootstrapHome = fs.mkdtempSync(path.join(os.tmpdir(), 'devchain-test-import-home-'));
  return {
    ...os,
    __testBootstrapHome: bootstrapHome,
    // The credential cipher captures a home path at import time, before the fixture starts.
    homedir: () =>
      process.env.HOME?.includes('/devchain-two-instance-') ? process.env.HOME : bootstrapHome,
  };
});

// Integration: two real apps, HTTP, encrypted vault/storage and host files;
// only the host marker and provider CLI/tmux process boundary are simulated.
describe('update logins across two instances', () => {
  let instances: TwoInstances;
  let marker: jest.SpyInstance;
  const oldKey = 'DEVCHAIN_TEST_OLD_LOGIN';
  const newKey = 'CLAUDE_CODE_OAUTH_TOKEN';
  let savedNew: string | undefined;
  let savedOld: string | undefined;

  beforeAll(async () => {
    savedNew = process.env[newKey];
    savedOld = process.env[oldKey];
    instances = await startTwoInstances({ healthIntervalMs: 60_000 });
    marker = jest
      .spyOn(instances.host.app.get(HostHelperService), 'isClaimedHost')
      .mockReturnValue(true);
    const executor = instances.host.app.get(ProcessExecutor);
    jest.mocked(executor.run).mockImplementation(async (request) => ({
      success: true,
      exitCode: 0,
      stdout: request.argv.includes('status') ? '{"loggedIn":true,"authMethod":"oauth_token"}' : '',
      stderr: '',
      timedOut: false,
      truncated: false,
    }));
  }, 60_000);

  afterAll(async () => {
    marker?.mockRestore();
    await instances?.close();
    const { __testBootstrapHome } = jest.requireMock('node:os') as { __testBootstrapHome: string };
    rmSync(__testBootstrapHome, { recursive: true, force: true });
    if (savedNew === undefined) delete process.env[newKey];
    else process.env[newKey] = savedNew;
    if (savedOld === undefined) delete process.env[oldKey];
    else process.env[oldKey] = savedOld;
  });

  it('accepts 202, applies the new login, removes the prior key and verifies only the changed provider', async () => {
    const remote = await instances.registerRemote('login-host');
    const old = await instances.home.storage.createProviderAuthEntry({
      provider: 'claude',
      kind: 'static',
      label: 'Old',
      payload: { payloadKind: 'env', envKey: oldKey, value: 'old-test-token' },
    });
    const replacement = await instances.home.storage.createProviderAuthEntry({
      provider: 'claude',
      kind: 'static',
      label: 'New',
      payload: { payloadKind: 'env', envKey: newKey, value: 'new-test-token' },
    });
    const identity = homeIdentity();
    const prior = await instances.home.storage.createRemoteOperation({
      kind: 'install_host',
      remoteId: remote.id,
      projectId: null,
      steps: [],
      details: {
        userName: identity.user,
        homePath: identity.homePath,
        port: 3000,
        version: getAppVersion(),
        claimed: true,
        providerAuth: { claude: { choice: 'reuse', entryId: old.id, entryIds: [old.id] } },
      },
    });
    await instances.home.storage.updateRemoteOperation(prior.id, { state: 'done' });
    const hostHome = join(instances.rootDir, 'shared-home');
    const relativeHome = relative(instances.rootDir, hostHome);
    expect(relativeHome).not.toMatch(/^\.\./);
    expect(isAbsolute(relativeHome)).toBe(false);
    expect(identity.homePath).toBe(hostHome);
    expect(process.env.HOME).toBe(hostHome);
    mkdirSync(join(hostHome, '.devchain'), { recursive: true });
    writeFileSync(
      join(hostHome, '.devchain', 'host.env'),
      renderHostEnvFile({ [oldKey]: 'old-test-token', UNCHANGED_TEST_KEY: 'keep' }),
    );
    process.env[oldKey] = 'old-test-token';

    const response = await fetch(`${instances.home.url}/api/remotes/${remote.id}/logins`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ providerAuth: { claude: `reuse:${replacement.id}` } }),
    });
    expect(response.status).toBe(202);
    const started = (await response.json()) as RemoteOperation;
    await instances.home.app.get(RemoteOperationRunner).whenIdle(started.id);
    const done = await waitForValue(async () => {
      const result = await instances.home.storage.getRemoteOperation(started.id);
      return result.state !== 'running' ? result : undefined;
    }, 10_000);
    expect(done).toMatchObject({
      state: 'done',
      kind: 'update_logins',
      details: {
        applyStarted: true,
        providerAuth: { claude: { entryIds: [replacement.id] } },
        verified: { claude: { ok: true } },
        appliedManifest: { claude: { envKeys: [newKey], files: [] } },
      },
    });
    expect(parseHostEnvFile(readFileSync(join(hostHome, '.devchain', 'host.env'), 'utf8'))).toEqual(
      { [newKey]: 'new-test-token', UNCHANGED_TEST_KEY: 'keep' },
    );
    expect(process.env[oldKey]).toBeUndefined();
    expect(process.env[newKey]).toBe('new-test-token');
    expect(JSON.stringify(done)).not.toContain('new-test-token');
  }, 30_000);
});
