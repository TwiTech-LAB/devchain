/**
 * Static catalog of all known WebSocket topic/type combinations and their
 * expected client-side reaction kind. Used by the contract test to verify
 * every server-side broadcastRegistry entry has a declared client-side handler.
 *
 * Each entry declares: topic pattern, type, kind, and the hook that owns it.
 */
export interface RegistryCatalogEntry {
  topicPattern: string;
  type: string;
  kind: 'invalidate' | 'no-op' | 'custom-handler';
  owner: string;
}

export const realtimeRegistryCatalog: RegistryCatalogEntry[] = [
  // ── Activity ──
  { topicPattern: 'session/{id}', type: 'activity', kind: 'invalidate', owner: 'useChatSocket' },

  // ── Chat ──
  {
    topicPattern: 'chat/{id}',
    type: 'message.created',
    kind: 'custom-handler',
    owner: 'useChatSocket',
  },
  { topicPattern: 'chat/{id}', type: 'message.read', kind: 'no-op', owner: 'global' },

  // ── Epics ──
  {
    topicPattern: 'project/{id}/epics',
    type: 'created',
    kind: 'invalidate',
    owner: 'useBoardSync',
  },
  {
    topicPattern: 'project/{id}/epics',
    type: 'deleted',
    kind: 'invalidate',
    owner: 'useBoardSync',
  },
  {
    topicPattern: 'project/{id}/epics',
    type: 'updated',
    kind: 'invalidate',
    owner: 'useBoardSync',
  },
  {
    topicPattern: 'project/{id}/epics',
    type: 'comment.created',
    kind: 'invalidate',
    owner: 'useBoardSync',
  },

  // ── Project state ──
  {
    topicPattern: 'project/{id}/state',
    type: 'agent.created',
    kind: 'invalidate',
    owner: 'useChatSocket',
  },
  {
    topicPattern: 'project/{id}/state',
    type: 'agent.deleted',
    kind: 'invalidate',
    owner: 'useChatSocket',
  },
  {
    topicPattern: 'project/{id}/state',
    type: 'team.member.added',
    kind: 'invalidate',
    owner: 'useChatSocket',
  },
  {
    topicPattern: 'project/{id}/state',
    type: 'team.member.removed',
    kind: 'invalidate',
    owner: 'useChatSocket',
  },
  {
    topicPattern: 'project/{id}/state',
    type: 'team.config.updated',
    kind: 'invalidate',
    owner: 'useChatSocket',
  },

  // ── Reviews (review-scoped) ──
  {
    topicPattern: 'review/{id}',
    type: 'comment.created',
    kind: 'invalidate',
    owner: 'useReviewSubscription',
  },
  {
    topicPattern: 'review/{id}',
    type: 'comment.resolved',
    kind: 'invalidate',
    owner: 'useReviewSubscription',
  },
  {
    topicPattern: 'review/{id}',
    type: 'review.updated',
    kind: 'invalidate',
    owner: 'useReviewSubscription',
  },
  {
    topicPattern: 'review/{id}',
    type: 'comment.updated',
    kind: 'invalidate',
    owner: 'useReviewSubscription',
  },
  {
    topicPattern: 'review/{id}',
    type: 'comment.deleted',
    kind: 'invalidate',
    owner: 'useReviewSubscription',
  },

  // ── Reviews (project-scoped) ──
  {
    topicPattern: 'project/{id}/reviews',
    type: 'comment.created',
    kind: 'invalidate',
    owner: 'useReviewSubscription',
  },
  {
    topicPattern: 'project/{id}/reviews',
    type: 'comment.resolved',
    kind: 'invalidate',
    owner: 'useReviewSubscription',
  },
  {
    topicPattern: 'project/{id}/reviews',
    type: 'review.updated',
    kind: 'invalidate',
    owner: 'useReviewSubscription',
  },
  {
    topicPattern: 'project/{id}/reviews',
    type: 'comment.updated',
    kind: 'invalidate',
    owner: 'useReviewSubscription',
  },
  {
    topicPattern: 'project/{id}/reviews',
    type: 'comment.deleted',
    kind: 'invalidate',
    owner: 'useReviewSubscription',
  },

  // ── Transcript ──
  {
    topicPattern: 'session/{id}/transcript',
    type: 'discovered',
    kind: 'custom-handler',
    owner: 'useSessionTranscript',
  },
  {
    topicPattern: 'session/{id}/transcript',
    type: 'updated',
    kind: 'custom-handler',
    owner: 'useSessionTranscript',
  },
  {
    topicPattern: 'session/{id}/transcript',
    type: 'ended',
    kind: 'custom-handler',
    owner: 'useSessionTranscript',
  },

  // ── Worktree ──
  { topicPattern: 'worktrees', type: 'changed', kind: 'invalidate', owner: 'useWorktreeTab' },

  // ── Presence ──
  { topicPattern: 'agent/{id}', type: 'presence', kind: 'invalidate', owner: 'useChatSocket' },

  // ── Cloud ──
  { topicPattern: 'cloud', type: 'connected', kind: 'invalidate', owner: 'useCloudConnection' },
  { topicPattern: 'cloud', type: 'disconnected', kind: 'invalidate', owner: 'useCloudConnection' },
  {
    topicPattern: 'cloud',
    type: 'egress_disconnected',
    kind: 'invalidate',
    owner: 'useCloudConnection',
  },

  // ── Events stream ──
  { topicPattern: 'events/logs', type: 'event_created', kind: 'invalidate', owner: 'EventsPage' },
  {
    topicPattern: 'events/logs',
    type: 'handler_recorded',
    kind: 'invalidate',
    owner: 'EventsPage',
  },

  // ── Message activity ──
  {
    topicPattern: 'messages/activity',
    type: 'enqueued',
    kind: 'invalidate',
    owner: 'MessageActivityList',
  },
  {
    topicPattern: 'messages/activity',
    type: 'delivered',
    kind: 'invalidate',
    owner: 'MessageActivityList',
  },
  {
    topicPattern: 'messages/activity',
    type: 'unconfirmed',
    kind: 'invalidate',
    owner: 'MessageActivityList',
  },
  {
    topicPattern: 'messages/activity',
    type: 'failed',
    kind: 'invalidate',
    owner: 'MessageActivityList',
  },

  // ── Message pools ──
  {
    topicPattern: 'messages/pools',
    type: 'updated',
    kind: 'invalidate',
    owner: 'CurrentPoolsPanel',
  },

  // ── System ──
  {
    topicPattern: 'system',
    type: 'session_recommendation',
    kind: 'custom-handler',
    owner: 'Layout',
  },
  { topicPattern: 'system', type: 'ping', kind: 'custom-handler', owner: 'socket.ts' },
];
