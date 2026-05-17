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
}

export interface DeliveryPolicy {
  readonly immediate?: boolean;
  readonly submitKeys?: readonly string[];
  readonly skipConfirmation?: boolean;
}

export interface DeliveryOutcome {
  readonly status: 'queued' | 'delivered' | 'failed' | 'unconfirmed' | 'partial';
  readonly results: readonly RecipientResult[];
}

export interface RecipientResult {
  readonly agentId: string;
  readonly status: 'queued' | 'delivered' | 'failed' | 'unconfirmed';
  readonly error?: string;
}

export interface DeliveryStatus {
  readonly messageId: string;
  readonly status: 'queued' | 'delivered' | 'failed' | 'unconfirmed';
  readonly deliveredAt?: number;
  readonly error?: string;
}
