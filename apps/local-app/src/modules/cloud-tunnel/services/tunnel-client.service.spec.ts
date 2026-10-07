/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports, @typescript-eslint/no-empty-object-type, @typescript-eslint/no-unsafe-function-type, @typescript-eslint/no-wrapper-object-types */
import { TunnelClientService } from './tunnel-client.service';
import { CloudSessionManagerService } from '../../cloud/services/cloud-session-manager.service';
import { RefreshGateService } from '../../cloud/services/refresh-gate.service';
import { InstanceLabelService } from '../../cloud/services/instance-label.service';
import { TunnelKeypairService } from './tunnel-keypair.service';
import { E2eeKeypairService } from '../../e2ee/services/e2ee-keypair.service';
import { TunnelHandlerService } from './tunnel-handler.service';
import { TunnelRpcCryptoService } from './tunnel-rpc-crypto.service';
import { WorkspaceModeCoordinatorService } from '../../workspaces/services/workspace-mode-coordinator.service';
import type { HostHelperService } from '../../remotes/host/host-helper.service';

const mockInstances: any[] = [];

jest.mock('ws', () => {
  const MockWebSocket = jest.fn().mockImplementation(() => {
    const listeners: Record<string, Function[]> = {};
    const instance = {
      on: jest.fn((event: string, fn: Function) => {
        if (!listeners[event]) listeners[event] = [];
        listeners[event].push(fn);
      }),
      send: jest.fn(),
      close: jest.fn(),
      terminate: jest.fn(),
      ping: jest.fn(),
      readyState: 1,
      _emit: (event: string, ...args: any[]) => {
        (listeners[event] ?? []).forEach((fn) => fn(...args));
      },
    };
    mockInstances.push(instance);
    return instance;
  });
  (MockWebSocket as any).OPEN = 1;
  return { __esModule: true, default: MockWebSocket };
});

