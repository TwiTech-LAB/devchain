import type { Provider } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { Test, type TestingModule } from '@nestjs/testing';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { bytesToBase64, fromX25519PrivateKey } from '@devchain/shared';
import { CloudTunnelModule } from '../cloud-tunnel.module';
import {
  CloudSessionManagerService,
  type E2eeEnrollmentVerification,
} from '../../cloud/services/cloud-session-manager.service';
import { DB_CONNECTION } from '../../storage/db/db.provider';
import { STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import { E2eeKeypairService } from '../../e2ee/services/e2ee-keypair.service';
import { E2eeDeviceStoreService } from '../../e2ee/services/e2ee-device-store.service';
import { E2eeTrustService } from '../../e2ee/services/e2ee-trust.service';
import { E2eePairingService } from '../../e2ee/services/e2ee-pairing.service';
import { REALTIME_BROADCASTER } from '../../realtime/ports/realtime-broadcaster.port';
import { ActiveSessionLookup } from '../../sessions/services/active-session-lookup.service';
import { TerminalKeyInputFacade } from '../../terminal/services/terminal-key-input/terminal-key-input.facade';
import { MobileChatRpcService } from './mobile-chat-rpc.service';
import { MobileBoardRpcService } from './mobile-board-rpc.service';
import { ViewportStreamerService } from './viewport-streamer.service';
import { MobileRpcWorkspaceAccessService } from './mobile-rpc-workspace-access.service';
import { ProjectWriteGate } from '../../storage/write-gate/project-write-gate';
import {
  TunnelHandlerService,
  E2EE_REQUIRE_SIGNED_ENROLLMENT_POLICY,
} from './tunnel-handler.service';

// Layer: backend integration. The real handler, trust service and SQLite directory prove
// enforcement and persistence together; signature verification has separate real-JOSE tests.
describe('E2EE enrollment RPC enforcement', () => {
  const phone = fromX25519PrivateKey(new Uint8Array(32).fill(1));
  const pc = fromX25519PrivateKey(new Uint8Array(32).fill(2));
  const params = { kid: phone.kid, publicKeyB64: bytesToBase64(phone.publicKey) };
  const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, CloudTunnelModule) as Provider[];
  let sqlite: Database.Database;
  let module: TestingModule | undefined;
  let previousPolicy: string | undefined;
  let verify: jest.Mock<Promise<E2eeEnrollmentVerification>, [string | undefined, string]>;
  let broadcastEvent: jest.Mock;

  beforeEach(() => {
    previousPolicy = process.env.E2EE_REQUIRE_SIGNED_ENROLLMENT;
    delete process.env.E2EE_REQUIRE_SIGNED_ENROLLMENT;
    sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE settings (
        id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, value TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE paired_device_workspace_grants (
        device_kid TEXT NOT NULL, workspace_id TEXT NOT NULL,
        PRIMARY KEY (device_kid, workspace_id)
      )
    `);
    verify = jest.fn();
    broadcastEvent = jest.fn();
  });

  afterEach(async () => {
    await module?.close();
    module = undefined;
    sqlite.close();
    if (previousPolicy === undefined) delete process.env.E2EE_REQUIRE_SIGNED_ENROLLMENT;
    else process.env.E2EE_REQUIRE_SIGNED_ENROLLMENT = previousPolicy;
  });

  async function resolveHandler(required = false): Promise<TunnelHandlerService> {
    if (required) process.env.E2EE_REQUIRE_SIGNED_ENROLLMENT = 'true';
    module = await Test.createTestingModule({
      providers: [
        ...providers.filter(
          (provider) =>
            provider === TunnelHandlerService ||
            (typeof provider === 'object' &&
              provider.provide === E2EE_REQUIRE_SIGNED_ENROLLMENT_POLICY),
        ),
        E2eeTrustService,
        E2eeDeviceStoreService,
        E2eePairingService,
        { provide: DB_CONNECTION, useValue: drizzle(sqlite) },
        {
          provide: E2eeKeypairService,
          useValue: {
            getOrCreate: async () => pc,
            exportPublic: async () => ({ kid: pc.kid, publicKeyB64: bytesToBase64(pc.publicKey) }),
          },
        },
        { provide: REALTIME_BROADCASTER, useValue: { broadcastEvent } },
        { provide: CloudSessionManagerService, useValue: { verifyE2eeEnrollment: verify } },
        {
          provide: MobileRpcWorkspaceAccessService,
          useValue: { authorize: async () => ({ allowedWorkspaceIds: null }) },
        },
        { provide: ProjectWriteGate, useValue: {} },
        ...[
          STORAGE_SERVICE,
          MobileChatRpcService,
          MobileBoardRpcService,
          ViewportStreamerService,
          TerminalKeyInputFacade,
          ActiveSessionLookup,
        ].map((provide) => ({ provide, useValue: {} })),
      ],
    }).compile();
    expect(module.get<boolean>(E2EE_REQUIRE_SIGNED_ENROLLMENT_POLICY)).toBe(required);
    return module.get(TunnelHandlerService);
  }

  it.each(['missing', 'invalid', 'unverifiable'] as const)(
    'records %s enrollment as unsigned by default',
    async (reason) => {
      verify.mockResolvedValue({ enrollment: 'unsigned', reason });
      const handler = await resolveHandler();

      const response = await handler.handle({
        jsonrpc: '2.0',
        id: 'adopt',
        method: 'e2ee.adoptDeviceKey',
        params,
      });

      expect(response).toMatchObject({ result: { kid: phone.kid, trust: 'unverified' } });
      expect(module!.get(E2eeDeviceStoreService).get(phone.kid)?.enrollment).toBe('unsigned');
    },
  );

  it.each(['missing', 'invalid', 'unverifiable'] as const)(
    'refuses a new key with %s enrollment when enforcement is on',
    async (reason) => {
      verify.mockResolvedValue({ enrollment: 'unsigned', reason });
      const handler = await resolveHandler(true);

      const response = await handler.handle({
        jsonrpc: '2.0',
        id: 'adopt',
        method: 'e2ee.adoptDeviceKey',
        params: { ...params, enrollment: 'signed' },
      });

      expect(response.error).toMatchObject({
        code: -32603,
        message: expect.stringMatching(/^E2EE enrollment/),
      });
      expect(module!.get(E2eeDeviceStoreService).list()).toEqual([]);
      expect(broadcastEvent).not.toHaveBeenCalled();
    },
  );

  it('accepts a signed new key when enforcement is on and threads its attestation', async () => {
    verify.mockResolvedValue({ enrollment: 'signed' });
    const handler = await resolveHandler(true);

    const response = await handler.handle({
      jsonrpc: '2.0',
      id: 'adopt',
      method: 'e2ee.adoptDeviceKey',
      params: { ...params, attestation: 'identity-attestation' },
    });

    expect(response).toMatchObject({ result: { kid: phone.kid, trust: 'unverified' } });
    expect(module!.get(E2eeDeviceStoreService).get(phone.kid)?.enrollment).toBe('signed');
    expect(verify).toHaveBeenCalledWith('identity-attestation', phone.kid);
    expect(broadcastEvent).not.toHaveBeenCalled();
  });

  it.each(['signed', 'unsigned'] as const)(
    'accepts an unsigned re-adopt of a known %s key as a no-op when enforcement is on',
    async (enrollment) => {
      verify.mockResolvedValue({ enrollment: 'unsigned', reason: 'missing' });
      const handler = await resolveHandler(true);
      const store = module!.get(E2eeDeviceStoreService);
      const original = store.add({ ...params, enrollment, label: 'Original phone' });

      const response = await handler.handle({
        jsonrpc: '2.0',
        id: 'adopt',
        method: 'e2ee.adoptDeviceKey',
        params: {
          ...params,
          label: 'Untrusted replacement label',
          installId: '11111111-1111-4111-8111-111111111111',
        },
      });

      expect(response).toMatchObject({ result: { kid: phone.kid, trust: 'unverified' } });
      expect(store.get(phone.kid)).toEqual(original);
      expect(broadcastEvent).not.toHaveBeenCalled();
    },
  );

  it('broadcasts a new unsigned phone once even when two adopts verify concurrently', async () => {
    verify.mockResolvedValue({ enrollment: 'unsigned', reason: 'missing' });
    const handler = await resolveHandler();
    const request = {
      jsonrpc: '2.0' as const,
      id: 'adopt',
      method: 'e2ee.adoptDeviceKey',
      params: { ...params, label: 'Pixel' },
    };

    const responses = await Promise.all([handler.handle(request), handler.handle(request)]);

    expect(responses).toEqual([
      expect.objectContaining({ result: { kid: phone.kid, trust: 'unverified' } }),
      expect.objectContaining({ result: { kid: phone.kid, trust: 'unverified' } }),
    ]);
    expect(broadcastEvent).toHaveBeenCalledTimes(1);
    expect(broadcastEvent).toHaveBeenCalledWith('cloud', 'e2ee_unsigned_device_added', {
      kid: phone.kid,
      label: 'Pixel',
    });
  });

  it('does not notify for a known unsigned phone in compatibility mode', async () => {
    verify.mockResolvedValue({ enrollment: 'unsigned', reason: 'missing' });
    const handler = await resolveHandler();
    module!.get(E2eeDeviceStoreService).add({ ...params, enrollment: 'unsigned' });

    await handler.handle({ jsonrpc: '2.0', id: 'known', method: 'e2ee.adoptDeviceKey', params });

    expect(broadcastEvent).not.toHaveBeenCalled();
  });

  it('suppresses an adopt-first notice while a QR pairing is pending', async () => {
    verify.mockResolvedValue({ enrollment: 'unsigned', reason: 'missing' });
    const handler = await resolveHandler();
    await module!.get(E2eePairingService).beginQrPairing('pending-qr');

    const response = await handler.handle({
      jsonrpc: '2.0',
      id: 'qr',
      method: 'e2ee.adoptDeviceKey',
      params,
    });

    expect(response).toMatchObject({ result: { kid: phone.kid, trust: 'unverified' } });
    expect(broadcastEvent).not.toHaveBeenCalled();
  });

  it('keeps a successful adopt when broadcasting its notice fails', async () => {
    verify.mockResolvedValue({ enrollment: 'unsigned', reason: 'missing' });
    const handler = await resolveHandler();
    broadcastEvent.mockImplementation(() => {
      throw new Error('socket unavailable');
    });

    const response = await handler.handle({
      jsonrpc: '2.0',
      id: 'adopt',
      method: 'e2ee.adoptDeviceKey',
      params,
    });

    expect(response).toMatchObject({ result: { kid: phone.kid, trust: 'unverified' } });
    expect(module!.get(E2eeDeviceStoreService).get(phone.kid)?.enrollment).toBe('unsigned');
    expect(broadcastEvent).toHaveBeenCalledTimes(1);
  });
});
