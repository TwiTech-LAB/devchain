export const FAILURE_NOTICE_SOURCE = 'pool.failure_notice';

export type FailureDisclosurePolicy = 'legacy' | 'project-safe';

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
  failureDisclosure?: FailureDisclosurePolicy;
  /** Caller-supplied idempotency key (mobile sends); see {@link EnqueueOptions.clientMessageId}. */
  clientMessageId?: string;
}

export interface EnqueueOptions {
  source?: string;
  submitKeys?: string[];
  /** Keys sent before the paste (e.g. `['Escape']`). Honored on the immediate path only. */
  preKeys?: string[];
  /** Delay (ms) after `preKeys`, before the paste. Ignored without `preKeys`. */
  preDelayMs?: number;
  senderAgentId?: string;
  immediate?: boolean;
  projectId?: string;
  agentName?: string;
  failureDisclosure?: FailureDisclosurePolicy;
  /**
   * Caller-supplied idempotency key. When set, a re-enqueue with the same
   * `clientMessageId` + `agentId` + `source` returns the existing entry instead
   * of delivering again (see the dedup invariant in
   * `SessionsMessagePoolService.enqueue`). Used by mobile so a relay-timeout
   * retry cannot duplicate a send.
   */
  clientMessageId?: string;
}

export interface EnqueueResult {
  status: 'queued' | 'delivered' | 'failed' | 'unconfirmed';
  poolSize?: number;
  error?: string;
  /** Log-entry id of the enqueued (or deduped) message; the mobile-facing messageId. */
  logEntryId?: string;
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
  | 'project_delivery_failed'
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
  /** Caller-supplied idempotency key; see {@link EnqueueOptions.clientMessageId}. */
  clientMessageId?: string;
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
