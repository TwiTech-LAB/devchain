/**
 * What a native push for a pending Vault request carries. Unit layer: the shared gate
 * flow (grace window, SSE liveness, mode checks) is covered by the AskUserQuestion gate
 * spec; here the cloud session, egress queue and tunnel are stubs and the payload mapper
 * is real.
 */
import { CloudSessionManagerService } from '../../cloud/services/cloud-session-manager.service';
import { EgressQueueService } from '../../cloud/services/egress-queue.service';
import { EventMapperService } from '../../cloud/services/event-mapper.service';
import { NotificationRecipientResolverService } from '../../cloud/services/notification-recipient-resolver.service';
import { ProjectEgressConfigService } from '../../cloud/services/project-egress-config.service';
import type { VaultRequestPendingEventPayload } from '../../events/catalog/vault.request.pending';
import type { EventsService } from '../../events/services/events.service';
import { VaultRequestStore } from '../../vault-requests/vault-request.store';
import type { VaultVmCacheService } from '../../vault/vault-vm-cache.service';
import type { WorkspaceModeCoordinatorService } from '../../workspaces/services/workspace-mode-coordinator.service';
import { NATIVE_PUSH_GRACE_MS } from './native-push-gate';
import { TunnelClientService } from './tunnel-client.service';
import { VaultRequestPushGateService } from './vault-request-push-gate.service';
import { VaultUseOptInRegistry } from './vault-use-opt-in';

const REQUEST: VaultRequestPendingEventPayload = {
  requestId: '44444444-4444-4444-8444-444444444444',
  projectId: 'project-1',
  sessionId: 'session-1',
  agentId: 'agent-1',
  agentName: 'Coder',
  familySlug: 'coder',
  type: 'create',
  name: 'STRIPE_KEY',
  description: 'Needed to run the payment tests',
  kind: 'secret',
  entryId: null,
  createdAt: 1,
  expiresAt: 2,
};

