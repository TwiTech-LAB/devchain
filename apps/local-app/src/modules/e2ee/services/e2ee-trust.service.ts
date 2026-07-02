import { Injectable } from '@nestjs/common';
import {
  base64ToBytes,
  deriveKid,
  deriveSafetyNumber,
  X25519_PUBLIC_KEY_BYTES,
  type E2eeTrustStatus,
  type E2eeVerificationMethod,
  type E2eeAdoptionMethod,
  type IncomingPeerKey,
} from '@devchain/shared';
import { NotFoundError, ValidationError } from '../../../common/errors/error-types';
import { createLogger } from '../../../common/logging/logger';
import { E2eeKeypairService } from './e2ee-keypair.service';
import { E2eeDeviceStoreService } from './e2ee-device-store.service';

const logger = createLogger('E2eeTrust');

/** The on-demand safety number for a paired device, plus its current trust label. */
export interface DeviceSafetyNumberResult {
  kid: string;
  /** The order-independent safety number — identical to the one the phone renders. */
  safetyNumber: string;
  trust: E2eeTrustStatus;
  verifiedVia?: E2eeVerificationMethod;
}

export interface DeviceTrustResult {
  kid: string;
  trust: E2eeTrustStatus;
  verifiedVia?: E2eeVerificationMethod;
}

/** A paired device row for the desktop "Paired devices" view — metadata only, no key
 *  material. The safety number is fetched per device on demand via `getSafetyNumber`. */
export interface PairedDeviceSummary {
  kid: string;
  label?: string;
  trust: E2eeTrustStatus;
  adoptedVia?: E2eeAdoptionMethod;
  verifiedVia?: E2eeVerificationMethod;
  verifiedAt?: string;
  addedAt: string;
}

/**
 * PC-side trust surface for the shared E2EE trust model (Task:8):
 *   - `getSafetyNumber` renders the same order-independent fingerprint the phone shows,
 *     so the user can compare both screens out-of-band (QrDisplayPanel reuse).
 *   - `verifyDevice` upgrades a device to VERIFIED after that compare succeeds.
 *   - `adoptPeerKeyTofu` is the email-TOFU adopt sink (and the seam Task:7 `946cc703`'s
 *     re-pair / rotation trigger calls) — delegates to the shared reconcile logic.
 * QR pairing already marks devices VERIFIED (Task:4); these add the email-TOFU + on-
 * demand-verify legs so BOTH paths converge on one model.
 */
@Injectable()
export class E2eeTrustService {
  constructor(
    private readonly keypair: E2eeKeypairService,
    private readonly deviceStore: E2eeDeviceStoreService,
  ) {}

  /**
   * All paired peer devices, newest first, WITHOUT key material — backs the desktop
   * "Paired devices" view. The per-device safety number is NOT included here; it is
   * computed on demand via {@link getSafetyNumber} only when the user asks to compare.
   */
  listDevices(): PairedDeviceSummary[] {
    return this.deviceStore
      .list()
      .map((d) => ({
        kid: d.kid,
        trust: d.trust,
        addedAt: d.addedAt,
        ...(d.label !== undefined ? { label: d.label } : {}),
        ...(d.adoptedVia !== undefined ? { adoptedVia: d.adoptedVia } : {}),
        ...(d.verifiedVia !== undefined ? { verifiedVia: d.verifiedVia } : {}),
        ...(d.verifiedAt !== undefined ? { verifiedAt: d.verifiedAt } : {}),
      }))
      .sort((a, b) => b.addedAt.localeCompare(a.addedAt));
  }

