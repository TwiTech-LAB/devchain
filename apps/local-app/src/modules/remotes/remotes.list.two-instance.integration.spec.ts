import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  startTwoInstances,
  waitForValue,
  type TwoInstances,
} from '../../common/test/two-instance.fixture';
import { certificateFingerprint } from '../../common/tls/certificate';
import { fixtureTls } from '../../common/test/tls-fixture';
import type {
  Remote,
  RemoteOperationKind,
  RemoteOperationState,
} from '../storage/models/domain.models';
import type { RemoteListItemDto } from './dtos/remote.dto';
import { REMOTE_HEALTH_PORT, type RemoteHealthPort } from './ports/remote-health.port';

// Jest's process.env never reaches the real os.homedir(); the fixture's HOME
// must, so that home and host report the fixture's folder.
jest.mock('node:os', () => {
  const os = jest.requireActual('node:os');
  return { ...os, homedir: () => process.env.HOME ?? os.homedir() };
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
  let instances: TwoInstances;
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

  beforeAll(async () => {
    // A poll interval far beyond the test timeout: only the POST's refresh can
    // bring a new remote online.
    instances = await startTwoInstances({ healthIntervalMs: 600_000 });
  }, 60_000);

  afterAll(async () => {
    await instances?.close();
  });

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
