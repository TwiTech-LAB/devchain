import { Injectable } from '@nestjs/common';
import { KeyedSerialQueue } from '../../../common/keyed-serial-queue';

/** Serializes lifecycle operations per agent, including launch and termination. */
@Injectable()
export class SessionCoordinatorService {
  private readonly queues = new KeyedSerialQueue();

  withAgentLock<T>(agentId: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.queues.run(agentId, fn, signal);
  }

  /**
   * Holds the locks of every listed agent, taken one by one in agent-id order. This is the only
   * place that holds one agent lock while it takes another: any other nesting can deadlock.
   */
  withAgentLocks<T>(agentIds: readonly string[], fn: () => Promise<T>): Promise<T> {
    const ordered = [...new Set(agentIds)].sort();
    const acquire = (index: number): Promise<T> =>
      index === ordered.length
        ? fn()
        : this.withAgentLock(ordered[index], () => acquire(index + 1));
    return acquire(0);
  }
}
