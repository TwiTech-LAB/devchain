import {
  CryptoEnvelopeService,
  generateX25519KeyPair,
  deriveSharedKey,
  bytesToBase64,
  base64ToBytes,
  type E2eeContext,
  type E2eeEnvelope,
  type E2eeKeyProvider,
} from '@devchain/shared';
import {
  TunnelRpcCryptoService,
  type JsonRpcRequestLike,
  type JsonRpcResponseLike,
  type SealedRpcResult,
} from './tunnel-rpc-crypto.service';

// Test layer: module-unit. The crypto is the REAL shared `CryptoEnvelopeService` /
// X25519 ECDH (resolved via the jest shim), with the keypair + device-store deps faked.
// It proves the PC seam (1) opens encrypted params BEFORE dispatch (decrypt-then-auth),
// (2) seals the result, (3) seals domain errors INSIDE the result (never as a top-level
// JSON-RPC error), and (4) passes plaintext params straight through (mixed-client).

const INSTANCE_ID = 'inst-xyz';

// A deterministic-but-varied byte source — randomness quality is irrelevant to these
// functional assertions (we only need valid-length keys + distinct nonces).
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

const pc = generateX25519KeyPair(makeRng(0x1111));
const mobile = generateX25519KeyPair(makeRng(0x2222));
const sharedKey = deriveSharedKey(mobile.privateKey, pc.publicKey);

/** The phone's half: seal params under the mobile kid, open the PC's sealed result. */
function mobileEnvelopeService(): CryptoEnvelopeService {
  const provider: E2eeKeyProvider = {
    resolveSealKey: () => ({ kid: mobile.kid, key: sharedKey }),
    getKeyById: (kid) => (kid === pc.kid || kid === mobile.kid ? sharedKey : undefined),
  };
  return new CryptoEnvelopeService(provider, makeRng(0x3333));
}

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

