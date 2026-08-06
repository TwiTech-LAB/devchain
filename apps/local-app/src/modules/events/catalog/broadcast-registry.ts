import type { BroadcastRegistryTopicEntry } from './broadcast-metadata';

type P = Record<string, unknown>;

/**
 * Narrow `epic.updated`'s `changes.agentId` record. `previous`/`current` are agent IDs
 * (the sibling `*Name` fields carry display names); either side may be null for a first
 * assignment or an unassignment.
 */
function agentIdChange(payload: P): { previous: string | null; current: string | null } | null {
  const changes = payload.changes;
  if (typeof changes !== 'object' || changes === null) return null;
  const change = (changes as Record<string, unknown>).agentId;
  if (typeof change !== 'object' || change === null) return null;
  const { previous, current } = change as { previous?: unknown; current?: unknown };
  return {
    previous: typeof previous === 'string' && previous.length > 0 ? previous : null,
    current: typeof current === 'string' && current.length > 0 ? current : null,
  };
}

export const broadcastRegistry: Record<string, BroadcastRegistryTopicEntry<P>[]> = {
  // ── Activity ──
  'session.activity.changed': [
    {
      topic: (p) => `session/${p.sessionId}`,
      type: 'activity',
      payloadProjection: (p) => ({
        state: p.state,
        lastActivityAt: p.lastActivityAt,
        busySince: p.busySince,
      }),
      clientReaction: { kind: 'invalidate', owner: 'useChatSocket' },
    },
  ],
  // Rides `session.starting`, not `session.started`: the latter only publishes after the
  // provider CLI has produced output and the pipeline has waited out its minimum launch
  // delay, which puts it seconds behind the agent visibly starting.
  'session.starting': [
    {
      topic: (p) => `project/${p.projectId}/agent-messages`,
      type: 'session.starting',
      payloadProjection: (p) => ({ agentId: p.agentId }),
      clientReaction: { kind: 'custom-handler', owner: 'useAgentEventBusStream' },
    },
  ],

  // ── Chat ──
  'chat.message.created': [
    {
      topic: (p) => `chat/${p.threadId}`,
      type: 'message.created',
      payloadProjection: (p) => p.message,
      clientReaction: { kind: 'custom-handler', owner: 'useChatSocket' },
      // The thread/group message body is real content — withheld on a plaintext push.
      contentBearing: true,
    },
  ],
  'chat.message.read': [
    {
      topic: (p) => `chat/${p.threadId}`,
      type: 'message.read',
      payloadProjection: (p) => ({
        messageId: p.messageId,
        agentId: p.agentId,
        readAt: p.readAt,
      }),
      clientReaction: { kind: 'no-op', owner: 'global' },
    },
  ],
  'agent.message.sent': [
    {
      topic: (p) => `project/${p.projectId}/agent-messages`,
      type: 'sent',
      shouldBroadcast: (p) => p.routingKind !== 'project',
      payloadProjection: (p) => ({
        senderAgentId: p.senderAgentId,
        routingKind: p.routingKind,
        ...(typeof p.teamId === 'string' ? { teamId: p.teamId } : {}),
        recipients: (p.recipients as Record<string, unknown>[]).map((recipient) => ({
          agentId: recipient.agentId,
          status: recipient.status,
        })),
      }),
      clientReaction: { kind: 'custom-handler', owner: 'useAgentEventBusStream' },
    },
  ],

  // ── Epics ──
  'epic.created': [
    {
      topic: (p) => `project/${p.projectId}/epics`,
      type: 'created',
      payloadProjection: (p) => ({
        epicId: p.epicId,
        projectId: p.projectId,
        title: p.title,
        statusId: p.statusId,
        agentId: p.agentId ?? null,
        parentId: p.parentId ?? null,
      }),
      clientReaction: { kind: 'invalidate', owner: 'useBoardSync' },
    },
  ],
  'epic.deleted': [
    {
      topic: (p) => `project/${p.projectId}/epics`,
      type: 'deleted',
      payloadProjection: (p) => ({
        epicId: p.epicId,
        projectId: p.projectId,
        title: p.title,
        parentId: p.parentId ?? null,
      }),
      clientReaction: { kind: 'invalidate', owner: 'useBoardSync' },
    },
  ],
  'epic.updated': [
    {
      topic: (p) => `project/${p.projectId}/epics`,
      type: 'updated',
      payloadProjection: (p) => ({
        epicId: p.epicId,
        projectId: p.projectId,
        version: p.version,
        epicTitle: p.epicTitle,
        changes: p.changes,
      }),
      clientReaction: { kind: 'invalidate', owner: 'useBoardSync' },
    },
    // Second entry: the event-bus visualization. `epic.updated` fires for every field
    // change, so `shouldBroadcast` keeps status/title/parent edits off this topic and
    // only an actual re-assignment reaches it. Projects agent IDs only — never the
    // resolved display names the domain event also carries.
    {
      topic: (p) => `project/${p.projectId}/agent-messages`,
      type: 'epic.assignment',
      shouldBroadcast: (p) => {
        const change = agentIdChange(p);
        return change !== null && change.current !== null && change.current !== change.previous;
      },
      payloadProjection: (p) => {
        const change = agentIdChange(p);
        return { fromAgentId: change?.previous ?? null, toAgentId: change?.current ?? null };
      },
      clientReaction: { kind: 'custom-handler', owner: 'useAgentEventBusStream' },
    },
  ],
  'epic.comment.created': [
    {
      topic: (p) => `project/${p.projectId}/epics`,
      type: 'comment.created',
      payloadProjection: (p) => ({
        commentId: p.commentId,
        epicId: p.epicId,
        authorName: p.authorName,
        content: p.content,
      }),
      clientReaction: { kind: 'invalidate', owner: 'useBoardSync' },
    },
  ],
  'epic.broadcast': [
    {
      topic: (p) => `project/${p.projectId}/epics`,
      type: (p) => String(p.type),
      payloadProjection: (p) => p.data,
      clientReaction: { kind: 'invalidate', owner: 'useBoardSync' },
    },
  ],
  'scheduled_epic.executed': [
    {
      topic: (p) => `project/${p.projectId}/scheduled-epics`,
      type: 'executed',
      payloadProjection: (p) => ({
        projectId: p.projectId,
        scheduleId: p.scheduleId,
        runId: p.runId,
        scheduleName: p.scheduleName,
        triggerSource: p.triggerSource,
        status: p.status,
        plannedFor: p.plannedFor,
        finishedAt: p.finishedAt,
        lagMs: p.lagMs,
        createdEpicId: p.createdEpicId,
        createdEpicTitle: p.createdEpicTitle,
        errorCode: p.errorCode,
        errorMessage: p.errorMessage,
      }),
      clientReaction: { kind: 'invalidate', owner: 'useBoardSync' },
    },
  ],

  // ── Claude hooks: AskUserQuestion (normalized questions only — never raw toolInput) ──
  'claude.hooks.ask_user_question.pending': [
    {
      topic: (p) => `session/${p.sessionId}`,
      type: 'ask_user_question.pending',
      payloadProjection: (p) => ({
        toolUseId: p.toolUseId,
        questions: p.questions,
      }),
      clientReaction: { kind: 'no-op', owner: 'global' },
      // The question text is real content — withheld on a plaintext push.
      contentBearing: true,
    },
  ],
  'claude.hooks.ask_user_question.resolved': [
    {
      topic: (p) => `session/${p.sessionId}`,
      type: 'ask_user_question.resolved',
      payloadProjection: (p) => ({
        toolUseId: p.toolUseId,
      }),
      clientReaction: { kind: 'no-op', owner: 'global' },
    },
  ],

  // ── Project state ──
  'agent.created': [
    {
      topic: (p) => `project/${p.projectId}/state`,
      type: 'agent.created',
      payloadProjection: (p) => ({
        agentId: p.agentId,
        agentName: p.agentName,
      }),
      clientReaction: { kind: 'invalidate', owner: 'useChatSocket' },
      // Carries the agent NAME — real content, withheld on a plaintext push.
      contentBearing: true,
    },
  ],
  'agent.deleted': [
    {
      topic: (p) => `project/${p.projectId}/state`,
      type: 'agent.deleted',
      payloadProjection: (p) => ({
        agentId: p.agentId,
        agentName: p.agentName,
        teamId: p.teamId ?? null,
        teamName: p.teamName ?? null,
      }),
      clientReaction: { kind: 'invalidate', owner: 'useChatSocket' },
      // Carries agent/team NAMES — real content, withheld on a plaintext push.
      contentBearing: true,
    },
  ],
  'team.member.added': [
    {
      topic: (p) => `project/${p.projectId}/state`,
      type: 'team.member.added',
      payloadProjection: (p) => ({
        teamId: p.teamId,
        teamName: p.teamName,
        addedAgentId: p.addedAgentId,
        addedAgentName: p.addedAgentName,
      }),
      clientReaction: { kind: 'invalidate', owner: 'useChatSocket' },
    },
  ],
  'team.member.removed': [
    {
      topic: (p) => `project/${p.projectId}/state`,
      type: 'team.member.removed',
      payloadProjection: (p) => ({
        teamId: p.teamId,
        teamName: p.teamName,
        removedAgentId: p.removedAgentId,
        removedAgentName: p.removedAgentName,
      }),
      clientReaction: { kind: 'invalidate', owner: 'useChatSocket' },
    },
  ],
  'team.config.updated': [
    {
      topic: (p) => `project/${p.projectId}/state`,
      type: 'team.config.updated',
      payloadProjection: (p) => ({
        teamId: p.teamId,
        teamName: p.teamName,
        previous: p.previous,
        current: p.current,
      }),
      clientReaction: { kind: 'invalidate', owner: 'useChatSocket' },
    },
  ],

  // ── Reviews (dual-topic fan-out) ──
  'review.comment.created': [
    {
      topic: (p) => `review/${p.reviewId}`,
      type: 'comment.created',
      payloadProjection: (p) => ({
        commentId: p.commentId,
        reviewId: p.reviewId,
        filePath: p.filePath,
        lineStart: p.lineStart,
        lineEnd: p.lineEnd,
        commentType: p.commentType,
        status: p.status,
        authorType: p.authorType,
        authorAgentId: p.authorAgentId,
        parentId: p.parentId,
      }),
      clientReaction: { kind: 'invalidate', owner: 'useReviewSubscription' },
    },
    {
      topic: (p) => `project/${p.projectId}/reviews`,
      type: 'comment.created',
      payloadProjection: (p) => ({
        reviewId: p.reviewId,
        commentId: p.commentId,
      }),
      clientReaction: { kind: 'invalidate', owner: 'useReviewSubscription' },
    },
  ],
  'review.comment.resolved': [
    {
      topic: (p) => `review/${p.reviewId}`,
      type: 'comment.resolved',
      payloadProjection: (p) => ({
        commentId: p.commentId,
        reviewId: p.reviewId,
        status: p.status,
        version: p.version,
      }),
      clientReaction: { kind: 'invalidate', owner: 'useReviewSubscription' },
    },
    {
      topic: (p) => `project/${p.projectId}/reviews`,
      type: 'comment.resolved',
      payloadProjection: (p) => ({
        reviewId: p.reviewId,
        commentId: p.commentId,
        status: p.status,
      }),
      clientReaction: { kind: 'invalidate', owner: 'useReviewSubscription' },
    },
  ],
  'review.updated': [
    {
      topic: (p) => `review/${p.reviewId}`,
      type: 'review.updated',
      payloadProjection: (p) => ({
        reviewId: p.reviewId,
        version: p.version,
        title: p.title,
        changes: p.changes,
      }),
      clientReaction: { kind: 'invalidate', owner: 'useReviewSubscription' },
    },
    {
      topic: (p) => `project/${p.projectId}/reviews`,
      type: 'review.updated',
      payloadProjection: (p) => ({
        reviewId: p.reviewId,
        version: p.version,
        title: p.title,
        changes: p.changes,
      }),
      clientReaction: { kind: 'invalidate', owner: 'useReviewSubscription' },
    },
  ],
  'review.comment.updated': [
    {
      topic: (p) => `review/${p.reviewId}`,
      type: 'comment.updated',
      payloadProjection: (p) => ({
        commentId: p.commentId,
        reviewId: p.reviewId,
        content: p.content,
        version: p.version,
        editedAt: p.editedAt,
        filePath: p.filePath,
      }),
      clientReaction: { kind: 'invalidate', owner: 'useReviewSubscription' },
    },
    {
      topic: (p) => `project/${p.projectId}/reviews`,
      type: 'comment.updated',
      payloadProjection: (p) => ({
        reviewId: p.reviewId,
        commentId: p.commentId,
      }),
      clientReaction: { kind: 'invalidate', owner: 'useReviewSubscription' },
    },
  ],
  'review.comment.deleted': [
    {
      topic: (p) => `review/${p.reviewId}`,
      type: 'comment.deleted',
      payloadProjection: (p) => ({
        commentId: p.commentId,
        reviewId: p.reviewId,
        filePath: p.filePath,
        parentId: p.parentId,
      }),
      clientReaction: { kind: 'invalidate', owner: 'useReviewSubscription' },
    },
    {
      topic: (p) => `project/${p.projectId}/reviews`,
      type: 'comment.deleted',
      payloadProjection: (p) => ({
        reviewId: p.reviewId,
        commentId: p.commentId,
      }),
      clientReaction: { kind: 'invalidate', owner: 'useReviewSubscription' },
    },
  ],

  // ── Transcript ──
  'session.transcript.discovered': [
    {
      topic: (p) => `session/${p.sessionId}/transcript`,
      type: 'discovered',
      payloadProjection: (p) => ({
        sessionId: p.sessionId,
        providerName: p.providerName,
      }),
      clientReaction: { kind: 'custom-handler', owner: 'useSessionTranscript' },
    },
  ],
  'session.providerSessionId.discovered': [
    {
      topic: (p) => `session/${p.sessionId}/transcript`,
      type: 'providerSessionId.discovered',
      payloadProjection: (p) => ({
        sessionId: p.sessionId,
        providerName: p.providerName,
      }),
      clientReaction: { kind: 'custom-handler', owner: 'useSessionTranscript' },
    },
  ],
  'session.transcript.updated': [
    {
      topic: (p) => `session/${p.sessionId}/transcript`,
      type: 'updated',
      payloadProjection: (p) =>
        p.kind === 'full-refetch-required'
          ? {
              kind: p.kind,
              sessionId: p.sessionId,
              sourceChangeKind: p.sourceChangeKind,
            }
          : {
              kind: p.kind,
              sessionId: p.sessionId,
              newMessageCount: p.newMessageCount,
              metrics: p.metrics,
              cursor: p.cursor,
              prevCursor: p.prevCursor,
              replaceFromChunkIndex: p.replaceFromChunkIndex,
              newChunkIds: p.newChunkIds,
              totalChunkCount: p.totalChunkCount,
              deltaChunks: p.deltaChunks,
              deltaMessages: p.deltaMessages,
            },
      clientReaction: { kind: 'custom-handler', owner: 'useSessionTranscript' },
      // `deltaChunks`/`deltaMessages` carry transcript body text — real content,
      // withheld on a plaintext push (mobile recovers via the per-topic catch-up RPC).
      contentBearing: true,
    },
  ],
  'session.transcript.ended': [
    {
      topic: (p) => `session/${p.sessionId}/transcript`,
      type: 'ended',
      payloadProjection: (p) => ({
        sessionId: p.sessionId,
        finalMetrics: p.finalMetrics,
        endReason: p.endReason,
      }),
      clientReaction: { kind: 'custom-handler', owner: 'useSessionTranscript' },
    },
  ],
  'session.runtime-context.updated': [
    {
      topic: (p) => `session/${p.sessionId}/runtime-context`,
      type: 'updated',
      payloadProjection: (p) => ({
        sessionId: p.sessionId,
      }),
      clientReaction: { kind: 'custom-handler', owner: 'session metrics hooks' },
    },
  ],

  // ── Worktree (Option A: added to catalog) ──
  'orchestrator.worktree.changed': [
    {
      topic: 'worktrees',
      type: 'changed',
      payloadProjection: () => ({}),
      clientReaction: { kind: 'invalidate', owner: 'useWorktreeTab' },
    },
  ],

  // ── Runtime signals ──
  'session.presence.changed': [
    {
      topic: (p) => `agent/${p.agentId}`,
      type: 'presence',
      payloadProjection: (p) => ({
        online: p.online,
        sessionId: p.sessionId,
        agentId: p.agentId,
      }),
      clientReaction: { kind: 'invalidate', owner: 'useChatSocket' },
    },
  ],
  'session.recommendation': [
    {
      topic: 'system',
      type: 'session_recommendation',
      clientReaction: { kind: 'custom-handler', owner: 'Layout' },
    },
  ],
};
