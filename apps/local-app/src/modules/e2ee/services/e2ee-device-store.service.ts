import { Injectable, Inject, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
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
import { TransactionRunner } from '../../storage/db/transaction-runner';
import { createLogger } from '../../../common/logging/logger';
import {
  PAIRED_DEVICE_WORKSPACE_ACCESS_REVOKED_EVENT,
  type PairedDeviceWorkspaceAccessRevokedEvent,
} from '../events/paired-device-workspace-access.events';

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
  /** User-chosen name stored only on this PC. Never synchronized to the peer. */
  localAlias?: string;
  /**
   * Stable per-install id of the mobile app that adopted this key (M2 `paired-device-dedup`).
   * Ordinary logout preserves both this value and the kid. If an exceptional same-install
   * identity reset mints a new kid, the supersede sweep can use the retained installId to evict
   * the prior row.
   * UNAUTHENTICATED grouping metadata only (never a trust signal); carried BESIDE the shared
   * `E2eeTrustRecord` (deliberately NOT part of `@devchain/shared`). Absent on pre-M2 records
   * and old-client adopts. Never logged (minimize unauthenticated metadata).
   */
  installId?: string;
  /**
   * Notification routing kid (RFC 7638 JWK thumbprint, base64url) this device registered with
   * the notifications service and bound to this paired X25519 identity over the sealed lane.
   * Addressing metadata for notification delivery — never a trust or workspace-authority input.
   * Absent until the device's first sealed bind. Preserved across key-trust updates.
   */
  notificationRoutingKid?: string;
}

type StoredE2eeTrustRecord = E2eeTrustRecord &
  Pick<E2eePeerDevice, 'installId' | 'localAlias' | 'notificationRoutingKid'>;

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
 * RFC 7638 JWK thumbprint shape: base64url-unpadded, 43 chars (a 32-byte digest). A
 * routing kid that fails this shape is never persisted.
 */
const ROUTING_KID_RE = /^[A-Za-z0-9_-]{43}$/;

