import { Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';
import {
  PAIRING_SECRET_BYTES,
  X25519_PUBLIC_KEY_BYTES,
  bytesToBase64,
  base64ToBytes,
  buildPairingTranscript,
  deriveKid,
  deriveSharedKey,
  verifyPairingMac,
  type E2eeTrustStatus,
} from '@devchain/shared';
import { ValidationError, ForbiddenError, NotFoundError } from '../../../common/errors/error-types';
import { createLogger } from '../../../common/logging/logger';
import { E2eeKeypairService } from './e2ee-keypair.service';
import { E2eeDeviceStoreService } from './e2ee-device-store.service';

const logger = createLogger('E2eePairing');

/** How long a pending pairing secret is held in memory before it is evicted. */
const PENDING_TTL_MS = 5 * 60 * 1000;

/** What the PC embeds into the on-screen QR for the phone to read off the visual channel. */
export interface BeginQrPairingResult {
  /** base64 of the PC's raw 32-byte X25519 public key. */
  pcEncPubKey: string;
  /** The PC's E2EE key id. */
  pcEncKid: string;
  /** base64 of the random pairing secret (the HMAC key) — VISUAL CHANNEL ONLY. */
  pairingSecret: string;
}

/** The device material the PC received (relayed) and must verify before trusting. */
export interface CompleteQrPairingInput {
  /** The pairing channel id used as the transcript's pairing identifier. */
  channelId: string;
  /** base64 of the device's raw 32-byte X25519 public key (relayed). */
  deviceEncPubKey: string;
  /** The device's E2EE key id (relayed). */
  deviceEncKid: string;
  /** base64 of `HMAC(pairingSecret, transcript)` the device returned (relayed). */
  pairingMac: string;
  /** Optional human label for the paired device. */
  label?: string;
  /**
   * Optional stable per-install id of the pairing phone (relayed through the QR channel by
   * identity-service, M2 `paired-device-dedup`). Opaque here — the device store validates it
   * as a canonical UUID before storing/evicting. Absent for old phones (append as today).
   */
  installId?: string;
}

export interface CompleteQrPairingResult {
  /** The now-trusted device key id. */
  kid: string;
  /** Resulting trust level (`'verified'` on the QR auto-verified path). */
  trust: E2eeTrustStatus;
}

/**
 * PC-side QR auto-verified key exchange (Phase-1 Task:4).
 *
 * `beginQrPairing` mints a random `pairingSecret` and hands it + the PC public key to
 * the renderer to embed in the on-screen QR — the out-of-band visual channel the cloud
 * relay cannot observe. `completeQrPairing` takes the device key + MAC the relay carried
 * back and accepts the key ONLY if the MAC verifies under that secret. A relay that
 * substitutes the device key never learns `pairingSecret`, so it cannot forge a matching
 * MAC: verification fails and nothing is stored (fail-closed). On success the peer key
 * is recorded VERIFIED and the shared key is derived (re-derivable on demand from the
 * PC private key + the stored peer public key — the secret itself is never persisted).
 */
@Injectable()
export class E2eePairingService {
  /** pairingSecret bytes, keyed by channelId, with creation time for TTL eviction. */
  private readonly pending = new Map<string, { secret: Uint8Array; createdAt: number }>();

  constructor(
    private readonly keypair: E2eeKeypairService,
    private readonly deviceStore: E2eeDeviceStoreService,
  ) {}

  /**
   * Start a QR pairing: return the PC public key + a fresh pairing secret to embed in
   * the QR. The secret is retained in memory (never logged, never sent to the relay)
   * until {@link completeQrPairing} consumes it.
   */
  async beginQrPairing(channelId: string): Promise<BeginQrPairingResult> {
    if (!channelId) throw new ValidationError('channelId is required');
    this.evictExpired();

    const pub = await this.keypair.exportPublic();
    const secret = Uint8Array.from(randomBytes(PAIRING_SECRET_BYTES));
    this.pending.set(channelId, { secret, createdAt: Date.now() });

    return {
      pcEncPubKey: pub.publicKeyB64,
      pcEncKid: pub.kid,
      pairingSecret: bytesToBase64(secret),
    };
  }

  /**
   * Finish a QR pairing: verify the device's MAC over the pairing transcript and, only
   * if it holds, record the device key as VERIFIED. Throws (and stores nothing) on a
   * missing/expired pairing, malformed input, or MAC failure.
   */
  async completeQrPairing(input: CompleteQrPairingInput): Promise<CompleteQrPairingResult> {
    this.evictExpired();
    const pending = this.pending.get(input.channelId);
    if (!pending) {
      throw new NotFoundError('Pairing session', input.channelId);
    }

    if (!input.deviceEncPubKey || !input.deviceEncKid || !input.pairingMac) {
      throw new ValidationError('deviceEncPubKey, deviceEncKid and pairingMac are required');
    }

    let devicePublicKey: Uint8Array;
    let mac: Uint8Array;
    try {
      devicePublicKey = base64ToBytes(input.deviceEncPubKey);
      mac = base64ToBytes(input.pairingMac);
    } catch {
      throw new ValidationError('deviceEncPubKey / pairingMac are not valid base64');
    }
    if (devicePublicKey.length !== X25519_PUBLIC_KEY_BYTES) {
      throw new ValidationError(`deviceEncPubKey must decode to ${X25519_PUBLIC_KEY_BYTES} bytes`);
    }
    // Identity binding (RE2E2): the `kid` is derived from the key and compared — never
    // trusted as supplied. A relay that substitutes the device key while keeping the
    // original kid is rejected here (the MAC also binds it, but verify explicitly at the
    // ingestion boundary so a forged kid can never be persisted).
    if (deriveKid(devicePublicKey) !== input.deviceEncKid) {
      this.pending.delete(input.channelId);
      logger.warn(
        { channelId: input.channelId, suppliedKid: input.deviceEncKid },
        'E2EE QR pairing rejected — deviceEncKid does not match deviceEncPubKey (possible substitution)',
      );
      throw new ForbiddenError('E2EE pairing verification failed');
    }

    const pc = await this.keypair.getOrCreate();
    const transcript = buildPairingTranscript({
      pcPublicKey: pc.publicKey,
      pcKid: pc.kid,
      mobilePublicKey: devicePublicKey,
      mobileKid: input.deviceEncKid,
      channelId: input.channelId,
    });

    if (!verifyPairingMac(pending.secret, transcript, mac)) {
      // Fail closed: burn the secret so the channel can't be retried, store NOTHING.
      this.pending.delete(input.channelId);
      logger.warn(
        { channelId: input.channelId, deviceKid: input.deviceEncKid },
        'E2EE QR pairing MAC verification failed — rejecting (possible key-substituting relay)',
      );
      throw new ForbiddenError('E2EE pairing verification failed');
    }

    // MAC verified over the visual-channel secret → the device key is authentic.
    // Derive the shared key to confirm the ECDH/HKDF leg succeeds; it is NOT persisted
    // (re-derivable from the PC private key + the stored peer public key in Phase 2+).
    deriveSharedKey(pc.privateKey, devicePublicKey);

    const record = this.deviceStore.add(
      {
        kid: input.deviceEncKid,
        publicKeyB64: input.deviceEncPubKey,
        trust: 'verified',
        verifiedVia: 'qr',
        verifiedAt: new Date().toISOString(),
        ...(input.label !== undefined ? { label: input.label } : {}),
        ...(input.installId !== undefined ? { installId: input.installId } : {}),
      },
      // QR pairing is MAC-authenticated, so a re-pair may supersede the phone's prior rows
      // EVEN if a stale one was verified — this device is the live, freshly-verified one.
      { evictVerified: true },
    );

    this.pending.delete(input.channelId);
    logger.info(
      { channelId: input.channelId, deviceKid: record.kid },
      'E2EE QR pairing verified — peer device marked VERIFIED',
    );
    return { kid: record.kid, trust: record.trust };
  }

  private evictExpired(): void {
    const cutoff = Date.now() - PENDING_TTL_MS;
    for (const [channelId, entry] of this.pending) {
      if (entry.createdAt < cutoff) this.pending.delete(channelId);
    }
  }
}
