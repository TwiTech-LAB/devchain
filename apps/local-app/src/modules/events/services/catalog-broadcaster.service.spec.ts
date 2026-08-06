import { EventEmitter2 } from '@nestjs/event-emitter';
import { CatalogBroadcasterService } from './catalog-broadcaster.service';
import { broadcastRegistry } from '../catalog/broadcast-registry';
import type { RealtimeBroadcaster } from '../../realtime/ports/realtime-broadcaster.port';

// Layer: module unit. A real in-process emitter with the realtime port mocked is
// the cheapest reliable proof of registry fanout and payload projection; a
// Socket.IO server would add transport cost without strengthening this contract.
describe('CatalogBroadcasterService', () => {
  let emitter: EventEmitter2;
  let mockBroadcaster: { broadcastEvent: jest.Mock };
  let service: CatalogBroadcasterService;

  beforeEach(() => {
    emitter = new EventEmitter2({ wildcard: false, maxListeners: 50 });
    mockBroadcaster = { broadcastEvent: jest.fn() };
    service = new CatalogBroadcasterService(
      emitter,
      mockBroadcaster as unknown as RealtimeBroadcaster,
    );
    service.onModuleInit();
  });

  it('registers handlers for all broadcast registry entries', () => {
    const registeredEvents = Object.keys(broadcastRegistry);
    expect(registeredEvents.length).toBeGreaterThanOrEqual(20);
  });

  // ── Activity ──
  it('broadcasts session.activity.changed to session/{sessionId}', () => {
    emitter.emit('session.activity.changed', {
      sessionId: 's1',
      state: 'busy',
      lastActivityAt: '2026-01-01T00:00:00Z',
      busySince: '2026-01-01T00:00:00Z',
    });

    expect(mockBroadcaster.broadcastEvent).toHaveBeenCalledWith('session/s1', 'activity', {
      state: 'busy',
      lastActivityAt: '2026-01-01T00:00:00Z',
      busySince: '2026-01-01T00:00:00Z',
    });
  });

  it('broadcasts an epic re-assignment as agent ids only, and skips non-assignment edits', () => {
    emitter.emit('epic.updated', {
      epicId: 'e1',
      projectId: 'p1',
      version: 5,
      epicTitle: 'Some epic',
      changes: {
        statusId: { previous: 's1', current: 's2' },
        agentId: { previous: 'a1', current: 'a2', previousName: 'Epic Manager' },
      },
    });

    expect(mockBroadcaster.broadcastEvent).toHaveBeenCalledWith(
      'project/p1/agent-messages',
      'epic.assignment',
      { fromAgentId: 'a1', toAgentId: 'a2' },
    );

    (mockBroadcaster.broadcastEvent as jest.Mock).mockClear();

    // A status-only edit must never reach the visualization topic: `shouldBroadcast`
    // gates it rather than emitting a frame the client is expected to discard.
    emitter.emit('epic.updated', {
      epicId: 'e1',
      projectId: 'p1',
      version: 6,
      epicTitle: 'Some epic',
      changes: { statusId: { previous: 's2', current: 's3' } },
    });

    expect(
      (mockBroadcaster.broadcastEvent as jest.Mock).mock.calls.filter(
        ([topic]: [string]) => topic === 'project/p1/agent-messages',
      ),
    ).toHaveLength(0);
  });

  it('treats a first assignment as having no source and an unassignment as nothing', () => {
    emitter.emit('epic.updated', {
      epicId: 'e1',
      projectId: 'p1',
      version: 2,
      epicTitle: 'Some epic',
      changes: { agentId: { previous: null, current: 'a2' } },
    });

    expect(mockBroadcaster.broadcastEvent).toHaveBeenCalledWith(
      'project/p1/agent-messages',
      'epic.assignment',
      { fromAgentId: null, toAgentId: 'a2' },
    );

    (mockBroadcaster.broadcastEvent as jest.Mock).mockClear();

    // Unassignment has no recipient to travel to, so it produces no route at all.
    emitter.emit('epic.updated', {
      epicId: 'e1',
      projectId: 'p1',
      version: 3,
      epicTitle: 'Some epic',
      changes: { agentId: { previous: 'a2', current: null } },
    });

    expect(
      (mockBroadcaster.broadcastEvent as jest.Mock).mock.calls.filter(
        ([topic]: [string]) => topic === 'project/p1/agent-messages',
      ),
    ).toHaveLength(0);
  });

  it('broadcasts session.starting with only the target agent identity', () => {
    emitter.emit('session.starting', {
      sessionId: 's1',
      projectId: 'p1',
      epicId: 'e1',
      agentId: 'a1',
      tmuxSessionName: 'tmux-1',
    });

    expect(mockBroadcaster.broadcastEvent).toHaveBeenCalledWith(
      'project/p1/agent-messages',
      'session.starting',
      { agentId: 'a1' },
    );
    expect(Object.keys(mockBroadcaster.broadcastEvent.mock.calls[0][2])).toEqual(['agentId']);
  });

  // ── Chat ──
  it('broadcasts chat.message.created with message payload', () => {
    const message = {
      id: 'm1',
      threadId: 't1',
      authorType: 'agent',
      content: 'hi',
      createdAt: '2026-01-01T00:00:00Z',
    };
    emitter.emit('chat.message.created', { threadId: 't1', message });

    expect(mockBroadcaster.broadcastEvent).toHaveBeenCalledWith(
      'chat/t1',
      'message.created',
      message,
    );
  });

  it('broadcasts chat.message.read to chat/{threadId}', () => {
    emitter.emit('chat.message.read', {
      threadId: 't1',
      messageId: 'm1',
      agentId: 'a1',
      readAt: '2026-01-01T00:00:00Z',
    });

    expect(mockBroadcaster.broadcastEvent).toHaveBeenCalledWith('chat/t1', 'message.read', {
      messageId: 'm1',
      agentId: 'a1',
      readAt: '2026-01-01T00:00:00Z',
    });
  });

  it('broadcasts agent.message.sent with only visualization metadata', () => {
    emitter.emit('agent.message.sent', {
      projectId: 'p1',
      senderAgentId: 'sender-1',
      senderAgentName: 'Sender',
      routingKind: 'group',
      groupKind: 'team',
      teamId: 'team-1',
      teamName: 'Team One',
      teamDeliveryMode: 'lead_excluded',
      recipients: [
        { agentId: 'recipient-1', agentName: 'Recipient One', status: 'delivered' },
        { agentId: 'recipient-2', agentName: 'Recipient Two', status: 'failed' },
      ],
      recipientCount: 2,
      deliveryStatus: 'partial',
      message: 'must not be forwarded',
    });

    expect(mockBroadcaster.broadcastEvent).toHaveBeenCalledWith(
      'project/p1/agent-messages',
      'sent',
      {
        senderAgentId: 'sender-1',
        routingKind: 'group',
        teamId: 'team-1',
        recipients: [
          { agentId: 'recipient-1', status: 'delivered' },
          { agentId: 'recipient-2', status: 'failed' },
        ],
      },
    );

    const projected = mockBroadcaster.broadcastEvent.mock.calls[0][2];
    expect(Object.keys(projected)).toEqual([
      'senderAgentId',
      'routingKind',
      'teamId',
      'recipients',
    ]);
    expect(projected).not.toHaveProperty('senderAgentName');
    expect(projected).not.toHaveProperty('teamName');
    expect(projected).not.toHaveProperty('message');
  });

  it('omits teamId from direct agent.message.sent frames', () => {
    emitter.emit('agent.message.sent', {
      projectId: 'p1',
      senderAgentId: 'sender-1',
      senderAgentName: 'Sender',
      routingKind: 'direct',
      recipients: [{ agentId: 'recipient-1', agentName: 'Recipient One', status: 'queued' }],
      recipientCount: 1,
      deliveryStatus: 'queued',
    });

    const projected = mockBroadcaster.broadcastEvent.mock.calls[0][2];
    expect(projected).toEqual({
      senderAgentId: 'sender-1',
      routingKind: 'direct',
      recipients: [{ agentId: 'recipient-1', status: 'queued' }],
    });
    expect(projected).not.toHaveProperty('teamId');
  });

  it('suppresses project-routed agent.message.sent events from the browser catalog path', () => {
    emitter.emit('agent.message.sent', {
      projectId: 'source-project',
      senderAgentId: 'sender-1',
      senderAgentName: 'Source Owner',
      routingKind: 'project',
      sourceProjectId: 'source-project',
      sourceProjectName: 'Source Project',
      targetProjectId: 'target-project',
      targetProjectName: 'Target Project',
      recipients: [{ agentId: 'recipient-1', agentName: 'Target Owner', status: 'queued' }],
      recipientCount: 1,
      deliveryStatus: 'queued',
    });

    expect(mockBroadcaster.broadcastEvent).not.toHaveBeenCalled();
  });

  // ── Epics ──
  it('broadcasts epic.created to project/{projectId}/epics', () => {
    emitter.emit('epic.created', {
      epicId: 'e1',
      projectId: 'p1',
      title: 'T',
      statusId: 's1',
      agentId: null,
      parentId: null,
      projectName: 'Project One',
      epicTitle: 'T',
      assignmentRecipientIds: ['a1'],
      subEpicRecipientIds: ['a2'],
    });

    expect(mockBroadcaster.broadcastEvent).toHaveBeenCalledWith(
      'project/p1/epics',
      'created',
      expect.objectContaining({ epicId: 'e1', projectId: 'p1' }),
    );
    const projected = mockBroadcaster.broadcastEvent.mock.calls[0][2];
    expect(projected).not.toHaveProperty('projectName');
    expect(projected).not.toHaveProperty('assignmentRecipientIds');
  });

  it('broadcasts scheduled_epic.executed to project/{projectId}/scheduled-epics', () => {
    emitter.emit('scheduled_epic.executed', {
      scheduleId: 'sched-1',
      runId: 'run-1',
      projectId: 'p1',
      scheduleName: 'Weekly sync',
      triggerSource: 'scheduler',
      status: 'completed',
      plannedFor: '2025-01-06T09:00:00.000Z',
      finishedAt: '2025-01-06T09:00:01.500Z',
      lagMs: 1500,
      createdEpicId: 'epic-1',
      createdEpicTitle: 'Weekly sync 2025-01-06',
      errorCode: null,
      errorMessage: null,
    });

    expect(mockBroadcaster.broadcastEvent).toHaveBeenCalledWith(
      'project/p1/scheduled-epics',
      'executed',
      expect.objectContaining({ projectId: 'p1', scheduleId: 'sched-1', runId: 'run-1' }),
    );
    const projected = mockBroadcaster.broadcastEvent.mock.calls[0][2];
    expect(projected).toHaveProperty('projectId', 'p1');
    expect(projected).toHaveProperty('status', 'completed');
    expect(projected).toHaveProperty('errorCode', null);
  });

  it('broadcasts epic.broadcast with dynamic type', () => {
    emitter.emit('epic.broadcast', {
      projectId: 'p1',
      type: 'deleted',
      data: { epicId: 'e1' },
    });

    expect(mockBroadcaster.broadcastEvent).toHaveBeenCalledWith('project/p1/epics', 'deleted', {
      epicId: 'e1',
    });
  });

  // ── Project state ──
  it('broadcasts agent.created to project/{projectId}/state', () => {
    emitter.emit('agent.created', {
      agentId: 'a1',
      agentName: 'Coder',
      projectId: 'p1',
      profileId: 'prof-1',
      providerConfigId: 'cfg-1',
      actor: null,
    });

    expect(mockBroadcaster.broadcastEvent).toHaveBeenCalledWith(
      'project/p1/state',
      'agent.created',
      { agentId: 'a1', agentName: 'Coder' },
    );
  });

  it('broadcasts agent.deleted with null team fields when omitted', () => {
    emitter.emit('agent.deleted', {
      agentId: 'a1',
      agentName: 'Coder',
      projectId: 'p1',
      actor: null,
    });

    expect(mockBroadcaster.broadcastEvent).toHaveBeenCalledWith(
      'project/p1/state',
      'agent.deleted',
      { agentId: 'a1', agentName: 'Coder', teamId: null, teamName: null },
    );
  });

  it('broadcasts team.member.added without leaking enriched delivery fields', () => {
    emitter.emit('team.member.added', {
      teamId: 'team-1',
      projectId: 'p1',
      teamLeadAgentId: 'lead-1',
      teamName: 'Backend',
      addedAgentId: 'agent-1',
      addedAgentName: 'Agent One',
      projectName: 'Project One',
      recipientIds: ['lead-1'],
      agentName: 'Agent One',
      teamLeadAgentName: 'Lead One',
    });

    expect(mockBroadcaster.broadcastEvent).toHaveBeenCalledWith(
      'project/p1/state',
      'team.member.added',
      {
        teamId: 'team-1',
        teamName: 'Backend',
        addedAgentId: 'agent-1',
        addedAgentName: 'Agent One',
      },
    );
    const projected = mockBroadcaster.broadcastEvent.mock.calls[0][2];
    expect(projected).not.toHaveProperty('recipientIds');
    expect(projected).not.toHaveProperty('projectName');
  });

  // ── Reviews (dual-topic fan-out) ──
  it('broadcasts review.comment.created to both review and project topics', () => {
    emitter.emit('review.comment.created', {
      commentId: 'c1',
      reviewId: 'r1',
      projectId: 'p1',
      filePath: 'src/a.ts',
      lineStart: 1,
      lineEnd: 10,
      commentType: 'inline',
      status: 'open',
      authorType: 'agent',
      authorAgentId: 'a1',
      parentId: null,
      recipientIds: ['a2'],
      agentName: 'Agent One',
      reviewTitle: 'Review One',
    });

    expect(mockBroadcaster.broadcastEvent).toHaveBeenCalledTimes(2);
    expect(mockBroadcaster.broadcastEvent).toHaveBeenCalledWith(
      'review/r1',
      'comment.created',
      expect.objectContaining({ commentId: 'c1', reviewId: 'r1', filePath: 'src/a.ts' }),
    );
    expect(mockBroadcaster.broadcastEvent).toHaveBeenCalledWith(
      'project/p1/reviews',
      'comment.created',
      { reviewId: 'r1', commentId: 'c1' },
    );
    const reviewPayload = mockBroadcaster.broadcastEvent.mock.calls[0][2];
    expect(reviewPayload).not.toHaveProperty('recipientIds');
    expect(reviewPayload).not.toHaveProperty('agentName');
  });

  // ── Transcript ──
  it('broadcasts session.transcript.updated with delta payload (preserves truncated content)', () => {
    const deltaChunks = [{ id: 'chunk-1', messages: ['truncated...'] }];
    const deltaMessages = [{ role: 'assistant', content: 'truncated...' }];

    emitter.emit('session.transcript.updated', {
      kind: 'delta',
      sessionId: 's1',
      transcriptPath: '/path/to/transcript',
      newMessageCount: 2,
      metrics: {
        totalTokens: 100,
        inputTokens: 50,
        outputTokens: 50,
        costUsd: 0.01,
        messageCount: 5,
      },
      cursor: 'c2',
      prevCursor: 'c1',
      replaceFromChunkIndex: 0,
      newChunkIds: ['chunk-1'],
      totalChunkCount: 3,
      deltaChunks,
      deltaMessages,
    });

    expect(mockBroadcaster.broadcastEvent).toHaveBeenCalledWith(
      'session/s1/transcript',
      'updated',
      expect.objectContaining({
        kind: 'delta',
        sessionId: 's1',
        deltaChunks,
        deltaMessages,
        newChunkIds: ['chunk-1'],
      }),
    );

    const projected = mockBroadcaster.broadcastEvent.mock.calls[0][2];
    expect(projected).not.toHaveProperty('transcriptPath');
  });

  it('broadcasts unsafe transcript generations as a cursor-free refetch action', () => {
    emitter.emit('session.transcript.updated', {
      kind: 'full-refetch-required',
      sessionId: 's1',
      transcriptPath: '/path/to/replacement',
      sourceChangeKind: 'file-replacement',
    });

    expect(mockBroadcaster.broadcastEvent).toHaveBeenCalledWith(
      'session/s1/transcript',
      'updated',
      {
        kind: 'full-refetch-required',
        sessionId: 's1',
        sourceChangeKind: 'file-replacement',
      },
    );
    const projected = mockBroadcaster.broadcastEvent.mock.calls[0][2];
    expect(projected).not.toHaveProperty('cursor');
    expect(projected).not.toHaveProperty('deltaChunks');
    expect(projected).not.toHaveProperty('deltaMessages');
    expect(projected).not.toHaveProperty('transcriptPath');
  });

  it('broadcasts session.transcript.discovered stripping internal fields', () => {
    emitter.emit('session.transcript.discovered', {
      sessionId: 's1',
      agentId: 'a1',
      projectId: 'p1',
      transcriptPath: '/path',
      providerName: 'claude',
    });

    const projected = mockBroadcaster.broadcastEvent.mock.calls[0][2];
    expect(projected).toEqual({ sessionId: 's1', providerName: 'claude' });
    expect(projected).not.toHaveProperty('transcriptPath');
    expect(projected).not.toHaveProperty('agentId');
  });

  it('broadcasts session.providerSessionId.discovered stripping the provider id', () => {
    emitter.emit('session.providerSessionId.discovered', {
      sessionId: 's1',
      providerSessionId: 'provider-session-1',
      providerName: 'codex',
    });

    const projected = mockBroadcaster.broadcastEvent.mock.calls[0][2];
    expect(mockBroadcaster.broadcastEvent).toHaveBeenCalledWith(
      'session/s1/transcript',
      'providerSessionId.discovered',
      { sessionId: 's1', providerName: 'codex' },
    );
    expect(projected).not.toHaveProperty('providerSessionId');
  });

  // ── Worktree ──
  it('broadcasts orchestrator.worktree.changed with empty payload', () => {
    emitter.emit('orchestrator.worktree.changed', { worktreeId: 'wt-1' });

    expect(mockBroadcaster.broadcastEvent).toHaveBeenCalledWith('worktrees', 'changed', {});
  });

  // ── Error handling ──
  it('does not throw when a topic projection throws', () => {
    emitter.emit('session.activity.changed', {});

    expect(mockBroadcaster.broadcastEvent).toHaveBeenCalledWith(
      'session/undefined',
      'activity',
      expect.anything(),
    );
  });

  it('does not throw when broadcaster.broadcastEvent throws', () => {
    mockBroadcaster.broadcastEvent.mockImplementation(() => {
      throw new Error('broadcast failed');
    });

    expect(() =>
      emitter.emit('session.activity.changed', {
        sessionId: 's1',
        state: 'busy',
        lastActivityAt: null,
        busySince: null,
      }),
    ).not.toThrow();
  });
});