function isRoutingKid(value: unknown): value is string {
  return typeof value === 'string' && ROUTING_KID_RE.test(value);
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
  private readonly transactionRunner: TransactionRunner;

  constructor(
    @Inject(DB_CONNECTION) private readonly db: BetterSQLite3Database,
    @Optional() private readonly eventEmitter?: EventEmitter2,
  ) {
    this.sqlite = getRawSqliteClient(this.db);
    this.transactionRunner = new TransactionRunner(this.sqlite);
  }

  /**
   * Add or update a peer device's public key + trust state. Returns the stored record.
   * `trust` defaults to `'unverified'`; `verifiedVia`/`verifiedAt` are persisted only
   * when supplied (the QR path passes `'verified'`/`'qr'`).
   */
  add(
    device: Omit<E2eePeerDevice, 'addedAt' | 'trust' | 'localAlias'> & {
      addedAt?: string;
      trust?: E2eeTrustStatus;
    },
    opts: { evictVerified?: boolean } = {},
  ): E2eePeerDevice {
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
    const supersededKids = this.transactionRunner.runImmediate(() => {
      const dir = this.load();
      const existing = dir.devices[record.kid];
      if (existing?.localAlias !== undefined) record.localAlias = existing.localAlias;
      if (existing?.notificationRoutingKid !== undefined) {
        record.notificationRoutingKid = existing.notificationRoutingKid;
      }
      if (!existing) this.deleteWorkspaceGrants(record.kid);
      dir.devices[record.kid] = record;
      const evicted = this.supersedeByInstallId(
        dir.devices,
        record.installId,
        record.kid,
        opts.evictVerified ?? false,
      );
      for (const kid of evicted) this.deleteWorkspaceGrants(kid);
      this.save(dir);
      return evicted;
    });
    this.emitDeviceRevocations(supersededKids);
    logger.info(
      { kid: record.kid, trust: record.trust, superseded: supersededKids.length },
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
    const { record, supersededKids } = this.transactionRunner.runImmediate(() => {
      const dir = this.load();
      const existing = dir.devices[incoming.kid] ?? null;
      const prior =
        existing ??
        Object.values(dir.devices).find((d) => d.publicKeyB64 === incoming.publicKeyB64) ??
        null;
      const reconciled = reconcilePeerKey(prior, incoming, now) as StoredE2eeTrustRecord;
      const next = this.toDevice(reconciled);
      if (isCanonicalUuid(opts.installId)) next.installId = opts.installId;
      if (!existing) this.deleteWorkspaceGrants(next.kid);
      dir.devices[next.kid] = next;
      const evicted = this.supersedeByInstallId(
        dir.devices,
        next.installId,
        next.kid,
        opts.evictVerified ?? false,
      );
      for (const kid of evicted) this.deleteWorkspaceGrants(kid);
      this.save(dir);
      return { record: next, supersededKids: evicted };
    });
    this.emitDeviceRevocations(supersededKids);
    logger.info(
      {
        kid: record.kid,
        trust: record.trust,
        adoptedVia: record.adoptedVia,
        superseded: supersededKids.length,
      },
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
    const record = this.toDevice(
      markVerifiedViaSafetyNumber(existing, now) as StoredE2eeTrustRecord,
    );
    dir.devices[kid] = record;
    this.save(dir);
    logger.info({ kid }, 'Peer E2EE device marked VERIFIED via safety-number');
    return record;
  }

  /**
   * Project a shared `E2eeTrustRecord` onto the persisted device shape (drop undefineds).
   * Local-only metadata is carried beside the shared record, so the param is widened to
   * preserve it: same-key reconcile and verification spread the prior runtime record, and
   * this projection must not silently drop its install id or alias.
   */
  private toDevice(rec: StoredE2eeTrustRecord): E2eePeerDevice {
    return {
      kid: rec.kid,
      publicKeyB64: rec.publicKeyB64,
      addedAt: rec.addedAt,
      trust: rec.trust,
      ...(rec.adoptedVia !== undefined ? { adoptedVia: rec.adoptedVia } : {}),
      ...(rec.verifiedVia !== undefined ? { verifiedVia: rec.verifiedVia } : {}),
      ...(rec.verifiedAt !== undefined ? { verifiedAt: rec.verifiedAt } : {}),
      ...(rec.label !== undefined ? { label: rec.label } : {}),
      ...(rec.localAlias !== undefined ? { localAlias: rec.localAlias } : {}),
      ...(rec.installId !== undefined ? { installId: rec.installId } : {}),
      ...(rec.notificationRoutingKid !== undefined
        ? { notificationRoutingKid: rec.notificationRoutingKid }
        : {}),
    };
  }

  /**
   * The ONE place the exceptional same-install identity-rotation supersede rule lives:
   * evict every stored device that shares `installId` with the just-adopted device but has
   * a DIFFERENT kid. This handles reinstall, key loss, or an explicit identity reset;
   * ordinary logout preserves the kid and does not enter this path. Mutates the in-memory
   * directory in place and returns the evicted kids so their independent grants can be
   * removed in the same transaction.
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
   * Accepted residue: after exceptional same-install identity rotation without an explicit
   * revoke, email TOFU leaves the prior VERIFIED row in place (this guard forbids evicting
   * it) until QR re-pair or manual unpair.
   */
  private supersedeByInstallId(
    devices: Record<string, E2eePeerDevice>,
    installId: string | undefined,
    keepKid: string,
    evictVerified: boolean,
  ): string[] {
    if (!isCanonicalUuid(installId)) return [];
    const evicted: string[] = [];
    for (const [kid, device] of Object.entries(devices)) {
      if (kid === keepKid) continue;
      if (device.installId !== installId) continue;
      if (!evictVerified && device.trust === 'verified') continue;
      delete devices[kid];
      evicted.push(kid);
    }
    return evicted;
  }

  /** Look up a peer device by `kid`. `null` if unknown (e.g. wiped, never paired). */
  get(kid: string): E2eePeerDevice | null {
    return this.load().devices[kid] ?? null;
  }

  /** Set or clear the local-only alias for a known device. */
  setLocalAlias(kid: string, localAlias: string | null): E2eePeerDevice | null {
    return this.transactionRunner.runImmediate(() => {
      const dir = this.load();
      const existing = dir.devices[kid];
      if (!existing) return null;
      if (localAlias === null) delete existing.localAlias;
      else existing.localAlias = localAlias;
      this.save(dir);
      return existing;
    });
  }

  /**
   * Bind a notification routing kid to a known paired device. Idempotent: rebinding the
   * same kid is a no-op write; binding a new kid overwrites the old one (one routing
   * identity per paired device). Returns the updated record, or `null` if the device is
   * unknown or the routing kid is malformed.
   */
  setNotificationRoutingKid(kid: string, routingKid: string): E2eePeerDevice | null {
    if (!isRoutingKid(routingKid)) return null;
    const record = this.transactionRunner.runImmediate(() => {
      const dir = this.load();
      const existing = dir.devices[kid];
      if (!existing) return null;
      existing.notificationRoutingKid = routingKid;
      this.save(dir);
      return existing;
    });
    if (record) logger.info({ kid }, 'Notification routing kid bound to paired device');
    return record;
  }

  /** Remove a peer device's public key (unpair / revoke). No-op if unknown. */
  revoke(kid: string): boolean {
    const removed = this.transactionRunner.runImmediate(() => {
      const dir = this.load();
      if (!dir.devices[kid]) return false;
      delete dir.devices[kid];
      this.deleteWorkspaceGrants(kid);
      this.save(dir);
      return true;
    });
    if (!removed) return false;
    this.emitDeviceRevocations([kid]);
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

  private deleteWorkspaceGrants(kid: string): void {
    this.sqlite.prepare('DELETE FROM paired_device_workspace_grants WHERE device_kid = ?').run(kid);
  }

  private emitDeviceRevocations(kids: string[]): void {
    for (const deviceKid of kids) {
      const event: PairedDeviceWorkspaceAccessRevokedEvent = {
        deviceKid,
        reason: 'device-revoked',
      };
      this.eventEmitter?.emit(PAIRED_DEVICE_WORKSPACE_ACCESS_REVOKED_EVENT, event);
    }
  }
}
