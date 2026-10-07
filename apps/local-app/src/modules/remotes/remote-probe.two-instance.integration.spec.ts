import {
  startTwoInstances,
  type TwoInstances,
  waitForValue,
} from '../../common/test/two-instance.fixture';
import { BASE_URL_MESSAGE, type RemoteListItemDto } from './dtos/remote.dto';
import { FakeProxmoxServer } from '../../common/test/fake-proxmox.server';
import {
  type Remote,
  type RemoteOperationKind,
  type RemoteOperationState,
  type RemoteOperation,
} from '../storage/models/domain.models';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { certificateFingerprint } from '../../common/tls/certificate';
import { fixtureTls } from '../../common/test/tls-fixture';
import { REMOTE_HEALTH_PORT, type RemoteHealthPort } from './ports/remote-health.port';
import { getAppVersion } from '../../common/app-version';
import { ProcessExecutor } from '../terminal/services/process-executor/process-executor.port';
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

describe('remote routes across two instances', () => {
  let instances: TwoInstances;
  beforeAll(async () => {
    instances = await startTwoInstances({ healthIntervalMs: 600_000 });
  }, 60_000);
  afterAll(async () => {
    await instances?.close();
    const { __testBootstrapHome } = jest.requireMock('node:os') as { __testBootstrapHome: string };
    rmSync(__testBootstrapHome, { recursive: true, force: true });
  });

  async function post(url: string, body: unknown): Promise<{ status: number; body: unknown }> {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }

  // Integration: the routes through the real app, its module wiring and error
  // filter; the probe's cases live in services/remote-probe.service.spec.ts.
  describe('remote probe routes across two instances', () => {
    it('finds the registered DevChain at an address and creates nothing', async () => {
      const remote = await instances.registerRemote('probed');
      const hostUrl = instances.host.url.replace(/^http:/, 'https:');
      const before = await instances.home.storage.listRemotes();

      const result = await post(`${instances.home.url}/api/remotes/probe`, {
        address: hostUrl,
        checkSsh: false,
      });

      expect(result).toEqual({
        status: 200,
        body: expect.objectContaining({
          kind: 'devchain',
          baseUrl: hostUrl,
          versionMatches: true,
          homePathMatches: true,
          remoteId: remote.id,
        }),
      });
      expect((await instances.home.storage.listRemotes()).total).toBe(before.total);
      expect(await instances.home.storage.listRemoteOperations({})).toEqual([]);
      expect((await fetch(`${instances.home.url}/api/remotes/readiness`)).status).toBe(200);
    }, 30_000);

    it('answers 400 with the address rule for an invalid address', async () => {
      const result = await post(`${instances.home.url}/api/remotes/probe`, {
        address: 'https://127.0.0.1:4000/path',
      });
      expect(result.status).toBe(400);
      expect(result.body).toMatchObject({ message: BASE_URL_MESSAGE });
    });
  });

  const OWNED_VMID = 150;
  const FOREIGN_VMID = 160;

  function identity(vmid: number): string {
    return `00000000-0000-4000-8000-${String(vmid).padStart(12, '0')}`;
  }

  async function postVm(url: string, body?: unknown): Promise<{ status: number; data: unknown }> {
    const response = await fetch(
      url,
      body === undefined
        ? { method: 'POST' }
        : {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          },
    );
    return { status: response.status, data: await response.json() };
  }

  // Integration: the route through the real app, storage and ProxmoxClient against
  // the HTTPS Proxmox fake, so the ownership guard reads real VM config and pools.
  describe('POST /api/remotes/:id/power-on', () => {
    let proxmox: FakeProxmoxServer;
    let connectionId: string;

    async function proxmoxRemote(name: string, vmIdentity: string | null): Promise<Remote> {
      return instances.home.storage.createRemote({
        name,
        kind: 'proxmox',
        baseUrl: 'http://127.0.0.1:1',
        vmProviderConnectionId: connectionId,
        vmIdentity,
        vmSpec: { cores: 2, memory: 4096, disk: 30 },
      });
    }

    function seedVm(vmid: number, owned: boolean): void {
      proxmox.vms.set(vmid, {
        vmid,
        name: owned ? 'devchain-worker' : 'someone-else',
        description: '',
        tags: owned ? 'devchain' : 'other',
        pool: owned ? 'devchain' : 'other',
        template: 0,
        status: 'stopped',
        cores: 2,
        memory: 4096,
        scsi0: `local-lvm:vm-${vmid}-disk-0,size=30G`,
        smbios1: `uuid=${identity(vmid)}`,
      });
    }

    function startCalls(vmid: number): number {
      return proxmox.calls.filter(
        (call) => call.method === 'POST' && call.path === `/nodes/hw/qemu/${vmid}/status/start`,
      ).length;
    }

    beforeAll(async () => {
      proxmox = new FakeProxmoxServer();
      await proxmox.listen();
      const connectionString = proxmox.connectionString();
      await postVm(`${instances.home.url}/api/vm-providers/proxmox/connect`, { connectionString });
      const connected = await postVm(`${instances.home.url}/api/vm-providers/proxmox/connect`, {
        connectionString,
        confirmFingerprint: true,
      });
      expect(connected.status).toBe(200);
      connectionId = (connected.data as { connection: { id: string } }).connection.id;
    }, 60_000);

    afterAll(async () => {
      await proxmox?.close();
    }, 30_000);

    beforeEach(() => {
      seedVm(OWNED_VMID, true);
      seedVm(FOREIGN_VMID, false);
    });

    it('starts a stopped DevChain-owned VM', async () => {
      const remote = await proxmoxRemote('owned', identity(OWNED_VMID));
      const before = startCalls(OWNED_VMID);

      const result = await postVm(`${instances.home.url}/api/remotes/${remote.id}/power-on`);

      expect(result).toEqual({ status: 200, data: { powerState: 'running' } });
      expect(proxmox.vms.get(OWNED_VMID)?.status).toBe('running');
      expect(startCalls(OWNED_VMID)).toBe(before + 1);
      expect(await instances.home.storage.listRemoteOperations({ remoteId: remote.id })).toEqual(
        [],
      );
    });

    it('refuses a VM that is not DevChain’s and leaves it stopped', async () => {
      const remote = await proxmoxRemote('foreign', identity(FOREIGN_VMID));

      const result = await postVm(`${instances.home.url}/api/remotes/${remote.id}/power-on`);

      expect(result.status).toBe(409);
      expect(result.data).toMatchObject({
        message: 'VM destroy guard refused: pool, tag, name prefix.',
      });
      expect(proxmox.vms.get(FOREIGN_VMID)?.status).toBe('stopped');
      expect(startCalls(FOREIGN_VMID)).toBe(0);
    });

    it.each(['address', 'proxmox without identity'] as const)(
      'refuses power on for %s',
      async (kind) => {
        const remote =
          kind === 'address'
            ? await instances.home.storage.createRemote({
                name: 'by-address',
                kind: 'address',
                baseUrl: 'http://127.0.0.1:2',
              })
            : await proxmoxRemote('no-identity', null);
        const result = await postVm(`${instances.home.url}/api/remotes/${remote.id}/power-on`);
        expect(result.status).toBe(409);
        expect(result.data).toMatchObject({
          message: 'Only a registered managed VM can be powered on.',
          details: { code: 'REMOTE_NOT_VM_MANAGED' },
        });
      },
    );

    it('refuses while a host operation is open and starts nothing', async () => {
      const remote = await proxmoxRemote('busy', identity(OWNED_VMID));
      await instances.home.storage.createRemoteOperation({
        kind: 'update_host',
        remoteId: remote.id,
        projectId: null,
        steps: [],
        details: {},
      });
      const before = startCalls(OWNED_VMID);

      const result = await postVm(`${instances.home.url}/api/remotes/${remote.id}/power-on`);

      expect(result.status).toBe(409);
      expect(proxmox.vms.get(OWNED_VMID)?.status).toBe('stopped');
      expect(startCalls(OWNED_VMID)).toBe(before);
    });
  });

  async function listRemotes(instances: TwoInstances): Promise<RemoteListItemDto[]> {
    const response = await fetch(`${instances.home.url}/api/remotes`);
    expect(response.status).toBe(200);
    return ((await response.json()) as { items: RemoteListItemDto[] }).items;
  }

  async function listed(instances: TwoInstances, remoteId: string): Promise<RemoteListItemDto> {
    const item = (await listRemotes(instances)).find((remote) => remote.id === remoteId);
    if (!item) throw new Error(`Remote ${remoteId} is not listed`);
    return item;
  }

  // Integration: the list reads real SQLite operation rows and the home folder the
  // host's real /api/runtime reports over HTTP; a unit mock would hide both.
  describe('GET /api/remotes home folder, latest operation and logins', () => {
    let sequence = 0;

    /** Records an operation whose creation order is explicit, not left to clock resolution. */
    async function record(
      remote: Remote,
      kind: RemoteOperationKind,
      state: RemoteOperationState,
      details: Record<string, unknown>,
    ) {
      const created = await instances.home.storage.createRemoteOperation({
        kind,
        remoteId: remote.id,
        projectId: null,
        steps: [],
        details,
      });
      sequence += 1;
      const createdAt = new Date(Date.UTC(2030, 0, 1, 0, 0, sequence)).toISOString();
      instances.home.sqlite
        .prepare('UPDATE remote_operations SET created_at = ? WHERE id = ?')
        .run(createdAt, created.id);
      return state === 'running'
        ? created
        : instances.home.storage.updateRemoteOperation(created.id, { state });
    }

    /** Registers the host under a new name and waits for the refresh the POST starts. */
    async function registerOnline(name: string): Promise<Remote> {
      const remote = await instances.registerRemote(name);
      await waitForValue(async () => (await listed(instances, remote.id)).online, 10_000);
      return remote;
    }

    it('lists a VM added by address and never set up with a matching home and no logins', async () => {
      const remote = await registerOnline('address-only');

      expect(await listed(instances, remote.id)).toMatchObject({
        online: true,
        homePath: process.env.HOME,
        homePathMatches: true,
        lastOperation: null,
        logins: null,
      });
    }, 30_000);

    it('lists the logins of a claimed VM and nothing else from the claim record', async () => {
      const remote = await registerOnline('claimed');
      const claim = await record(remote, 'claim', 'done', {
        userName: 'alice',
        homePath: process.env.HOME,
        bootstrapUrl: 'http://127.0.0.1:1',
        version: '0.0.0',
        claimed: true,
        bundleSummary: { envKeys: ['DEVCHAIN_TEST_SECRET_KEY'], files: [] },
        verified: { codex: { ok: true } },
        providerAuth: {
          claude: { choice: 'reuse', entryId: 'entry-single', checkedOut: ['family-1'] },
          codex: {
            choice: 'generate',
            entryIds: ['entry-generated'],
            sessionId: 'devchain-test-login-session',
          },
          gemini: { choice: 'skip' },
        },
      });

      const item = await listed(instances, remote.id);

      expect(item.lastOperation).toEqual({
        id: claim.id,
        kind: 'claim',
        state: 'done',
        updatedAt: claim.updatedAt,
      });
      expect(item.logins).toEqual({
        claude: { choice: 'reuse', entryIds: ['entry-single'] },
        codex: { choice: 'generate', entryIds: ['entry-generated'] },
        gemini: { choice: 'skip', entryIds: [] },
      });
      const serialized = JSON.stringify(item);
      for (const leaked of [
        'DEVCHAIN_TEST_SECRET_KEY',
        'family-1',
        'devchain-test-login-session',
        'bootstrapUrl',
        'verified',
      ]) {
        expect(serialized).not.toContain(leaked);
      }
    }, 30_000);

    it('takes logins from the newest done update_logins record while the newest operation is later', async () => {
      const remote = await registerOnline('changed-logins');
      await record(remote, 'install_host', 'done', {
        providerAuth: { claude: { choice: 'reuse', entryIds: ['entry-install'] } },
      });
      await record(remote, 'update_logins', 'done', {
        providerAuth: { claude: { choice: 'reuse', entryIds: ['entry-changed'] } },
      });
      await record(remote, 'update_logins', 'failed', {
        providerAuth: { claude: { choice: 'reuse', entryIds: ['entry-failed'] } },
      });
      const latest = await record(remote, 'update_host', 'cancelled', {});

      const item = await listed(instances, remote.id);

      expect(item.logins).toEqual({ claude: { choice: 'reuse', entryIds: ['entry-changed'] } });
      expect(item.lastOperation).toEqual({
        id: latest.id,
        kind: 'update_host',
        state: 'cancelled',
        updatedAt: latest.updatedAt,
      });
    }, 30_000);

    it("reports a VM whose home folder differs from this PC's as not matching", async () => {
      const remote = await registerOnline('other-home');
      const homeHome = process.env.HOME!;
      const otherHome = join(instances.rootDir, 'other-home');
      mkdirSync(otherHome, { recursive: true });
      // Both apps share one process and HOME: the host reports the other folder
      // only while this poll runs.
      process.env.HOME = otherHome;
      try {
        await instances.home.app.get<RemoteHealthPort>(REMOTE_HEALTH_PORT).refresh(remote.id);
      } finally {
        process.env.HOME = homeHome;
      }

      expect(await listed(instances, remote.id)).toMatchObject({
        online: true,
        homePath: otherHome,
        homePathMatches: false,
      });
    }, 30_000);

    it('refuses to add an address that does not answer', async () => {
      const response = await fetch(`${instances.home.url}/api/remotes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'unreachable',
          baseUrl: 'https://127.0.0.1:9',
          certificateFingerprint: certificateFingerprint(fixtureTls.cert),
        }),
      });
      expect(response.status).toBe(502);
      expect(await response.json()).toMatchObject({
        message:
          'Nothing answers over HTTPS at https://127.0.0.1:9. Start the VM, then check the address.',
      });
      const { items } = await instances.home.storage.listRemotes({ limit: 500 });
      expect(items.some((remote) => remote.baseUrl === 'https://127.0.0.1:9')).toBe(false);
    }, 30_000);

    it('reports the home folder as unknown when the VM never answered', async () => {
      const remote = await instances.home.storage.createRemote({
        kind: 'address',
        name: 'unreachable',
        baseUrl: 'https://127.0.0.1:9',
        tlsCertificate: fixtureTls.cert,
      });
      await instances.home.app.get<RemoteHealthPort>(REMOTE_HEALTH_PORT).refresh(remote.id);

      expect(await listed(instances, remote.id)).toMatchObject({
        online: false,
        homePath: null,
        homePathMatches: null,
        lastOperation: null,
        logins: null,
      });
    }, 30_000);
  });

  // Integration: two real apps, HTTP, encrypted vault/storage and host files;
  // only the host marker and provider CLI/tmux process boundary are simulated.
  describe('update logins across two instances', () => {
    let marker: jest.SpyInstance;
    let restoreExecutor: (() => void) | undefined;
    const oldKey = 'DEVCHAIN_TEST_OLD_LOGIN';
    const newKey = 'CLAUDE_CODE_OAUTH_TOKEN';
    let savedNew: string | undefined;
    let savedOld: string | undefined;

    beforeAll(async () => {
      savedNew = process.env[newKey];
      savedOld = process.env[oldKey];
      marker = jest
        .spyOn(instances.host.app.get(HostHelperService), 'isClaimedHost')
        .mockReturnValue(true);
      const executor = instances.host.app.get(ProcessExecutor);
      const run = jest.mocked(executor.run);
      const originalRun = run.getMockImplementation()!;
      const executorSpy = jest.spyOn(executor, 'run');
      restoreExecutor = () => {
        executorSpy.mockRestore();
        run.mockImplementation(originalRun);
      };
      executorSpy.mockImplementation(async (request) => ({
        success: true,
        exitCode: 0,
        stdout: request.argv.includes('status')
          ? '{"loggedIn":true,"authMethod":"oauth_token"}'
          : '',
        stderr: '',
        timedOut: false,
        truncated: false,
      }));
    }, 60_000);

    afterAll(async () => {
      marker?.mockRestore();
      restoreExecutor?.();
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
      expect(
        parseHostEnvFile(readFileSync(join(hostHome, '.devchain', 'host.env'), 'utf8')),
      ).toEqual({ [newKey]: 'new-test-token', UNCHANGED_TEST_KEY: 'keep' });
      expect(process.env[oldKey]).toBeUndefined();
      expect(process.env[newKey]).toBe('new-test-token');
      expect(JSON.stringify(done)).not.toContain('new-test-token');
    }, 30_000);
  });
});
