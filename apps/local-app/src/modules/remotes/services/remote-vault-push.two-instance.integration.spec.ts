/**
 * Home pushes Vault entries to a VM across Connect, value changes, a VM reboot and
 * Disconnect, and an agent session on the VM resolves values from the pushed cache under
 * the pushed Vault access. Test layer: two-instance integration. Grant filters, the health poll,
 * the binding events, HTTP and the VM's DB and runtime directory meet only in two
 * booted apps.
 */
import { Injectable } from '@nestjs/common';
import type { IncomingMessage } from 'node:http';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  startTwoInstances,
  waitForValue,
  type TestInstance,
  type TwoInstances,
} from '../../../common/test/two-instance.fixture';
import {
  RUNTIME_DIRECTORY_HOST,
  systemRuntimeDirectoryHost,
} from '../../runtime-directory/runtime-directory';
import {
  STORAGE_SERVICE,
  type VaultEntryStorage,
} from '../../storage/interfaces/storage.interface';
import type { Remote, RemoteOperation, VaultEntry } from '../../storage/models/domain.models';
import { VaultPushBuilder } from '../../vault/vault-push.builder';
import { VAULT_VM_CACHE_FILE, VaultVmCacheService } from '../../vault/vault-vm-cache.service';
import { HostApiKeyService } from '../host/host-api-key.service';
import { HostHelperService } from '../host/host-helper.service';
import { ensureProvider, seedReplicaSource } from '../replica/__fixtures__/replica-seed';

const TMPFS = 0x01021994;
const CANARY = 'canary-vm-push-3b7e';
const ROTATED = 'canary-vm-rotated-c41d';
const FILE_CANARY = 'canary-vm-file-58aa';
const VM_SESSION = '77777777-7777-4777-8777-777777777777';
/** A session of agent-2, whose profile has no family. */
const VM_NO_FAMILY_SESSION = '88888888-8888-4888-8888-888888888888';

// The host plays a claimed VM. Both apps share `process.env`, so a real claim record
// would also make home a VM and lock its Vault; these seams claim only the host.
@Injectable()
class ClaimedHelper extends HostHelperService {
  override assertClaimedHost(): void {}
}
@Injectable()
class ClaimedCache extends VaultVmCacheService {
  override isClaimedHost(): boolean {
    return true;
  }
}
/** The fixture host has no key file; the route's own key rule is covered in its API test. */
@Injectable()
class KeylessHostApiKey extends HostApiKeyService {
  override allows(request: IncomingMessage, transport: 'http' | 'socket') {
    return super.allows(request, transport, false);
  }
}

type Api = <T>(
  instance: TestInstance,
  method: string,
  path: string,
  body?: unknown,
) => Promise<{ status: number; body: T }>;

