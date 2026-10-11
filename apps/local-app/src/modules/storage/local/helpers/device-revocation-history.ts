import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

export const REVOKED_DEVICE_KIDS_KEY = 'cloud.e2ee.revokedDeviceKids';
export const MAX_REVOKED_DEVICE_KIDS = 1000;

/** Oldest first. Retained authority lets the next Connect propagate a full unpair. */
export function readRevokedDeviceKids(sqlite: Database.Database): string[] {
  const row = sqlite
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(REVOKED_DEVICE_KIDS_KEY) as { value: string } | undefined;
  if (!row) return [];
  const value: unknown = JSON.parse(row.value);
  if (!Array.isArray(value) || !value.every((kid) => typeof kid === 'string' && kid.length > 0)) {
    throw new Error('Invalid revoked-device history');
  }
  return value;
}

/** Caller owns the device/grant transaction so revocation and retained authority commit together. */
export function updateRevokedDeviceKids(
  sqlite: Database.Database,
  revoked: readonly string[],
  pairedKid?: string,
): void {
  const previous = readRevokedDeviceKids(sqlite);
  const next = [
    ...new Set([
      ...previous.filter((kid) => kid !== pairedKid && !revoked.includes(kid)),
      ...revoked,
    ]),
  ].slice(-MAX_REVOKED_DEVICE_KIDS);
  if (JSON.stringify(next) === JSON.stringify(previous)) return;
  const now = new Date().toISOString();
  sqlite
    .prepare(
      `INSERT INTO settings (id, key, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(randomUUID(), REVOKED_DEVICE_KIDS_KEY, JSON.stringify(next), now, now);
}
