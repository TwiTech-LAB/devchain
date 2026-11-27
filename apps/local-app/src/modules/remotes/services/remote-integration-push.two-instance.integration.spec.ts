/**
 * Home delivers a project's Jira connection to a VM across Connect, a VM reboot, a locked
 * Vault, a token replacement, a reconnect and Disconnect, and a VM agent reads the remote
 * task through MCP while home is stopped. No token reaches the VM's files, a replica, an MCP
 * answer or any log line. Test layer: two-instance integration. The health poll, binding
 * events, HTTP, the VM's DB, runtime directory and MCP meet only in two booted apps; the
 * vendor is one recording fake that both apps call.
 */
import { Injectable, Logger } from '@nestjs/common';
import { inspect } from 'node:util';
import type { IncomingMessage } from 'node:http';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  startTwoInstances,
  waitForValue,
  type TwoInstances,
} from '../../../common/test/two-instance.fixture';
import {
  INTEGRATIONS_VM_CACHE_FILE,
  IntegrationVmCacheService,
} from '../../external-integrations/vm-cache/integration-vm-cache.service';
import { recordingVendor } from '../../external-integrations/testing/recording-vendor.fixture';
import { McpService } from '../../mcp/services/mcp.service';
import {
  RUNTIME_DIRECTORY_HOST,
  systemRuntimeDirectoryHost,
} from '../../runtime-directory/runtime-directory';
import type {
  IntegrationConnection,
  Remote,
  RemoteOperation,
} from '../../storage/models/domain.models';
import { VaultKeyService } from '../../vault/vault-key.service';
import { HostApiKeyService } from '../host/host-api-key.service';
import { HostHelperService } from '../host/host-helper.service';
import { ProjectReplicaBuilder } from '../replica/project-replica.builder';
import { ensureProvider, seedReplicaSource } from '../replica/__fixtures__/replica-seed';
import { RemoteIntegrationPushService } from './remote-integration-push.service';

const TMPFS = 0x01021994;
const CANARY = 'canary-jira-token-5d1e';
const ROTATED = 'canary-jira-rotated-9a02';
const RECONNECTED = 'canary-jira-reconnected-77b3';
const CLICKUP_B = 'canary-clickup-b-31f0';
const VM_SESSION = '77777777-7777-4777-8777-777777777777';
const EMAIL = 'agent@example.com';

// The host plays a claimed VM. Both apps share `process.env`, so a real claim record
// would also make home a VM; these seams claim only the host.
@Injectable()
class ClaimedHelper extends HostHelperService {
  override assertClaimedHost(): void {}
}
@Injectable()
class ClaimedIntegrationCache extends IntegrationVmCacheService {
  override isClaimedHost(): boolean {
    return true;
  }
}
/** The fixture host has no key file; the route's own key rule matches the Vault route's. */
@Injectable()
class KeylessHostApiKey extends HostApiKeyService {
  override allows(request: IncomingMessage, transport: 'http' | 'socket') {
    return super.allows(request, transport, false);
  }
}

// Every log line of both apps, at every level, for the token checks.
jest.mock('../../../common/logging/logger', () => {
  const pino = jest.requireActual<typeof import('pino')>('pino');
  const { Writable } = jest.requireActual<typeof import('node:stream')>('node:stream');
  const lines: string[] = [];
  (globalThis as { __loggedLines?: string[] }).__loggedLines = lines;
  const sink = new Writable({
    write(chunk: Buffer, _encoding: string, done: () => void) {
      lines.push(chunk.toString('utf8'));
      done();
    },
  });
  const logger = pino.default({ level: 'trace' }, sink);
  return { logger, createLogger: (context: string) => logger.child({ context }) };
});
const loggedLines = (): string[] =>
  (globalThis as { __loggedLines?: string[] }).__loggedLines ?? [];

const vendor = recordingVendor();
vendor.issues.add('ENG-1');
/** The vendor calls of one VM `devchain_external_tasks_get` of ENG-1. */
const TASK_READ = [
  'GET /rest/api/3/issue/ENG-1',
  'GET /rest/api/3/issue/ENG-1/transitions',
  'GET /rest/api/3/configuration',
];

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

