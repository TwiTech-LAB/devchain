import { createHash } from 'crypto';
import { createLogger } from '../../../common/logging/logger';
import type { Watcher } from '../../storage/models/domain.models';

/**
 * Owns the per-{watcher,session} trigger state for {@link WatcherRunnerService}.
 *
 * All four maps share the composite key `` `${watcherId}:${sessionId}` ``;
 * per-watcher teardown is a prefix sweep on that key ({@link clearForWatcher}).
 *
 * Invariants — each is load-bearing for trigger correctness:
 *
 * - `lastConditionState` is written on EVERY evaluation, BEFORE the trigger
 *   decision branch. `until_clear` reads the prior value to detect the
 *   false→true transition, and the unconditional write keeps it fresh even
 *   when a trigger is suppressed by cooldown or the hold window.
 * - `lastTriggeredHash` is set ONLY when a trigger is approved — it is the
 *   dedup watermark, never bumped on a suppressed evaluation.
 * - `cooldowns` is set when a trigger is approved and cleared solely by the
 *   mode rules in {@link evaluate} (`until_clear` clears it once the condition
 *   goes false past the hold window; `time` lets the stored timestamp expire).
 * - `triggerCounts` is incremented by the RUNNER after {@link evaluate} returns
 *   `shouldTrigger=true` and BEFORE the event is published. {@link evaluate}
 *   never touches the count — the ordering assertion lives in
 *   `watcher-trigger-state.spec.ts`.
 */
export class WatcherTriggerState {
  private readonly logger = createLogger('WatcherTriggerState');

  private readonly cooldowns = new Map<string, number>(); // key: `${watcherId}:${sessionId}`, value: expiry timestamp
  private readonly lastConditionState = new Map<string, boolean>(); // key: `${watcherId}:${sessionId}`
  private readonly lastTriggeredHash = new Map<string, string>(); // key: `${watcherId}:${sessionId}`
  private readonly triggerCounts = new Map<string, number>(); // key: `${watcherId}:${sessionId}`

  /**
   * Decide whether a matched condition should fire, applying cooldown and
   * dedup rules. Writes `lastConditionState` first (see class invariants), then
   * sets cooldown + lastTriggeredHash only when the trigger is approved.
   *
   * @returns `shouldTrigger` plus the viewport hash for dedup tracking.
   */
  evaluate(
    watcher: Watcher,
    sessionId: string,
    viewport: string,
    conditionMatched: boolean,
  ): { shouldTrigger: boolean; viewportHash: string } {
    const watcherId = watcher.id;
    const viewportHash = this.computeViewportHash(viewport);
    const previousState = this.getLastConditionState(watcherId, sessionId);

    // Always update the condition state
    this.setLastConditionState(watcherId, sessionId, conditionMatched);

    if (conditionMatched) {
      // Cooldown check based on mode
      if (watcher.cooldownMode === 'time') {
        // Time-based cooldown
        if (this.isOnCooldown(watcherId, sessionId)) {
          this.logger.debug(
            { watcherId, sessionId },
            'Skipping trigger: time-based cooldown active',
          );
          return { shouldTrigger: false, viewportHash };
        }

        // Hash-based deduplication is only applied when cooldownMs=0 (no time throttle).
        // When cooldownMs>0, the cooldown already prevents spamming and we allow periodic
        // re-triggers even if the viewport content is unchanged.
        if (watcher.cooldownMs === 0) {
          const lastHash = this.getLastTriggeredHash(watcherId, sessionId);
          if (lastHash === viewportHash) {
            this.logger.debug(
              { watcherId, sessionId, viewportHash },
              'Skipping trigger: viewport unchanged (hash dedup)',
            );
            return { shouldTrigger: false, viewportHash };
          }
        }
      } else if (watcher.cooldownMode === 'until_clear') {
        // until_clear: only trigger on false -> true transition
        if (previousState === true) {
          this.logger.debug(
            { watcherId, sessionId },
            'Skipping trigger: until_clear mode, condition already true',
          );
          return { shouldTrigger: false, viewportHash };
        }
        // Also check if cooldown entry exists (condition was never cleared)
        if (this.cooldowns.has(`${watcherId}:${sessionId}`)) {
          this.logger.debug(
            { watcherId, sessionId },
            'Skipping trigger: until_clear mode, cooldown not cleared',
          );
          return { shouldTrigger: false, viewportHash };
        }

        const lastHash = this.getLastTriggeredHash(watcherId, sessionId);
        if (lastHash === viewportHash) {
          this.logger.debug(
            { watcherId, sessionId, viewportHash },
            'Skipping trigger: until_clear mode, viewport unchanged since last trigger',
          );
          return { shouldTrigger: false, viewportHash };
        }
      }

      // All checks passed - should trigger
      // Set cooldown and hash
      this.setCooldown(watcherId, sessionId, watcher.cooldownMs);
      this.setLastTriggeredHash(watcherId, sessionId, viewportHash);

      this.logger.debug(
        { watcherId, sessionId, viewportHash, cooldownMode: watcher.cooldownMode },
        'Trigger approved',
      );
      return { shouldTrigger: true, viewportHash };
    } else {
      // Condition is false
      if (watcher.cooldownMode === 'until_clear') {
        // Clear only after the configured hold window expires. Terminal capture can
        // transiently miss a matched line while the same condition is still effectively active.
        if (this.isOnCooldown(watcherId, sessionId)) {
          this.logger.debug(
            { watcherId, sessionId },
            'Keeping cooldown: condition no longer matches but hold window is active',
          );
          return { shouldTrigger: false, viewportHash };
        }

        this.clearCooldown(watcherId, sessionId);
        this.logger.debug(
          { watcherId, sessionId },
          'Cleared cooldown: condition no longer matches (until_clear mode)',
        );
      }
      return { shouldTrigger: false, viewportHash };
    }
  }

