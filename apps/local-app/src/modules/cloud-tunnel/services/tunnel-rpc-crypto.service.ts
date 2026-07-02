import { Injectable, Inject, Optional } from '@nestjs/common';
import { randomBytes as nodeRandomBytes } from 'crypto';
import {
  CryptoEnvelopeService,
  isE2eeEnvelope,
  base64ToBytes,
  deriveSharedKey,
  X25519_PUBLIC_KEY_BYTES,
  type E2eeContext,
  type E2eeKeyProvider,
} from '@devchain/shared';
import { createLogger } from '../../../common/logging/logger';
import { E2eeKeypairService } from '../../e2ee/services/e2ee-keypair.service';
import { E2eeDeviceStoreService } from '../../e2ee/services/e2ee-device-store.service';

const logger = createLogger('TunnelRpcCrypto');

/**
 * DI token for the PC-side E2EE-required policy (Phase 2, Task:2). When true, the PC
 * refuses to accept plaintext RPC `params` — every inbound request MUST be an
 * `E2eeEnvelope` (fail closed). Env-gated (`E2EE_REQUIRED=true`) for gradual rollout;
 * default false so mixed old/new clients keep interoperating in plaintext. The SAME
 * value is advertised in the attest capability descriptor so the mobile side negotiates
 * consistently (`tunnel-client.service.ts#buildE2eeCapability`).
 */
export const E2EE_REQUIRED_POLICY = 'E2EE_REQUIRED_POLICY';

/**
 * Methods that bootstrap E2EE itself and therefore MUST travel plaintext — the PC cannot
 * decrypt them yet. `e2ee.adoptDeviceKey` (RE2E1) delivers the mobile's PUBLIC key so the
 * PC can derive the shared key for that device; it carries no secret content. These are
 * exempt from the `e2eeRequired` plaintext rejection so strict-mode can't deadlock the
 * key exchange (can't encrypt before the key is delivered, can't deliver if plaintext is
 * refused).
 */
export const RPC_BOOTSTRAP_METHODS = new Set<string>(['e2ee.adoptDeviceKey']);

/**
 * Methods that MUST arrive sealed and are rejected if they travel plaintext — REGARDLESS of
 * `e2eeRequired`. `e2ee.revokeDeviceKey` (M3 `paired-device-dedup`) removes the SENDER's own
 * device using the verified envelope kid; a plaintext revoke has no verified sender, so a
 * bridge-position actor could name and force-unpair a device it never proved possession of.
 * The default mixed-client path (`e2eeRequired=false`) would otherwise dispatch it plaintext,
 * so this needs an explicit method-level guard here — `RPC_BOOTSTRAP_METHODS`/`e2eeRequired`
 * do not cover it.
 */
export const RPC_SEALED_ONLY_METHODS = new Set<string>(['e2ee.revokeDeviceKey']);

/**
 * Trusted per-request crypto context handed to the dispatch layer. `senderKid` is set BY THE
 * CRYPTO LAYER from the VERIFIED envelope kid — decryption succeeding proves the sender holds
 * that device's private key, so it is a trusted identity. It is NEVER derived from decrypted
 * params (a sealed client could forge `params.__senderKid` to target a different device). Only
 * present on the encrypted path; the plaintext path passes no context.
 */
export interface RpcCryptoContext {
  senderKid: string;
}

/** Inbound JSON-RPC request shape (structurally compatible with the tunnel handler's). */
export interface JsonRpcRequestLike {
  jsonrpc: '2.0';
  id: string;
  method: string;
  params?: unknown;
}