describe('VaultRequestPushGateService', () => {
  const enqueue = jest.fn();
  const getSnapshot = jest.fn();
  const getRequest = jest.fn();
  let gate: VaultRequestPushGateService;
  let claimed: boolean;
  let optIns: VaultUseOptInRegistry;

  beforeEach(() => {
    optIns = new VaultUseOptInRegistry();
    jest.useFakeTimers();
    enqueue.mockReset();
    getSnapshot.mockResolvedValue({ multiWorkspaceMode: false, failClosedPending: false });
    getRequest.mockReset().mockReturnValue(REQUEST);
    claimed = false;
    gate = createGate({ get: getRequest } as unknown as VaultRequestStore);
  });

  function createGate(requests: VaultRequestStore) {
    return new VaultRequestPushGateService(
      {
        getStatus: () => ({ connected: true, userId: 'user-1' }),
      } as unknown as CloudSessionManagerService,
      { enqueue } as unknown as EgressQueueService,
      new EventMapperService(),
      { isEnabled: () => true } as unknown as ProjectEgressConfigService,
      {
        querySseLiveness: async () => ({ live: false, lastSeenAt: null }),
        getInstanceId: () => 'inst-1',
      } as unknown as TunnelClientService,
      { getSnapshot } as unknown as WorkspaceModeCoordinatorService,
      requests,
      { isClaimedHost: () => claimed } as unknown as VaultVmCacheService,
      optIns,
      new NotificationRecipientResolverService(
        { getProject: async () => ({ workspaceId: 'workspace-1' }) } as never,
        {
          list: () => [
            { kid: 'kid-old', notificationRoutingKid: 'route-old' },
            { kid: 'kid-new', notificationRoutingKid: 'route-new' },
          ],
        } as never,
        { getAccess: () => ({ workspaceIds: ['workspace-1'] }) } as never,
      ),
    );
  }

  afterEach(() => {
    gate.onModuleDestroy();
    jest.useRealTimers();
  });

  async function afterGrace() {
    jest.advanceTimersByTime(NATIVE_PUSH_GRACE_MS);
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  }

  async function pushFor(payload = REQUEST) {
    gate.onPending(payload);
    await afterGrace();
    expect(enqueue).toHaveBeenCalledTimes(1);
    return enqueue.mock.calls[0][0];
  }

  it('pushes the identifiers of the request only, keyed by the request', async () => {
    const push = await pushFor();

    expect(push).toMatchObject({
      sourceEventId: `vault.request:${REQUEST.requestId}`,
      sourceEventType: 'vault.request.pending',
      projectId: 'project-1',
      payload: {
        requestId: REQUEST.requestId,
        projectId: 'project-1',
        sessionId: 'session-1',
        agentId: 'agent-1',
        instanceId: 'inst-1',
      },
    });
    expect(JSON.stringify(push)).not.toMatch(/STRIPE_KEY|payment tests|Coder/);
  });

  it('pushes only an account notice in multi-workspace mode', async () => {
    getSnapshot.mockResolvedValue({ multiWorkspaceMode: true, failClosedPending: false });

    const push = await pushFor();

    expect(push).toMatchObject({
      sourceEventId: `vault.request:${REQUEST.requestId}`,
      sourceEventType: 'vault.request.pending',
      projectId: null,
      payload: { accountLevel: true },
    });
  });

  it.each([
    ['single-workspace', false],
    ['multi-workspace', true],
  ])(
    'sends nothing in %s mode for a request answered within the grace window',
    async (_label, multiWorkspaceMode) => {
      // The user answered on web (or the TTL fired) before the 12 s timer: a push
      // would open a chat with no sheet and sit in the Inbox for a day.
      getSnapshot.mockResolvedValue({ multiWorkspaceMode, failClosedPending: false });
      getRequest.mockReturnValue(null);

      gate.onPending(REQUEST);
      await afterGrace();

      expect(getRequest).toHaveBeenCalledWith(REQUEST.requestId);
      expect(enqueue).not.toHaveBeenCalled();
    },
  );

  describe('for a use request', () => {
    const USE_REQUEST = { ...REQUEST, type: 'use' as const, entryId: 'entry-1' };

    it.each([
      ['single-workspace', false],
      ['multi-workspace', true],
    ])(
      'sends nothing in %s mode while no device asked for use requests',
      async (_label, multiWorkspaceMode) => {
        // An older build lists no use request, so a push would open an empty sheet.
        getSnapshot.mockResolvedValue({ multiWorkspaceMode, failClosedPending: false });

        gate.onPending(USE_REQUEST);
        await afterGrace();

        expect(enqueue).not.toHaveBeenCalled();
      },
    );

    it.each([
      ['the push', false, { requestId: REQUEST.requestId }],
      ['the account notice', true, { accountLevel: true }],
    ])('sends %s only to the devices that asked', async (_label, multiWorkspaceMode, payload) => {
      getSnapshot.mockResolvedValue({ multiWorkspaceMode, failClosedPending: false });
      optIns.record('kid-new');

      expect(await pushFor(USE_REQUEST)).toMatchObject({
        recipientDeviceKids: ['route-new'],
        payload,
      });
    });

    it('keeps create and grant pushes for every device', async () => {
      optIns.record('kid-new');

      expect(await pushFor()).not.toHaveProperty('recipientDeviceKids');
    });
  });

  it('sends nothing from a claimed VM', async () => {
    claimed = true;

    gate.onPending(REQUEST);
    await afterGrace();

    expect(getRequest).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  describe('for a request mirrored from a VM', () => {
    // Home's adoption publishes the pending event; the gate must find the request in
    // home's own store when the grace timer fires.
    let store: VaultRequestStore;
    const mirroredRequest = () => ({
      ...REQUEST,
      createdAt: Date.now(),
      expiresAt: Date.now() + 60 * NATIVE_PUSH_GRACE_MS,
    });

    beforeEach(() => {
      store = new VaultRequestStore({
        publish: async () => 'event-id',
      } as unknown as EventsService);
      gate.onModuleDestroy();
      gate = createGate(store);
    });
    afterEach(() => store.onModuleDestroy());

    it('pushes while the request is pending at home', async () => {
      const request = mirroredRequest();
      await store.syncRemote('vm-1', [request], NATIVE_PUSH_GRACE_MS);

      expect(await pushFor(request)).toMatchObject({
        sourceEventId: `vault.request:${REQUEST.requestId}`,
        payload: { requestId: REQUEST.requestId, instanceId: 'inst-1' },
      });
    });

    it.each([
      ['the VM stops reporting it', (s: VaultRequestStore) => s.syncRemote('vm-1', [], 0)],
      ['the VM goes offline', (s: VaultRequestStore) => s.dropRemote('vm-1')],
      ['it is answered', (s: VaultRequestStore) => s.resolve(REQUEST.requestId, 'denied', {})],
    ])('sends nothing when %s within the grace window', async (_label, end) => {
      const request = mirroredRequest();
      await store.syncRemote('vm-1', [request], NATIVE_PUSH_GRACE_MS);

      gate.onPending(request);
      await end(store);
      await afterGrace();

      expect(enqueue).not.toHaveBeenCalled();
    });
  });
});
