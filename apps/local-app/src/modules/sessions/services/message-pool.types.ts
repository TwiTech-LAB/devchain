export const FAILURE_NOTICE_SOURCE = 'pool.failure_notice';

export type FailureDisclosurePolicy = 'legacy' | 'project-safe';

export const MESSAGE_DELIVERY_MODES = ['default', 'immediate', 'on_idle'] as const;

export type MessageDeliveryMode = (typeof MESSAGE_DELIVERY_MODES)[number];

export function isMessageDeliveryMode(value: unknown): value is MessageDeliveryMode {
  return MESSAGE_DELIVERY_MODES.some((mode) => mode === value);
}

export function deliveryModeFromLegacyImmediate(value: unknown): MessageDeliveryMode {
  return value === true || value === 'true' ? 'immediate' : 'default';
}

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
  /** Internal policy; never derived from source text. */
  deferWhileHumanTyping?: boolean;
  /** True when this message also requires provider-idle delivery. */
  requiresProviderIdle?: boolean;
  /** Generation that caused this message to be held; counting/logging metadata only. */
  heldGeneration?: number;
}

export interface EnqueueOptions {
  source?: string;
  submitKeys?: string[];
  /** Keys sent before the paste (e.g. `['Escape']`). Honored on the immediate path only. */
  preKeys?: string[];
  /** Delay (ms) after `preKeys`, before the paste. Ignored without `preKeys`. */
  preDelayMs?: number;
  senderAgentId?: string;
  deliveryMode?: MessageDeliveryMode;
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
  /** Internal policy derived by Agent Message Delivery from structured sender identity. */
  deferWhileHumanTyping?: boolean;
  /** Internal explicit-human-submit marker. */
  humanPromptSubmit?: boolean;
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
  outcome?: 'delivered' | 'unconfirmed' | 'deferred';
}

export type DeliveryFailureCode =
  | 'paste_not_confirmed'
  | 'no_active_session'
  | 'pool_capacity_exceeded'
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
  humanHeldMessageCount: number;
  /** When the delayed explicit-release affordance may be shown. */
  humanReleaseEligibleAt?: number;
  waitingMs: number;
  messages: Array<{
    id: string;
    preview: string;
    source: string;
    timestamp: number;
  }>;
}
