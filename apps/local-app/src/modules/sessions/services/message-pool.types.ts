export const FAILURE_NOTICE_SOURCE = 'pool.failure_notice';

export interface MessagePoolConfig {
  enabled: boolean;
  delayMs: number;
  maxWaitMs: number;
  maxMessages: number;
  separator: string;
}

export interface PooledMessage {
  text: string;
  source: string;
  timestamp: number;
  submitKeys: string[];
  senderAgentId?: string;
  logEntryId: string;
}

export interface EnqueueOptions {
  source?: string;
  submitKeys?: string[];
  senderAgentId?: string;
  immediate?: boolean;
  projectId?: string;
  agentName?: string;
}

export interface EnqueueResult {
  status: 'queued' | 'delivered' | 'failed' | 'unconfirmed';
  poolSize?: number;
  error?: string;
}

export interface FlushResult {
  success: boolean;
  deliveredCount?: number;
  discardedCount?: number;
  reason?: string;
  outcome?: 'delivered' | 'unconfirmed';
}

export type DeliveryFailureCode =
  | 'paste_not_confirmed'
  | 'no_active_session'
  | 'send_keys_failed'
  | 'tmux_error';

export interface MessageLogEntry {
  id: string;
  timestamp: number;
  projectId: string;
  agentId: string;
  agentName: string;
  text: string;
  source: string;
  senderAgentId?: string;
  status: 'queued' | 'delivered' | 'failed' | 'unconfirmed';
  batchId?: string;
  deliveredAt?: number;
  error?: string;
  immediate: boolean;
  nonce?: string;
  confirmedAt?: number;
  retryCount?: number;
  failureCode?: DeliveryFailureCode;
}

export interface PoolDetails {
  agentId: string;
  agentName: string;
  projectId: string;
  messageCount: number;
  waitingMs: number;
  messages: Array<{
    id: string;
    preview: string;
    source: string;
    timestamp: number;
  }>;
}