  /** Compute the safety number for a paired device. Throws if the device is unknown. */
  async getSafetyNumber(kid: string): Promise<DeviceSafetyNumberResult> {
    if (!kid) throw new ValidationError('kid is required');
    const device = this.deviceStore.get(kid);
    if (!device) throw new NotFoundError('E2EE device', kid);

    let devicePub: Uint8Array;
    try {
      devicePub = base64ToBytes(device.publicKeyB64);
    } catch {
      throw new ValidationError('stored device public key is not valid base64');
    }
    if (devicePub.length !== X25519_PUBLIC_KEY_BYTES) {
      throw new ValidationError(`device public key must be ${X25519_PUBLIC_KEY_BYTES} bytes`);
    }

    const self = await this.keypair.getOrCreate();
    const safetyNumber = deriveSafetyNumber(self.publicKey, devicePub);
    return {
      kid: device.kid,
      safetyNumber,
      trust: device.trust,
      ...(device.verifiedVia !== undefined ? { verifiedVia: device.verifiedVia } : {}),
    };
  }

  /** Mark a device VERIFIED after the user confirms the safety numbers match. */
  verifyDevice(kid: string): DeviceTrustResult {
    if (!kid) throw new ValidationError('kid is required');
    const record = this.deviceStore.markVerified(kid);
    if (!record) throw new NotFoundError('E2EE device', kid);
    logger.info({ kid }, 'E2EE device verified via safety-number compare');
    return {
      kid: record.kid,
      trust: record.trust,
      ...(record.verifiedVia !== undefined ? { verifiedVia: record.verifiedVia } : {}),
    };
  }

  /**
   * Un-pair (remove) a device's stored public key — used to clear stale entries from old
   * app installs (each reinstall/rotation creates a new kid). Idempotent: returns
   * `removed: false` when the kid is already gone. If the device is still the active one,
   * E2EE re-establishes on its next message via the plaintext key-delivery bootstrap.
   */
  revokeDevice(kid: string): { kid: string; removed: boolean } {
    if (!kid) throw new ValidationError('kid is required');
    const removed = this.deviceStore.revoke(kid);
    if (removed) logger.info({ kid }, 'E2EE device un-paired from Paired devices');
    return { kid, removed };
  }

  /**
   * Email-TOFU adopt sink / re-pair seam — reconcile a relayed peer key into the store.
   *
   * `installId` (M2 `paired-device-dedup`) is carried as a SEPARATE param, never folded into
   * the shared `IncomingPeerKey` type. It supersedes the phone's prior rows on re-login, but
   * ONLY non-verified ones (`evictVerified: false`): this adopt arrives PLAINTEXT over the
   * unauthenticated bootstrap lane, so it must never force-unpair a QR-verified device. The
   * store validates installId as a canonical UUID before storing/evicting; opaque here.
   */
  adoptPeerKeyTofu(incoming: IncomingPeerKey, installId?: string): DeviceTrustResult {
    if (!incoming?.kid || !incoming.publicKeyB64) {
      throw new ValidationError('kid and publicKeyB64 are required');
    }
    let pub: Uint8Array;
    try {
      pub = base64ToBytes(incoming.publicKeyB64);
    } catch {
      throw new ValidationError('publicKeyB64 is not valid base64');
    }
    if (pub.length !== X25519_PUBLIC_KEY_BYTES) {
      throw new ValidationError(`publicKeyB64 must decode to ${X25519_PUBLIC_KEY_BYTES} bytes`);
    }
    // Identity binding (coordinated with RE2E2): the `kid` is NOT trusted as supplied — it
    // is derived from the public key and compared. A relay/caller that substitutes a key
    // while keeping the original `kid` is rejected here, so a forged key never reaches the
    // device store. (binding `kid` into the AAD only protects in transit, not at ingestion.)
    const derivedKid = deriveKid(pub);
    if (derivedKid !== incoming.kid) {
      logger.warn(
        { suppliedKid: incoming.kid, derivedKid },
        'E2EE adopt rejected — kid does not match public key (possible substitution)',
      );
      throw new ValidationError('kid does not match public key');
    }
    const record = this.deviceStore.reconcile(incoming, undefined, {
      installId,
      evictVerified: false,
    });
    return {
      kid: record.kid,
      trust: record.trust,
      ...(record.verifiedVia !== undefined ? { verifiedVia: record.verifiedVia } : {}),
    };
  }
}