describe('TunnelClientService', () => {
  let service: TunnelClientService;
  let cloudSession: Partial<CloudSessionManagerService>;
  let refreshGate: Partial<RefreshGateService>;
  let keypair: Partial<TunnelKeypairService>;
  let handler: Partial<TunnelHandlerService>;
  let e2eeKeypair: Partial<E2eeKeypairService>;
  let rpcCrypto: Partial<TunnelRpcCryptoService>;
  let workspaceMode: Partial<WorkspaceModeCoordinatorService>;
  let instanceLabel: Partial<InstanceLabelService>;
  let hostHelper: { isClaimedHost: jest.Mock };

  beforeEach(() => {
    jest.useFakeTimers();
    mockInstances.length = 0;
    (require('ws').default as jest.Mock).mockClear();

    cloudSession = {
      getAccessToken: jest.fn().mockReturnValue('valid-jwt'),
      getStatus: jest.fn().mockReturnValue({ connected: false }),
    };

    refreshGate = {
      attemptRefresh: jest.fn().mockResolvedValue('success'),
    };

    keypair = {
      getOrCreate: jest.fn().mockResolvedValue({
        publicKey: 'test-pub-key',
        privateKey: 'test-priv-key',
        instanceId: undefined,
      }),
      sign: jest.fn().mockResolvedValue('test-signature'),
      setInstanceId: jest.fn().mockResolvedValue(undefined),
    };

    handler = {
      handle: jest.fn().mockResolvedValue({ jsonrpc: '2.0', id: 'r1', result: {} }),
    };

    e2eeKeypair = {
      exportPublic: jest.fn().mockResolvedValue({ kid: 'e2ee-kid', publicKeyB64: 'e2ee-pub-b64' }),
    };

    // Default: the RPC crypto seam delegates straight to the inner handler (plaintext
    // path). Encryption behaviour is unit-tested in tunnel-rpc-crypto.service.spec.ts.
    rpcCrypto = {
      handle: jest.fn((req, _instanceId, dispatch) => dispatch(req)),
    };

    workspaceMode = {
      getSnapshot: jest.fn().mockResolvedValue({
        multiWorkspaceMode: false,
        failClosedPending: false,
      }),
    };

    instanceLabel = {
      getLabel: jest.fn().mockReturnValue(null),
    };

    hostHelper = { isClaimedHost: jest.fn().mockReturnValue(false) };

    service = new TunnelClientService(
      cloudSession as CloudSessionManagerService,
      refreshGate as RefreshGateService,
      keypair as TunnelKeypairService,
      handler as TunnelHandlerService,
      e2eeKeypair as E2eeKeypairService,
      rpcCrypto as TunnelRpcCryptoService,
      workspaceMode as WorkspaceModeCoordinatorService,
      instanceLabel as InstanceLabelService,
      hostHelper as unknown as HostHelperService,
    );
  });

  afterEach(() => {
    service.onModuleDestroy();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('should connect on cloud.connected event', () => {
    const WebSocket = require('ws').default;
    service.handleCloudConnected();
    expect(WebSocket).toHaveBeenCalledTimes(1);
  });

  it('connects on application bootstrap when cloud session was restored before tunnel init completes', () => {
    const WebSocket = require('ws').default;
    (cloudSession.getStatus as jest.Mock).mockReturnValue({ connected: true });

    service.onApplicationBootstrap();

    expect(WebSocket).toHaveBeenCalledTimes(1);
  });

  it('does not open a duplicate tunnel on application bootstrap if already connected', () => {
    const WebSocket = require('ws').default;
    (cloudSession.getStatus as jest.Mock).mockReturnValue({ connected: true });

    service.onModuleInit();
    service.onApplicationBootstrap();

    expect(WebSocket).toHaveBeenCalledTimes(1);
  });

  it('should disconnect on cloud.disconnected event', () => {
    service.handleCloudConnected();
    const ws = mockInstances[0];
    service.handleCloudDisconnected();
    expect(ws.close).toHaveBeenCalled();
  });

  it('should reconnect with exponential backoff after normal WS close', async () => {
    const WebSocket = require('ws').default;
    service.handleCloudConnected();
    expect(WebSocket).toHaveBeenCalledTimes(1);

    mockInstances[0]._emit('close', 1006, 'abnormal');
    await Promise.resolve();

    jest.advanceTimersByTime(2000);
    expect(WebSocket).toHaveBeenCalledTimes(2);

    mockInstances[1]._emit('close', 1006, 'abnormal');
    await Promise.resolve();

    jest.advanceTimersByTime(3000);
    expect(WebSocket).toHaveBeenCalledTimes(3);
  });

  it('should terminate and reconnect after WS error even without a close event', () => {
    const WebSocket = require('ws').default;
    service.handleCloudConnected();
    expect(WebSocket).toHaveBeenCalledTimes(1);

    mockInstances[0]._emit('error', new Error('network reset'));

    expect(mockInstances[0].terminate).toHaveBeenCalled();

    jest.advanceTimersByTime(2000);
    expect(WebSocket).toHaveBeenCalledTimes(2);
  });

  it('should terminate and reconnect if tunnel never becomes ready', () => {
    const WebSocket = require('ws').default;
    service.handleCloudConnected();
    expect(WebSocket).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(30_000);

    expect(mockInstances[0].terminate).toHaveBeenCalled();

    jest.advanceTimersByTime(2000);
    expect(WebSocket).toHaveBeenCalledTimes(2);
  });

  it('should reset backoff after ready message', async () => {
    service.handleCloudConnected();
    const ws = mockInstances[0];

    ws._emit('message', Buffer.from(JSON.stringify({ type: 'ready', instanceId: 'inst-1' })));
    await Promise.resolve();
    await Promise.resolve();

    expect(keypair.setInstanceId).toHaveBeenCalledWith('inst-1');
    jest.advanceTimersByTime(30_000);
    expect(ws.terminate).not.toHaveBeenCalled();
  });

  it('should terminate and reconnect when heartbeat pong is missed', async () => {
    const WebSocket = require('ws').default;
    service.handleCloudConnected();
    const ws = mockInstances[0];

    ws._emit('message', Buffer.from(JSON.stringify({ type: 'ready', instanceId: 'inst-1' })));
    await Promise.resolve();
    await Promise.resolve();

    jest.advanceTimersByTime(30_000);
    expect(ws.ping).toHaveBeenCalledTimes(1);
    expect(ws.terminate).not.toHaveBeenCalled();

    jest.advanceTimersByTime(10_000);
    expect(ws.terminate).toHaveBeenCalled();

    jest.advanceTimersByTime(2000);
    expect(WebSocket).toHaveBeenCalledTimes(2);
  });

  it('should call refreshGate.attemptRefresh on 4001 close and reconnect on success', async () => {
    const WebSocket = require('ws').default;
    service.handleCloudConnected();

    mockInstances[0]._emit('close', 4001, 'auth_failed');
    await Promise.resolve();
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(0);

    expect(refreshGate.attemptRefresh).toHaveBeenCalled();

    jest.advanceTimersByTime(2000);
    expect(WebSocket).toHaveBeenCalledTimes(2);
  });

  it('should reconnect on transient refresh failure after auth close', async () => {
    (refreshGate.attemptRefresh as jest.Mock).mockResolvedValue('transient_failure');
    const WebSocket = require('ws').default;
    service.handleCloudConnected();

    mockInstances[0]._emit('close', 4001, 'auth_failed');
    await jest.advanceTimersByTimeAsync(100);

    jest.advanceTimersByTime(2000);
    expect(WebSocket).toHaveBeenCalledTimes(2);
  });

  it('should stop reconnecting on permanent_failure from refreshGate', async () => {
    (refreshGate.attemptRefresh as jest.Mock).mockResolvedValue('permanent_failure');
    const WebSocket = require('ws').default;
    service.handleCloudConnected();
    expect(WebSocket).toHaveBeenCalledTimes(1);

    mockInstances[0]._emit('close', 4001, 'auth_failed');
    await jest.advanceTimersByTimeAsync(100);

    jest.advanceTimersByTime(120_000);
    expect(WebSocket).toHaveBeenCalledTimes(1);
  });

  it.each([
    [4002, 'revoked'],
    [4003, 'protocol_unsupported'],
  ])('does not reconnect after close %s (%s)', async (code, reason) => {
    const WebSocket = require('ws').default;
    service.handleCloudConnected();

    mockInstances[0]._emit('close', code, reason);
    await Promise.resolve();

    jest.advanceTimersByTime(120_000);
    expect(WebSocket).toHaveBeenCalledTimes(1);
  });

  it.each(['lab-vm', null])('attests label %s with hostname fallback', async (label) => {
    (instanceLabel.getLabel as jest.Mock).mockReturnValue(label);
    service.handleCloudConnected();
    const ws = mockInstances[0];

    ws._emit('message', Buffer.from(JSON.stringify({ type: 'challenge', nonce: 'n', ts: 't' })));
    for (let i = 0; i < 6; i++) await Promise.resolve();

    const attestCall = ws.send.mock.calls.find((c: any[]) => JSON.parse(c[0]).type === 'attest');
    expect(JSON.parse(attestCall[0]).label).toBe(label ?? require('os').hostname());
  });

  it.each([true, false])('attests role for claimed=%s', async (claimed) => {
    hostHelper.isClaimedHost.mockReturnValue(claimed);
    service.handleCloudConnected();
    const ws = mockInstances[0];

    ws._emit('message', Buffer.from(JSON.stringify({ type: 'challenge', nonce: 'n', ts: 't' })));
    for (let i = 0; i < 6; i++) await Promise.resolve();

    const attestCall = ws.send.mock.calls.find((c: any[]) => JSON.parse(c[0]).type === 'attest');
    if (claimed) {
      expect(JSON.parse(attestCall[0]).role).toBe('host');
    } else {
      expect(JSON.parse(attestCall[0])).not.toHaveProperty('role');
    }
  });

  it('advertises the E2EE capability (pubkey + fingerprint) in the attest handshake', async () => {
    service.handleCloudConnected();
    const ws = mockInstances[0];

    ws._emit('message', Buffer.from(JSON.stringify({ type: 'challenge', nonce: 'n', ts: 't' })));
    // Flush the respondToChallenge microtask chain (getOrCreate → sign → exportPublic → send).
    for (let i = 0; i < 6; i++) await Promise.resolve();

    const attestCall = ws.send.mock.calls.find((c: any[]) => JSON.parse(c[0]).type === 'attest');
    const e2ee = JSON.parse(attestCall[0]).e2ee;
    expect(e2ee).toMatchObject({
      e2eeSupported: true,
      e2eeRequired: false,
      keyFingerprint: 'e2ee-kid',
      publicKeyB64: 'e2ee-pub-b64',
    });
    expect(typeof e2ee.v).toBe('number');
    expect(typeof e2ee.envelopeVersion).toBe('number');
  });

  it('advertises workspace support and the authoritative live mode independently', async () => {
    (workspaceMode.getSnapshot as jest.Mock).mockResolvedValueOnce({
      multiWorkspaceMode: true,
      failClosedPending: true,
    });
    service.handleCloudConnected();
    const ws = mockInstances[0];

    ws._emit('message', Buffer.from(JSON.stringify({ type: 'challenge', nonce: 'n', ts: 't' })));
    for (let i = 0; i < 8; i++) await Promise.resolve();

    const attest = ws.send.mock.calls
      .map((call: any[]) => JSON.parse(call[0]))
      .find((message: any) => message.type === 'attest');
    expect(attest).toMatchObject({
      workspaceSupport: { v: 1 },
      multiWorkspaceMode: true,
      workspaceModePending: true,
    });
  });

  it('still attests (advertising no E2EE) when the E2EE keypair export fails', async () => {
    (e2eeKeypair.exportPublic as jest.Mock).mockRejectedValueOnce(new Error('keystore locked'));
    service.handleCloudConnected();
    const ws = mockInstances[0];

    ws._emit('message', Buffer.from(JSON.stringify({ type: 'challenge', nonce: 'n', ts: 't' })));
    // Flush the respondToChallenge microtask chain (getOrCreate → sign → exportPublic → send).
    for (let i = 0; i < 6; i++) await Promise.resolve();

    const attestCall = ws.send.mock.calls.find((c: any[]) => JSON.parse(c[0]).type === 'attest');
    expect(attestCall).toBeDefined();
    expect(JSON.parse(attestCall[0]).e2ee).toBeUndefined();
    expect(JSON.parse(attestCall[0]).protocolVersion).toBe('2');
  });

  it('sendPush is gated: false (no write) before ready, true (writes frame) after ready', async () => {
    service.handleCloudConnected();
    const ws = mockInstances[0];
    const frame = {
      type: 'push' as const,
      v: 2 as const,
      topic: 'session/s1/transcript',
      eventType: 'updated',
      payload: { x: 1 },
    };

    // Before `ready`: gated.
    expect(service.canPush()).toBe(false);
    const sendsBefore = ws.send.mock.calls.length;
    expect(service.sendPush(frame)).toBe(false);
    expect(ws.send.mock.calls.length).toBe(sendsBefore);

    // After `ready`: writes exactly the serialized frame.
    ws._emit('message', Buffer.from(JSON.stringify({ type: 'ready', instanceId: 'inst-1' })));
    await Promise.resolve();
    await Promise.resolve();

    expect(service.canPush()).toBe(true);
    expect(service.sendPush(frame)).toBe(true);
    const pushWrite = ws.send.mock.calls
      .map((c: any[]) => c[0])
      .find((s: string) => {
        try {
          return JSON.parse(s).type === 'push';
        } catch {
          return false;
        }
      });
    expect(pushWrite).toBe(JSON.stringify(frame));
  });

  it('sendPush stops writing after the socket closes', async () => {
    service.handleCloudConnected();
    const ws = mockInstances[0];

    ws._emit('message', Buffer.from(JSON.stringify({ type: 'ready', instanceId: 'inst-1' })));
    await Promise.resolve();
    await Promise.resolve();
    expect(service.canPush()).toBe(true);

    ws._emit('close', 1006, 'abnormal');
    await Promise.resolve();

    expect(service.canPush()).toBe(false);
    expect(
      service.sendPush({
        type: 'push',
        v: 2,
        topic: 'session/s1/transcript',
        eventType: 'updated',
        payload: {},
      }),
    ).toBe(false);
  });

  async function driveToReady() {
    service.handleCloudConnected();
    const ws = mockInstances[0];
    ws._emit('message', Buffer.from(JSON.stringify({ type: 'ready', instanceId: 'inst-42' })));
    await Promise.resolve();
    await Promise.resolve();
    return ws;
  }

  async function flushMicrotasks(count = 8): Promise<void> {
    for (let i = 0; i < count; i++) await Promise.resolve();
  }

  function workspaceModeCommands(ws: any): any[] {
    return ws.send.mock.calls
      .map((call: any[]) => JSON.parse(call[0]))
      .filter((message: any) => message.ctrl === 'workspace_mode_command');
  }

  it('exposes the bridge-assigned instanceId after ready', async () => {
    expect(service.getInstanceId()).toBeNull();
    await driveToReady();
    expect(service.getInstanceId()).toBe('inst-42');
  });

  it('querySseLiveness sends a control query and resolves from the bridge reply', async () => {
    const ws = await driveToReady();

    const promise = service.querySseLiveness();
    const queryWrite = ws.send.mock.calls
      .map((c: any[]) => c[0])
      .map((s: string) => {
        try {
          return JSON.parse(s);
        } catch {
          return null;
        }
      })
      .find((m: any) => m?.type === 'ctrl' && m?.ctrl === 'sse_liveness_query');
    expect(queryWrite).toBeTruthy();
    expect(typeof queryWrite.id).toBe('string');

    // Bridge replies on the same correlation id.
    ws._emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'ctrl',
          v: 1,
          ctrl: 'sse_liveness_result',
          id: queryWrite.id,
          live: true,
          lastSeenAt: 1234,
        }),
      ),
    );
    await Promise.resolve();

    await expect(promise).resolves.toEqual({ live: true, lastSeenAt: 1234 });
  });

  it('querySseLiveness resolves not-live when the tunnel is not push-ready', async () => {
    // No ready handshake → canPush() false.
    service.handleCloudConnected();
    await expect(service.querySseLiveness()).resolves.toEqual({ live: false, lastSeenAt: null });
  });

  it('querySseLiveness times out to not-live when the bridge never replies', async () => {
    await driveToReady();
    const promise = service.querySseLiveness();
    jest.advanceTimersByTime(5_000);
    await expect(promise).resolves.toEqual({ live: false, lastSeenAt: null });
  });

  it('querySseLiveness resolves not-live when the socket closes mid-query', async () => {
    const ws = await driveToReady();
    const promise = service.querySseLiveness();
    ws._emit('close', 1006, 'abnormal');
    await expect(promise).resolves.toEqual({ live: false, lastSeenAt: null });
  });

  it('ignores workspace-mode events while the cloud session is disconnected', () => {
    expect(service.handleWorkspaceModeChanged()).toBeUndefined();

    expect(workspaceMode.getSnapshot).not.toHaveBeenCalled();
    expect(require('ws').default).not.toHaveBeenCalled();
  });

  it('coalesces connected pre-ready events and flushes only the latest snapshot after ready', async () => {
    (cloudSession.getStatus as jest.Mock).mockReturnValue({ connected: true });
    (workspaceMode.getSnapshot as jest.Mock).mockResolvedValue({
      multiWorkspaceMode: true,
      failClosedPending: false,
    });
    const sendCommand = jest
      .spyOn(service, 'sendWorkspaceModeCommand')
      .mockResolvedValue(undefined);
    service.handleCloudConnected();
    const ws = mockInstances[0];

    service.handleWorkspaceModeChanged();
    service.handleWorkspaceModeChanged();
    expect(workspaceMode.getSnapshot).not.toHaveBeenCalled();
    expect(sendCommand).not.toHaveBeenCalled();

    ws._emit('message', Buffer.from(JSON.stringify({ type: 'ready', instanceId: 'inst-42' })));
    await flushMicrotasks();

    expect(workspaceMode.getSnapshot).toHaveBeenCalledTimes(1);
    expect(sendCommand.mock.calls).toEqual([
      ['prepare', true],
      ['commit', true],
    ]);
  });

  it.each([
    {
      name: 'committed multi-workspace takes precedence over pending',
      snapshot: { multiWorkspaceMode: true, failClosedPending: true },
      commands: [
        ['prepare', true],
        ['commit', true],
      ],
    },
    {
      name: 'pending-only mode',
      snapshot: { multiWorkspaceMode: false, failClosedPending: true },
      commands: [['prepare', true]],
    },
    {
      name: 'committed single-workspace mode',
      snapshot: { multiWorkspaceMode: false, failClosedPending: false },
      commands: [['commit', false]],
    },
  ])('maps $name to the existing command contract', async ({ snapshot, commands }) => {
    (cloudSession.getStatus as jest.Mock).mockReturnValue({ connected: true });
    await driveToReady();
    (workspaceMode.getSnapshot as jest.Mock).mockResolvedValue(snapshot);
    const sendCommand = jest
      .spyOn(service, 'sendWorkspaceModeCommand')
      .mockResolvedValue(undefined);

    service.handleWorkspaceModeChanged();
    await flushMicrotasks();

    expect(workspaceMode.getSnapshot).toHaveBeenCalledTimes(1);
    expect(sendCommand.mock.calls).toEqual(commands);
  });

  it('performs one more latest-state pass when an event arrives during a flush', async () => {
    (cloudSession.getStatus as jest.Mock).mockReturnValue({ connected: true });
    await driveToReady();
    (workspaceMode.getSnapshot as jest.Mock)
      .mockResolvedValueOnce({ multiWorkspaceMode: false, failClosedPending: false })
      .mockResolvedValueOnce({ multiWorkspaceMode: false, failClosedPending: true });
    let finishFirstCommand!: () => void;
    const sendCommand = jest
      .spyOn(service, 'sendWorkspaceModeCommand')
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishFirstCommand = resolve;
          }),
      )
      .mockResolvedValue(undefined);

    service.handleWorkspaceModeChanged();
    await flushMicrotasks(2);
    expect(workspaceMode.getSnapshot).toHaveBeenCalledTimes(1);

    service.handleWorkspaceModeChanged();
    finishFirstCommand();
    await flushMicrotasks();

    expect(workspaceMode.getSnapshot).toHaveBeenCalledTimes(2);
    expect(sendCommand.mock.calls).toEqual([
      ['commit', false],
      ['prepare', true],
    ]);
  });

  it('contains snapshot-read rejection and closes the current tunnel for retry', async () => {
    (cloudSession.getStatus as jest.Mock).mockReturnValue({ connected: true });
    const ws = await driveToReady();
    (workspaceMode.getSnapshot as jest.Mock).mockRejectedValueOnce(new Error('storage busy'));

    expect(service.handleWorkspaceModeChanged()).toBeUndefined();
    await flushMicrotasks();

    expect(ws.close).toHaveBeenCalledWith(1012, 'workspace_mode_reconcile_failed');
    expect(service.canPush()).toBe(false);
  });

  it('closes the current tunnel when a live workspace command is rejected', async () => {
    (cloudSession.getStatus as jest.Mock).mockReturnValue({ connected: true });
    const ws = await driveToReady();
    (workspaceMode.getSnapshot as jest.Mock).mockResolvedValue({
      multiWorkspaceMode: false,
      failClosedPending: true,
    });

    service.handleWorkspaceModeChanged();
    await flushMicrotasks(2);
    const command = workspaceModeCommands(ws)[0];
    ws._emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'ctrl',
          v: 1,
          ctrl: 'workspace_mode_result',
          id: command.id,
          operation: command.operation,
          ok: false,
          error: 'bridge cleanup failed',
        }),
      ),
    );
    await flushMicrotasks();

    expect(ws.close).toHaveBeenCalledWith(1012, 'workspace_mode_reconcile_failed');
    expect(service.canPush()).toBe(false);
  });

  it('uses command timeout to force normal reconnect and next-attestation convergence', async () => {
    const WebSocket = require('ws').default;
    (cloudSession.getStatus as jest.Mock).mockReturnValue({ connected: true });
    const ws = await driveToReady();
    (workspaceMode.getSnapshot as jest.Mock).mockResolvedValue({
      multiWorkspaceMode: false,
      failClosedPending: true,
    });

    service.handleWorkspaceModeChanged();
    await flushMicrotasks(2);
    expect(workspaceModeCommands(ws)).toHaveLength(1);

    jest.advanceTimersByTime(5_000);
    await flushMicrotasks();
    expect(ws.close).toHaveBeenCalledWith(1012, 'workspace_mode_reconcile_failed');

    ws._emit('close', 1012, 'workspace_mode_reconcile_failed');
    await flushMicrotasks();
    jest.advanceTimersByTime(2_000);
    expect(WebSocket).toHaveBeenCalledTimes(2);

    const reconnected = mockInstances[1];
    reconnected._emit(
      'message',
      Buffer.from(JSON.stringify({ type: 'challenge', nonce: 'next', ts: 'attestation' })),
    );
    await flushMicrotasks();
    const attest = reconnected.send.mock.calls
      .map((call: any[]) => JSON.parse(call[0]))
      .find((message: any) => message.type === 'attest');
    expect(attest).toMatchObject({
      multiWorkspaceMode: false,
      workspaceModePending: true,
    });

    reconnected._emit(
      'message',
      Buffer.from(JSON.stringify({ type: 'ready', instanceId: 'inst-reconnected' })),
    );
    await flushMicrotasks();
    expect(workspaceModeCommands(reconnected)).toHaveLength(0);
  });

  it('sends workspace-mode control and resolves only its matching acknowledgement', async () => {
    const ws = await driveToReady();
    const promise = service.sendWorkspaceModeCommand('prepare', true);
    const command = ws.send.mock.calls
      .map((call: any[]) => JSON.parse(call[0]))
      .find((message: any) => message.ctrl === 'workspace_mode_command');

    expect(command).toMatchObject({
      type: 'ctrl',
      v: 1,
      operation: 'prepare',
      multiWorkspaceMode: true,
    });
    ws._emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'ctrl',
          v: 1,
          ctrl: 'workspace_mode_result',
          id: command.id,
          operation: 'prepare',
          ok: true,
        }),
      ),
    );

    await expect(promise).resolves.toBeUndefined();
  });

  it('rejects workspace-mode control when the bridge rejects or disconnects', async () => {
    const ws = await driveToReady();
    const rejected = service.sendWorkspaceModeCommand('commit', true);
    const command = ws.send.mock.calls
      .map((call: any[]) => JSON.parse(call[0]))
      .find((message: any) => message.ctrl === 'workspace_mode_command');
    ws._emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'ctrl',
          v: 1,
          ctrl: 'workspace_mode_result',
          id: command.id,
          operation: 'commit',
          ok: false,
          error: 'workspace_mode_control_failed',
        }),
      ),
    );
    await expect(rejected).rejects.toThrow('workspace_mode_control_failed');

    const disconnected = service.sendWorkspaceModeCommand('abort', false);
    ws._emit('close', 1006, 'abnormal');
    await expect(disconnected).rejects.toThrow('Bridge tunnel closed');
  });

  it('routes inbound RPC through the crypto seam (instanceId bound) and sends the response', async () => {
    const ws = await driveToReady();
    const rpcMsg = { jsonrpc: '2.0', id: 'r1', method: 'board.listProjects', params: {} };
    ws._emit('message', Buffer.from(JSON.stringify(rpcMsg)));
    await Promise.resolve();
    await Promise.resolve();

    // The seam is invoked with the bridge-assigned instanceId + a dispatch callback.
    expect(rpcCrypto.handle).toHaveBeenCalledTimes(1);
    const [seenReq, seenInstanceId, dispatch] = (rpcCrypto.handle as jest.Mock).mock.calls[0];
    expect(seenReq).toMatchObject({ id: 'r1', method: 'board.listProjects' });
    expect(seenInstanceId).toBe('inst-42');
    expect(typeof dispatch).toBe('function');

    // The (delegated) handler result is written back on the socket.
    const rpcSend = ws.send.mock.calls
      .map((c: any[]) => JSON.parse(c[0]))
      .find((m: any) => m.id === 'r1');
    expect(rpcSend).toEqual({ jsonrpc: '2.0', id: 'r1', result: {} });
    expect(handler.handle).toHaveBeenCalled();
  });
});