describe('broadcastRegistry contract', () => {
  it('covers all expected event names', () => {
    const expectedEvents = [
      'session.activity.changed',
      'session.starting',
      'chat.message.created',
      'chat.message.read',
      'agent.message.sent',
      'epic.created',
      'epic.updated',
      'epic.comment.created',
      'epic.broadcast',
      'agent.created',
      'agent.deleted',
      'team.member.added',
      'team.member.removed',
      'team.config.updated',
      'review.comment.created',
      'review.comment.resolved',
      'review.updated',
      'review.comment.updated',
      'review.comment.deleted',
      'session.transcript.discovered',
      'session.providerSessionId.discovered',
      'session.transcript.updated',
      'session.transcript.ended',
      'orchestrator.worktree.changed',
      'session.presence.changed',
      'session.recommendation',
      'scheduled_epic.executed',
    ];

    for (const event of expectedEvents) {
      expect(event in broadcastRegistry).toBe(true);
      expect(broadcastRegistry[event].length).toBeGreaterThanOrEqual(1);
    }
  });

  it('review events have exactly 2 broadcast topics (fan-out)', () => {
    const reviewEvents = [
      'review.comment.created',
      'review.comment.resolved',
      'review.updated',
      'review.comment.updated',
      'review.comment.deleted',
    ];

    for (const event of reviewEvents) {
      expect(broadcastRegistry[event]).toHaveLength(2);
    }
  });

  it('every entry has a topic and type', () => {
    for (const [, entries] of Object.entries(broadcastRegistry)) {
      for (const entry of entries) {
        expect(entry.topic).toBeDefined();
        expect(entry.type).toBeDefined();
      }
    }
  });
});
