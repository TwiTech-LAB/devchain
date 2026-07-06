/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * RPC lane E2EE — backend INTEGRATION tests (Phase 2, Task:3).
 *
 * Layer: **backend integration** (real `:memory:` SQLite `E2eeKeypairService` +
 * `E2eeDeviceStoreService`, NOT mocks; real shared `CryptoEnvelopeService`). This is the
 * CHEAPEST layer that proves the FULL storage → key-derivation → X25519 ECDH → seal/open
 * chain end-to-end through the real `TunnelRpcCryptoService` PC seam, PLUS the
 * decrypt-then-auth ordering (a cross-project request is decrypted THEN rejected by the
 * post-decrypt scope check), PLUS the mixed-capability matrix on the PC side.
 *
 * Why not a cheaper layer: the module-unit `tunnel-rpc-crypto.service.spec.ts` mocks the
 * keypair + device-store, so it can NOT prove the real encrypted-at-rest key persists +
 * reloads + derives a matching shared key with a paired device. Why not dearer: a full
 * `TunnelHandlerService` wiring (SessionsRead/SessionReader/Teams/...) would not prove any
 * additional E2EE property — the dispatch's scope check is the only handler behavior that
 * matters here, and a real scope-checking dispatch proves the decrypt-then-auth ordering at
 * a fraction of the wiring cost. The bridge's opaque forwarding is proven separately by
 * `apps/devchain-bridge/.../relay.controller.spec.ts`; the mobile-side mirror is proven by
 * the contract specs. The mobile role here is played by the SAME real
 * `CryptoEnvelopeService` the mobile mirrors (byte-identical, per the contract specs).
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import {
  CryptoEnvelopeService,
  generateX25519KeyPair,
  deriveSharedKey,
  bytesToBase64,
  base64ToBytes,
  buildPairingTranscript,
  computePairingMac,
  isE2eeEnvelope,
  type E2eeContext,
  type E2eeEnvelope,
  type E2eeKeyProvider,
} from '@devchain/shared';
import { E2eeKeypairService } from '../../e2ee/services/e2ee-keypair.service';
import { E2eeDeviceStoreService } from '../../e2ee/services/e2ee-device-store.service';
import { E2eeTrustService } from '../../e2ee/services/e2ee-trust.service';
import { E2eePairingService } from '../../e2ee/services/e2ee-pairing.service';
import {
  TunnelRpcCryptoService,
  type JsonRpcRequestLike,
  type JsonRpcResponseLike,
  type SealedRpcResult,
} from './tunnel-rpc-crypto.service';

const INSTANCE_ID = 'inst-int';

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

