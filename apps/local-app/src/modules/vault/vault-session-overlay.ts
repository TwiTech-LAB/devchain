import type { VaultEntryKind } from '../storage/models/domain.models';

/** A value the user gave to one session only. It lives in memory, never in the DB. */
export interface VaultSessionValue {
  readonly name: string;
  readonly kind: VaultEntryKind;
  readonly description: string;
  readonly value: Buffer;
}

/**
 * Session-only values that a resolve adds to the session's granted entries. A value
 * here wins over a stored entry of the same name: the user gave it for this session.
 */
export interface VaultSessionOverlay {
  valuesFor(sessionId: string): readonly VaultSessionValue[];
}

export const VAULT_SESSION_OVERLAY = Symbol('VAULT_SESSION_OVERLAY');
