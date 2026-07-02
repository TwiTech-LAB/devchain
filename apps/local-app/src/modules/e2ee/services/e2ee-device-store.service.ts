import { Injectable, Inject } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import Database from 'better-sqlite3';
import {
  reconcilePeerKey,
  markVerifiedViaSafetyNumber,
  type E2eeTrustStatus,
  type E2eeVerificationMethod,
  type E2eeAdoptionMethod,
  type E2eeTrustRecord,
  type IncomingPeerKey,
} from '@devchain/shared';
import { DB_CONNECTION } from '../../storage/db/db.provider';
import { getRawSqliteClient } from '../../storage/db/sqlite-raw';
import { createLogger } from '../../../common/logging/logger';

const logger = createLogger('E2eeDeviceStore');

const SETTINGS_KEY = 'cloud.e2ee.devices';

/**
 * A peer device's public X25519 key plus its trust state, keyed by its `kid`. Public
 * material only — safe to store unencrypted (it is the counterpart to this PC's private
 * key). Used at ECDH/open() time to derive shared keys per recipient device; reserved
 * for the multi-device fan-out declared in `E2eeEnvelope.recipients`. Concretely the
 * PC-side persistence of the shared `E2eeTrustRecord`: QR pairing (Task:4) writes
 * `trust:'verified'`/`verifiedVia:'qr'`; email TOFU (Task:8) writes `'unverified'`.
 */
export interface E2eePeerDevice {
  /** Key id — SHA-256(peer public key) truncated; the lookup key. */
  kid: string;
  /** base64 of the raw 32-byte peer X25519 public key. */
  publicKeyB64: string;
  /** ISO timestamp the device was added (pairing time). */
  addedAt: string;
  /** Trust level for this key. Defaults to `'unverified'` when not specified. */
  trust: E2eeTrustStatus;
  /** How the key was adopted: 'qr' (auto-verified) or 'email-tofu' (trust-on-first-use). */
  adoptedVia?: E2eeAdoptionMethod;
  /** How the key was verified — present iff `trust === 'verified'`. */
  verifiedVia?: E2eeVerificationMethod;
  /** ISO timestamp the key reached `'verified'`. */
  verifiedAt?: string;
  /** Optional human label (device name); populated when known. */
  label?: string;
  /**
   * Stable per-install id of the mobile app that adopted this key (M2 `paired-device-dedup`).
   * Survives logout on the phone (it is NOT key material), so re-login mints a fresh kid but
   * carries the SAME installId — the supersede sweep uses it to evict the phone's prior row.
   * UNAUTHENTICATED grouping metadata only (never a trust signal); carried BESIDE the shared
   * `E2eeTrustRecord` (deliberately NOT part of `@devchain/shared`). Absent on pre-M2 records
   * and old-client adopts. Never logged (minimize unauthenticated metadata).
   */
  installId?: string;
}

interface StoredDirectory {
  v: number;
  devices: Record<string, E2eePeerDevice>;
}

const STORE_VERSION = 1;

/**
 * Canonical RFC-4122/9562 UUID (lowercase, hyphenated, version 1–8, variant 8–b). The
 * mobile install id is minted as a canonical UUID; we validate it BEFORE storing OR
 * evicting so a malformed/hostile value can neither be persisted nor drive an eviction
 * (invalid/absent ⇒ store nothing, evict nothing — indistinguishable from an old client).
 */
const CANONICAL_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function isCanonicalUuid(value: unknown): value is string {
  return typeof value === 'string' && CANONICAL_UUID_RE.test(value);
}

/**
 * PC-side directory of peer (mobile / other) device public X25519 keys, keyed by the
 * device `kid`. Reserved for multi-device: `seal()` (Phase 2+) wraps a message key per
 * recipient `kid`; `open()` looks the sender's key up here. Add on pairing, revoke on
 * unpair. Public material only — stored as a JSON blob in the settings table (no
 * encryption needed; these keys are intentionally shareable).
 */
@Injectable()
export class E2eeDeviceStoreService {
  private sqlite: Database.Database;

  constructor(@Inject(DB_CONNECTION) private readonly db: BetterSQLite3Database) {
    this.sqlite = getRawSqliteClient(this.db);
  }

