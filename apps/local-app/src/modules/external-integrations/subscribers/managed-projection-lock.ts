import { Injectable } from '@nestjs/common';
import { ProjectionLockCoverageError } from '../../../common/errors/error-types';

/** Lock rounds before a holder that keeps meeting new projections gives up. */
const MAX_PROJECTION_LOCK_ATTEMPTS = 5;

/** In-process FIFO lock per string key. */
export class KeyedFifoLock {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(id) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => tail);
    this.tails.set(id, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.tails.get(id) === queued) {
        this.tails.delete(id);
      }
    }
  }

  /** Holds every id at once; sorted acquisition keeps two multi-id holders deadlock-free. */
  async runAll<T>(ids: readonly string[], operation: () => Promise<T>): Promise<T> {
    const sorted = [...new Set(ids)].sort();
    const acquire = (index: number): Promise<T> =>
      index >= sorted.length ? operation() : this.run(sorted[index]!, () => acquire(index + 1));
    return acquire(0);
  }
}

/**
 * In-process FIFO lock per managed-subtask projection id. Managed sync holds
 * it for a whole reconcile of one projection (read, vendor call, confirm);
 * an epic link change holds it while it releases projections, so a release
 * never lands between a projection's admission and its vendor call.
 *
 * Never hold it while waiting for a storage transaction that another holder
 * of the same lock needs, and acquire several ids only through `runAll`.
 */
@Injectable()
export class ManagedProjectionLock extends KeyedFifoLock {
  /**
   * Runs `attempt` holding `initialIds`. The set an attempt releases is known only
   * inside its transaction: an attempt that would release an unlocked projection
   * throws `ProjectionLockCoverageError`, and the next round holds those ids too.
   * After the last round it throws `busy()`.
   */
  async runCovering<T>(
    initialIds: readonly string[],
    attempt: (lockedIds: readonly string[]) => Promise<T>,
    busy: () => Error,
  ): Promise<T> {
    let lockIds = [...initialIds];
    for (let round = 1; ; round += 1) {
      const held = lockIds;
      try {
        return await this.runAll(held, () => attempt(held));
      } catch (error) {
        if (!(error instanceof ProjectionLockCoverageError)) throw error;
        if (round >= MAX_PROJECTION_LOCK_ATTEMPTS) throw busy();
        lockIds = [...held, ...error.projectionIds];
      }
    }
  }
}
