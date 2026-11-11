/**
 * Home's mirror of the Vault requests pending on claimed VMs. Unit layer: the VM list,
 * the bindings, agents and entries are fakes at the storage and host-client edges; the
 * real store and its published events are the contract every answering surface reads.
 */
const mockWarn = jest.fn();
jest.mock('../../common/logging/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: mockWarn, error: jest.fn(), debug: jest.fn() }),
}));

import type { VaultRequestPendingEventPayload as HostVaultRequest } from '../events/catalog/vault.request.pending';
import { resetEnvConfig } from '../../common/config/env.config';
import { NotFoundError } from '../../common/errors/error-types';
import { eventCatalog, type EventName } from '../events/catalog';
import type { EventsService } from '../events/services/events.service';
import type { RemoteHostClient } from '../remotes/operations/remote-host.client';
import type { RemoteHealthPort, RemotePollListener } from '../remotes/ports/remote-health.port';
import type { VaultAccessService } from '../vault/vault-access.service';
import { VaultRequestMirrorService } from './vault-request-mirror.service';
import { VaultRequestStore } from './vault-request.store';

const POLL_MS = 10_000;
const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';

describe('VaultRequestMirrorService', () => {
  let published: Array<{ name: EventName; payload: Record<string, unknown> }>;
  let store: VaultRequestStore;
  let mirror: VaultRequestMirrorService;
  let listener: RemotePollListener;
  let listVaultRequests: jest.Mock<Promise<HostVaultRequest[]>, [string]>;
  let bindings: Array<{ projectId: string; remoteId: string; state: string }>;
  let entries: Array<{ id: string; projectId: string | null; name: string; kind: string }>;

  let granted: Array<{ id: string; name: string; kind: string; approvalRequired: boolean }>;

  const agents: Record<string, { id: string; projectId: string; name: string; profileId: string }> =
    {
      'a-coder': { id: 'a-coder', projectId: 'A', name: 'Coder', profileId: 'p-coder' },
      'a-other': { id: 'a-other', projectId: 'B', name: 'Other', profileId: 'p-other' },
    };

  const vmRequest = (overrides: Partial<HostVaultRequest> = {}): HostVaultRequest => ({
    requestId: REQUEST_ID,
    projectId: 'A',
    sessionId: 'vm-session-1',
    agentId: 'a-coder',
    agentName: 'Coder',
    familySlug: 'coder',
    type: 'create',
    name: 'API_TOKEN',
    description: 'Token for the tracker',
    kind: 'secret',
    entryId: null,
    createdAt: Date.now() - 1000,
    expiresAt: Date.now() + 60_000,
    ...overrides,
  });
  const reports = (...lists: HostVaultRequest[][]) => {
    for (const list of lists) listVaultRequests.mockResolvedValueOnce(list);
  };
  const named = (name: EventName) => published.filter((event) => event.name === name);

  beforeEach(() => {
    jest.useFakeTimers();
    process.env.REMOTES_HEALTH_INTERVAL_MS = String(POLL_MS);
    resetEnvConfig();
    mockWarn.mockClear();
    published = [];
    store = new VaultRequestStore({
      publish: jest.fn(async (name: EventName, payload: Record<string, unknown>) => {
        eventCatalog[name].parse(payload);
        published.push({ name, payload });
        return 'event-id';
      }),
    } as unknown as EventsService);
    bindings = [
      { projectId: 'A', remoteId: 'remote-1', state: 'remote' },
      { projectId: 'B', remoteId: 'remote-2', state: 'remote' },
      { projectId: 'C', remoteId: 'remote-1', state: 'attaching' },
    ];
    entries = [];
    granted = [];
    listVaultRequests = jest.fn();
    const health = {
      registerPollListener: (registered: RemotePollListener) => {
        listener = registered;
        return () => undefined;
      },
    } as unknown as RemoteHealthPort;
    mirror = new VaultRequestMirrorService(
      health,
      { listVaultRequests } as unknown as RemoteHostClient,
      {
        listRemoteProjectBindings: async () => bindings,
        getAgent: async (id: string) => {
          if (!agents[id]) throw new NotFoundError('Agent', id);
          return agents[id];
        },
        listVaultEntries: async ({ projectId }: { projectId: string }) =>
          entries.filter((entry) => entry.projectId === projectId || entry.projectId === null),
      } as never,
      store,
      {
        // The profile's ' Coder ' normalizes to 'coder'; a VM session has no overlay here.
        grantedForSession: async (agent: { projectId: string }) => ({
          familySlug: 'coder',
          stored: agent.projectId === 'A' ? granted : [],
          sessionValues: [],
        }),
      } as unknown as VaultAccessService,
    );
    mirror.onModuleInit();
  });

  afterEach(() => {
    store.onModuleDestroy();
    jest.useRealTimers();
  });

  it('adopts a pending VM request on its first poll and announces it once', async () => {
    const reported = vmRequest();
    listVaultRequests.mockResolvedValue([reported]);

    listener.polled('remote-1');
    await jest.advanceTimersByTimeAsync(0);
    await mirror.poll('remote-1');

    expect(listVaultRequests).toHaveBeenCalledWith('remote-1');
    expect(store.listPending()).toEqual([reported]);
    expect(store.remoteOrigin(REQUEST_ID)).toBe('remote-1');
    expect(named('vault.request.pending')).toHaveLength(1);
    expect(named('vault.request.pending')[0].payload).not.toHaveProperty('remoteId');
  });

  it("keeps a request for one poll interval when the VM's expiry has passed on home's clock", async () => {
    reports([vmRequest({ expiresAt: Date.now() - 5000 })]);
    await mirror.poll('remote-1');

    await jest.advanceTimersByTimeAsync(POLL_MS - 1);
    expect(store.get(REQUEST_ID)).not.toBeNull();
    await jest.advanceTimersByTimeAsync(1);
    expect(store.get(REQUEST_ID)).toBeNull();
  });

  it.each([
    ['a project bound to another VM', { projectId: 'B', agentId: 'a-other' }],
    ['a project still attaching', { projectId: 'C' }],
    ['an agent of another project', { agentId: 'a-other' }],
    ['an agent home does not know', { agentId: 'a-ghost' }],
  ])('refuses and logs a request for %s', async (_case, overrides) => {
    reports([vmRequest(overrides)]);

    await mirror.poll('remote-1');

    expect(store.listPending()).toEqual([]);
    expect(published).toEqual([]);
    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({ remoteId: 'remote-1', requestId: REQUEST_ID }),
      expect.stringMatching(/^Refused a Vault request/),
    );
  });

  it("re-derives the request against home's entries, which the VM sees only in part", async () => {
    entries = [
      { id: 'shared-file', projectId: null, name: 'API_TOKEN', kind: 'file' },
      { id: 'other-project', projectId: 'B', name: 'GONE_KEY', kind: 'secret' },
    ];
    reports([
      vmRequest(),
      vmRequest({ requestId: OTHER_ID, name: 'GONE_KEY', type: 'grant', entryId: 'stale' }),
    ]);

    await mirror.poll('remote-1');

    expect(store.get(REQUEST_ID)).toMatchObject({
      type: 'grant',
      entryId: 'shared-file',
      kind: 'file',
    });
    expect(store.get(OTHER_ID)).toMatchObject({ type: 'create', entryId: null });
  });

  it("keeps a use request's type with home's family, and drops it once its entry needs no approval", async () => {
    granted = [
      { id: 'gated', name: 'GATED', kind: 'file', approvalRequired: true },
      { id: 'plain', name: 'PLAIN', kind: 'secret', approvalRequired: false },
    ];
    const use = (requestId: string, name: string, entryId: string) =>
      vmRequest({ requestId, type: 'use', name, entryId, familySlug: 'reviewer' });
    const gated = use(REQUEST_ID, 'GATED', 'gated');
    reports(
      [
        gated,
        use(OTHER_ID, 'PLAIN', 'plain'),
        use('33333333-3333-4333-8333-333333333333', 'X', 'x'),
      ],
      [gated],
    );

    await mirror.poll('remote-1');

    expect(store.listPending()).toEqual([{ ...gated, familySlug: 'coder', kind: 'file' }]);
    expect(mockWarn).toHaveBeenCalledTimes(2);

    granted[0].approvalRequired = false;
    await mirror.poll('remote-1');

    expect(store.listPending()).toEqual([]);
    expect(named('vault.request.resolved').map((event) => event.payload.status)).toEqual([
      'expired',
    ]);
  });

  it('ends a request the VM stops reporting as expired, with nothing to tell the agent', async () => {
    reports([vmRequest()], []);
    await mirror.poll('remote-1');

    await mirror.poll('remote-1');

    expect(store.listPending()).toEqual([]);
    expect(named('vault.request.resolved').map((event) => event.payload.status)).toEqual([
      'expired',
    ]);
    expect(named('vault.request.pending')).toHaveLength(1);
    expect(store.remoteOrigin(REQUEST_ID)).toBeNull();
  });

  it('expires the requests of a lost VM and adopts them again when it reports them', async () => {
    reports([vmRequest()], [vmRequest()]);
    await mirror.poll('remote-1');

    listener.lost('remote-1');
    await jest.advanceTimersByTimeAsync(0);
    expect(store.listPending()).toEqual([]);
    expect(named('vault.request.resolved').map((event) => event.payload.status)).toEqual([
      'expired',
    ]);

    await mirror.poll('remote-1');
    expect(store.get(REQUEST_ID)).not.toBeNull();
    expect(named('vault.request.pending')).toHaveLength(2);
  });

  it('never brings back an answered request from a list fetched before the answer', async () => {
    reports([vmRequest()]);
    await mirror.poll('remote-1');
    let reply!: (list: HostVaultRequest[]) => void;
    listVaultRequests.mockReturnValueOnce(new Promise((resolve) => (reply = resolve)));
    const stale = mirror.poll('remote-1');

    await store.resolve(REQUEST_ID, 'fulfilled');
    reply([vmRequest()]);
    await stale;

    expect(store.listPending()).toEqual([]);
    expect(named('vault.request.pending')).toHaveLength(1);
    // The origin outlives the answer for the resolved subscribers, until the VM drops it.
    expect(store.remoteOrigin(REQUEST_ID)).toBe('remote-1');
    reports([]);
    await mirror.poll('remote-1');
    expect(store.remoteOrigin(REQUEST_ID)).toBeNull();
  });

  it('drops a fetch that a newer fetch overtook', async () => {
    let reply!: (list: HostVaultRequest[]) => void;
    listVaultRequests.mockReturnValueOnce(new Promise((resolve) => (reply = resolve)));
    const older = mirror.poll('remote-1');
    reports([]);
    await mirror.poll('remote-1');

    reply([vmRequest()]);
    await older;

    expect(store.listPending()).toEqual([]);
    expect(published).toEqual([]);
  });
});
