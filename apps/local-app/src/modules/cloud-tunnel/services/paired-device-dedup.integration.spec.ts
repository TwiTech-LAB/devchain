/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Cross-component paired-device-dedup convergence matrix (Phase 1, Task:5).
 *
 * Layer: **backend integration** (real `:memory:` SQLite `E2eeDeviceStoreService` + real
 * `E2eePairingService.completeQrPairing` + real `E2eeTrustService.adoptPeerKeyTofu`). This is
 * the CHEAPEST layer that proves the cross-component permutations NO single per-task unit
 * test covers: the convergence behavior emerges only across the real store + BOTH adopt
 * seams (QR-complete `evictVerified:true` vs email-TOFU `evictVerified:false`) + the
 * dormant explicit sealed-revoke path, all through real persistence.
 *
 * Why not a cheaper layer: the module-unit `e2ee-device-store.service.spec.ts` already pins
 * the supersede rule in isolation (single store method calls) — it cannot prove that the QR
 * vs email SEAMS drive the trust guard correctly end-to-end, nor exceptional same-install
 * identity-rotation convergence across supersede and optional explicit revoke. Why not dearer: a full
 * `TunnelHandlerService` / live-bridge wiring would not prove any additional dedup property
 * — the dispatch seams are pinned by `rpc-e2ee.integration.spec.ts` + the per-task units.
 *
 * What is NOT re-tested here (per-task unit coverage): the supersede guard in isolation,
 * plaintext-revoke rejection, senderKid threading, mobile installId survival, sealed-only
 * enforcement. This file is the CROSS-COMPONENT matrix only.
 *
 * The same-kid continuity section below proves the PC-side policy the mobile logout
 * change relies on: an ordinary logout that PRESERVES the mobile X25519 keypair must keep
 * the device row (verified trust, localAlias, explicit multi-workspace grants) intact on
 * both reconnect seams, while desktop Un-pair remains the one path that resets a device.
 */
import Database from 'better-sqlite3';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import {
  CryptoEnvelopeService,
  generateX25519KeyPair,
  deriveSharedKey,
  bytesToBase64,
  base64ToBytes,
  buildPairingTranscript,
  computePairingMac,
  type E2eeContext,
  type E2eeKeyProvider,
} from '@devchain/shared';
import { E2eeKeypairService } from '../../e2ee/services/e2ee-keypair.service';
import { E2eeDeviceStoreService } from '../../e2ee/services/e2ee-device-store.service';
import { E2eeTrustService } from '../../e2ee/services/e2ee-trust.service';
import { E2eePairingService } from '../../e2ee/services/e2ee-pairing.service';
import { PairedDeviceWorkspaceAccessService } from '../../e2ee/services/paired-device-workspace-access.service';
import { DEFAULT_PROJECT_WORKSPACE_ID } from '../../storage/db/schema';
import { NotFoundError } from '../../../common/errors/error-types';

const INSTANCE_ID = 'inst-dedup';

// Canonical UUID v4 (valid against both the mobile `[1-5]` and PC `[1-8]` install-id regex).
// The SAME value identifies one app install across ordinary same-kid reconnects and
// exceptional same-install identity rotation.
const INSTALL_ID = '11111111-1111-4111-8111-111111111111';
// A genuinely different app install (fresh install / another phone → its own kid).
const INSTALL_ID_B = '55555555-5555-4555-8555-555555555555';
const SECOND_WORKSPACE_ID = '22222222-2222-4222-8222-222222222222';

function makeRng(seed: number): (n: number) => Uint8Array {
  let s = seed >>> 0;
  return (n: number) => {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      out[i] = s & 0xff;
    }
    return out;
  };
}