  /**
   * Add or update a peer device's public key + trust state. Returns the stored record.
   * `trust` defaults to `'unverified'`; `verifiedVia`/`verifiedAt` are persisted only
   * when supplied (the QR path passes `'verified'`/`'qr'`).
   */
  add(
    device: Omit<E2eePeerDevice, 'addedAt' | 'trust'> & {
      addedAt?: string;
      trust?: E2eeTrustStatus;
    },
    opts: { evictVerified?: boolean } = {},
  ): E2eePeerDevice {
    const dir = this.load();
    const record: E2eePeerDevice = {
      kid: device.kid,
      publicKeyB64: device.publicKeyB64,
      addedAt: device.addedAt ?? new Date().toISOString(),
      trust: device.trust ?? 'unverified',
      ...(device.adoptedVia !== undefined ? { adoptedVia: device.adoptedVia } : {}),
      ...(device.verifiedVia !== undefined ? { verifiedVia: device.verifiedVia } : {}),
      ...(device.verifiedAt !== undefined ? { verifiedAt: device.verifiedAt } : {}),
      ...(device.label !== undefined ? { label: device.label } : {}),
      // Persist installId only when it is a canonical UUID (validate BEFORE storing).
      ...(isCanonicalUuid(device.installId) ? { installId: device.installId } : {}),
    };
    dir.devices[record.kid] = record;
    // Supersede the same phone's prior rows in the SAME load/save (no add-then-evict window).
    // QR complete passes evictVerified:true (MAC-authenticated); a plaintext seam must not.
    const superseded = this.supersedeByInstallId(
      dir.devices,
      record.installId,
      record.kid,
      opts.evictVerified ?? false,
    );
    this.save(dir);
    logger.info(
      { kid: record.kid, trust: record.trust, superseded },
      'Peer E2EE device public key added',
    );
    return record;
  }

  /**
   * Trust-on-first-use adopt + key-change revert for a relayed peer key — the email-TOFU
   * sink (Task:8) and the seam the re-pair / rotation TRIGGER (Task:7 `946cc703`) calls.
   * Delegates to the shared `reconcilePeerKey` so PC + mobile share ONE trust model: a
   * new key adopts as `'unverified'`/`'email-tofu'`; an unchanged key is preserved
   * (keeps a prior `'verified'`); a CHANGED key silently reverts to `'unverified'`
   * (verification dropped — never auto-trust a rotated key). Returns the stored record.
   */
  reconcile(
    incoming: IncomingPeerKey,
    now: string = new Date().toISOString(),
    opts: { installId?: string; evictVerified?: boolean } = {},
  ): E2eePeerDevice {
    const dir = this.load();
    const existing = (dir.devices[incoming.kid] ?? null) as E2eeTrustRecord | null;
    // A key change keeps the same logical device but a new kid — find any prior record
    // for this device by walking the directory so a rotation reverts the old entry too.
    const prior =
      existing ??
      Object.values(dir.devices).find((d) => d.publicKeyB64 === incoming.publicKeyB64) ??
      null;
    const reconciled = reconcilePeerKey(prior as E2eeTrustRecord | null, incoming, now);
    // `toDevice` preserves any installId already on an unchanged record; a fresh/rotated
    // record has none. Then backfill from the adopt: a same-key adopt carrying a valid
    // installId writes it onto the record EVEN when reconcile returned the prior unchanged,
    // so a pre-installId row gains one and dedupes on its next rotation.
    const record = this.toDevice(reconciled as E2eeTrustRecord & { installId?: string });
    if (isCanonicalUuid(opts.installId)) {
      record.installId = opts.installId;
    }
    dir.devices[record.kid] = record;
    // Single load/save: supersede the phone's prior rows here, not in a second store call.
    // TOFU adopt (this path) MUST NOT evict verified rows — an unauthenticated plaintext
    // bootstrap adopt must never force-unpair a QR-verified device (see supersedeByInstallId).
    const superseded = this.supersedeByInstallId(
      dir.devices,
      record.installId,
      record.kid,
      opts.evictVerified ?? false,
    );
    this.save(dir);
    logger.info(
      { kid: record.kid, trust: record.trust, adoptedVia: record.adoptedVia, superseded },
      'Peer E2EE device reconciled (TOFU adopt / rotation)',
    );
    return record;
  }

  /**
   * Mark a known device VERIFIED after a successful out-of-band safety-number compare
   * (Task:8 on-demand verification). Returns the updated record, or `null` if unknown.
   */
  markVerified(kid: string, now: string = new Date().toISOString()): E2eePeerDevice | null {
    const dir = this.load();
    const existing = dir.devices[kid];
    if (!existing) return null;
    const record = this.toDevice(markVerifiedViaSafetyNumber(existing as E2eeTrustRecord, now));
    dir.devices[kid] = record;
    this.save(dir);
    logger.info({ kid }, 'Peer E2EE device marked VERIFIED via safety-number');
    return record;
  }

