import { Injectable } from '@nestjs/common';

/**
 * Serializes session operations per agent to prevent race conditions.
 * Uses promise-chain pattern (same as TerminalSendCoordinatorService).
 *
 * Without this, concurrent epic.updated events (with agent assignment) for the same agent can
 * both pass the "no existing session" check and create duplicate sessions.
 */
@Injectable()
export class SessionCoordinatorService {
  private tailByAgent = new Map<string, Promise<void>>();

  /**
   * Execute an async operation with per-agent serialization.
   * Operations for the same agent queue up and execute sequentially.
   */
  async withAgentLock<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tailByAgent.get(agentId) ?? Promise.resolve();

    let result: T;
    const next = prev.then(async () => {
      result = await fn();
    });

    // Keep the chain; ignore errors to avoid breaking subsequent calls
    this.tailByAgent.set(
      agentId,
      next.catch(() => {
        /* no-op */
      }),
    );

    await next;
    return result!;
  }
}
