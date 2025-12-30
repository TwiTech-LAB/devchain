import { Injectable } from '@nestjs/common';

@Injectable()
export class TerminalSendCoordinatorService {
  private lastByAgent = new Map<string, number>();
  private tailByAgent = new Map<string, Promise<void>>();

  async ensureAgentGap(agentId: string, minMs: number = 500): Promise<void> {
    const prev = this.tailByAgent.get(agentId) ?? Promise.resolve();

    const next = prev.then(async () => {
      const now = Date.now();
      const last = this.lastByAgent.get(agentId) ?? 0;
      const delta = now - last;
      if (delta < minMs) {
        await new Promise((r) => setTimeout(r, minMs - delta));
      }
      this.lastByAgent.set(agentId, Date.now());
    });

    // Keep the chain; ignore errors to avoid breaking subsequent calls
    this.tailByAgent.set(
      agentId,
      next.catch(() => {
        /* no-op */
      }),
    );
    return next;
  }
}
