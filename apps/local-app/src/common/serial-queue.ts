/** Cancelling admission removes the waiter. Once admitted, work owns the queue until it settles. */
export class SerialQueue {
  private readonly waiters = new Set<() => void>();
  private busy = false;

  get idle(): boolean {
    return !this.busy;
  }

  async run<T>(operation: () => T | Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal);
    try {
      signal?.throwIfAborted();
      return await operation();
    } finally {
      const next = this.waiters.values().next().value;
      if (next) {
        this.waiters.delete(next);
        next();
      } else {
        this.busy = false;
      }
    }
  }

  private async acquire(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (!this.busy) {
      this.busy = true;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const enter = () => {
        signal?.removeEventListener('abort', cancel);
        resolve();
      };
      const cancel = () => {
        this.waiters.delete(enter);
        reject(signal!.reason);
      };
      this.waiters.add(enter);
      signal?.addEventListener('abort', cancel, { once: true });
    });
  }
}