function makeService(deviceLookup?: (kid: string) => unknown, opts?: { e2eeRequired?: boolean }) {
  const keypair = { getOrCreate: jest.fn().mockResolvedValue(pc) };
  const deviceStore = {
    get: jest.fn((kid: string) =>
      deviceLookup
        ? deviceLookup(kid)
        : kid === mobile.kid
          ? { kid: mobile.kid, publicKeyB64: bytesToBase64(mobile.publicKey), trust: 'verified' }
          : null,
    ),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const svc = new TunnelRpcCryptoService(keypair as any, deviceStore as any, opts?.e2eeRequired);
  return { svc, keypair, deviceStore };
}

describe('TunnelRpcCryptoService', () => {
  it('passes plaintext (non-envelope) params straight through to dispatch', async () => {
    const { svc, deviceStore } = makeService();
    const req: JsonRpcRequestLike = {
      jsonrpc: '2.0',
      id: 'c1',
      method: 'board.listProjects',
      params: { projectId: 'p1' },
    };
    const dispatch = jest
      .fn<Promise<JsonRpcResponseLike>, [JsonRpcRequestLike]>()
      .mockResolvedValue({ jsonrpc: '2.0', id: 'c1', result: { items: [] } });

    const resp = await svc.handle(req, INSTANCE_ID, dispatch);

    expect(dispatch).toHaveBeenCalledWith(req);
    expect(resp).toEqual({ jsonrpc: '2.0', id: 'c1', result: { items: [] } });
    // Plaintext path never touches the device store / keypair.
    expect(deviceStore.get).not.toHaveBeenCalled();
  });

  it('decrypts params BEFORE dispatch and seals the result (decrypt-then-auth)', async () => {
    const { svc } = makeService();
    const method = 'chat.getTranscriptTail';
    const mobileSvc = mobileEnvelopeService();
    const plainParams = { sessionId: 's1', projectId: 'p1', since: '2026-01-01T00:00:00.000Z' };
    const sealedParams = await mobileSvc.seal(plainParams, reqCtx(method));

    let seenByDispatch: unknown;
    const dispatch = jest.fn(async (plain: JsonRpcRequestLike) => {
      seenByDispatch = plain.params;
      return { jsonrpc: '2.0' as const, id: plain.id, result: { events: ['hi'] } };
    });

    const resp = await svc.handle(
      { jsonrpc: '2.0', id: 'c2', method, params: sealedParams },
      INSTANCE_ID,
      dispatch,
    );

    // Dispatch saw PLAINTEXT params (decrypt happened first).
    expect(seenByDispatch).toEqual(plainParams);
    // The wire response carries an opaque envelope as `result`, with no top-level error.
    expect(resp.error).toBeUndefined();
    const env = resp.result as E2eeEnvelope;
    expect(env.kid).toBe(pc.kid);
    expect(typeof env.ct).toBe('string');
    // The phone opens it back to { ok:true, data }.
    const opened = (await mobileSvc.open(env, resCtx(method))) as SealedRpcResult;
    expect(opened).toEqual({ ok: true, data: { events: ['hi'] } });
  });

  it('seals a DOMAIN error inside the result (never a top-level JSON-RPC error)', async () => {
    const { svc } = makeService();
    const method = 'board.getEpicDetail';
    const mobileSvc = mobileEnvelopeService();
    const sealedParams = await mobileSvc.seal({ epicId: 'e1' }, reqCtx(method));

    const dispatch = jest.fn(async (plain: JsonRpcRequestLike) => ({
      jsonrpc: '2.0' as const,
      id: plain.id,
      error: { code: -32004, message: 'Forbidden', data: { code: 'CROSS_PROJECT' } },
    }));

    const resp = await svc.handle(
      { jsonrpc: '2.0', id: 'c3', method, params: sealedParams },
      INSTANCE_ID,
      dispatch,
    );

    // Bridge sees NO domain error — only an opaque sealed result.
    expect(resp.error).toBeUndefined();
    const opened = (await mobileSvc.open(resp.result, resCtx(method))) as SealedRpcResult;
    expect(opened).toEqual({
      ok: false,
      error: { code: -32004, message: 'Forbidden', data: { code: 'CROSS_PROJECT' } },
    });
  });

  it('fails closed (no dispatch) when no device is paired for the envelope kid', async () => {
    const { svc } = makeService(() => null); // device store knows nobody
    const method = 'chat.getTranscriptTail';
    const sealedParams = await mobileEnvelopeService().seal({ sessionId: 's1' }, reqCtx(method));
    const dispatch = jest.fn();

    const resp = await svc.handle(
      { jsonrpc: '2.0', id: 'c4', method, params: sealedParams },
      INSTANCE_ID,
      dispatch,
    );

    expect(dispatch).not.toHaveBeenCalled();
    expect(resp.error).toEqual({ code: -32602, message: 'E2EE decrypt failed' });
    expect(resp.result).toBeUndefined();
  });

  it('fails closed when the ciphertext was sealed for a DIFFERENT route (AAD mismatch)', async () => {
    const { svc } = makeService();
    const mobileSvc = mobileEnvelopeService();
    // Seal bound to method A, but deliver it claiming method B → AAD (routeKey) mismatch.
    const sealedParams = await mobileSvc.seal(
      { sessionId: 's1' },
      reqCtx('chat.getTranscriptTail'),
    );
    const dispatch = jest.fn();

    const resp = await svc.handle(
      { jsonrpc: '2.0', id: 'c5', method: 'chat.sendMessage', params: sealedParams },
      INSTANCE_ID,
      dispatch,
    );

    expect(dispatch).not.toHaveBeenCalled();
    expect(resp.error).toEqual({ code: -32602, message: 'E2EE decrypt failed' });
  });

  it('round-trips a real cross-side derivation (PC opens what the phone sealed)', async () => {
    // Sanity: the PC derives the SAME shared key from its private key + the stored device
    // public key as the phone did from its own private key + the PC public key.
    const pcSideKey = deriveSharedKey(
      pc.privateKey,
      base64ToBytes(bytesToBase64(mobile.publicKey)),
    );
    expect(bytesToBase64(pcSideKey)).toBe(bytesToBase64(sharedKey));
  });

  describe('Phase 2, Task:2 — fail-closed enforcement (e2eeRequired)', () => {
    it('REJECTS plaintext params (no dispatch) when e2eeRequired is set', async () => {
      const { svc, deviceStore } = makeService(undefined, { e2eeRequired: true });
      const req: JsonRpcRequestLike = {
        jsonrpc: '2.0',
        id: 'c1',
        method: 'board.listProjects',
        params: { projectId: 'p1' },
      };
      const dispatch = jest.fn();

      const resp = await svc.handle(req, INSTANCE_ID, dispatch);

      expect(dispatch).not.toHaveBeenCalled();
      expect(deviceStore.get).not.toHaveBeenCalled();
      expect(resp.error).toEqual({ code: -32603, message: 'E2EE required' });
      expect(resp.result).toBeUndefined();
    });

    it('still accepts encrypted params when e2eeRequired is set (decrypt-then-auth)', async () => {
      const { svc } = makeService(undefined, { e2eeRequired: true });
      const method = 'chat.getTranscriptTail';
      const mobileSvc = mobileEnvelopeService();
      const sealedParams = await mobileSvc.seal({ sessionId: 's1' }, reqCtx(method));
      const dispatch = jest.fn(async (plain: JsonRpcRequestLike) => ({
        jsonrpc: '2.0' as const,
        id: plain.id,
        result: { ok: true },
      }));

      const resp = await svc.handle(
        { jsonrpc: '2.0', id: 'c2', method, params: sealedParams },
        INSTANCE_ID,
        dispatch,
      );

      expect(dispatch).toHaveBeenCalled();
      expect(resp.error).toBeUndefined();
      expect(typeof (resp.result as E2eeEnvelope).ct).toBe('string');
    });

    it('still passes plaintext through when e2eeRequired is NOT set (mixed-client)', async () => {
      const { svc } = makeService(); // default e2eeRequired=false
      const dispatch = jest
        .fn<Promise<JsonRpcResponseLike>, [JsonRpcRequestLike]>()
        .mockResolvedValue({ jsonrpc: '2.0', id: 'c1', result: { items: [] } });
      const resp = await svc.handle(
        { jsonrpc: '2.0', id: 'c1', method: 'board.listProjects', params: { projectId: 'p1' } },
        INSTANCE_ID,
        dispatch,
      );
      expect(dispatch).toHaveBeenCalled();
      expect(resp.result).toEqual({ items: [] });
    });
  });

  describe('M3 — sealed-only e2ee.revokeDeviceKey + trusted sender context', () => {
    const REVOKE = 'e2ee.revokeDeviceKey';

    // DEDICATED: a sealed-only test alone would miss the default mixed-client path — a
    // plaintext revoke MUST be rejected even when e2eeRequired is false (the branch that
    // would otherwise dispatch it plaintext).
    it('rejects a PLAINTEXT revoke with NO dispatch even when e2eeRequired is false', async () => {
      const { svc, deviceStore } = makeService(); // default e2eeRequired=false
      const dispatch = jest.fn();
      const resp = await svc.handle(
        { jsonrpc: '2.0', id: 'r1', method: REVOKE, params: { kid: 'anything' } },
        INSTANCE_ID,
        dispatch,
      );
      expect(dispatch).not.toHaveBeenCalled();
      expect(deviceStore.get).not.toHaveBeenCalled();
      expect(resp.error).toEqual({ code: -32603, message: 'E2EE required' });
      expect(resp.result).toBeUndefined();
    });

    it('also rejects a PLAINTEXT revoke when e2eeRequired is true', async () => {
      const { svc } = makeService(undefined, { e2eeRequired: true });
      const dispatch = jest.fn();
      const resp = await svc.handle(
        { jsonrpc: '2.0', id: 'r2', method: REVOKE, params: {} },
        INSTANCE_ID,
        dispatch,
      );
      expect(dispatch).not.toHaveBeenCalled();
      expect(resp.error).toEqual({ code: -32603, message: 'E2EE required' });
    });

    it('threads the VERIFIED sender kid (envelope kid) to dispatch, ignoring any param kid', async () => {
      const { svc } = makeService();
      const mobileSvc = mobileEnvelopeService();
      // Params name a DECOY kid — it must never become the sender identity.
      const sealedParams = await mobileSvc.seal(
        { kid: 'decoy-kid', __senderKid: 'decoy-kid' },
        reqCtx(REVOKE),
      );
      let ctxSeen: unknown;
      const dispatch = jest.fn(async (plain: JsonRpcRequestLike, cryptoCtx?: unknown) => {
        ctxSeen = cryptoCtx;
        return {
          jsonrpc: '2.0' as const,
          id: plain.id,
          result: { kid: mobile.kid, removed: true },
        };
      });

      const resp = await svc.handle(
        { jsonrpc: '2.0', id: 'r3', method: REVOKE, params: sealedParams },
        INSTANCE_ID,
        dispatch,
      );

      // The trusted context carries the ENVELOPE kid (proven by successful decrypt), not the decoy.
      expect(ctxSeen).toEqual({ senderKid: mobile.kid });
      expect(resp.error).toBeUndefined();
      const opened = (await mobileSvc.open(resp.result, resCtx(REVOKE))) as SealedRpcResult;
      expect(opened).toEqual({ ok: true, data: { kid: mobile.kid, removed: true } });
    });

    it('does NOT attach a crypto context on the plaintext (non-sealed-only) path', async () => {
      const { svc } = makeService();
      const dispatch = jest.fn(
        async (): Promise<JsonRpcResponseLike> => ({ jsonrpc: '2.0', id: 'r4', result: {} }),
      );
      await svc.handle(
        { jsonrpc: '2.0', id: 'r4', method: 'board.listProjects', params: { projectId: 'p1' } },
        INSTANCE_ID,
        dispatch,
      );
      // Single-arg call → no verified sender for an unauthenticated request.
      expect(dispatch.mock.calls[0]).toHaveLength(1);
    });
  });
});