  /**
   * Remove ALL state for a watcher across every session (prefix sweep on
   * `` `${watcherId}:` ``). Spread-copy guards against iterator invalidation
   * while deleting. Called on watcher stop and module teardown.
   */
  clearForWatcher(watcherId: string): void {
    const prefix = `${watcherId}:`;

    for (const key of [...this.cooldowns.keys()]) {
      if (key.startsWith(prefix)) {
        this.cooldowns.delete(key);
      }
    }

    for (const key of [...this.lastConditionState.keys()]) {
      if (key.startsWith(prefix)) {
        this.lastConditionState.delete(key);
      }
    }

    for (const key of [...this.lastTriggeredHash.keys()]) {
      if (key.startsWith(prefix)) {
        this.lastTriggeredHash.delete(key);
      }
    }

    for (const key of [...this.triggerCounts.keys()]) {
      if (key.startsWith(prefix)) {
        this.triggerCounts.delete(key);
      }
    }
  }

  /**
   * Get the cooldown state for a watcher+session pair.
   */
  isOnCooldown(watcherId: string, sessionId: string): boolean {
    const key = `${watcherId}:${sessionId}`;
    const cooldownUntil = this.cooldowns.get(key);

    if (!cooldownUntil) {
      return false;
    }

    return Date.now() < cooldownUntil;
  }

  private setCooldown(watcherId: string, sessionId: string, durationMs: number): void {
    const key = `${watcherId}:${sessionId}`;
    this.cooldowns.set(key, Date.now() + durationMs);
  }

  private clearCooldown(watcherId: string, sessionId: string): void {
    const key = `${watcherId}:${sessionId}`;
    this.cooldowns.delete(key);
  }

  /**
   * Compute a hash of viewport text for deduplication.
   * Uses SHA-256 truncated to 16 hex chars (64 bits).
   */
  computeViewportHash(viewport: string): string {
    return createHash('sha256').update(viewport).digest('hex').slice(0, 16);
  }

  /**
   * Get the last condition state (for until_clear mode).
   */
  getLastConditionState(watcherId: string, sessionId: string): boolean | undefined {
    const key = `${watcherId}:${sessionId}`;
    return this.lastConditionState.get(key);
  }

  private setLastConditionState(watcherId: string, sessionId: string, matched: boolean): void {
    const key = `${watcherId}:${sessionId}`;
    this.lastConditionState.set(key, matched);
  }

  /**
   * Get the last triggered hash (for deduplication).
   */
  getLastTriggeredHash(watcherId: string, sessionId: string): string | undefined {
    const key = `${watcherId}:${sessionId}`;
    return this.lastTriggeredHash.get(key);
  }

  private setLastTriggeredHash(watcherId: string, sessionId: string, hash: string): void {
    const key = `${watcherId}:${sessionId}`;
    this.lastTriggeredHash.set(key, hash);
  }

  /**
   * Get and increment the trigger count.
   *
   * Deliberately NOT called from {@link evaluate}: the runner invokes this
   * after `shouldTrigger=true` and before publishing the event, so the count
   * reflects only triggers that actually fire.
   */
  incrementTriggerCount(watcherId: string, sessionId: string): number {
    const key = `${watcherId}:${sessionId}`;
    const current = this.triggerCounts.get(key) ?? 0;
    const next = current + 1;
    this.triggerCounts.set(key, next);
    return next;
  }

  /**
   * Get the current trigger count.
   */
  getTriggerCount(watcherId: string, sessionId: string): number {
    const key = `${watcherId}:${sessionId}`;
    return this.triggerCounts.get(key) ?? 0;
  }
}
