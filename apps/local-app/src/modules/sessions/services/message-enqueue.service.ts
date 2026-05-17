import { Injectable } from '@nestjs/common';
import { SessionsMessagePoolService, type EnqueueResult } from './sessions-message-pool.service';

export interface PoolMessage {
  readonly agentId: string;
  readonly text: string;
  readonly source: string;
  readonly submitKeys?: readonly string[];
  readonly senderAgentId?: string;
  readonly immediate?: boolean;
  readonly projectId?: string;
  readonly agentName?: string;
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
        senderAgentId: message.senderAgentId,
        immediate: message.immediate,
        projectId: message.projectId,
        agentName: message.agentName,
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
