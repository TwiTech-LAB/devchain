import { Injectable } from '@nestjs/common';
import type { EventPayload } from '../events/catalog';
import { OnCatalogEvent } from '../events/catalog/on-catalog-event';
import type { VaultSessionOverlay, VaultSessionValue } from './vault-session-overlay';

/**
 * Values the user gave to one running session, in memory only: never persisted, never
 * logged, gone when the session stops or crashes or DevChain restarts. Each instance
 * holds the values of the sessions it runs: a claimed VM gets them from home's answer.
 */
@Injectable()
export class VaultSessionValueStore implements VaultSessionOverlay {
  private readonly bySession = new Map<string, Map<string, VaultSessionValue>>();

  /** Replaces the session's value of the same name. */
  set(sessionId: string, value: VaultSessionValue): void {
    let values = this.bySession.get(sessionId);
    if (!values) {
      values = new Map();
      this.bySession.set(sessionId, values);
    }
    values.set(value.name, Object.freeze({ ...value }));
  }

  valuesFor(sessionId: string): readonly VaultSessionValue[] {
    return [...(this.bySession.get(sessionId)?.values() ?? [])];
  }

  @OnCatalogEvent('session.stopped')
  onSessionStopped(payload: EventPayload<'session.stopped'>): void {
    this.bySession.delete(payload.sessionId);
  }

  @OnCatalogEvent('session.crashed')
  onSessionCrashed(payload: EventPayload<'session.crashed'>): void {
    this.bySession.delete(payload.sessionId);
  }
}