/** Outbound JSON-RPC response shape (structurally compatible with the tunnel handler's). */
export interface JsonRpcResponseLike {
  jsonrpc: '2.0';
  id: string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * Sealed RPC result wire shape — the plaintext that rides INSIDE the result envelope.
 * Domain success and domain failure BOTH travel encrypted so the bridge sees only opaque
 * ciphertext, never the method's result or error. Mirrored byte-for-byte on the mobile
 * side (`apps/mobile-app/src/services/e2ee/e2ee-rpc-crypto.ts`).
 */
export type SealedRpcResult =
  | { ok: true; data: unknown }
  | { ok: false; error: { code: number; message: string; data?: unknown } };

/**
 * The PC-side RPC transport seam (Phase 2, Task:1).
 *
 * Wraps the tunnel RPC handler so EVERY method's `params`/`result` is sealed with the
 * shared {@link CryptoEnvelopeService}, while `method` + correlation `id` stay cleartext
 * for the bridge. The ordering is **decrypt-then-auth**: encrypted `params` are opened
 * BEFORE the handler's schema validation + project scope checks run, so source-side auth
 * is unchanged and still rejects an unowned / cross-project request. The handler's
 * outcome is then re-wrapped — a success as `{ ok:true, data }`, a domain error as
 * `{ ok:false, error }` — and sealed back, so domain errors are never bridge-readable.
 *
 * Mixed-client back-compat: a request whose `params` are NOT an envelope (an older mobile
 * build, or one negotiated to plaintext) passes straight through to the plaintext path —
 * no silent change of behaviour. The pairwise shared key is re-derived on demand from the
 * PC private key + the paired device's public key (never persisted); the envelope `kid`
 * identifies the SEALER's device, so both directions resolve the same key.
 */
@Injectable()
export class TunnelRpcCryptoService {
  constructor(
    private readonly keypair: E2eeKeypairService,
    private readonly deviceStore: E2eeDeviceStoreService,
    @Optional() @Inject(E2EE_REQUIRED_POLICY) private readonly e2eeRequired: boolean = false,
  ) {}

  /** node:crypto CSPRNG, adapted to the injected `(n) => Uint8Array` contract. */
  private readonly randomBytes = (n: number): Uint8Array => new Uint8Array(nodeRandomBytes(n));

