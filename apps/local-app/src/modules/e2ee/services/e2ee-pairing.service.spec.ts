import { Test, TestingModule } from '@nestjs/testing';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import {
  fromX25519PrivateKey,
  bytesToBase64,
  base64ToBytes,
  buildPairingTranscript,
  computePairingMac,
  deriveSharedKey,
  type E2eeKeyPair,
} from '@devchain/shared';
import { DB_CONNECTION } from '../../storage/db/db.provider';
import { ForbiddenError, NotFoundError, ValidationError } from '../../../common/errors/error-types';
import { E2eeDeviceStoreService } from './e2ee-device-store.service';
import { E2eeKeypairService } from './e2ee-keypair.service';
import { E2eePairingService } from './e2ee-pairing.service';

// Test layer: module-unit. Real :memory: SQLite proves the VERIFIED peer record is
// actually persisted; the keypair service is faked to a fixed PC key so the test owns
// both sides of the handshake (no machine-binding file side effects). The crypto under
// test (`deriveSharedKey` / transcript / MAC) is the REAL shared implementation.
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

describe('E2eePairingService (Task:4 — QR auto-verified key exchange)', () => {
  let service: E2eePairingService;
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
        E2eePairingService,
        E2eeDeviceStoreService,
        { provide: DB_CONNECTION, useValue: db },
        { provide: E2eeKeypairService, useValue: fakeKeypair },
      ],
    }).compile();

    service = module.get(E2eePairingService);
    deviceStore = module.get(E2eeDeviceStoreService);
  });

  afterEach(() => sqlite.close());

  /** Simulate the phone: read the QR, build the transcript, return key + honest MAC. */
  function mobileResponds(
    channelId: string,
    pairingSecretB64: string,
    mobile: E2eeKeyPair,
    overridePcPub?: Uint8Array,
  ) {
    const transcript = buildPairingTranscript({
      pcPublicKey: overridePcPub ?? pcKeyPair.publicKey,
      pcKid: pcKeyPair.kid,
      mobilePublicKey: mobile.publicKey,
      mobileKid: mobile.kid,
      channelId,
    });
    const mac = computePairingMac(base64ToBytes(pairingSecretB64), transcript);
    return {
      channelId,
      deviceEncPubKey: bytesToBase64(mobile.publicKey),
      deviceEncKid: mobile.kid,
      pairingMac: bytesToBase64(mac),
    };
  }

  it('begin returns the PC public key + a fresh base64 pairing secret', async () => {
    const res = await service.beginQrPairing('chan-1');
    expect(res.pcEncPubKey).toBe(bytesToBase64(pcKeyPair.publicKey));
    expect(res.pcEncKid).toBe(pcKeyPair.kid);
    expect(base64ToBytes(res.pairingSecret).length).toBe(32);
  });

  it('begin mints a distinct secret per channel', async () => {
    const a = await service.beginQrPairing('chan-a');
    const b = await service.beginQrPairing('chan-b');
    expect(a.pairingSecret).not.toBe(b.pairingSecret);
  });

  it('completes the handshake on a valid MAC and marks the device VERIFIED', async () => {
    const mobile = fromX25519PrivateKey(bytes(0xb0b));
    const begin = await service.beginQrPairing('chan-2');
    const reply = mobileResponds('chan-2', begin.pairingSecret, mobile);

    const result = await service.completeQrPairing(reply);

    expect(result.kid).toBe(mobile.kid);
    expect(result.trust).toBe('verified');
    const stored = deviceStore.get(mobile.kid);
    expect(stored?.trust).toBe('verified');
    expect(stored?.verifiedVia).toBe('qr');
    expect(stored?.verifiedAt).toBeTruthy();
    expect(stored?.publicKeyB64).toBe(bytesToBase64(mobile.publicKey));
  });

  it('QR complete supersedes ALL of the phone’s prior rows for the same installId (verified + unverified)', async () => {
    const INSTALL = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    // The phone paired before under two now-dead kids (a verified one and a stale unverified one).
    deviceStore.add({
      kid: 'oldverified'.padEnd(32, '0'),
      publicKeyB64: bytesToBase64(new Uint8Array(32).fill(7)),
      trust: 'verified',
      verifiedVia: 'qr',
      installId: INSTALL,
    });
    deviceStore.add({
      kid: 'oldunverified'.padEnd(32, '0'),
      publicKeyB64: bytesToBase64(new Uint8Array(32).fill(8)),
      installId: INSTALL,
    });

    const mobile = fromX25519PrivateKey(bytes(0xbeef));
    const begin = await service.beginQrPairing('chan-repair');
    const reply = {
      ...mobileResponds('chan-repair', begin.pairingSecret, mobile),
      installId: INSTALL,
    };

    const result = await service.completeQrPairing(reply);

    // Both stale rows are gone; only the freshly-verified re-pair remains for this phone.
    expect(deviceStore.list().map((d) => d.kid)).toEqual([result.kid]);
    expect(deviceStore.get(result.kid)?.trust).toBe('verified');
  });

  it('both ends derive the identical shared key (HKDF works)', async () => {
    const mobile = fromX25519PrivateKey(bytes(0xb0b));
    const pcShared = deriveSharedKey(pcKeyPair.privateKey, mobile.publicKey);
    const mobileShared = deriveSharedKey(mobile.privateKey, pcKeyPair.publicKey);
    expect(Buffer.from(pcShared).toString('hex')).toBe(Buffer.from(mobileShared).toString('hex'));
  });

  it('FAILS CLOSED when a relay substitutes the device key (MAC mismatch)', async () => {
    const mobile = fromX25519PrivateKey(bytes(0xb0b));
    const attacker = fromX25519PrivateKey(bytes(0xbad));
    const begin = await service.beginQrPairing('chan-3');
    // Honest phone computes the MAC over ITS key; the relay forwards the MAC but swaps
    // the public key for the attacker's (it cannot recompute the MAC without the secret).
    const honest = mobileResponds('chan-3', begin.pairingSecret, mobile);
    const tampered = {
      ...honest,
      deviceEncPubKey: bytesToBase64(attacker.publicKey),
      deviceEncKid: attacker.kid,
    };

    await expect(service.completeQrPairing(tampered)).rejects.toBeInstanceOf(ForbiddenError);
    // Nothing trusted — neither the real nor the substituted key was stored.
    expect(deviceStore.get(mobile.kid)).toBeNull();
    expect(deviceStore.get(attacker.kid)).toBeNull();
    expect(deviceStore.list()).toHaveLength(0);
  });

  it('FAILS CLOSED when deviceEncKid does not match deviceEncPubKey (RE2E2 identity binding)', async () => {
    const mobile = fromX25519PrivateKey(bytes(0xb0b));
    const begin = await service.beginQrPairing('chan-kid');
    // A reply with a real 32-byte key but a kid that is NOT its deriveKid — even with an
    // internally-consistent MAC over the lied kid, the derive-and-compare rejects it.
    const honest = mobileResponds('chan-kid', begin.pairingSecret, mobile);
    const forgedKid = { ...honest, deviceEncKid: 'f'.repeat(32) };

    await expect(service.completeQrPairing(forgedKid)).rejects.toBeInstanceOf(ForbiddenError);
    expect(deviceStore.list()).toHaveLength(0);
  });

  it('FAILS CLOSED when the MAC was computed under the wrong secret', async () => {
    const mobile = fromX25519PrivateKey(bytes(0xb0b));
    await service.beginQrPairing('chan-4');
    // Attacker guesses a secret instead of reading it off the screen.
    const forged = mobileResponds('chan-4', bytesToBase64(bytes(0x9999)), mobile);

    await expect(service.completeQrPairing(forged)).rejects.toBeInstanceOf(ForbiddenError);
    expect(deviceStore.list()).toHaveLength(0);
  });

  it('burns the pairing secret on failure (no retry even with a correct MAC)', async () => {
    const mobile = fromX25519PrivateKey(bytes(0xb0b));
    const begin = await service.beginQrPairing('chan-5');
    const bad = mobileResponds('chan-5', bytesToBase64(bytes(0x1234)), mobile);
    await expect(service.completeQrPairing(bad)).rejects.toBeInstanceOf(ForbiddenError);

    // A subsequent correct attempt on the same channel is rejected — secret is gone.
    const good = mobileResponds('chan-5', begin.pairingSecret, mobile);
    await expect(service.completeQrPairing(good)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('rejects completion for an unknown / never-started channel', async () => {
    const mobile = fromX25519PrivateKey(bytes(0xb0b));
    const reply = mobileResponds('never', 'AAAA', mobile);
    await expect(service.completeQrPairing(reply)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('rejects a device public key that is not 32 bytes', async () => {
    await service.beginQrPairing('chan-6');
    await expect(
      service.completeQrPairing({
        channelId: 'chan-6',
        deviceEncPubKey: bytesToBase64(new Uint8Array(16)),
        deviceEncKid: 'short',
        pairingMac: bytesToBase64(new Uint8Array(32)),
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('does not retain the secret after a successful completion (single-use)', async () => {
    const mobile = fromX25519PrivateKey(bytes(0xb0b));
    const begin = await service.beginQrPairing('chan-7');
    await service.completeQrPairing(mobileResponds('chan-7', begin.pairingSecret, mobile));
    // Re-completing the same channel fails — the pending secret was consumed.
    await expect(
      service.completeQrPairing(mobileResponds('chan-7', begin.pairingSecret, mobile)),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