describe('Paired-device-dedup convergence matrix (Phase 1 Task:5) — real store + real pairing/trust', () => {
  let sqlite: Database.Database;
  let keypair: E2eeKeypairService;
  let deviceStore: E2eeDeviceStoreService;
  let trust: E2eeTrustService;
  let pairing: E2eePairingService;
  let access: PairedDeviceWorkspaceAccessService;

  // Unused today but kept to mirror the sibling integration harness (sealing lane ready if a
  // future matrix case needs to prove an encrypted RPC post-convergence).
  const reqCtx = (method: string): E2eeContext => ({
    lane: 'rpc',
    direction: 'mobile-to-pc',
    instanceId: INSTANCE_ID,
    routeKey: method,
  });
  void reqCtx;

  /** A real "phone" keypair + envelope sealing under the pairwise shared key with the PC. */
  async function mobileEnvelopeFor(seed: number): Promise<{
    kid: string;
    publicKeyB64: string;
  }> {
    const pc = await keypair.getOrCreate();
    const mob = generateX25519KeyPair(makeRng(seed));
    const sharedKey = deriveSharedKey(mob.privateKey, pc.publicKey);
    const provider: E2eeKeyProvider = {
      resolveSealKey: () => ({ kid: mob.kid, key: sharedKey }),
      getKeyById: (kid) => (kid === pc.kid || kid === mob.kid ? sharedKey : undefined),
    };
    // Construct to exercise the real ECDH/HKDF leg (proves the derived key is usable); the
    // envelope itself is not sealed in these convergence cases.
    void new CryptoEnvelopeService(provider, makeRng(0x3333));
    return { kid: mob.kid, publicKeyB64: bytesToBase64(mob.publicKey) };
  }

  /** The renderer QR `complete` write: real `beginQrPairing` → valid MAC → `completeQrPairing`. */
  async function qrComplete(
    channelId: string,
    phoneKid: string,
    phonePublicKeyB64: string,
    installId?: string,
  ): Promise<void> {
    const pc = await keypair.getOrCreate();
    const begun = await pairing.beginQrPairing(channelId);
    expect(begun.pcEncKid).toBe(pc.kid);
    const transcript = buildPairingTranscript({
      pcPublicKey: pc.publicKey,
      pcKid: pc.kid,
      mobilePublicKey: base64ToBytes(phonePublicKeyB64),
      mobileKid: phoneKid,
      channelId,
    });
    const mac = computePairingMac(base64ToBytes(begun.pairingSecret), transcript);
    await pairing.completeQrPairing({
      channelId,
      deviceEncPubKey: phonePublicKeyB64,
      deviceEncKid: phoneKid,
      pairingMac: bytesToBase64(mac),
      ...(installId !== undefined ? { installId } : {}),
    });
  }

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, value TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE paired_device_workspace_grants (
        device_kid TEXT NOT NULL, workspace_id TEXT NOT NULL,
        PRIMARY KEY (device_kid, workspace_id)
      );
      CREATE TABLE project_workspaces (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, is_default INTEGER NOT NULL,
        position INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      )
    `);
    const insertWorkspace = sqlite.prepare(
      `INSERT INTO project_workspaces
       (id, name, is_default, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, '2026-01-01', '2026-01-01')`,
    );
    insertWorkspace.run(DEFAULT_PROJECT_WORKSPACE_ID, 'Default', 1, 0);
    insertWorkspace.run(SECOND_WORKSPACE_ID, 'W2', 0, 1);
    const db = drizzle(sqlite);
    keypair = new E2eeKeypairService(db);
    deviceStore = new E2eeDeviceStoreService(db);
    trust = new E2eeTrustService(keypair, deviceStore);
    pairing = new E2eePairingService(keypair, deviceStore);
    access = new PairedDeviceWorkspaceAccessService(db, deviceStore, new EventEmitter2());
  });

  afterEach(() => sqlite.close());

  // ── 1. Old phone (no installId) + new PC: append behavior preserved (QR + email) ──────
  describe('old phone (no installId) + new PC — append preserved (backward compat)', () => {
    it.each(['email-TOFU', 'QR'])('%s keeps legacy peers without installId', async (seam) => {
      const phone1 = await mobileEnvelopeFor(0x0101);
      const phone2 = await mobileEnvelopeFor(0x0202);
      if (seam === 'email-TOFU') {
        trust.adoptPeerKeyTofu({ kid: phone1.kid, publicKeyB64: phone1.publicKeyB64 });
        trust.adoptPeerKeyTofu({ kid: phone2.kid, publicKeyB64: phone2.publicKeyB64 });
      } else {
        await qrComplete('chan-old-a', phone1.kid, phone1.publicKeyB64);
        await qrComplete('chan-old-b', phone2.kid, phone2.publicKeyB64);
      }
      const devices = deviceStore.list();
      expect(devices).toHaveLength(2);
      expect(devices.every((d) => d.installId === undefined)).toBe(true);
    });
  });

  // ── 2. Mixed fleet: verified-with-installId + a TOFU-without-installId entry ─────────
  describe('mixed fleet — supersede does not interact with a no-installId entry', () => {
    it('a TOFU adopt WITH installId leaves a separate no-installId entry untouched', async () => {
      // Phone A: QR-verified, carries installId.
      const phoneA = await mobileEnvelopeFor(0xa1a1);
      await qrComplete('chan-a', phoneA.kid, phoneA.publicKeyB64, INSTALL_ID);

      // A stale same-phone row from a pre-installId client build (NO installId).
      const phoneStale = await mobileEnvelopeFor(0xa2a2);
      trust.adoptPeerKeyTofu({ kid: phoneStale.kid, publicKeyB64: phoneStale.publicKeyB64 });
      expect(deviceStore.list()).toHaveLength(2);

      // Re-login via email-TOFU with installId — the supersede sweep runs.
      const phoneNew = await mobileEnvelopeFor(0xa3a3);
      trust.adoptPeerKeyTofu(
        { kid: phoneNew.kid, publicKeyB64: phoneNew.publicKeyB64 },
        INSTALL_ID,
      );

      const devices = deviceStore.list();
      // The no-installId stale entry is NOT matched (installId !== undefined) → untouched.
      expect(devices.find((d) => d.kid === phoneStale.kid)).toBeDefined();
      expect(devices.find((d) => d.kid === phoneStale.kid)?.installId).toBeUndefined();
      // The verified same-install entry is preserved (TOFU guard: evictVerified === false).
      expect(devices.find((d) => d.kid === phoneA.kid)?.trust).toBe('verified');
      // The new entry is stored.
      expect(devices.find((d) => d.kid === phoneNew.kid)?.installId).toBe(INSTALL_ID);
    });
  });

  // ── 3. Both QR completion arrival orders preserve installId ─────────────────────────
  describe('QR arrival orders preserve installId on the verified record', () => {
    it('Order A (complete-first → adopt): installId is on the verified record and survives the adopt', async () => {
      const phone = await mobileEnvelopeFor(0xb1b1);
      await qrComplete('chan-ord-a', phone.kid, phone.publicKeyB64, INSTALL_ID);
      expect(deviceStore.get(phone.kid)).toMatchObject({
        trust: 'verified',
        verifiedVia: 'qr',
        installId: INSTALL_ID,
      });

      // The awaited adopt lands second → reconcile MUST preserve installId + verified label.
      trust.adoptPeerKeyTofu({ kid: phone.kid, publicKeyB64: phone.publicKeyB64 }, INSTALL_ID);
      expect(deviceStore.get(phone.kid)).toMatchObject({
        trust: 'verified',
        verifiedVia: 'qr',
        installId: INSTALL_ID,
      });
    });

    it('Order B (adopt-first → complete): installId lands via adopt, then complete overwrites to verified keeping installId', async () => {
      const phone = await mobileEnvelopeFor(0xb2b2);
      trust.adoptPeerKeyTofu({ kid: phone.kid, publicKeyB64: phone.publicKeyB64 }, INSTALL_ID);
      expect(deviceStore.get(phone.kid)).toMatchObject({
        trust: 'unverified',
        installId: INSTALL_ID,
      });

      await qrComplete('chan-ord-b', phone.kid, phone.publicKeyB64, INSTALL_ID);
      expect(deviceStore.get(phone.kid)).toMatchObject({
        trust: 'verified',
        verifiedVia: 'qr',
        installId: INSTALL_ID,
      });
    });

    it('a prior same-install verified row is superseded when complete re-pairs (QR evictVerified:true)', async () => {
      // First QR pair (verified, installId).
      const phone1 = await mobileEnvelopeFor(0xb3b3);
      await qrComplete('chan-ord-c1', phone1.kid, phone1.publicKeyB64, INSTALL_ID);

      // A re-pair arrives via the adopt lane first (new kid, same installId, unverified).
      const phone2 = await mobileEnvelopeFor(0xb4b4);
      trust.adoptPeerKeyTofu({ kid: phone2.kid, publicKeyB64: phone2.publicKeyB64 }, INSTALL_ID);
      // TOFU adopt did NOT evict the verified phone1 (guard).
      expect(deviceStore.list().filter((d) => d.installId === INSTALL_ID)).toHaveLength(2);

      // The QR complete for phone2 lands → evicts the prior verified same-install row.
      await qrComplete('chan-ord-c2', phone2.kid, phone2.publicKeyB64, INSTALL_ID);
      const sameInstall = deviceStore.list().filter((d) => d.installId === INSTALL_ID);
      expect(sameInstall).toHaveLength(1);
      expect(sameInstall[0].kid).toBe(phone2.kid);
      expect(sameInstall[0].trust).toBe('verified');
    });
  });

  // ── 4. Exceptional identity-rotation convergence ────────────────────────────────────
  describe('same-install identity rotation (installId supersede + explicit revoke)', () => {
    it('QR → QR: installId survives an identity reset → converges to EXACTLY ONE entry', async () => {
      // Initial QR pair (verified, installId).
      const phone1 = await mobileEnvelopeFor(0xc1c1);
      await qrComplete('chan-qr-1', phone1.kid, phone1.publicKeyB64, INSTALL_ID);
      trust.setLocalAlias(phone1.kid, 'Old local alias');
      expect(deviceStore.list()).toHaveLength(1);

      // A low-level same-install identity reset mints a fresh kid while installId survives.
      const phone2 = await mobileEnvelopeFor(0xc2c2);
      await qrComplete('chan-qr-2', phone2.kid, phone2.publicKeyB64, INSTALL_ID);

      const devices = deviceStore.list();
      expect(devices).toHaveLength(1); // the dead phone1 row was superseded (QR evictVerified)
      expect(devices[0].kid).toBe(phone2.kid);
      expect(devices[0].installId).toBe(INSTALL_ID);
      expect(devices[0].trust).toBe('verified');
      expect(devices[0].localAlias).toBeUndefined();
    });

    it('QR → email, explicit revoke removed the prior kid → converges to ONE', async () => {
      // Initial QR pair (verified, installId).
      const phone1 = await mobileEnvelopeFor(0xd1d1);
      await qrComplete('chan-em-1', phone1.kid, phone1.publicKeyB64, INSTALL_ID);

      // An explicit sealed revoke removes phone1 using the verified envelope kid.
      expect(trust.revokeDevice(phone1.kid)).toEqual({ kid: phone1.kid, removed: true });

      // The reset identity returns via email TOFU with the same installId.
      const phone2 = await mobileEnvelopeFor(0xd2d2);
      trust.adoptPeerKeyTofu({ kid: phone2.kid, publicKeyB64: phone2.publicKeyB64 }, INSTALL_ID);

      const devices = deviceStore.list();
      expect(devices).toHaveLength(1); // prior was already revoked; nothing left to supersede
      expect(devices[0].kid).toBe(phone2.kid);
      expect(devices[0].installId).toBe(INSTALL_ID);
    });

    it('QR → email, no explicit revoke: verified RESIDUE remains until QR re-pair / manual unpair', async () => {
      // Initial QR pair (verified, installId).
      const phone1 = await mobileEnvelopeFor(0xe1e1);
      await qrComplete('chan-off-1', phone1.kid, phone1.publicKeyB64, INSTALL_ID);

      // A same-install identity reset occurs without an explicit revoke; phone1 remains.
      // The reset identity returns via email TOFU with the same installId.
      const phone2 = await mobileEnvelopeFor(0xe2e2);
      trust.adoptPeerKeyTofu({ kid: phone2.kid, publicKeyB64: phone2.publicKeyB64 }, INSTALL_ID);

      // The documented verified RESIDUE: the TOFU guard forbids evicting the verified phone1,
      // so both the stale verified row AND the fresh unverified row coexist.
      const devices = deviceStore.list();
      expect(devices).toHaveLength(2);
      const old = devices.find((d) => d.kid === phone1.kid);
      const fresh = devices.find((d) => d.kid === phone2.kid);
      expect(old?.trust).toBe('verified'); // preserved by the TOFU guard
      expect(old?.installId).toBe(INSTALL_ID);
      expect(fresh?.trust).toBe('unverified'); // the new email-TOFU entry
      expect(fresh?.installId).toBe(INSTALL_ID);

      // Manual Un-pair (or a future QR re-pair) removes the stale verified row.
      expect(trust.revokeDevice(phone1.kid)).toEqual({ kid: phone1.kid, removed: true });
      expect(deviceStore.list()).toHaveLength(1);
    });
  });

  // ── 5. Same-kid reconnect continuity (paired-kid-continuity) ────────────────────────
  describe('same-kid reconnect continuity — ordinary logout preserves the mobile keypair', () => {
    const aliasAndGrantBothWorkspaces = async (kid: string): Promise<void> => {
      trust.setLocalAlias(kid, 'My Pixel');
      await access.updateAccess(kid, [DEFAULT_PROJECT_WORKSPACE_ID, SECOND_WORKSPACE_ID]);
    };

    it('same-kid email reconnect preserves verified trust, localAlias, and explicit multi-workspace grants', async () => {
      const phone = await mobileEnvelopeFor(0xf1f1);
      await qrComplete('chan-same-email', phone.kid, phone.publicKeyB64, INSTALL_ID);
      await aliasAndGrantBothWorkspaces(phone.kid);
      expect(deviceStore.list()).toHaveLength(1);

      // Ordinary logout now keeps the phone's X25519 keypair: re-login carries the SAME
      // kid + key through the email-TOFU bootstrap lane.
      const result = trust.adoptPeerKeyTofu(
        { kid: phone.kid, publicKeyB64: phone.publicKeyB64 },
        INSTALL_ID,
      );

      expect(result).toEqual({ kid: phone.kid, trust: 'verified', verifiedVia: 'qr' });
      expect(deviceStore.get(phone.kid)).toMatchObject({
        trust: 'verified',
        verifiedVia: 'qr',
        localAlias: 'My Pixel',
        installId: INSTALL_ID,
      });
      expect(deviceStore.list()).toHaveLength(1);
      expect(access.getAccess(phone.kid)).toEqual({
        kid: phone.kid,
        explicit: true,
        workspaceIds: [DEFAULT_PROJECT_WORKSPACE_ID, SECOND_WORKSPACE_ID],
      });
    });

    it('same-kid QR reconnect remains verified and preserves localAlias and explicit multi-workspace grants', async () => {
      const phone = await mobileEnvelopeFor(0xf2f2);
      await qrComplete('chan-same-qr-1', phone.kid, phone.publicKeyB64, INSTALL_ID);
      await aliasAndGrantBothWorkspaces(phone.kid);

      // Same phone, same key: a re-pair over QR after an ordinary logout.
      await qrComplete('chan-same-qr-2', phone.kid, phone.publicKeyB64, INSTALL_ID);

      expect(deviceStore.get(phone.kid)).toMatchObject({
        trust: 'verified',
        verifiedVia: 'qr',
        localAlias: 'My Pixel',
        installId: INSTALL_ID,
      });
      expect(deviceStore.list()).toHaveLength(1);
      expect(access.getAccess(phone.kid)).toEqual({
        kid: phone.kid,
        explicit: true,
        workspaceIds: [DEFAULT_PROJECT_WORKSPACE_ID, SECOND_WORKSPACE_ID],
      });
    });

    it('desktop un-pair followed by same-kid adoption restores neither alias nor grants — effective Default-only', async () => {
      const phone = await mobileEnvelopeFor(0xf3f3);
      await qrComplete('chan-unpair-1', phone.kid, phone.publicKeyB64, INSTALL_ID);
      await aliasAndGrantBothWorkspaces(phone.kid);

      // Desktop Un-pair (Paired devices → remove) is the one path that resets the device.
      expect(trust.revokeDevice(phone.kid)).toEqual({ kid: phone.kid, removed: true });
      expect(deviceStore.get(phone.kid)).toBeNull();
      expect(() => access.getAccess(phone.kid)).toThrow(NotFoundError);

      // The phone re-adopts with the SAME kid over the email-TOFU lane.
      const result = trust.adoptPeerKeyTofu(
        { kid: phone.kid, publicKeyB64: phone.publicKeyB64 },
        INSTALL_ID,
      );

      expect(result).toEqual({ kid: phone.kid, trust: 'unverified' });
      expect(deviceStore.get(phone.kid)).toMatchObject({ installId: INSTALL_ID });
      expect(deviceStore.get(phone.kid)?.localAlias).toBeUndefined();
      expect(
        sqlite
          .prepare('SELECT workspace_id FROM paired_device_workspace_grants WHERE device_kid = ?')
          .all(phone.kid),
      ).toEqual([]);
      expect(access.getAccess(phone.kid)).toEqual({
        kid: phone.kid,
        explicit: false,
        workspaceIds: [DEFAULT_PROJECT_WORKSPACE_ID],
      });
    });

    it('a genuinely new kid remains a new Default-only device', async () => {
      const other = await mobileEnvelopeFor(0xf4f4);
      const result = trust.adoptPeerKeyTofu(
        { kid: other.kid, publicKeyB64: other.publicKeyB64 },
        INSTALL_ID_B,
      );

      expect(result).toEqual({ kid: other.kid, trust: 'unverified' });
      expect(deviceStore.get(other.kid)?.localAlias).toBeUndefined();
      expect(access.getAccess(other.kid)).toEqual({
        kid: other.kid,
        explicit: false,
        workspaceIds: [DEFAULT_PROJECT_WORKSPACE_ID],
      });
    });
  });
});
