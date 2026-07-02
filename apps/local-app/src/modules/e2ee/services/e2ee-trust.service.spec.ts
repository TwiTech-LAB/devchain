import { Test, TestingModule } from '@nestjs/testing';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import {
  fromX25519PrivateKey,
  bytesToBase64,
  deriveSafetyNumber,
  type E2eeKeyPair,
} from '@devchain/shared';
import { DB_CONNECTION } from '../../storage/db/db.provider';
import { NotFoundError, ValidationError } from '../../../common/errors/error-types';
import { E2eeDeviceStoreService } from './e2ee-device-store.service';
import { E2eeKeypairService } from './e2ee-keypair.service';
import { E2eeTrustService } from './e2ee-trust.service';

// Module-unit with REAL :memory: SQLite. The keypair service is faked to a fixed PC key
// so the test owns both pubkeys; the crypto under test (deriveSafetyNumber) is the REAL
// shared impl, asserted to match a directly-computed value (so PC == phone).
function bytes(seed: number): Uint8Array {
  let s = seed >>> 0;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    out[i] = s & 0xff;
  }
  return out;
}

const pcKeyPair = fromX25519PrivateKey(bytes(0xa11ce));
const deviceKeyPair = fromX25519PrivateKey(bytes(0xb0b));
// The kid is the DERIVED id of the device public key — adoptPeerKeyTofu now derives-and-
// verifies it (RE2E1/RE2E2 identity binding), so the fixture must use the real derived kid.
const deviceKid = deviceKeyPair.kid;
const devicePubB64 = bytesToBase64(deviceKeyPair.publicKey);