  /**
   * Run an inbound JSON-RPC request through the encryption seam. `dispatch` is the
   * existing plaintext handler (schema validation + scope/auth + method dispatch); it is
   * always called with PLAINTEXT params. `instanceId` is the bridge-assigned id this
   * tunnel belongs to — it binds the AEAD's AAD and must match the value the phone used.
   */
  async handle(
    req: JsonRpcRequestLike,
    instanceId: string | null,
    dispatch: (
      plain: JsonRpcRequestLike,
      cryptoCtx?: RpcCryptoContext,
    ) => Promise<JsonRpcResponseLike>,
  ): Promise<JsonRpcResponseLike> {
    const params = req.params;

    // Fail-closed enforcement (Phase 2, Task:2): when the PC's policy is `e2eeRequired`,
    // a plaintext (non-envelope) request is REJECTED — no domain content is dispatched.
    // This is the strict-rollout mode; when the policy is false (default), a non-envelope
    // request rides the plaintext path so mixed old/new clients interoperate.
    if (!isE2eeEnvelope(params)) {
      // Sealed-only methods (e.g. e2ee.revokeDeviceKey) are rejected when plaintext REGARDLESS
      // of e2eeRequired — a plaintext request carries no verified sender, so it must never
      // reach the dispatch layer (force-unpair defense). Checked before the e2eeRequired gate
      // because the default mixed-client path below would otherwise dispatch it.
      if (RPC_SEALED_ONLY_METHODS.has(req.method)) {
        logger.warn(
          { id: req.id, method: req.method },
          'Plaintext RPC rejected — method is sealed-only',
        );
        return {
          jsonrpc: '2.0',
          id: req.id,
          error: { code: -32603, message: 'E2EE required' },
        };
      }
      if (this.e2eeRequired && !RPC_BOOTSTRAP_METHODS.has(req.method)) {
        logger.warn(
          { id: req.id, method: req.method },
          'Plaintext RPC rejected — E2EE is required on this instance',
        );
        return {
          jsonrpc: '2.0',
          id: req.id,
          error: { code: -32603, message: 'E2EE required' },
        };
      }
      // Mixed-client back-compat: non-envelope params ride the existing plaintext path (no
      // crypto context — an unauthenticated request has no verified sender identity).
      return dispatch(req);
    }

    // Encrypted request. instanceId binds the AAD; RPC only flows after `ready`, so it is
    // present in practice — guard defensively rather than silently dropping the binding.
    if (!instanceId) {
      logger.warn(
        { id: req.id, method: req.method },
        'Encrypted RPC arrived before tunnel ready — cannot bind AAD',
      );
      return { jsonrpc: '2.0', id: req.id, error: { code: -32603, message: 'E2EE unavailable' } };
    }

    const service = await this.buildEnvelopeService(params.kid);
    if (!service) {
      // No paired device for this envelope kid → no shared key to derive. Surface a
      // crypto-failure (NOT any domain content) so the phone can flag a needed re-pair.
      logger.warn(
        { id: req.id, method: req.method, kid: params.kid },
        'No paired device for RPC envelope kid — rejecting',
      );
      return {
        jsonrpc: '2.0',
        id: req.id,
        error: { code: -32602, message: 'E2EE decrypt failed' },
      };
    }

    // Decrypt BEFORE auth/scope (decrypt-then-auth).
    let plainParams: unknown;
    try {
      plainParams = await service.open(params, this.ctx('mobile-to-pc', instanceId, req.method));
    } catch (err) {
      logger.warn(
        { err: (err as Error)?.name, id: req.id, method: req.method },
        'RPC params decryption failed — rejecting',
      );
      return {
        jsonrpc: '2.0',
        id: req.id,
        error: { code: -32602, message: 'E2EE decrypt failed' },
      };
    }

    const plainReq: JsonRpcRequestLike = {
      ...req,
      params:
        plainParams && typeof plainParams === 'object' && !Array.isArray(plainParams)
          ? (plainParams as Record<string, unknown>)
          : {},
    };

    // Trusted context: the envelope `kid` is the sender's device kid, and `service.open`
    // above only succeeded because the sender holds the matching private key — so this is a
    // VERIFIED identity. It is threaded SEPARATELY from `plainReq.params` so a handler can
    // trust it (a sealed client cannot forge it via decrypted params). Sealed-lane only.
    const cryptoCtx: RpcCryptoContext = { senderKid: params.kid };

    // Existing dispatch: schema validation + project scope/auth + handler. Unchanged, plus the
    // trusted crypto context (ignored by every handler except the sealed-only ones).
    const resp = await dispatch(plainReq, cryptoCtx);

    // Re-wrap the outcome ENCRYPTED: a domain error rides inside { ok:false, error } so it
    // is never bridge-readable; only transport errors (offline/timeout, generated by the
    // bridge) stay cleartext.
    const payload: SealedRpcResult = resp.error
      ? { ok: false, error: resp.error }
      : { ok: true, data: resp.result };
    const sealed = await service.seal(payload, this.ctx('pc-to-mobile', instanceId, req.method));
    return { jsonrpc: '2.0', id: req.id, result: sealed };
  }

  /**
   * Build a {@link CryptoEnvelopeService} bound to the pairwise shared key for the device
   * that sealed the request (identified by the incoming envelope `kid`). Returns `null`
   * when no such device is paired or its stored public key is unusable — the caller then
   * fails closed. The shared key is derived on demand and never persisted.
   */
  private async buildEnvelopeService(peerKid: string): Promise<CryptoEnvelopeService | null> {
    const device = this.deviceStore.get(peerKid);
    if (!device) return null;

    let devicePub: Uint8Array;
    try {
      devicePub = base64ToBytes(device.publicKeyB64);
    } catch {
      return null;
    }
    if (devicePub.length !== X25519_PUBLIC_KEY_BYTES) return null;

    const pc = await this.keypair.getOrCreate();
    const sharedKey = deriveSharedKey(pc.privateKey, devicePub);

    const provider: E2eeKeyProvider = {
      // Results are sealed under THIS PC's kid; the phone maps it to the same shared key.
      resolveSealKey: () => ({ kid: pc.kid, key: sharedKey }),
      // Params arrive sealed under the device (phone) kid; both kids map to the one
      // pairwise shared key, so either resolves it.
      getKeyById: (kid) => (kid === device.kid || kid === pc.kid ? sharedKey : undefined),
    };
    return new CryptoEnvelopeService(provider, this.randomBytes);
  }

  private ctx(
    direction: 'mobile-to-pc' | 'pc-to-mobile',
    instanceId: string,
    method: string,
  ): E2eeContext {
    return { lane: 'rpc', direction, instanceId, routeKey: method };
  }
}
