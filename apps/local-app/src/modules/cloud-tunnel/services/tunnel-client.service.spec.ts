/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires, @typescript-eslint/ban-types */
import { TunnelClientService } from './tunnel-client.service';
import { CloudSessionManagerService } from '../../cloud/services/cloud-session-manager.service';
import { RefreshGateService } from '../../cloud/services/refresh-gate.service';
import { TunnelKeypairService } from './tunnel-keypair.service';
import { TunnelHandlerService } from './tunnel-handler.service';

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

    service = new TunnelClientService(
      cloudSession as CloudSessionManagerService,
      refreshGate as RefreshGateService,
      keypair as TunnelKeypairService,
      handler as TunnelHandlerService,
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

  it('should not reconnect on 4002 (revoked)', async () => {
    const WebSocket = require('ws').default;
    service.handleCloudConnected();

    mockInstances[0]._emit('close', 4002, 'revoked');
    await Promise.resolve();

    jest.advanceTimersByTime(120_000);
    expect(WebSocket).toHaveBeenCalledTimes(1);
  });

  it('should not reconnect on 4003 (protocol_unsupported)', async () => {
    const WebSocket = require('ws').default;
    service.handleCloudConnected();

    mockInstances[0]._emit('close', 4003, 'protocol_unsupported');
    await Promise.resolve();

    jest.advanceTimersByTime(120_000);
    expect(WebSocket).toHaveBeenCalledTimes(1);
  });
});