describe('RPC lane E2EE — backend integration (real :memory: SQLite key services)', () => {
  let sqlite: Database.Database;
  let keypair: E2eeKeypairService;
  let deviceStore: E2eeDeviceStoreService;
  let svc: TunnelRpcCryptoService;
  // The "mobile" side: a real X25519 keypair + the shared CryptoEnvelopeService the mobile
  // mirror is byte-identical to. Paired into the PC device store so the PC can derive the
  // same pairwise shared key.
  let mobileKid: string;
  let mobileEnvelope: CryptoEnvelopeService;
  let pcKid: string;

  const reqCtx = (method: string): E2eeContext => ({
    lane: 'rpc',
    direction: 'mobile-to-pc',
    instanceId: INSTANCE_ID,
    routeKey: method,
  });
  const resCtx = (method: string): E2eeContext => ({
    lane: 'rpc',
    direction: 'pc-to-mobile',
    instanceId: INSTANCE_ID,
    routeKey: method,
  });

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, value TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      )
    `);
    const db = drizzle(sqlite);
    keypair = new E2eeKeypairService(db);
    deviceStore = new E2eeDeviceStoreService(db);
    svc = new TunnelRpcCryptoService(keypair, deviceStore, false);

    // PC generates + persists its dedicated X25519 keypair (real encrypted-at-rest).
    const pc = await keypair.getOrCreate();
    pcKid = pc.kid;

    // Mobile keypair + pairing into the PC device directory (real SQLite store).
    const mob = generateX25519KeyPair(makeRng(0x2222));
    mobileKid = mob.kid;
    deviceStore.add({
      kid: mobileKid,
      publicKeyB64: bytesToBase64(mob.publicKey),
      label: 'test-phone',
    });

    // The mobile-side envelope service: same shared key the PC will derive.
    const sharedKey = deriveSharedKey(mob.privateKey, pc.publicKey);
    const provider: E2eeKeyProvider = {
      resolveSealKey: () => ({ kid: mobileKid, key: sharedKey }),
      getKeyById: (kid) => (kid === pcKid || kid === mobileKid ? sharedKey : undefined),
    };
    mobileEnvelope = new CryptoEnvelopeService(provider, makeRng(0x3333));
  });

  afterEach(() => {
    sqlite.close();
  });

  // ── 1. Round-trip: ciphertext at the seam, plaintext only at endpoints ────────────
  it('round-trips: mobile-sealed params → PC decrypt+dispatch → PC-sealed result → mobile open', async () => {
    const method = 'board.listStatuses';
    const plainParams = { projectId: 'proj-own', secret: 'transcript-text' };
    const sealedParams = (await mobileEnvelope.seal(plainParams, reqCtx(method))) as E2eeEnvelope;

    // The "bridge" sees only the envelope shape (opaque ciphertext) — method + id cleartext.
    expect(sealedParams.alg).toBe('XC20P');
    expect(JSON.stringify(sealedParams)).not.toContain('transcript-text');

    let dispatchSaw: unknown = null;
    const dispatch = jest.fn(async (plain: JsonRpcRequestLike): Promise<JsonRpcResponseLike> => {
      dispatchSaw = plain.params; // dispatch receives PLAINTEXT (decrypt happened first)
      return { jsonrpc: '2.0', id: plain.id, result: { statuses: ['todo', 'done'] } };
    });

    const resp = await svc.handle(
      { jsonrpc: '2.0', id: 'c1', method, params: sealedParams },
      INSTANCE_ID,
      dispatch,
    );

    // Bridge-visible fields: only method + id cleartext; result is an opaque envelope.
    expect(dispatch).toHaveBeenCalled();
    expect(dispatchSaw).toEqual(plainParams); // PC dispatch got plaintext, not ciphertext
    expect(resp.error).toBeUndefined();
    expect(isE2eeEnvelope(resp.result)).toBe(true);

    // Mobile opens the sealed result back to the plaintext data.
    const opened = (await mobileEnvelope.open(resp.result, resCtx(method))) as SealedRpcResult;
    expect(opened).toEqual({ ok: true, data: { statuses: ['todo', 'done'] } });
  });

  // ── terminal.sendKey rides the SAME crypto seam (no special handling) ─────────────
  // The input method is content-shaped like any other RPC; the crypto seam is method-
  // agnostic, so a sealed key press decrypts → dispatches → re-seals without any crypto-
  // layer change. This is the acceptance round-trip for the terminal.sendKey input path.
  it('round-trips a terminal.sendKey request through the existing crypto seam unchanged', async () => {
    const method = 'terminal.sendKey';
    const plainParams = { sessionId: 's1', projectId: 'proj-own', key: 'Up' };
    const sealedParams = (await mobileEnvelope.seal(plainParams, reqCtx(method))) as E2eeEnvelope;

    // The bridge-facing payload is opaque ciphertext — the key value is never bridge-visible.
    expect(JSON.stringify(sealedParams)).not.toContain('"key":"Up"');

    let dispatchSaw: unknown = null;
    const dispatch = jest.fn(async (plain: JsonRpcRequestLike): Promise<JsonRpcResponseLike> => {
      dispatchSaw = plain.params; // dispatch receives PLAINTEXT (decrypt happened first)
      return { jsonrpc: '2.0', id: plain.id, result: { ok: true } };
    });

    const resp = await svc.handle(
      { jsonrpc: '2.0', id: 'tk1', method, params: sealedParams },
      INSTANCE_ID,
      dispatch,
    );

    expect(dispatch).toHaveBeenCalled();
    expect(dispatchSaw).toEqual(plainParams); // PC dispatch got plaintext, not ciphertext
    expect(resp.error).toBeUndefined();
    expect(isE2eeEnvelope(resp.result)).toBe(true);

    const opened = (await mobileEnvelope.open(resp.result, resCtx(method))) as SealedRpcResult;
    expect(opened).toEqual({ ok: true, data: { ok: true } });
  });

  // ── 2. Negative: tampered ciphertext rejected (no dispatch) ───────────────────────
  it('rejects tampered ciphertext (AAD/tag) — dispatch never runs', async () => {
    const method = 'chat.getTranscriptTail';
    const sealedParams = (await mobileEnvelope.seal(
      { sessionId: 's1', projectId: 'proj-own' },
      reqCtx(method),
    )) as E2eeEnvelope;

    // Flip a ciphertext byte → AEAD tag no longer validates.
    const tamperedCt = base64ToBytes(sealedParams.ct);
    tamperedCt[0] ^= 0x01;
    const tampered: E2eeEnvelope = { ...sealedParams, ct: bytesToBase64(tamperedCt) };

    const dispatch = jest.fn();
    const resp = await svc.handle(
      { jsonrpc: '2.0', id: 'c2', method, params: tampered },
      INSTANCE_ID,
      dispatch,
    );

    expect(dispatch).not.toHaveBeenCalled();
    expect(resp.error).toEqual({ code: -32602, message: 'E2EE decrypt failed' });
    expect(resp.result).toBeUndefined();
  });

  // ── 3. Negative: cross-project request fails AFTER decrypt (decrypt-then-auth) ────
  it('decrypts a cross-project request THEN rejects it at the post-decrypt scope check', async () => {
    const method = 'board.listStatuses';
    // A valid ciphertext carrying a projectId the dispatch does NOT own. Decryption MUST
    // succeed (it is well-formed); the scope check runs on the PLAINTEXT projectId and
    // rejects. This proves decrypt-then-auth ordering — a pre-decrypt scope check could not
    // see projectId (it would be opaque ciphertext).
    const sealedParams = (await mobileEnvelope.seal(
      { projectId: 'proj-OTHER' },
      reqCtx(method),
    )) as E2eeEnvelope;

    let scopeCheckedPlaintext = false;
    const dispatch = jest.fn(async (plain: JsonRpcRequestLike): Promise<JsonRpcResponseLike> => {
      const params = plain.params as { projectId: string };
      scopeCheckedPlaintext = params.projectId === 'proj-OTHER'; // saw decrypted plaintext
      return {
        jsonrpc: '2.0',
        id: plain.id,
        error: { code: -32004, message: 'Forbidden', data: { code: 'CROSS_PROJECT' } },
      };
    });

    const resp = await svc.handle(
      { jsonrpc: '2.0', id: 'c3', method, params: sealedParams },
      INSTANCE_ID,
      dispatch,
    );

    // Dispatch ran (decryption succeeded) AND saw the plaintext cross-project id.
    expect(dispatch).toHaveBeenCalled();
    expect(scopeCheckedPlaintext).toBe(true);
    // The domain error is sealed INSIDE the result — never a bridge-visible top-level error.
    expect(resp.error).toBeUndefined();
    const opened = (await mobileEnvelope.open(resp.result, resCtx(method))) as SealedRpcResult;
    expect(opened.ok).toBe(false);
    expect(opened.error.data).toEqual({ code: 'CROSS_PROJECT' });
  });

  // ── 4. Domain errors ride INSIDE the encrypted result (not bridge-visible) ────────
  it('seals a domain error inside the result (bridge never sees the error text)', async () => {
    const method = 'board.getEpicDetail';
    const sealedParams = (await mobileEnvelope.seal(
      { epicId: 'e1' },
      reqCtx(method),
    )) as E2eeEnvelope;
    const dispatch = jest.fn(
      async (plain: JsonRpcRequestLike): Promise<JsonRpcResponseLike> => ({
        jsonrpc: '2.0',
        id: plain.id,
        error: { code: -32600, message: 'Epic not found', data: { code: 'NOT_FOUND' } },
      }),
    );

    const resp = await svc.handle(
      { jsonrpc: '2.0', id: 'c4', method, params: sealedParams },
      INSTANCE_ID,
      dispatch,
    );

    expect(resp.error).toBeUndefined(); // no top-level JSON-RPC error (bridge can't read it)
    expect(isE2eeEnvelope(resp.result)).toBe(true);
    expect(JSON.stringify(resp.result)).not.toContain('Epic not found');
    const opened = (await mobileEnvelope.open(resp.result, resCtx(method))) as SealedRpcResult;
    expect(opened).toEqual({
      ok: false,
      error: { code: -32600, message: 'Epic not found', data: { code: 'NOT_FOUND' } },
    });
  });

  // ── 5. Mixed-capability matrix (PC-side enforcement) ─────────────────────────────
  describe('mixed-capability matrix (PC e2eeRequired policy)', () => {
    it('on/on (encrypted): sealed params decrypt + dispatch + seal result', async () => {
      const method = 'board.listProjects';
      const sealedParams = (await mobileEnvelope.seal({}, reqCtx(method))) as E2eeEnvelope;
      const dispatch = jest.fn(async (plain) => ({
        jsonrpc: '2.0' as const,
        id: plain.id,
        result: { items: [] },
      }));
      const resp = await svc.handle(
        { jsonrpc: '2.0', id: 'm1', method, params: sealedParams },
        INSTANCE_ID,
        dispatch,
      );
      expect(dispatch).toHaveBeenCalled();
      expect(isE2eeEnvelope(resp.result)).toBe(true);
    });

    it('off/off (plaintext, not required): plaintext params dispatch unchanged', async () => {
      const dispatch = jest.fn(async (plain) => ({
        jsonrpc: '2.0' as const,
        id: plain.id,
        result: { items: [] },
      }));
      const resp = await svc.handle(
        { jsonrpc: '2.0', id: 'm2', method: 'board.listProjects', params: { projectId: 'p1' } },
        INSTANCE_ID,
        dispatch,
      );
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ params: { projectId: 'p1' } }),
      );
      expect(resp.result).toEqual({ items: [] });
    });

    it('required/incapable: PC with e2eeRequired REJECTS plaintext params (fail closed)', async () => {
      const requiredSvc = new TunnelRpcCryptoService(keypair, deviceStore, true);
      const dispatch = jest.fn();
      const resp = await requiredSvc.handle(
        { jsonrpc: '2.0', id: 'm3', method: 'board.listProjects', params: { projectId: 'p1' } },
        INSTANCE_ID,
        dispatch,
      );
      expect(dispatch).not.toHaveBeenCalled();
      expect(resp.error).toEqual({ code: -32603, message: 'E2EE required' });
    });

    it('required + encrypted: PC with e2eeRequired still accepts sealed params', async () => {
      const requiredSvc = new TunnelRpcCryptoService(keypair, deviceStore, true);
      const method = 'board.listProjects';
      const sealedParams = (await mobileEnvelope.seal({}, reqCtx(method))) as E2eeEnvelope;
      const dispatch = jest.fn(async (plain) => ({
        jsonrpc: '2.0' as const,
        id: plain.id,
        result: { ok: true },
      }));
      const resp = await requiredSvc.handle(
        { jsonrpc: '2.0', id: 'm4', method, params: sealedParams },
        INSTANCE_ID,
        dispatch,
      );
      expect(dispatch).toHaveBeenCalled();
      expect(isE2eeEnvelope(resp.result)).toBe(true);
    });
  });

  // ── RE2E1: fresh email-login device — deliver mobile key → PC adopts → first RPC works ─
  describe('RE2E1 — email-login bidirectional adoption (fresh, un-paired device)', () => {
    it('first encrypted RPC FAILS before delivery, then ROUND-TRIPS after PC adoption', async () => {
      // Simulate a fresh email-login device: the PC has NOT yet received the mobile key
      // (clear the beforeEach pre-seed). This is the RE2E1 bug surface.
      expect(deviceStore.revoke(mobileKid)).toBe(true);

      const method = 'board.listProjects';
      const dispatch = jest.fn(
        async (plain: JsonRpcRequestLike): Promise<JsonRpcResponseLike> => ({
          jsonrpc: '2.0',
          id: plain.id,
          result: { items: ['p1'] },
        }),
      );

      // Before delivery: the PC can't find the device key → fail closed, NO dispatch.
      const sealedBefore = (await mobileEnvelope.seal({}, reqCtx(method))) as E2eeEnvelope;
      const respBefore = await svc.handle(
        { jsonrpc: '2.0', id: 'pre', method, params: sealedBefore },
        INSTANCE_ID,
        dispatch,
      );
      expect(dispatch).not.toHaveBeenCalled();
      expect(respBefore.error).toEqual({ code: -32602, message: 'E2EE decrypt failed' });

      // Delivery: the mobile relays its PUBLIC key; the PC TOFU-adopts it (kid verified).
      const trust = new E2eeTrustService(keypair, deviceStore);
      const mob = generateX25519KeyPair(makeRng(0x2222)); // same device keypair as beforeEach
      const adopted = trust.adoptPeerKeyTofu({
        kid: mobileKid,
        publicKeyB64: bytesToBase64(mob.publicKey),
      });
      expect(adopted.trust).toBe('unverified');
      expect(deviceStore.get(mobileKid)?.adoptedVia).toBe('email-tofu');

      // After delivery: the SAME first-style encrypted RPC now decrypts + dispatches + seals.
      const sealedAfter = (await mobileEnvelope.seal({}, reqCtx(method))) as E2eeEnvelope;
      const respAfter = await svc.handle(
        { jsonrpc: '2.0', id: 'post', method, params: sealedAfter },
        INSTANCE_ID,
        dispatch,
      );
      expect(dispatch).toHaveBeenCalledTimes(1);
      const opened = (await mobileEnvelope.open(
        respAfter.result,
        resCtx(method),
      )) as SealedRpcResult;
      expect(opened).toEqual({ ok: true, data: { items: ['p1'] } });
    });

    it('rejects adoption when the kid does not match the delivered public key', () => {
      const trust = new E2eeTrustService(keypair, deviceStore);
      const mob = generateX25519KeyPair(makeRng(0x2222));
      expect(() =>
        trust.adoptPeerKeyTofu({ kid: 'f'.repeat(32), publicKeyB64: bytesToBase64(mob.publicKey) }),
      ).toThrow();
    });
  });

  // ── 6. Real storage round-trip: key survives a PC "restart" (new keypair instance) ─
  it('a reloaded PC keypair (new instance, same DB) decrypts mobile-sealed params', async () => {
    // The PC keypair is persisted encrypted-at-rest; a new E2eeKeypairService pointing at
    // the same SQLite reloads it, so a previously-paired mobile envelope still opens.
    const method = 'chat.sendMessage';
    const sealedParams = (await mobileEnvelope.seal(
      { agentId: 'a1', projectId: 'proj-own', text: 'hi' },
      reqCtx(method),
    )) as E2eeEnvelope;

    const reloadedKeypair = new E2eeKeypairService(drizzle(sqlite));
    const restartedSvc = new TunnelRpcCryptoService(reloadedKeypair, deviceStore, false);
    const dispatch = jest.fn(async (plain) => ({
      jsonrpc: '2.0' as const,
      id: plain.id,
      result: { status: 'delivered' },
    }));

    const resp = await restartedSvc.handle(
      { jsonrpc: '2.0', id: 'r1', method, params: sealedParams },
      INSTANCE_ID,
      dispatch,
    );
    expect(dispatch).toHaveBeenCalled();
    const opened = (await mobileEnvelope.open(resp.result, resCtx(method))) as SealedRpcResult;
    expect(opened).toEqual({ ok: true, data: { status: 'delivered' } });
  });

  // ── M3: sealed-only e2ee.revokeDeviceKey with trusted sender context ───────────────
  describe('e2ee.revokeDeviceKey (M3 paired-device-dedup)', () => {
    const REVOKE = 'e2ee.revokeDeviceKey';

    it('revokes EXACTLY the verified sender kid (ignoring a decoy param kid) and STILL seals the response after the device is deleted', async () => {
      // A second paired device — the one a malicious param would try to force-unpair.
      const victim = generateX25519KeyPair(makeRng(0x9999));
      deviceStore.add({
        kid: victim.kid,
        publicKeyB64: bytesToBase64(victim.publicKey),
        label: 'victim',
      });
      expect(deviceStore.list()).toHaveLength(2); // sender (from beforeEach) + victim

      // The phone seals a revoke whose PARAMS name the victim kid — this must be ignored.
      const sealedParams = (await mobileEnvelope.seal(
        { kid: victim.kid, __senderKid: victim.kid },
        reqCtx(REVOKE),
      )) as E2eeEnvelope;

      // Dispatch mirrors the real handler: revoke ONLY cryptoCtx.senderKid (deletes the row),
      // then return the result — proving the seam can still seal AFTER the device is gone.
      let ctxSeen: { senderKid: string } | undefined;
      const dispatch = jest.fn(
        async (plain: JsonRpcRequestLike, cryptoCtx?: { senderKid: string }) => {
          ctxSeen = cryptoCtx;
          const removed = deviceStore.revoke(cryptoCtx!.senderKid);
          return {
            jsonrpc: '2.0' as const,
            id: plain.id,
            result: { kid: cryptoCtx!.senderKid, removed },
          };
        },
      );

      const resp = await svc.handle(
        { jsonrpc: '2.0', id: 'rv1', method: REVOKE, params: sealedParams },
        INSTANCE_ID,
        dispatch,
      );

      // senderKid is the VERIFIED envelope kid (the sealer), never the decoy param kid.
      expect(ctxSeen).toEqual({ senderKid: mobileKid });
      // The sender's own row is gone; the victim (param-named) row is untouched.
      expect(deviceStore.get(mobileKid)).toBeNull();
      expect(deviceStore.get(victim.kid)).not.toBeNull();
      // Response sealed successfully EVEN THOUGH the sender device was just deleted.
      expect(resp.error).toBeUndefined();
      expect(isE2eeEnvelope(resp.result)).toBe(true);
      const opened = (await mobileEnvelope.open(resp.result, resCtx(REVOKE))) as SealedRpcResult;
      expect(opened).toEqual({ ok: true, data: { kid: mobileKid, removed: true } });
    });

    it('rejects a PLAINTEXT revoke (no dispatch, no revoke) even though e2eeRequired is false', async () => {
      const dispatch = jest.fn();
      const resp = await svc.handle(
        { jsonrpc: '2.0', id: 'rv2', method: REVOKE, params: { kid: mobileKid } },
        INSTANCE_ID,
        dispatch,
      );
      expect(dispatch).not.toHaveBeenCalled();
      expect(resp.error).toEqual({ code: -32603, message: 'E2EE required' });
      expect(deviceStore.get(mobileKid)).not.toBeNull(); // nothing revoked
    });
  });
});

// ──────────────────────────────────────────────────────────────────────────────────
// RE2E1 regression: fresh email-login device, EMPTY device store → first encrypted RPC.
//
// Layer: backend integration (real :memory: SQLite, real E2eeTrustService adoption +
// real TunnelRpcCryptoService seam). This is the cheapest layer that proves the FULL
// email-login bidirectional-adoption path: the PC starts knowing NOTHING about the
// device, the mobile delivers its key via the TOFU adopt sink (the RE2E1 fix path), and
// the FIRST encrypted RPC round-trips. The sibling `describe` above PRE-SEEDS the device
// store — that pre-seed is exactly what MASKED RE2E1 (no test ever exercised an empty
// store + the adoption → RPC chain). This block does NOT pre-seed.
// ──────────────────────────────────────────────────────────────────────────────────
describe('RPC lane E2EE — fresh email-login (EMPTY device store → first encrypted RPC) [RE2E1]', () => {
  let sqlite: Database.Database;
  let keypair: E2eeKeypairService;
  let deviceStore: E2eeDeviceStoreService;
  let trust: E2eeTrustService;
  let svc: TunnelRpcCryptoService;

  const reqCtx = (method: string): E2eeContext => ({
    lane: 'rpc',
    direction: 'mobile-to-pc',
    instanceId: INSTANCE_ID,
    routeKey: method,
  });
  const resCtx = (method: string): E2eeContext => ({
    lane: 'rpc',
    direction: 'pc-to-mobile',
    instanceId: INSTANCE_ID,
    routeKey: method,
  });

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, value TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      )
    `);
    const db = drizzle(sqlite);
    keypair = new E2eeKeypairService(db);
    deviceStore = new E2eeDeviceStoreService(db);
    trust = new E2eeTrustService(keypair, deviceStore);
    svc = new TunnelRpcCryptoService(keypair, deviceStore, false);
  });

  afterEach(() => sqlite.close());

  it('adopts the mobile key via the TOFU sink, then the FIRST encrypted RPC succeeds', async () => {
    // 1. EMPTY device store — the PC has never seen this device (no QR pairing, fresh
    //    email login). Before RE2E1, this is exactly the state that caused every
    //    encrypted RPC to fail with `E2EE decrypt failed` (deviceStore.get(kid) → null).
    expect(deviceStore.list()).toHaveLength(0);

    // 2. The mobile generates its keypair and delivers its public key to the PC via the
    //    relayed adopt sink (the RE2E1 fix: POST /api/e2ee/devices/adopt → adoptPeerKeyTofu).
    const pc = await keypair.getOrCreate();
    const mobile = generateX25519KeyPair(makeRng(0xe5a11));
    const adoptResult = trust.adoptPeerKeyTofu({
      kid: mobile.kid,
      publicKeyB64: bytesToBase64(mobile.publicKey),
    });
    expect(adoptResult.kid).toBe(mobile.kid);
    expect(deviceStore.get(mobile.kid)?.publicKeyB64).toBe(bytesToBase64(mobile.publicKey));

    // 3. The mobile now seals RPC params under the pairwise shared key. The PC seam must
    //    derive the SAME shared key (PC private + adopted mobile public) and decrypt.
    const sharedKey = deriveSharedKey(mobile.privateKey, pc.publicKey);
    const provider: E2eeKeyProvider = {
      resolveSealKey: () => ({ kid: mobile.kid, key: sharedKey }),
      getKeyById: (kid) => (kid === pc.kid || kid === mobile.kid ? sharedKey : undefined),
    };
    const mobileEnvelope = new CryptoEnvelopeService(provider, makeRng(0x3333));

    const method = 'board.listStatuses';
    const plainParams = { projectId: 'proj-own', q: 'fresh-email-login' };
    const sealedParams = (await mobileEnvelope.seal(plainParams, reqCtx(method))) as E2eeEnvelope;

    let dispatchSaw: unknown = null;
    const dispatch = jest.fn(async (plain: JsonRpcRequestLike): Promise<JsonRpcResponseLike> => {
      dispatchSaw = plain.params;
      return { jsonrpc: '2.0', id: plain.id, result: { statuses: ['todo'] } };
    });

    const resp = await svc.handle(
      { jsonrpc: '2.0', id: 'fresh-1', method, params: sealedParams },
      INSTANCE_ID,
      dispatch,
    );

    // 4. The FIRST encrypted RPC round-trips — no `E2EE decrypt failed`.
    expect(resp.error).toBeUndefined();
    expect(dispatch).toHaveBeenCalled();
    expect(dispatchSaw).toEqual(plainParams);
    const opened = (await mobileEnvelope.open(resp.result, resCtx(method))) as SealedRpcResult;
    expect(opened).toEqual({ ok: true, data: { statuses: ['todo'] } });
  });

  it('WITHOUT adoption, an encrypted RPC from the device fails closed (proves the test exercises the adoption path)', async () => {
    // Control: with an empty store and NO adoption, the PC cannot derive a shared key →
    // `E2EE decrypt failed`. This confirms the test above succeeds BECAUSE of the adoption
    // (the RE2E1 fix), not by accident.
    const pc = await keypair.getOrCreate();
    const mobile = generateX25519KeyPair(makeRng(0xd0ad));
    const sharedKey = deriveSharedKey(mobile.privateKey, pc.publicKey);
    const provider: E2eeKeyProvider = {
      resolveSealKey: () => ({ kid: mobile.kid, key: sharedKey }),
      getKeyById: (kid) => (kid === pc.kid || kid === mobile.kid ? sharedKey : undefined),
    };
    const mobileEnvelope = new CryptoEnvelopeService(provider, makeRng(0x3333));
    const sealedParams = (await mobileEnvelope.seal(
      { projectId: 'p1' },
      reqCtx('board.listStatuses'),
    )) as E2eeEnvelope;

    const dispatch = jest.fn();
    const resp = await svc.handle(
      { jsonrpc: '2.0', id: 'no-adopt', method: 'board.listStatuses', params: sealedParams },
      INSTANCE_ID,
      dispatch,
    );
    expect(dispatch).not.toHaveBeenCalled();
    expect(resp.error).toEqual({ code: -32602, message: 'E2EE decrypt failed' });
  });
});

