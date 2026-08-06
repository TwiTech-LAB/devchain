import { Injectable } from '@nestjs/common';
import {
  SessionsMessagePoolService,
  type EnqueueResult,
  type FailureDisclosurePolicy,
} from './sessions-message-pool.service';

export interface PoolMessage {
  readonly agentId: string;
  readonly text: string;
  readonly source: string;
  readonly submitKeys?: readonly string[];
  /** Keys sent before the paste (e.g. `['Escape']`). Immediate path only. */
  readonly preKeys?: readonly string[];
  /** Delay (ms) after `preKeys`, before the paste. Ignored without `preKeys`. */
  readonly preDelayMs?: number;
  readonly senderAgentId?: string;
  readonly immediate?: boolean;
  readonly projectId?: string;
  readonly agentName?: string;
  readonly failureDisclosure?: FailureDisclosurePolicy;
  /** Caller-supplied idempotency key (mobile sends); threaded into the pool for dedup. */
  readonly clientMessageId?: string;
}

export interface MessageEnqueueResult extends EnqueueResult {
  readonly agentId: string;
}

export interface PoolStatus {
  readonly agentCount: number;
  readonly totalMessages: number;
  readonly pools: readonly {
    readonly agentId: string;
    readonly messageCount: number;
    readonly waitingMs: number;
  }[];
}

@Injectable()
export class MessageEnqueueService {
  constructor(private readonly pool: SessionsMessagePoolService) {}

  async enqueue(messages: readonly PoolMessage[]): Promise<MessageEnqueueResult[]> {
    const results: MessageEnqueueResult[] = [];

    for (const message of messages) {
      const result = await this.pool.enqueue(message.agentId, message.text, {
        source: message.source,
        submitKeys: message.submitKeys ? [...message.submitKeys] : undefined,
        preKeys: message.preKeys ? [...message.preKeys] : undefined,
        preDelayMs: message.preDelayMs,
        senderAgentId: message.senderAgentId,
        immediate: message.immediate,
        projectId: message.projectId,
        agentName: message.agentName,
        failureDisclosure: message.failureDisclosure,
        clientMessageId: message.clientMessageId,
      });

      results.push({ agentId: message.agentId, ...result });
    }

    return results;
  }

  async flush(agentId: string): Promise<void> {
    await this.pool.flushNow(agentId);
  }

  getPoolStatus(): PoolStatus {
    const pools = this.pool.getPoolStats().map((pool) => ({
      agentId: pool.agentId,
      messageCount: pool.messageCount,
      waitingMs: pool.waitingMs,
    }));

    return {
      agentCount: pools.length,
      totalMessages: pools.reduce((sum, pool) => sum + pool.messageCount, 0),
      pools,
    };
  }
}