  /**
   * Project a shared `E2eeTrustRecord` onto the persisted device shape (drop undefineds).
   * `installId` is carried BESIDE the shared record (not a `@devchain/shared` field), so the
   * param is widened to preserve it: an unchanged same-key reconcile returns the prior record,
   * and without this projection its installId would be silently dropped on every re-adopt.
   */
  private toDevice(rec: E2eeTrustRecord & { installId?: string }): E2eePeerDevice {
    return {
      kid: rec.kid,
      publicKeyB64: rec.publicKeyB64,
      addedAt: rec.addedAt,
      trust: rec.trust,
      ...(rec.adoptedVia !== undefined ? { adoptedVia: rec.adoptedVia } : {}),
      ...(rec.verifiedVia !== undefined ? { verifiedVia: rec.verifiedVia } : {}),
      ...(rec.verifiedAt !== undefined ? { verifiedAt: rec.verifiedAt } : {}),
      ...(rec.label !== undefined ? { label: rec.label } : {}),
      ...(rec.installId !== undefined ? { installId: rec.installId } : {}),
    };
  }

  /**
   * The ONE place the re-login supersede rule lives: evict every stored device that shares
   * `installId` with the just-adopted device but has a DIFFERENT kid (the phone's dead
   * pre-logout rows). Mutates the in-memory directory in place and returns the eviction
   * count — the caller folds it into a SINGLE load/save so no intermediate state ever
   * persists the new entry alongside the rows it supersedes.
   *
   * SECURITY INVARIANT (not a style choice): with `evictVerified === false` a
   * `trust === 'verified'` row is NEVER evicted. `e2ee.adoptDeviceKey` arrives PLAINTEXT
   * (unauthenticated bridge-position bootstrap) — allowing it to drop a QR-verified device
   * would be a force-unpair attack. Only the MAC-authenticated QR-complete seam passes
   * `evictVerified: true`. The guard is written `trust !== 'verified'` (not
   * `=== 'unverified'`) so any future/unknown trust value also stays protected by default.
   *
   * The installId is validated canonical BEFORE any eviction; an invalid/absent installId
   * evicts nothing (old-client append behavior). installId values are never logged.
   *
   * Accepted residue (M3's case): an OFFLINE logout + email re-login leaves the phone's prior
   * VERIFIED row in place (this guard forbids evicting it) until QR re-pair or manual unpair.
   */
  private supersedeByInstallId(
    devices: Record<string, E2eePeerDevice>,
    installId: string | undefined,
    keepKid: string,
    evictVerified: boolean,
  ): number {
    if (!isCanonicalUuid(installId)) return 0;
    let evicted = 0;
    for (const [kid, device] of Object.entries(devices)) {
      if (kid === keepKid) continue;
      if (device.installId !== installId) continue;
      if (!evictVerified && device.trust === 'verified') continue;
      delete devices[kid];
      evicted++;
    }
    return evicted;
  }

  /** Look up a peer device by `kid`. `null` if unknown (e.g. wiped, never paired). */
  get(kid: string): E2eePeerDevice | null {
    return this.load().devices[kid] ?? null;
  }

  /** Remove a peer device's public key (unpair / revoke). No-op if unknown. */
  revoke(kid: string): boolean {
    const dir = this.load();
    if (!dir.devices[kid]) return false;
    delete dir.devices[kid];
    this.save(dir);
    logger.info({ kid }, 'Peer E2EE device public key revoked');
    return true;
  }

  /** List all known peer devices. */
  list(): E2eePeerDevice[] {
    return Object.values(this.load().devices);
  }

  private load(): StoredDirectory {
    const row = this.sqlite
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(SETTINGS_KEY) as { value: string } | undefined;
    if (!row) return { v: STORE_VERSION, devices: {} };
    try {
      const parsed = JSON.parse(row.value) as StoredDirectory;
      if (parsed.v !== STORE_VERSION || typeof parsed.devices !== 'object') {
        logger.warn('E2EE device directory has unexpected shape — resetting');
        return { v: STORE_VERSION, devices: {} };
      }
      // Normalize records persisted before the trust field existed (Task:3): an absent
      // trust level is treated as 'unverified' (never silently 'verified').
      for (const rec of Object.values(parsed.devices)) {
        if (rec && typeof rec === 'object' && rec.trust === undefined) {
          rec.trust = 'unverified';
        }
      }
      return parsed;
    } catch {
      logger.warn('Failed to parse E2EE device directory — resetting');
      return { v: STORE_VERSION, devices: {} };
    }
  }

  private save(dir: StoredDirectory): void {
    const now = new Date().toISOString();
    this.sqlite
      .prepare(
        `INSERT INTO settings (id, key, value, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(randomUUID(), SETTINGS_KEY, JSON.stringify(dir), now, now);
  }
}