describe('E2eeTrustService (Task:8 — safety-number + TOFU + verify)', () => {
  let service: E2eeTrustService;
  let deviceStore: E2eeDeviceStoreService;
  let sqlite: Database.Database;

  const fakeKeypair: Pick<E2eeKeypairService, 'getOrCreate' | 'exportPublic'> = {
    getOrCreate: async (): Promise<E2eeKeyPair> => pcKeyPair,
    exportPublic: async () => ({
      kid: pcKeyPair.kid,
      publicKeyB64: bytesToBase64(pcKeyPair.publicKey),
    }),
  };

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, value TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      )
    `);
    const db = drizzle(sqlite);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        E2eeTrustService,
        E2eeDeviceStoreService,
        { provide: DB_CONNECTION, useValue: db },
        { provide: E2eeKeypairService, useValue: fakeKeypair },
      ],
    }).compile();
    service = module.get(E2eeTrustService);
    deviceStore = module.get(E2eeDeviceStoreService);
  });

  afterEach(() => sqlite.close());

  describe('getSafetyNumber', () => {
    it('returns the same number the phone computes for the pair (order-independent)', async () => {
      deviceStore.add({ kid: deviceKid, publicKeyB64: devicePubB64 });
      const result = await service.getSafetyNumber(deviceKid);
      // PC computes deriveSafetyNumber(pc, device); the phone computes (device, pc) —
      // identical because the function sorts the keys.
      expect(result.safetyNumber).toBe(
        deriveSafetyNumber(deviceKeyPair.publicKey, pcKeyPair.publicKey),
      );
      expect(result.safetyNumber.split(' ')).toHaveLength(8);
      expect(result.trust).toBe('unverified');
    });

    it('throws NotFound for an unknown device', async () => {
      await expect(service.getSafetyNumber('missing')).rejects.toBeInstanceOf(NotFoundError);
    });

    it('throws Validation for a missing kid', async () => {
      await expect(service.getSafetyNumber('')).rejects.toBeInstanceOf(ValidationError);
    });
  });

  describe('listDevices', () => {
    it('lists paired devices newest-first with metadata only (no key material)', () => {
      deviceStore.add({
        kid: deviceKid,
        publicKeyB64: devicePubB64,
        addedAt: '2026-06-20T00:00:00Z',
        adoptedVia: 'email-tofu',
        label: 'Pixel',
      });
      const second = fromX25519PrivateKey(bytes(0xfeed));
      deviceStore.add({
        kid: second.kid,
        publicKeyB64: bytesToBase64(second.publicKey),
        addedAt: '2026-06-22T00:00:00Z',
        adoptedVia: 'qr',
        trust: 'verified',
        verifiedVia: 'qr',
        verifiedAt: '2026-06-22T00:00:00Z',
        label: 'iPhone',
      });

      const list = service.listDevices();

      expect(list.map((d) => d.label)).toEqual(['iPhone', 'Pixel']); // newest first
      expect(list[1]).toEqual({
        kid: deviceKid,
        label: 'Pixel',
        trust: 'unverified',
        adoptedVia: 'email-tofu',
        addedAt: '2026-06-20T00:00:00Z',
      });
      // Key material must never leak into the summary surface.
      expect(list[0]).not.toHaveProperty('publicKeyB64');
    });

    it('returns an empty list when nothing is paired', () => {
      expect(service.listDevices()).toEqual([]);
    });
  });

  describe('revokeDevice', () => {
    it('removes a paired device (un-pair) and reports removed', () => {
      service.adoptPeerKeyTofu({ kid: deviceKid, publicKeyB64: devicePubB64 });
      expect(deviceStore.get(deviceKid)).not.toBeNull();

      const res = service.revokeDevice(deviceKid);

      expect(res).toEqual({ kid: deviceKid, removed: true });
      expect(deviceStore.get(deviceKid)).toBeNull();
      expect(service.listDevices()).toEqual([]);
    });

    it('is idempotent for an unknown device (removed:false)', () => {
      expect(service.revokeDevice('missing')).toEqual({ kid: 'missing', removed: false });
    });

    it('rejects a missing kid', () => {
      expect(() => service.revokeDevice('')).toThrow(ValidationError);
    });
  });

  describe('verifyDevice', () => {
    it('marks a TOFU-adopted device verified via safety-number', () => {
      service.adoptPeerKeyTofu({ kid: deviceKid, publicKeyB64: devicePubB64 });
      const result = service.verifyDevice(deviceKid);
      expect(result.trust).toBe('verified');
      expect(result.verifiedVia).toBe('safety-number');
      expect(deviceStore.get(deviceKid)?.trust).toBe('verified');
    });

    it('throws NotFound for an unknown device', () => {
      expect(() => service.verifyDevice('missing')).toThrow(NotFoundError);
    });
  });

  describe('adoptPeerKeyTofu', () => {
    it('adopts a relayed key as unverified email-tofu', () => {
      const result = service.adoptPeerKeyTofu({ kid: deviceKid, publicKeyB64: devicePubB64 });
      expect(result.trust).toBe('unverified');
      expect(deviceStore.get(deviceKid)?.adoptedVia).toBe('email-tofu');
    });

    it('rejects a non-32-byte key', () => {
      expect(() =>
        service.adoptPeerKeyTofu({
          kid: deviceKid,
          publicKeyB64: bytesToBase64(new Uint8Array(16)),
        }),
      ).toThrow(ValidationError);
    });

    it('reverts to unverified when re-adopting a rotated key (new key → new kid)', () => {
      service.adoptPeerKeyTofu({ kid: deviceKid, publicKeyB64: devicePubB64 });
      service.verifyDevice(deviceKid);
      // A rotated key necessarily carries its OWN derived kid (kid-verify forbids reusing
      // the old kid for a new key); it adopts fresh as unverified — never auto-trusted.
      const rotatedKeyPair = fromX25519PrivateKey(bytes(0xc0c));
      const rotated = service.adoptPeerKeyTofu({
        kid: rotatedKeyPair.kid,
        publicKeyB64: bytesToBase64(rotatedKeyPair.publicKey),
      });
      expect(rotated.trust).toBe('unverified');
      expect(rotated.verifiedVia).toBeUndefined();
    });

    it('rejects a kid that does not match the public key (identity binding)', () => {
      expect(() =>
        service.adoptPeerKeyTofu({ kid: 'd'.repeat(32), publicKeyB64: devicePubB64 }),
      ).toThrow(ValidationError);
    });

    // RE2E2 regression (identity binding at ingestion): a substituted public key carrying
    // an EXISTING trusted kid must be rejected AND must NOT overwrite the trusted record.
    // Before RE2E2, `deriveKid` was never called at ingestion, so a relay that swaps the
    // key while keeping the victim's kid would have silently replaced the trusted key.
    // Layer: module-unit with real :memory: SQLite — the cheapest layer proving the
    // ingestion boundary rejects + does-not-persist (a pure mock couldn't prove "not
    // stored"; the real device store does).
    it('a substituted key carrying an existing trusted kid is rejected and does NOT overwrite the record (RE2E2)', () => {
      // Establish a trusted device.
      service.adoptPeerKeyTofu({ kid: deviceKid, publicKeyB64: devicePubB64 });
      service.verifyDevice(deviceKid);
      expect(deviceStore.get(deviceKid)?.trust).toBe('verified');

      // Attacker relays a DIFFERENT key but keeps the original (trusted) kid.
      const attacker = fromX25519PrivateKey(bytes(0xdead));
      expect(() =>
        service.adoptPeerKeyTofu({
          kid: deviceKid,
          publicKeyB64: bytesToBase64(attacker.publicKey),
        }),
      ).toThrow(ValidationError);

      // The trusted record is UNTOUCHED — the substituted key did not overwrite it.
      const stored = deviceStore.get(deviceKid);
      expect(stored?.publicKeyB64).toBe(devicePubB64);
      expect(stored?.trust).toBe('verified');
      // The attacker's key was NOT persisted under any kid.
      expect(deviceStore.get(attacker.kid)).toBeNull();
      expect(deviceStore.list()).toHaveLength(1);
    });

    // M2 supersede (paired-device-dedup, Task:3): the TOFU seam threads installId through
    // to the store with evictVerified:false — a plaintext bootstrap adopt.
    describe('installId supersede (M2)', () => {
      const INSTALL = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      const device2 = fromX25519PrivateKey(bytes(0xc0ffee));

      it('supersedes the phone’s prior UNVERIFIED row on re-login (same install, new kid)', () => {
        service.adoptPeerKeyTofu({ kid: deviceKid, publicKeyB64: devicePubB64 }, INSTALL);
        service.adoptPeerKeyTofu(
          { kid: device2.kid, publicKeyB64: bytesToBase64(device2.publicKey) },
          INSTALL,
        );
        // The dead pre-login row is gone; exactly one live entry remains.
        expect(deviceStore.list().map((d) => d.kid)).toEqual([device2.kid]);
      });

      it('SECURITY INVARIANT: a plaintext TOFU adopt must NEVER force-unpair a verified device', () => {
        service.adoptPeerKeyTofu({ kid: deviceKid, publicKeyB64: devicePubB64 }, INSTALL);
        service.verifyDevice(deviceKid); // becomes 'verified' (e.g. via safety-number)

        // Attacker (or a benign re-login) TOFU-adopts a new key claiming the same installId.
        service.adoptPeerKeyTofu(
          { kid: device2.kid, publicKeyB64: bytesToBase64(device2.publicKey) },
          INSTALL,
        );

        // The verified device survives; the new key is merely added alongside it.
        expect(deviceStore.get(deviceKid)?.trust).toBe('verified');
        expect(
          deviceStore
            .list()
            .map((d) => d.kid)
            .sort(),
        ).toEqual([deviceKid, device2.kid].sort());
      });
    });

    it('UI contract: installId is NOT exposed by listDevices (unauthenticated metadata stays server-side)', () => {
      service.adoptPeerKeyTofu(
        { kid: deviceKid, publicKeyB64: devicePubB64 },
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      );
      const summary = service.listDevices()[0];
      expect(summary).toBeDefined();
      expect('installId' in summary).toBe(false);
    });
  });
});
