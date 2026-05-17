import type { BroadcastTopicEntry } from './broadcast-metadata';

type P = Record<string, unknown>;

export const broadcastRegistry: Record<string, BroadcastTopicEntry<P>[]> = {
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
    },
  ],

  // ── Chat ──
  'chat.message.created': [
    {
      topic: (p) => `chat/${p.threadId}`,
      type: 'message.created',
      payloadProjection: (p) => p.message,
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
    },
  ],
  'epic.broadcast': [
    {
      topic: (p) => `project/${p.projectId}/epics`,
      type: (p) => p.type as string,
      payloadProjection: (p) => p.data,
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
    },
    {
      topic: (p) => `project/${p.projectId}/reviews`,
      type: 'comment.created',
      payloadProjection: (p) => ({
        reviewId: p.reviewId,
        commentId: p.commentId,
      }),
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
    },
    {
      topic: (p) => `project/${p.projectId}/reviews`,
      type: 'comment.resolved',
      payloadProjection: (p) => ({
        reviewId: p.reviewId,
        commentId: p.commentId,
        status: p.status,
      }),
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
    },
    {
      topic: (p) => `project/${p.projectId}/reviews`,
      type: 'comment.updated',
      payloadProjection: (p) => ({
        reviewId: p.reviewId,
        commentId: p.commentId,
      }),
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
    },
    {
      topic: (p) => `project/${p.projectId}/reviews`,
      type: 'comment.deleted',
      payloadProjection: (p) => ({
        reviewId: p.reviewId,
        commentId: p.commentId,
      }),
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
    },
  ],
  'session.transcript.updated': [
    {
      topic: (p) => `session/${p.sessionId}/transcript`,
      type: 'updated',
      payloadProjection: (p) => ({
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
      }),
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
    },
  ],

  // ── Worktree (Option A: added to catalog) ──
  'orchestrator.worktree.changed': [
    {
      topic: 'worktrees',
      type: 'changed',
      payloadProjection: () => ({}),
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
    },
  ],
  'session.recommendation': [
    {
      topic: 'system',
      type: 'session_recommendation',
    },
  ],
};