const api: Api = async (instance, method, path, body) => {
  const response = await fetch(`${instance.url}${path}`, {
    method,
    ...(body !== undefined && {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
};

function filesUnder(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    try {
      return statSync(path).isDirectory() ? filesUnder(path) : [path];
    } catch {
      return []; // Removed while the scan ran (an atomic rename's temporary file).
    }
  });
}

function readIfPresent(path: string): Buffer | null {
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}

describe('Vault push from home to a VM', () => {
  let instances: TwoInstances;
  let remote: Remote;
  let runtimeDir: string;

  const home = () => instances.home;
  const host = () => instances.host;
  const cacheFile = () => join(runtimeDir, VAULT_VM_CACHE_FILE);
  const hostCache = () => host().app.get(VaultVmCacheService);
  const hostEntryNames = () =>
    (
      host().sqlite.prepare('SELECT name FROM vault_entries ORDER BY name').all() as Array<{
        name: string;
      }>
    ).map((row) => row.name);
  const hostAccess = () =>
    host()
      .sqlite.prepare(
        'SELECT project_id, family_slug FROM vault_family_access ORDER BY project_id, family_slug',
      )
      .all();
  const resolveOnHost = (sessionId: string) =>
    api<{ code?: string; env: Record<string, string>; files: Record<string, string> }>(
      host(),
      'POST',
      '/api/vault/sessions/resolve',
      { sessionId },
    );
  const setHomeAccess = async (projectId: string, access: Record<string, unknown>) =>
    expect(
      (await api(home(), 'PUT', `/api/vault/projects/${projectId}/grants`, { entries: [], access }))
        .status,
    ).toBe(200);
  const hostValue = async (name: string) => {
    const row = host()
      .sqlite.prepare('SELECT id, revision FROM vault_entries WHERE name = ?')
      .get(name) as { id: string; revision: number } | undefined;
    if (!row) return null;
    return (await hostCache().readValues([row]))?.get(row.id)?.toString('utf8') ?? null;
  };

  async function runOperation(kind: 'attach' | 'detach', projectId: string) {
    const started = await api<RemoteOperation>(
      home(),
      'POST',
      `/api/remotes/${remote.id}/${kind}`,
      {
        projectId,
      },
    );
    expect(started.status).toBe(202);
    await waitForValue(async () => {
      const { body } = await api<RemoteOperation>(
        home(),
        'GET',
        `/api/remotes/operations/${started.body.id}`,
      );
      if (body.state === 'failed')
        throw new Error(`Operation failed: ${JSON.stringify(body.steps)}`);
      return body.state === 'done';
    }, 15_000);
  }

  async function createEntry(body: Record<string, unknown>): Promise<VaultEntry> {
    const response = await api<VaultEntry>(home(), 'POST', '/api/vault/entries', body);
    expect(response.status).toBe(201);
    return response.body;
  }

  beforeAll(async () => {
    instances = await startTwoInstances({
      configureModule: (builder, instance, dataDir) => {
        if (instance !== 'host') return builder;
        runtimeDir = join(dataDir, 'run');
        mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
        return builder
          .overrideProvider(HostHelperService)
          .useClass(ClaimedHelper)
          .overrideProvider(VaultVmCacheService)
          .useClass(ClaimedCache)
          .overrideProvider(HostApiKeyService)
          .useClass(KeylessHostApiKey)
          .overrideProvider(RUNTIME_DIRECTORY_HOST)
          .useValue({
            ...systemRuntimeDirectoryHost(join(dataDir, 'devchain.db')),
            env: () => ({ RUNTIME_DIRECTORY: runtimeDir }),
            fileSystemType: async () => TMPFS,
          });
      },
    });
    seedReplicaSource(home().sqlite);
    home()
      .sqlite.prepare("UPDATE agent_profiles SET family_slug = 'coder' WHERE id = 'profile-a'")
      .run();
    // Home pushes its skill switches; with the built-in source on, Connect makes the
    // host download it from GitHub.
    for (const instance of [home(), host()]) {
      instance.sqlite
        .prepare(
          `INSERT INTO settings (id, key, value, created_at, updated_at)
           VALUES ('skill-switches', 'skills.sources', ?, 'T', 'T')
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        )
        .run(JSON.stringify({ microsoft: false }));
    }
    ensureProvider(host().sqlite, 'host-claude', 'claude', null);
    ensureProvider(host().sqlite, 'host-codex', 'codex', null);
    expect((await api(home(), 'POST', '/api/vault/setup', { mode: 'recovery' })).status).toBe(200);

    remote = await instances.registerRemote('vm-1');
    await waitForValue(async () => {
      const { body } = await api<{ items: { online: boolean }[] }>(home(), 'GET', '/api/remotes');
      return body.items[0]?.online === true;
    }, 10_000);
  }, 60_000);

  afterAll(async () => {
    await instances?.close();
  }, 30_000);

  it('sends granted entries at Connect, follows changes and a reboot, and clears them at Disconnect', async () => {
    const own = await createEntry({
      projects: [{ projectId: 'A', mode: 'all' }],
      name: 'OWN_TOKEN',
      kind: 'secret',
      description: 'Token of project A',
      value: CANARY,
    });
    const keyFile = await createEntry({
      projects: [],
      name: 'CODER_KEY',
      kind: 'file',
      description: 'Key for coders',
      value: `-----BEGIN KEY-----\n${FILE_CANARY}\n`,
    });
    expect(
      (
        await api(home(), 'PUT', '/api/vault/projects/A/grants', {
          entries: [{ entryId: keyFile.id, mode: 'families', familySlugs: ['coder'] }],
        })
      ).status,
    ).toBe(200);
    await createEntry({
      projects: [{ projectId: 'B', mode: 'all' }],
      name: 'B_TOKEN',
      kind: 'secret',
      description: 'Token of project B',
      value: 'not-for-this-vm',
    });
    await setHomeAccess('A', { mode: 'families', familySlugs: ['coder'] });
    await setHomeAccess('B', { mode: 'all' });

    await runOperation('attach', 'A');

    expect(hostEntryNames()).toEqual(['CODER_KEY', 'OWN_TOKEN']);
    expect(await hostValue('OWN_TOKEN')).toBe(CANARY);
    expect(await hostValue('CODER_KEY')).toContain(FILE_CANARY);
    // Values exist on the VM only in its runtime directory; the cache file proves the scan finds them.
    expect(readFileSync(cacheFile()).includes(Buffer.from(CANARY).toString('base64'))).toBe(true);
    // A push can be mid-write, so the cache's temporary files count as the runtime directory.
    const leaks = [
      ...filesUnder(join(instances.rootDir, 'host')),
      ...filesUnder(join(instances.rootDir, 'shared-home')),
    ]
      .filter((path) => !path.startsWith(`${runtimeDir}/`))
      .filter((path) => {
        const content = readIfPresent(path);
        return [CANARY, FILE_CANARY, Buffer.from(CANARY).toString('base64')].some((canary) =>
          content?.includes(canary),
        );
      });
    expect(leaks).toEqual([]);

    // Only the access of the VM's project arrives; project B stays at home.
    expect(hostAccess()).toEqual([{ project_id: 'A', family_slug: 'coder' }]);
    for (const [sessionId, agentId] of [
      [VM_SESSION, 'agent-1'],
      [VM_NO_FAMILY_SESSION, 'agent-2'],
    ]) {
      host()
        .sqlite.prepare(
          `INSERT INTO sessions (id, agent_id, status, started_at, created_at, updated_at)
           VALUES (?, ?, 'running', 'T', 'T', 'T')`,
        )
        .run(sessionId, agentId);
    }
    const denied = await resolveOnHost(VM_NO_FAMILY_SESSION);
    expect([denied.status, denied.body.code]).toEqual([403, 'VAULT_ACCESS_DENIED']);
    const resolved = await resolveOnHost(VM_SESSION);
    expect(resolved.status).toBe(200);
    expect(resolved.body.env).toEqual({ OWN_TOKEN: CANARY });
    expect(resolved.body.files.CODER_KEY.startsWith(`${runtimeDir}/`)).toBe(true);
    expect(readFileSync(resolved.body.files.CODER_KEY, 'utf8')).toContain(FILE_CANARY);

    // An access change alone reaches the VM at the next health poll.
    await setHomeAccess('A', { mode: 'all' });
    await waitForValue(
      async () =>
        JSON.stringify(hostAccess()) === JSON.stringify([{ project_id: 'A', family_slug: null }]),
      5_000,
    );
    const admitted = await resolveOnHost(VM_NO_FAMILY_SESSION);
    expect([admitted.status, admitted.body.env]).toEqual([200, { OWN_TOKEN: CANARY }]);

    expect(
      (await api(home(), 'PUT', `/api/vault/entries/${own.id}/value`, { value: ROTATED })).status,
    ).toBe(200);
    await waitForValue(async () => (await hostValue('OWN_TOKEN')) === ROTATED, 5_000);

    // Hold home's pushes back so the health poll cannot refill the cache before the check.
    const paused = jest
      .spyOn(hostCache(), 'apply')
      .mockRejectedValue(new Error('push paused by the test'));
    rmSync(cacheFile());
    const missing = await api<{ code: string }>(host(), 'POST', '/api/vault/sessions/resolve', {
      sessionId: VM_SESSION,
    });
    expect([missing.status, missing.body.code]).toEqual([409, 'VAULT_LOCKED']);
    paused.mockRestore();
    await waitForValue(async () => (await hostCache().status()).cacheReady, 5_000);
    expect(await hostValue('OWN_TOKEN')).toBe(ROTATED);

    // Removed access rows revoke access on the VM.
    await setHomeAccess('A', { mode: 'none' });
    await waitForValue(async () => hostAccess().length === 0, 5_000);
    const off = await resolveOnHost(VM_SESSION);
    expect([off.status, off.body.code]).toEqual([403, 'VAULT_NOT_ENABLED']);
    await setHomeAccess('A', { mode: 'all' });
    await waitForValue(async () => hostAccess().length === 1, 5_000);

    // The approval policy rides the push and the VM's read-back gives home's revision, so
    // the health poll stops pushing; the flag keeps the entry revision and the cached value.
    expect(
      (await api(home(), 'PATCH', `/api/vault/entries/${own.id}`, { approvalRequired: true }))
        .status,
    ).toBe(200);
    await home()
      .app.get<VaultEntryStorage>(STORAGE_SERVICE)
      .addVaultUseFamilyApproval(own.id, 'A', 'coder');
    const hostApprovals = () =>
      host()
        .sqlite.prepare('SELECT entry_id, project_id, family_slug FROM vault_use_family_approvals')
        .all();
    await waitForValue(async () => hostApprovals().length === 1, 5_000);
    expect(hostApprovals()).toEqual([{ entry_id: own.id, project_id: 'A', family_slug: 'coder' }]);
    expect(
      host()
        .sqlite.prepare('SELECT revision, approval_required FROM vault_entries WHERE id = ?')
        .get(own.id),
    ).toEqual({ revision: 2, approval_required: 1 });
    const plan = await home().app.get(VaultPushBuilder).plan(['A']);
    expect((await hostCache().status()).appliedRevision).toBe(plan.revision);
    expect(await hostValue('OWN_TOKEN')).toBe(ROTATED);

    await runOperation('detach', 'A');

    await waitForValue(async () => !existsSync(cacheFile()), 5_000);
    expect(hostEntryNames()).toEqual([]);
    expect(hostAccess()).toEqual([]);
  }, 60_000);
});
