/**
 * An agent on a claimed VM asks for a Vault entry, the user answers at home, and the
 * value reaches the agent on the VM: once as a stored entry, once as a session-only
 * value. Test layer: two-instance integration. The health poll that mirrors the VM's
 * request, the awaited Vault push, the VM's delivery check and the order in which both
 * stores end the request meet only in two booted apps over HTTP. Agent message delivery
 * is the stubbed edge.
 */
const mockLogLines: unknown[] = [];
jest.mock('../../common/logging/logger', () => {
  const record = (...args: unknown[]) => mockLogLines.push(args);
  const child = { info: record, warn: record, error: record, debug: record, trace: record };
  return { createLogger: () => child, logger: child };
});

import { Injectable } from '@nestjs/common';
import type { IncomingMessage } from 'node:http';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  startTwoInstances,
  waitForValue,
  type TestInstance,
  type TwoInstances,
} from '../../common/test/two-instance.fixture';
import { canaryForms, dumpDatabase, expectNoCanaries } from '../../common/test/vault-canary.helper';
import { AgentMessageDeliveryService } from '../agent-message-delivery/agent-message-delivery.service';
import { EventsService } from '../events/services/events.service';
import { HostApiKeyService } from '../remotes/host/host-api-key.service';
import { HostHelperService } from '../remotes/host/host-helper.service';
import { RemoteHostClient } from '../remotes/operations/remote-host.client';
import { ensureProvider, seedReplicaSource } from '../remotes/replica/__fixtures__/replica-seed';
import {
  RUNTIME_DIRECTORY_HOST,
  systemRuntimeDirectoryHost,
} from '../runtime-directory/runtime-directory';
import type { Remote, RemoteOperation } from '../storage/models/domain.models';
import { VaultVmCacheService } from '../vault/vault-vm-cache.service';
import { VaultRequestService } from './vault-request.service';
import { VaultRequestStore } from './vault-request.store';

const TMPFS = 0x01021994;
const STORED_CANARY = 'canary-vm-request-stored-2c9d';
const SESSION_CANARY = 'canary-vm-request-session-e41b';
const USE_SESSION_CANARY = 'canary-vm-use-session-58a3';
const USE_FAMILY_CANARY = 'canary-vm-use-family-0d96';
const CANARIES = canaryForms([
  STORED_CANARY,
  SESSION_CANARY,
  USE_SESSION_CANARY,
  USE_FAMILY_CANARY,
]);
/** A session of agent-1, whose profile is in the `coder` family. */
const VM_SESSION = '77777777-7777-4777-8777-777777777777';
/** A session of agent-2 in the same project. */
const OTHER_SESSION = '88888888-8888-4888-8888-888888888888';

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
/** The fixture host has no key file; the routes' own key rule is covered in their API tests. */
@Injectable()
class KeylessHostApiKey extends HostApiKeyService {
  override allows(request: IncomingMessage, transport: 'http' | 'socket') {
    return super.allows(request, transport, false);
  }
}

