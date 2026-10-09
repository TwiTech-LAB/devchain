import type { Provider } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { Test, type TestingModule } from '@nestjs/testing';
import { CloudSessionManagerService } from '../cloud/services/cloud-session-manager.service';
import { RefreshGateService } from '../cloud/services/refresh-gate.service';
import { InstanceLabelService } from '../cloud/services/instance-label.service';
import { E2eeKeypairService } from '../e2ee/services/e2ee-keypair.service';
import { E2eeDeviceStoreService } from '../e2ee/services/e2ee-device-store.service';
import { WorkspaceModeCoordinatorService } from '../workspaces/services/workspace-mode-coordinator.service';
import { HostHelperService } from '../remotes/host/host-helper.service';
import { CloudTunnelModule } from './cloud-tunnel.module';
import { TunnelEventForwarderService } from './services/tunnel-event-forwarder.service';
import { TunnelClientService } from './services/tunnel-client.service';
import { TunnelHandlerService } from './services/tunnel-handler.service';
import { TunnelKeypairService } from './services/tunnel-keypair.service';
import {
  E2EE_REQUIRED_POLICY,
  TunnelRpcCryptoService,
  type JsonRpcRequestLike,
} from './services/tunnel-rpc-crypto.service';

const mockSockets: { on: jest.Mock; send: jest.Mock; close: jest.Mock; readyState: number }[] = [];

jest.mock('ws', () => ({
  __esModule: true,
  default: Object.assign(
    jest.fn(() => {
      const socket = { on: jest.fn(), send: jest.fn(), close: jest.fn(), readyState: 1 };
      mockSockets.push(socket);
      return socket;
    }),
    { OPEN: 1 },
  ),
}));

// Layer: module unit. Resolve the real policy and consumers through Nest while faking
// storage and networking; no application bootstrap is needed to prove the runtime default.
describe('CloudTunnelModule', () => {
  const providers = (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, CloudTunnelModule) ??
    []) as Provider[];
  let testingModule: TestingModule | undefined;
  let previousPolicy: string | undefined;

  beforeEach(() => {
    previousPolicy = process.env.E2EE_REQUIRED;
    delete process.env.E2EE_REQUIRED;
    mockSockets.length = 0;
    jest.useFakeTimers();
  });

  afterEach(async () => {
    await testingModule?.close();
    testingModule = undefined;
    if (previousPolicy === undefined) delete process.env.E2EE_REQUIRED;
    else process.env.E2EE_REQUIRED = previousPolicy;
    jest.useRealTimers();
  });

  async function resolveModule(): Promise<TestingModule> {
    testingModule = await Test.createTestingModule({
      providers: [
        ...providers.filter(
          (provider) =>
            provider === TunnelRpcCryptoService ||
            provider === TunnelClientService ||
            (typeof provider === 'object' && provider.provide === E2EE_REQUIRED_POLICY),
        ),
        { provide: E2eeDeviceStoreService, useValue: {} },
        {
          provide: E2eeKeypairService,
          useValue: {
            exportPublic: jest.fn().mockResolvedValue({
              kid: 'pc-kid',
              publicKeyB64: 'pc-public-key',
            }),
          },
        },
        {
          provide: CloudSessionManagerService,
          useValue: { getAccessToken: () => 'test-token', getStatus: () => ({ connected: false }) },
        },
        { provide: RefreshGateService, useValue: {} },
        {
          provide: TunnelKeypairService,
          useValue: {
            getOrCreate: jest.fn().mockResolvedValue({
              publicKey: 'tunnel-public-key',
              privateKey: 'tunnel-private-key',
            }),
            sign: jest.fn().mockResolvedValue('test-signature'),
          },
        },
        { provide: TunnelHandlerService, useValue: {} },
        {
          provide: WorkspaceModeCoordinatorService,
          useValue: {
            getSnapshot: jest.fn().mockResolvedValue({
              multiWorkspaceMode: false,
              failClosedPending: false,
            }),
          },
        },
        { provide: InstanceLabelService, useValue: { getLabel: () => null } },
        { provide: HostHelperService, useValue: { isClaimedHost: () => false } },
      ],
    }).compile();
    return testingModule;
  }

  it('registers TunnelEventForwarderService (push events up the tunnel)', () => {
    expect(providers).toContain(TunnelEventForwarderService);
  });

  it.each([
    { value: undefined, required: true },
    { value: 'false', required: false },
    { value: 'true', required: true },
    { value: '', required: true },
  ])(
    'resolves E2EE_REQUIRED_POLICY to $required for E2EE_REQUIRED=$value',
    async ({ value, required }) => {
      if (value !== undefined) process.env.E2EE_REQUIRED = value;
      const module = await resolveModule();

      expect(module.get<boolean>(E2EE_REQUIRED_POLICY)).toBe(required);
    },
  );

  it('refuses plaintext chat.sendMessage with the default policy before dispatch', async () => {
    const module = await resolveModule();
    const dispatch = jest.fn();

    const response = await module
      .get(TunnelRpcCryptoService)
      .handle(
        { jsonrpc: '2.0', id: 'send', method: 'chat.sendMessage', params: { text: 'hello' } },
        'instance-1',
        dispatch,
      );

    expect(response).toEqual({
      jsonrpc: '2.0',
      id: 'send',
      error: { code: -32603, message: 'E2EE required' },
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('accepts plaintext e2ee.adoptDeviceKey with the default policy', async () => {
    const module = await resolveModule();
    const request: JsonRpcRequestLike = {
      jsonrpc: '2.0',
      id: 'adopt',
      method: 'e2ee.adoptDeviceKey',
      params: { kid: 'phone-kid', publicKeyB64: 'phone-public-key' },
    };
    const dispatch = jest.fn(async (req: JsonRpcRequestLike) => ({
      jsonrpc: '2.0' as const,
      id: req.id,
      result: { accepted: true },
    }));

    const response = await module
      .get(TunnelRpcCryptoService)
      .handle(request, 'instance-1', dispatch);

    expect(response).toEqual({ jsonrpc: '2.0', id: 'adopt', result: { accepted: true } });
    expect(dispatch).toHaveBeenCalledWith(request);
  });

  it('advertises e2eeRequired: true in the attest handshake by default', async () => {
    const module = await resolveModule();
    module.get(TunnelClientService).handleCloudConnected();
    const socket = mockSockets[0];
    const onMessage = socket.on.mock.calls.find(([event]) => event === 'message')![1] as (
      data: Buffer,
    ) => Promise<void>;

    await onMessage(Buffer.from(JSON.stringify({ type: 'challenge', nonce: 'nonce', ts: 'ts' })));

    const attest = JSON.parse(socket.send.mock.calls[0][0]);
    expect(attest).toMatchObject({
      type: 'attest',
      e2ee: { e2eeRequired: true, e2eeSupported: true },
    });
  });
});
