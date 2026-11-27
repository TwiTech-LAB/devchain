import { SerialQueue } from './serial-queue';

/** One FIFO queue per key; a key's queue is dropped once it is idle. Not reentrant. */
export class KeyedSerialQueue {
  private readonly queues = new Map<string, SerialQueue>();

  async run<T>(key: string, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const queue = this.queues.get(key) ?? new SerialQueue();
    this.queues.set(key, queue);
    try {
      return await queue.run(operation, signal);
    } finally {
      if (queue.idle && this.queues.get(key) === queue) this.queues.delete(key);
    }
  }
}