const api = async <T>(
  instance: TestInstance,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; text: string; body: T }> => {
  const response = await fetch(`${instance.url}${path}`, {
    method,
    ...(body !== undefined && {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  });
  const text = await response.text();
  return { status: response.status, text, body: text ? JSON.parse(text) : null };
};

describe('Vault requests from an agent on a VM, answered at home', () => {
  let instances: TwoInstances;
  let remote: Remote;
  let runtimeDir: string;
  const homeBound: unknown[] = [];
  const events: Record<'home' | 'host', Array<{ name: string; payload: unknown }>> = {
    home: [],
    host: [],
  };
  let hostNotices: jest.SpyInstance;
  let homeNotices: jest.SpyInstance;

  const home = () => instances.home;
  const host = () => instances.host;
  const homeStore = () => home().app.get(VaultRequestStore);
  const hostStore = () => host().app.get(VaultRequestStore);
  const resolveOnVm = (sessionId: string, names: string[]) =>
    api<{ details?: { code: string }; env: Record<string, string> }>(
      host(),
      'POST',
      '/api/vault/sessions/resolve',
      { sessionId, names },
    );
  const noticesTo = (spy: jest.SpyInstance) =>
    spy.mock.calls.map((call) => [call[0], (call[1] as { body: string }).body]);
  const eventsNamed = (instance: 'home' | 'host', name: string) =>
    events[instance].filter((event) => event.name === name).map((event) => event.payload);

  async function askOnVm(name: string): Promise<string> {
    const result = await host()
      .app.get(VaultRequestService)
      .request({
        sessionId: VM_SESSION,
        agentId: 'agent-1',
        name,
        description: `${name} for deploys`,
      });
    expect(result).toMatchObject({ status: 'pending', type: 'create', name });
    return (result as { requestId: string }).requestId;
  }

  /** Waits for the health poll to mirror the request and returns home's listed view. */
  async function listedAtHome(requestId: string) {
    let listed: Array<Record<string, unknown>> = [];
    await waitForValue(async () => {
      const response = await api<Array<Record<string, unknown>>>(
        home(),
        'GET',
        '/api/vault/requests',
      );
      homeBound.push(response.text);
      listed = response.body;
      return listed.some((request) => request.requestId === requestId);
    }, 5_000);
    return listed.find((request) => request.requestId === requestId);
  }

  async function attach(projectId: string) {
    const started = await api<RemoteOperation>(home(), 'POST', `/api/remotes/${remote.id}/attach`, {
      projectId,
    });
    expect(started.status).toBe(202);
    await waitForValue(async () => {
      const { body } = await api<RemoteOperation>(
        home(),
        'GET',
        `/api/remotes/operations/${started.body.id}`,
      );
      if (body.state === 'failed') throw new Error(`Attach failed: ${JSON.stringify(body.steps)}`);
      return body.state === 'done';
    }, 15_000);
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
    expect((await api(home(), 'POST', '/api/vault/setup', { mode: 'recovery' })).status).toBe(200);
    const access = { entries: [], access: { mode: 'all' } };
    expect((await api(home(), 'PUT', '/api/vault/projects/A/grants', access)).status).toBe(200);

    remote = await instances.registerRemote('vm-1');
    await waitForValue(async () => {
      const { body } = await api<{ items: { online: boolean }[] }>(home(), 'GET', '/api/remotes');
      return body.items[0]?.online === true;
    }, 10_000);
    await attach('A');
    for (const [sessionId, agentId] of [
      [VM_SESSION, 'agent-1'],
      [OTHER_SESSION, 'agent-2'],
    ]) {
      host()
        .sqlite.prepare(
          `INSERT INTO sessions (id, agent_id, status, started_at, created_at, updated_at)
           VALUES (?, ?, 'running', 'T', 'T', 'T')`,
        )
        .run(sessionId, agentId);
    }

    for (const instance of ['home', 'host'] as const) {
      const publish = instances[instance].app.get(EventsService).publish;
      jest
        .spyOn(instances[instance].app.get(EventsService), 'publish')
        .mockImplementation(function (this: EventsService, name, payload, ...rest) {
          events[instance].push({ name, payload });
          return publish.call(this, name, payload, ...rest);
        } as EventsService['publish']);
    }
    const delivered = { status: 'delivered', results: [] };
    hostNotices = jest
      .spyOn(host().app.get(AgentMessageDeliveryService), 'deliver')
      .mockResolvedValue(delivered as never);
    homeNotices = jest
      .spyOn(home().app.get(AgentMessageDeliveryService), 'deliver')
      .mockResolvedValue(delivered as never);
    const client = home().app.get(RemoteHostClient);
    const list = client.listVaultRequests.bind(client);
    jest.spyOn(client, 'listVaultRequests').mockImplementation(async (remoteId) => {
      const requests = await list(remoteId);
      homeBound.push(requests);
      return requests;
    });
  }, 60_000);

  afterAll(async () => {
    jest.restoreAllMocks();
    await instances?.close();
  }, 30_000);

  it('stores the answer at home, delivers it to the VM, and then ends the request on both', async () => {
    const requestId = await askOnVm('DEPLOY_TOKEN');

    expect(await listedAtHome(requestId)).toMatchObject({
      type: 'create',
      name: 'DEPLOY_TOKEN',
      agentName: 'Agent agent-1',
      familySlug: 'coder',
    });
    expect(eventsNamed('home', 'vault.request.pending')).toEqual([
      expect.objectContaining({ requestId, name: 'DEPLOY_TOKEN' }),
    ]);

    const answered = await api<{ entryId: string }>(
      home(),
      'POST',
      `/api/vault/requests/${requestId}/fulfill`,
      { value: STORED_CANARY, permanent: true },
    );

    expect(answered.status).toBe(200);
    expect(answered.body).toMatchObject({ requestId, status: 'fulfilled', permanent: true });
    expect(
      home()
        .sqlite.prepare('SELECT project_id, family_slug FROM vault_entry_grants WHERE entry_id = ?')
        .all(answered.body.entryId),
    ).toEqual([{ project_id: 'A', family_slug: 'coder' }]);
    // The push was acknowledged before the VM ended the request.
    const pushed = host()
      .sqlite.prepare('SELECT id, revision FROM vault_entries WHERE name = ?')
      .get('DEPLOY_TOKEN') as { id: string; revision: number };
    expect(
      (await host().app.get(VaultVmCacheService).readValues([pushed]))?.get(pushed.id)?.toString(),
    ).toBe(STORED_CANARY);
    expect([homeStore().get(requestId), hostStore().get(requestId)]).toEqual([null, null]);
    expect(eventsNamed('host', 'vault.request.resolved')).toEqual([
      expect.objectContaining({ requestId, status: 'fulfilled', agentId: 'agent-1' }),
    ]);
    await waitForValue(async () => hostNotices.mock.calls.length === 1, 2_000);
    expect(noticesTo(hostNotices)).toEqual([
      [
        ['agent-1'],
        'Secret DEPLOY_TOKEN is available — use devchain vault exec --only DEPLOY_TOKEN -- <cmd>',
      ],
    ]);
    expect(homeNotices).not.toHaveBeenCalled();

    const resolved = await resolveOnVm(VM_SESSION, ['DEPLOY_TOKEN']);
    expect([resolved.status, resolved.body.env]).toEqual([200, { DEPLOY_TOKEN: STORED_CANARY }]);
  }, 30_000);

  it('sends a session-only answer to the VM for the asking session only', async () => {
    hostNotices.mockClear();
    const requestId = await askOnVm('SESSION_TOKEN');
    await listedAtHome(requestId);

    const answered = await api(home(), 'POST', `/api/vault/requests/${requestId}/fulfill`, {
      value: SESSION_CANARY,
      permanent: false,
    });

    expect([answered.status, answered.body]).toEqual([
      200,
      { requestId, status: 'fulfilled', permanent: false, entryId: null },
    ]);
    expect([homeStore().get(requestId), hostStore().get(requestId)]).toEqual([null, null]);
    const resolved = await resolveOnVm(VM_SESSION, ['SESSION_TOKEN']);
    expect([resolved.status, resolved.body.env]).toEqual([200, { SESSION_TOKEN: SESSION_CANARY }]);
    const other = await resolveOnVm(OTHER_SESSION, ['SESSION_TOKEN']);
    expect([other.status, other.body.details]).toEqual([
      403,
      { code: 'VAULT_ENTRY_NOT_GRANTED', names: ['SESSION_TOKEN'] },
    ]);
    // Home keeps no copy and stores no entry.
    expect(
      home().sqlite.prepare("SELECT id FROM vault_entries WHERE name = 'SESSION_TOKEN'").all(),
    ).toEqual([]);
    await waitForValue(async () => hostNotices.mock.calls.length === 1, 2_000);
    expect(noticesTo(hostNotices)).toEqual([
      [
        ['agent-1'],
        'Secret SESSION_TOKEN is available — use devchain vault exec --only SESSION_TOKEN -- <cmd>',
      ],
    ]);
    expect(homeNotices).not.toHaveBeenCalled();
  }, 30_000);

  describe('a use ask raised on the VM', () => {
    /** Creates a gated entry at home and waits until the poll's push brought it to the VM. */
    async function gatedOnVm(name: string, value: string) {
      const created = await api(home(), 'POST', '/api/vault/entries', {
        projects: [{ projectId: 'A', mode: 'families', familySlugs: ['coder'] }],
        name,
        kind: 'secret',
        description: `${name} for releases`,
        value,
        approvalRequired: true,
      });
      expect(created.status).toBe(201);
      await waitForValue(
        async () =>
          host()
            .sqlite.prepare('SELECT approval_required FROM vault_entries WHERE name = ?')
            .get(name) !== undefined,
        10_000,
      );
    }
    /** The gate holds the explicit resolve on the VM and opens a `use` request there. */
    async function askUseOnVm(name: string): Promise<string> {
      const held = await resolveOnVm(VM_SESSION, [name]);
      expect([held.status, held.body.details]).toEqual([
        409,
        { code: 'VAULT_USE_APPROVAL_PENDING', names: [name] },
      ]);
      const [request] = hostStore()
        .listPending()
        .filter((pending) => pending.name === name);
      expect(request).toMatchObject({ type: 'use', sessionId: VM_SESSION });
      return request.requestId;
    }
    const familyRowsOn = (instance: TestInstance) =>
      instance.sqlite
        .prepare('SELECT project_id, family_slug FROM vault_use_family_approvals')
        .all();

    it('reaches home within a poll, and "this session" is applied on the VM', async () => {
      hostNotices.mockClear();
      await gatedOnVm('USE_SESSION', USE_SESSION_CANARY);
      const requestId = await askUseOnVm('USE_SESSION');

      expect(await listedAtHome(requestId)).toMatchObject({
        type: 'use',
        name: 'USE_SESSION',
        familySlug: 'coder',
        remoteName: expect.any(String),
      });
      const approved = await api(home(), 'POST', `/api/vault/requests/${requestId}/approve`, {
        decision: 'session',
      });

      expect([approved.status, approved.body]).toEqual([
        200,
        { requestId, status: 'approved', decision: 'session' },
      ]);
      expect([homeStore().get(requestId), hostStore().get(requestId)]).toEqual([null, null]);
      expect(familyRowsOn(home())).toEqual([]);
      const resolved = await resolveOnVm(VM_SESSION, ['USE_SESSION']);
      expect([resolved.status, resolved.body.env]).toEqual([
        200,
        { USE_SESSION: USE_SESSION_CANARY },
      ]);
      await waitForValue(async () => hostNotices.mock.calls.length === 1, 2_000);
      expect(noticesTo(hostNotices)).toEqual([
        [
          ['agent-1'],
          'Secret USE_SESSION is available — use devchain vault exec --only USE_SESSION -- <cmd>',
        ],
      ]);
    }, 30_000);

    it('ends a "family" answer on the VM only once the pushed snapshot holds the row', async () => {
      await gatedOnVm('USE_FAMILY', USE_FAMILY_CANARY);
      const requestId = await askUseOnVm('USE_FAMILY');
      await listedAtHome(requestId);
      const approve = () =>
        api<{ details?: { code: string } }>(
          home(),
          'POST',
          `/api/vault/requests/${requestId}/approve`,
          { decision: 'family' },
        );
      // A push that home believes delivered but the VM never got.
      const client = home().app.get(RemoteHostClient);
      const held = jest.spyOn(client, 'putVault').mockResolvedValue(undefined as never);

      const refused = await approve();

      expect([refused.status, refused.body.details]).toEqual([
        409,
        { code: 'VAULT_REQUEST_APPROVAL_NOT_DELIVERED' },
      ]);
      expect(familyRowsOn(home())).toEqual([{ project_id: 'A', family_slug: 'coder' }]);
      expect(familyRowsOn(host())).toEqual([]);
      expect(hostStore().get(requestId)).not.toBeNull();
      expect(homeStore().get(requestId)).not.toBeNull();

      held.mockRestore();
      const retried = await approve();

      expect(retried.status).toBe(200);
      expect(familyRowsOn(host())).toEqual([{ project_id: 'A', family_slug: 'coder' }]);
      expect([homeStore().get(requestId), hostStore().get(requestId)]).toEqual([null, null]);
      const resolved = await resolveOnVm(VM_SESSION, ['USE_FAMILY']);
      expect([resolved.status, resolved.body.env]).toEqual([
        200,
        { USE_FAMILY: USE_FAMILY_CANARY },
      ]);
    }, 30_000);
  });

  it('keeps every value out of list responses, events, both DBs and the logs', async () => {
    const vmList = await api(host(), 'GET', '/api/host/vault/requests');

    // Each surface was captured, so an empty scan cannot pass for the wrong reason.
    expect([homeBound.length, mockLogLines.length].every((count) => count > 0)).toBe(true);
    expectNoCanaries(
      {
        vmList: vmList.text,
        homeBound,
        homeEvents: events.home,
        hostEvents: events.host,
        homeDb: dumpDatabase(home().sqlite),
        hostDb: dumpDatabase(host().sqlite),
        logs: mockLogLines,
      },
      CANARIES,
    );
  });
});
