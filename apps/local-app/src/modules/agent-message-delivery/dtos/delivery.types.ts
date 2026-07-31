export type DeliveryKind = 'mcp.direct' | 'mcp.thread' | 'chat.user' | 'pooled';

export interface DeliveryMessage {
  readonly kind: DeliveryKind;
  readonly body: string;
  readonly source: string;
  readonly projectId: string;
  readonly senderName: string;
  readonly senderType?: 'agent' | 'guest' | 'user';
  readonly threadId?: string;
  readonly messageId?: string;
  readonly senderAgentId?: string;
  /**
   * Caller-supplied idempotency key threaded into the message pool so a retry
   * with the same key dedups instead of double-delivering (mobile sends). The
   * resulting log-entry id comes back on {@link RecipientResult.messageId}.
   */
  readonly clientMessageId?: string;
  /**
   * Tmux framing directive for `kind:'mcp.direct'` deliveries. Only applies to
   * `mcp.direct`; ignored for `'mcp.thread'`, `'chat.user'`, and `'pooled'`.
   * `'agent-banner'` (default when unset) wraps the body in the agent-oriented
   * `[This message is sent from …]` banner; `'plain'` delivers the raw body with
   * no wrapper — used for human (mobile) user turns where the banner is wrong.
   */
  readonly framing?: 'agent-banner' | 'plain';
}

export interface DeliveryPolicy {
  readonly immediate?: boolean;
  readonly submitKeys?: readonly string[];
  readonly skipConfirmation?: boolean;
  /**
   * Keys sent to the tmux session BEFORE the paste (e.g. `['Escape']` to dismiss
   * an open AskUserQuestion picker so the pasted text lands as a normal user turn
   * instead of selecting the highlighted option). Paired with `preDelayMs` to let
   * the TUI settle before the paste. Only honored on the immediate delivery path.
   */
  readonly preKeys?: readonly string[];
  /** Delay (ms) after `preKeys` and before the paste. Ignored without `preKeys`. */
  readonly preDelayMs?: number;
  /**
   * When true, delivery requires an already-active session and will NOT
   * auto-launch one. If the recipient has no active session the delivery fails
   * (RecipientResult `status:'failed'`, `error:'SESSION_NOT_RUNNING'`) instead of
   * launching. Defaults to false — existing callers keep the auto-launch
   * behavior via `ensureActiveSession`. Used by mobile deliver-only sends, where
   * launching would exceed the relay timeout and is an explicit user action.
   */
  readonly requireActiveSession?: boolean;
}

export interface DeliveryOutcome {
  readonly status: 'queued' | 'delivered' | 'failed' | 'unconfirmed' | 'partial';
  readonly results: readonly RecipientResult[];
}

export interface AgentDescriptor {
  readonly agentId: string;
  readonly agentName: string;
}

export type TeamDeliveryMode = 'lead' | 'lead_excluded' | 'no_lead';

export type AgentMessageRouting =
  | {
      readonly routingKind: 'direct';
    }
  | {
      readonly routingKind: 'group';
      readonly groupKind: 'explicit';
    }
  | {
      readonly routingKind: 'group';
      readonly groupKind: 'team';
      readonly teamId: string;
      readonly teamName: string;
      readonly teamDeliveryMode: TeamDeliveryMode;
    };

export type AgentMessageDeliveryMessage = DeliveryMessage & {
  readonly kind: 'mcp.direct';
  readonly senderAgentId: string;
};

export interface RecipientResult {
  readonly agentId: string;
  readonly status: 'queued' | 'delivered' | 'failed' | 'unconfirmed';
  readonly error?: string;
  /** Log-entry id of the enqueued (or deduped) message, when the pool returned one. */
  readonly messageId?: string;
}

export interface DeliveryStatus {
  readonly messageId: string;
  readonly status: 'queued' | 'delivered' | 'failed' | 'unconfirmed';
  readonly deliveredAt?: number;
  readonly error?: string;
}