describe('Integration connections from home to a VM', () => {
  let instances: TwoInstances;
  let remote: Remote;
  let runtimeDir: string;

  const home = () => instances.home;
  const host = () => instances.host;
  const cacheFile = () => join(runtimeDir, INTEGRATIONS_VM_CACHE_FILE);
  const hostCache = () => host().app.get(IntegrationVmCacheService);
  const cachedText = () => readIfPresent(cacheFile())?.toString('utf8') ?? '';
  const hostRows = () =>
    host()
      .sqlite.prepare(
        `SELECT id, project_id, provider, generation, credential_ciphertext, subtask_sync_enabled
         FROM integration_connections ORDER BY id`,
      )
      .all();
  const jira = (token: string) =>
    ({ provider: 'jira', siteUrl: 'https://acme.atlassian.net', email: EMAIL, token }) as const;
  const connect = (projectId: string, credentials: ReturnType<typeof jira>) =>
    home().storage.replaceIntegrationConnection(
      { projectId, provider: credentials.provider, credentials },
      async () => undefined,
    );
  const hostRow = (connection: IntegrationConnection) => ({
    id: connection.id,
    project_id: 'A',
    provider: 'jira',
    generation: connection.generation,
    credential_ciphertext: '',
    subtask_sync_enabled: 0,
  });

  /** The VM agent's `devchain_external_tasks_get`; its output must never hold a token. */
  let from = 0;
  async function readOnVm(): Promise<{
    success: boolean;
    data?: unknown;
    error?: { code: string };
  }> {
    from = vendor.calls.length;
    const response = await host()
      .app.get(McpService)
      .handleToolCall('devchain_external_tasks_get', {
        sessionId: VM_SESSION,
        ref: 'ENG-1',
        provider: 'jira',
      });
    for (const token of [CANARY, ROTATED, RECONNECTED]) {
      expect(JSON.stringify(response)).not.toContain(token);
    }
    return response as { success: boolean; data?: unknown; error?: { code: string } };
  }

  async function expectRead(token: string): Promise<void> {
    const read = await readOnVm();
    expect(read).toMatchObject({ success: true, data: { remoteKey: 'ENG-1' } });
    expect(vendor.callsAfter(from)).toEqual(
      TASK_READ.map((op) => ({ instance: 'host', op, token: `${EMAIL}:${token}` })),
    );
  }

  async function expectRefused(code: string): Promise<void> {
    const read = await readOnVm();
    expect([read.success, read.error?.code]).toEqual([false, code]);
    expect(vendor.callsAfter(from)).toEqual([]);
  }

  async function runOperation(kind: 'attach' | 'detach', projectId: string) {
    const started = await fetch(`${home().url}/api/remotes/${remote.id}/${kind}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId }),
    });
    expect(started.status).toBe(202);
    const { id } = (await started.json()) as RemoteOperation;
    await waitForValue(async () => {
      const response = await fetch(`${home().url}/api/remotes/operations/${id}`);
      const body = (await response.json()) as RemoteOperation;
      if (body.state === 'failed')
        throw new Error(`Operation failed: ${JSON.stringify(body.steps)}`);
      return body.state === 'done';
    }, 15_000);
  }

  /** Nest loggers are muted in the fixture apps; their calls still pass through here. */
  const nestLogged: string[] = [];

  function expectNoLeak(tokens: readonly string[]): void {
    const encoded = tokens.flatMap((token) => [token, Buffer.from(token).toString('base64')]);
    const logs = [...loggedLines(), ...nestLogged];
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.filter((line) => encoded.some((canary) => line.includes(canary)))).toEqual([]);
    const leaks = [
      ...filesUnder(join(instances.rootDir, 'host')),
      ...filesUnder(join(instances.rootDir, 'shared-home')),
    ]
      .filter((path) => !path.startsWith(`${runtimeDir}/`))
      .filter((path) => encoded.some((canary) => readIfPresent(path)?.includes(canary)));
    expect(leaks).toEqual([]);
  }

  beforeAll(async () => {
    for (const method of ['log', 'error', 'warn', 'debug', 'verbose', 'fatal'] as const) {
      jest
        .spyOn(Logger.prototype, method)
        .mockImplementation((...args: unknown[]) => void nestLogged.push(inspect(args)));
    }
    instances = await startTwoInstances({
      configureModule: (builder, instance, dataDir) => {
        const routed = vendor.configure(builder, instance);
        if (instance !== 'host') return routed;
        runtimeDir = join(dataDir, 'run');
        mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
        return routed
          .overrideProvider(HostHelperService)
          .useClass(ClaimedHelper)
          .overrideProvider(IntegrationVmCacheService)
          .useClass(ClaimedIntegrationCache)
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
    // With the built-in skill source on, Connect makes the host download it from GitHub.
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

    remote = await instances.registerRemote('vm-1');
    await waitForValue(async () => {
      const response = await fetch(`${home().url}/api/remotes`);
      const { items } = (await response.json()) as { items: { online: boolean }[] };
      return items[0]?.online === true;
    }, 10_000);
  }, 60_000);

  afterAll(async () => {
    jest.restoreAllMocks();
    await instances?.close();
  }, 30_000);

  it('delivers, keeps, replaces and removes the connection as home changes it', async () => {
    const first = await connect('A', jira(CANARY));
    await home().storage.replaceIntegrationConnection(
      {
        projectId: 'B',
        provider: 'clickup',
        credentials: { provider: 'clickup', token: CLICKUP_B },
      },
      async () => undefined,
    );

    await runOperation('attach', 'A');

    // Connect delivers metadata and the credentials; project B stays at home.
    expect(hostRows()).toEqual([hostRow(first)]);
    expect(cachedText()).toContain(CANARY);
    expect(cachedText()).not.toContain(CLICKUP_B);
    expect(await hostCache().status()).toMatchObject({ cacheReady: true, cacheUnavailable: null });
    const replica = await host()
      .app.get(ProjectReplicaBuilder)
      .build({ projectIds: ['A'], scope: 'live' });
    expect(JSON.stringify(replica)).not.toContain(CANARY);
    host()
      .sqlite.prepare(
        `INSERT INTO sessions (id, agent_id, status, started_at, created_at, updated_at)
         VALUES (?, 'agent-1', 'running', 'T', 'T', 'T')`,
      )
      .run(VM_SESSION);

    // The VM agent calls Jira itself while home is stopped.
    await home().close();
    await expectRead(CANARY);

    // A VM reboot clears the tmpfs: the agent waits for home.
    rmSync(cacheFile());
    await expectRefused('INTEGRATION_NOT_DELIVERED');
    expectNoLeak([CANARY, CLICKUP_B]);

    // Home's first poll after it returns heals the cache.
    await instances.restartHome();
    await waitForValue(async () => (await hostCache().status()).cacheReady, 10_000);
    await expectRead(CANARY);

    // A locked Vault sends metadata only, and the VM keeps the credentials it holds.
    const locked = jest
      .spyOn(home().app.get(VaultKeyService), 'getState')
      .mockReturnValue('locked');
    const apply = jest.spyOn(hostCache(), 'apply');
    await home().app.get(RemoteIntegrationPushService).pushNow(remote.id);
    expect(apply.mock.calls.at(-1)?.[0]).not.toHaveProperty('secrets');
    await expectRead(CANARY);

    // A token replacement still reaches the VM, and its old credentials stop working.
    const rotated = await connect('A', jira(ROTATED));
    expect(rotated.generation).toBe(2);
    await waitForValue(
      async () => JSON.stringify(hostRows()) === JSON.stringify([hostRow(rotated)]),
      5_000,
    );
    expect(cachedText()).not.toContain(CANARY);
    await expectRefused('INTEGRATION_NOT_DELIVERED');
    locked.mockRestore();
    await waitForValue(async () => (await hostCache().status()).cacheReady, 5_000);
    await expectRead(ROTATED);

    // Disconnect and reconnect land in one push: the new id takes the same project and
    // provider without hitting the VM's unique index.
    apply.mockRejectedValue(new Error('push paused by the test'));
    expect(
      await home().storage.disconnectIntegrationConnection({ projectId: 'A', provider: 'jira' }),
    ).toBe(true);
    const reconnected = await connect('A', jira(RECONNECTED));
    expect(reconnected.id).not.toBe(first.id);
    apply.mockRestore();
    await waitForValue(
      async () =>
        JSON.stringify(hostRows()) === JSON.stringify([hostRow(reconnected)]) &&
        (await hostCache().status()).cacheReady,
      5_000,
    );
    expect(cachedText()).not.toContain(ROTATED);
    await expectRead(RECONNECTED);

    // Disconnect: the VM keeps the metadata while the binding is `detaching`, then
    // the release removes the rows and the cached credentials.
    const watch = jest.spyOn(hostCache(), 'apply');
    await runOperation('detach', 'A');
    await waitForValue(async () => !existsSync(cacheFile()), 5_000);
    const detachPushes = watch.mock.calls.map(([push]) => push);
    watch.mockRestore();
    expect(hostRows()).toEqual([]);
    expect(detachPushes[0]?.connections.map((connection) => connection.id)).toEqual([
      reconnected.id,
    ]);
    expect(detachPushes.at(-1)?.connections).toEqual([]);
    expectNoLeak([CANARY, ROTATED, RECONNECTED, CLICKUP_B]);
    // Home holds the connections but never calls the vendor itself in this sequence.
    expect(vendor.callsAfter(0, { instance: 'home' })).toEqual([]);
  }, 90_000);
});
