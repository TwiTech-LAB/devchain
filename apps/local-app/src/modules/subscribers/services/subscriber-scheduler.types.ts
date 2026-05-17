export interface SubscriberExecutionResult {
  subscriberId: string;
  subscriberName: string;
  actionType: string;
  success: boolean;
  message?: string;
  error?: string;
  durationMs: number;
  skipped?: boolean;
  skipReason?:
    | 'deleted'
    | 'disabled'
    | 'filter_not_matched'
    | 'cooldown'
    | 'action_not_found'
    | 'session_error';
}

export interface ScheduledTask {
  taskId: string;
  subscriberId: string;
  eventId?: string;
  runAt: number;
  priority: number;
  position: number;
  createdAt: string;
  agentId?: string;
  groupKey: string;
  execute: () => Promise<SubscriberExecutionResult>;
}
