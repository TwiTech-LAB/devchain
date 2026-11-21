import { Injectable } from '@nestjs/common';
import { SerialQueue } from '../../../common/serial-queue';

/** Serializes lifecycle operations per agent, including launch and termination. */
@Injectable()
export class SessionCoordinatorService {
  private readonly queues = new Map<string, SerialQueue>();

  async withAgentLock<T>(agentId: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const queue = this.queues.get(agentId) ?? new SerialQueue();
    this.queues.set(agentId, queue);
    try {
      return await queue.run(fn, signal);
    } finally {
      if (queue.idle && this.queues.get(agentId) === queue) this.queues.delete(agentId);
    }
  }
}