// ──────────────────────────────────────────────────────────────────────────────────
// QR first-start arrival-order convergence (Code Review Remediation 10, Task:5).
//
// Layer: **backend integration** (real `:memory:` SQLite `E2eeDeviceStoreService` +
// `E2eePairingService.completeQrPairing` + `E2eeTrustService` adopt sink + real
// `TunnelRpcCryptoService` decrypt seam). This is the cheapest layer that proves the
// trust-boundary of the QR delivery fix: regardless of which write lands first — the
// awaited `e2ee.adoptDeviceKey` (reconcile, unverified/email-tofu) or the renderer QR
// `complete` poll (add, verified/qr) — the PC ends up holding the phone's key and RPCs
// decrypt. The ONE residue (complete-NEVER ⇒ unverified-but-functional) is asserted
// explicitly through the real decrypt path, since `buildEnvelopeService` keys on key
// existence/length only, never trust (`tunnel-rpc-crypto.service.ts:193-216`).
// ──────────────────────────────────────────────────────────────────────────────────
describe('QR first-start arrival-order convergence (Remediation 10) — real store + real pairing', () => {
  let sqlite: Database.Database;
  let keypair: E2eeKeypairService;
  let deviceStore: E2eeDeviceStoreService;
  let trust: E2eeTrustService;
  let pairing: E2eePairingService;
  let svc: TunnelRpcCryptoService;

  const reqCtx = (method: string): E2eeContext => ({
    lane: 'rpc',
    direction: 'mobile-to-pc',
    instanceId: INSTANCE_ID,
    routeKey: method,
  });
  const resCtx = (method: string): E2eeContext => ({
    lane: 'rpc',
    direction: 'pc-to-mobile',
    instanceId: INSTANCE_ID,
    routeKey: method,
  });

  /** A real "phone" keypair + envelope sealing under the pairwise shared key with the PC. */
  async function mobileEnvelopeFor(seed: number): Promise<{
    kid: string;
    publicKeyB64: string;
    envelope: CryptoEnvelopeService;
  }> {
    const pc = await keypair.getOrCreate();
    const mob = generateX25519KeyPair(makeRng(seed));
    const sharedKey = deriveSharedKey(mob.privateKey, pc.publicKey);
    const provider: E2eeKeyProvider = {
      resolveSealKey: () => ({ kid: mob.kid, key: sharedKey }),
      getKeyById: (kid) => (kid === pc.kid || kid === mob.kid ? sharedKey : undefined),
    };
    return {
      kid: mob.kid,
      publicKeyB64: bytesToBase64(mob.publicKey),
      envelope: new CryptoEnvelopeService(provider, makeRng(0x3333)),
    };
  }

  /** The renderer QR `complete` write: real `beginQrPairing` → valid MAC → `completeQrPairing`. */
  async function qrComplete(
    channelId: string,
    phoneKid: string,
    phonePublicKeyB64: string,
  ): Promise<void> {
    const pc = await keypair.getOrCreate();
    const begun = await pairing.beginQrPairing(channelId);
    expect(begun.pcEncKid).toBe(pc.kid); // the QR embeds the PC key the phone paired against
    const transcript = buildPairingTranscript({
      pcPublicKey: pc.publicKey,
      pcKid: pc.kid,
      mobilePublicKey: base64ToBytes(phonePublicKeyB64),
      mobileKid: phoneKid,
      channelId,
    });
    const mac = computePairingMac(base64ToBytes(begun.pairingSecret), transcript);
    const result = await pairing.completeQrPairing({
      channelId,
      deviceEncPubKey: phonePublicKeyB64,
      deviceEncKid: phoneKid,
      pairingMac: bytesToBase64(mac),
    });
    expect(result.trust).toBe('verified');
  }

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, value TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      )
    `);
    const db = drizzle(sqlite);
    keypair = new E2eeKeypairService(db);
    deviceStore = new E2eeDeviceStoreService(db);
    trust = new E2eeTrustService(keypair, deviceStore);
    pairing = new E2eePairingService(keypair, deviceStore);
    svc = new TunnelRpcCryptoService(keypair, deviceStore, false);
  });

  afterEach(() => sqlite.close());

  // ── Order A: complete-first → adopt. Converges to verified/qr (reconcile preserves it). ──
  it('Order A (complete-first → adopt): reconcile preserves the verified/qr record', async () => {
    const phone = await mobileEnvelopeFor(0xa1);
    // 1. The renderer `complete` poll lands FIRST → deviceStore.add writes verified/qr.
    await qrComplete('chan-a', phone.kid, phone.publicKeyB64);
    expect(deviceStore.get(phone.kid)).toMatchObject({ trust: 'verified', verifiedVia: 'qr' });

    // 2. The phone's awaited `e2ee.adoptDeviceKey` then lands → reconcile sees the SAME key
    //    and MUST preserve the existing verified/qr record (no trust downgrade).
    trust.adoptPeerKeyTofu({ kid: phone.kid, publicKeyB64: phone.publicKeyB64 });
    const stored = deviceStore.get(phone.kid);
    expect(stored).toMatchObject({ trust: 'verified', verifiedVia: 'qr' });
    expect(stored?.publicKeyB64).toBe(phone.publicKeyB64);
  });

  // ── Order B: adopt-first → complete. Converges to verified/qr (complete overwrites). ─────
  it('Order B (adopt-first → complete): adopt writes unverified, then complete overwrites to verified/qr', async () => {
    const phone = await mobileEnvelopeFor(0xb2);
    // 1. The phone's awaited adopt lands FIRST → reconcile writes unverified/email-tofu.
    trust.adoptPeerKeyTofu({ kid: phone.kid, publicKeyB64: phone.publicKeyB64 });
    expect(deviceStore.get(phone.kid)).toMatchObject({
      trust: 'unverified',
      adoptedVia: 'email-tofu',
    });

    // 2. The renderer `complete` then lands → deviceStore.add overwrites to verified/qr.
    await qrComplete('chan-b', phone.kid, phone.publicKeyB64);
    const stored = deviceStore.get(phone.kid);
    expect(stored).toMatchObject({ trust: 'verified', verifiedVia: 'qr' });
    expect(stored?.publicKeyB64).toBe(phone.publicKeyB64);
  });

  // ── Order C: complete-NEVER. Adopt-only leaves unverified, but the key is present AND the
  //    RPC still decrypts (unverified-but-functional) — the security/trust boundary of the fix.
  it('Order C (complete-NEVER): adopt-only leaves unverified, but the key is present and an encrypted RPC still decrypts (unverified-but-functional)', async () => {
    const phone = await mobileEnvelopeFor(0xc3);
    // The renderer `complete` NEVER fires (browser closed in the window). Only the phone's
    // awaited adopt lands → unverified/email-tofu, but the public key IS stored.
    trust.adoptPeerKeyTofu({ kid: phone.kid, publicKeyB64: phone.publicKeyB64 });
    const stored = deviceStore.get(phone.kid);
    expect(stored).toMatchObject({ trust: 'unverified', adoptedVia: 'email-tofu' });
    expect(stored?.publicKeyB64).toBe(phone.publicKeyB64);

    // The encrypted RPC still decrypts: buildEnvelopeService keys on existence/length only,
    // never trust, so an unverified-but-present key is fully functional. This is the accepted
    // fallback (strictly better than the pre-fix hard `-32602`); `complete` is NOT mandatory
    // for functional RPC after the awaited-delivery fix.
    const method = 'board.listStatuses';
    const sealedParams = (await phone.envelope.seal(
      { projectId: 'proj-own' },
      reqCtx(method),
    )) as E2eeEnvelope;

    let dispatchSaw: unknown = null;
    const dispatch = jest.fn(async (plain: JsonRpcRequestLike): Promise<JsonRpcResponseLike> => {
      dispatchSaw = plain.params;
      return { jsonrpc: '2.0', id: plain.id, result: { statuses: ['todo'] } };
    });

    const resp = await svc.handle(
      { jsonrpc: '2.0', id: 'order-c', method, params: sealedParams },
      INSTANCE_ID,
      dispatch,
    );

    expect(resp.error).toBeUndefined(); // NOT `E2EE decrypt failed`
    expect(dispatch).toHaveBeenCalled(); // decrypted despite unverified trust
    expect(dispatchSaw).toEqual({ projectId: 'proj-own' });
    const opened = (await phone.envelope.open(resp.result, resCtx(method))) as SealedRpcResult;
    expect(opened).toEqual({ ok: true, data: { statuses: ['todo'] } });
  });

  it('the awaited adopt alone (no complete) is sufficient for a functional first RPC — functional guarantee no longer depends on the renderer complete poll', async () => {
    // Pinpoint regression for the Remediation 10 root cause: before the fix the QR path's
    // functional RPC depended on the fire-and-forget renderer `complete` poll winning a race.
    // Now the phone's OWN awaited `e2ee.adoptDeviceKey` delivery is sufficient — complete is
    // only the path to the `verified/qr` TRUST label, not to functional decryption.
    const phone = await mobileEnvelopeFor(0xd4);
    expect(deviceStore.get(phone.kid)).toBeNull(); // PC knows nothing yet

    trust.adoptPeerKeyTofu({ kid: phone.kid, publicKeyB64: phone.publicKeyB64 });

    const method = 'chat.sendMessage';
    const sealedParams = (await phone.envelope.seal(
      { agentId: 'a1', projectId: 'proj-own', text: 'first rpc' },
      reqCtx(method),
    )) as E2eeEnvelope;
    const dispatch = jest.fn(async (plain) => ({
      jsonrpc: '2.0' as const,
      id: plain.id,
      result: { status: 'delivered' },
    }));

    const resp = await svc.handle(
      { jsonrpc: '2.0', id: 'sufficient', method, params: sealedParams },
      INSTANCE_ID,
      dispatch,
    );
    expect(dispatch).toHaveBeenCalled();
    expect(resp.error).toBeUndefined();
    // Trust label is still unverified (complete never ran) — but the RPC worked.
    expect(deviceStore.get(phone.kid)?.trust).toBe('unverified');
  });
});
