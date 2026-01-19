import { isPendingComment, type CommentThread, type ReviewComment } from './reviews';

// Base time for timestamp testing (2025-01-01T12:00:00.000Z)
const BASE_TIME = new Date('2025-01-01T12:00:00.000Z');

// Helper to create timestamps relative to base time
function timestamp(minutesOffset: number): string {
  return new Date(BASE_TIME.getTime() + minutesOffset * 60 * 1000).toISOString();
}

// Helper to create a mock comment
function createComment(overrides: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id: 'comment-1',
    reviewId: 'review-1',
    filePath: 'src/file.ts',
    parentId: null,
    lineStart: 10,
    lineEnd: 10,
    side: 'new',
    content: 'Test comment',
    commentType: 'comment',
    status: 'open',
    authorType: 'user',
    authorAgentId: null,
    authorAgentName: null,
    targetAgents: [],
    version: 1,
    editedAt: null,
    createdAt: timestamp(0),
    updatedAt: timestamp(0),
    ...overrides,
  };
}

describe('isPendingComment', () => {
  describe('returns false', () => {
    it('when comment is not a root comment (has parentId)', () => {
      const thread: CommentThread = {
        comment: createComment({
          parentId: 'parent-123',
          targetAgents: [{ agentId: 'agent-1', name: 'Coder' }],
        }),
        replies: [],
      };
      expect(isPendingComment(thread)).toBe(false);
    });

    it('when comment status is not open (resolved)', () => {
      const thread: CommentThread = {
        comment: createComment({
          status: 'resolved',
          targetAgents: [{ agentId: 'agent-1', name: 'Coder' }],
        }),
        replies: [],
      };
      expect(isPendingComment(thread)).toBe(false);
    });

    it('when comment status is not open (wont_fix)', () => {
      const thread: CommentThread = {
        comment: createComment({
          status: 'wont_fix',
          targetAgents: [{ agentId: 'agent-1', name: 'Coder' }],
        }),
        replies: [],
      };
      expect(isPendingComment(thread)).toBe(false);
    });

    it('when comment has no targetAgents', () => {
      const thread: CommentThread = {
        comment: createComment({
          status: 'open',
          targetAgents: [],
        }),
        replies: [],
      };
      expect(isPendingComment(thread)).toBe(false);
    });

    it('when a target agent has replied after user message (user → agent)', () => {
      // User posts at T0, agent replies at T5 → NOT pending (agent addressed the comment)
      const thread: CommentThread = {
        comment: createComment({
          status: 'open',
          createdAt: timestamp(0),
          targetAgents: [
            { agentId: 'agent-1', name: 'Coder' },
            { agentId: 'agent-2', name: 'Reviewer' },
          ],
        }),
        replies: [
          createComment({
            id: 'reply-1',
            parentId: 'comment-1',
            authorType: 'agent',
            authorAgentId: 'agent-1',
            authorAgentName: 'Coder',
            createdAt: timestamp(5),
          }),
        ],
      };
      expect(isPendingComment(thread)).toBe(false);
    });

    it('when all target agents have replied after user message', () => {
      // User posts at T0, agents reply at T5 and T10 → NOT pending
      const thread: CommentThread = {
        comment: createComment({
          status: 'open',
          createdAt: timestamp(0),
          targetAgents: [
            { agentId: 'agent-1', name: 'Coder' },
            { agentId: 'agent-2', name: 'Reviewer' },
          ],
        }),
        replies: [
          createComment({
            id: 'reply-1',
            parentId: 'comment-1',
            authorType: 'agent',
            authorAgentId: 'agent-1',
            authorAgentName: 'Coder',
            createdAt: timestamp(5),
          }),
          createComment({
            id: 'reply-2',
            parentId: 'comment-1',
            authorType: 'agent',
            authorAgentId: 'agent-2',
            authorAgentName: 'Reviewer',
            createdAt: timestamp(10),
          }),
        ],
      };
      expect(isPendingComment(thread)).toBe(false);
    });
  });

  describe('returns true', () => {
    it('when root comment is open with targets and no agent replies', () => {
      const thread: CommentThread = {
        comment: createComment({
          status: 'open',
          targetAgents: [{ agentId: 'agent-1', name: 'Coder' }],
        }),
        replies: [],
      };
      expect(isPendingComment(thread)).toBe(true);
    });

    it('when root comment has targets but only user replies (not agent)', () => {
      const thread: CommentThread = {
        comment: createComment({
          status: 'open',
          targetAgents: [{ agentId: 'agent-1', name: 'Coder' }],
        }),
        replies: [
          createComment({
            id: 'reply-1',
            parentId: 'comment-1',
            authorType: 'user',
            authorAgentId: null,
          }),
        ],
      };
      expect(isPendingComment(thread)).toBe(true);
    });

    it('when root comment has targets but replies are from different agents', () => {
      const thread: CommentThread = {
        comment: createComment({
          status: 'open',
          targetAgents: [{ agentId: 'agent-1', name: 'Coder' }],
        }),
        replies: [
          createComment({
            id: 'reply-1',
            parentId: 'comment-1',
            authorType: 'agent',
            authorAgentId: 'agent-other',
            authorAgentName: 'OtherAgent',
          }),
        ],
      };
      expect(isPendingComment(thread)).toBe(true);
    });

    it('when multiple targets and only non-targeted agents replied', () => {
      const thread: CommentThread = {
        comment: createComment({
          status: 'open',
          targetAgents: [
            { agentId: 'agent-1', name: 'Coder' },
            { agentId: 'agent-2', name: 'Reviewer' },
          ],
        }),
        replies: [
          createComment({
            id: 'reply-1',
            parentId: 'comment-1',
            authorType: 'agent',
            authorAgentId: 'agent-3',
            authorAgentName: 'Brainstormer',
          }),
        ],
      };
      expect(isPendingComment(thread)).toBe(true);
    });
  });

  describe('time/order-aware pending detection', () => {
    it('user → agent → user = pending (user follows up after agent reply)', () => {
      // User posts at T0, agent replies at T5, user follows up at T10 → PENDING
      const thread: CommentThread = {
        comment: createComment({
          id: 'comment-1',
          status: 'open',
          createdAt: timestamp(0),
          authorType: 'user',
          targetAgents: [{ agentId: 'agent-1', name: 'Coder' }],
        }),
        replies: [
          createComment({
            id: 'reply-1',
            parentId: 'comment-1',
            authorType: 'agent',
            authorAgentId: 'agent-1',
            authorAgentName: 'Coder',
            createdAt: timestamp(5),
          }),
          createComment({
            id: 'reply-2',
            parentId: 'comment-1',
            authorType: 'user',
            authorAgentId: null,
            createdAt: timestamp(10),
          }),
        ],
      };
      expect(isPendingComment(thread)).toBe(true);
    });

    it('user → agent = NOT pending (agent addressed the comment)', () => {
      // User posts at T0, agent replies at T5 → NOT pending
      const thread: CommentThread = {
        comment: createComment({
          id: 'comment-1',
          status: 'open',
          createdAt: timestamp(0),
          authorType: 'user',
          targetAgents: [{ agentId: 'agent-1', name: 'Coder' }],
        }),
        replies: [
          createComment({
            id: 'reply-1',
            parentId: 'comment-1',
            authorType: 'agent',
            authorAgentId: 'agent-1',
            authorAgentName: 'Coder',
            createdAt: timestamp(5),
          }),
        ],
      };
      expect(isPendingComment(thread)).toBe(false);
    });

    it('multi-target: user → agent1 → user → agent2 = NOT pending (agent2 replied last)', () => {
      // User posts at T0, agent1 replies at T5, user follows up at T10, agent2 replies at T15
      // Latest user message (T10) < latest agent reply (T15) → NOT pending
      const thread: CommentThread = {
        comment: createComment({
          id: 'comment-1',
          status: 'open',
          createdAt: timestamp(0),
          authorType: 'user',
          targetAgents: [
            { agentId: 'agent-1', name: 'Coder' },
            { agentId: 'agent-2', name: 'Reviewer' },
          ],
        }),
        replies: [
          createComment({
            id: 'reply-1',
            parentId: 'comment-1',
            authorType: 'agent',
            authorAgentId: 'agent-1',
            authorAgentName: 'Coder',
            createdAt: timestamp(5),
          }),
          createComment({
            id: 'reply-2',
            parentId: 'comment-1',
            authorType: 'user',
            authorAgentId: null,
            createdAt: timestamp(10),
          }),
          createComment({
            id: 'reply-3',
            parentId: 'comment-1',
            authorType: 'agent',
            authorAgentId: 'agent-2',
            authorAgentName: 'Reviewer',
            createdAt: timestamp(15),
          }),
        ],
      };
      expect(isPendingComment(thread)).toBe(false);
    });

    it('multi-target: user → agent1 → user (no agent2 reply yet) = pending', () => {
      // User posts at T0, agent1 replies at T5, user follows up at T10, agent2 never replies
      // Latest user message (T10) > latest agent reply (T5) → PENDING
      const thread: CommentThread = {
        comment: createComment({
          id: 'comment-1',
          status: 'open',
          createdAt: timestamp(0),
          authorType: 'user',
          targetAgents: [
            { agentId: 'agent-1', name: 'Coder' },
            { agentId: 'agent-2', name: 'Reviewer' },
          ],
        }),
        replies: [
          createComment({
            id: 'reply-1',
            parentId: 'comment-1',
            authorType: 'agent',
            authorAgentId: 'agent-1',
            authorAgentName: 'Coder',
            createdAt: timestamp(5),
          }),
          createComment({
            id: 'reply-2',
            parentId: 'comment-1',
            authorType: 'user',
            authorAgentId: null,
            createdAt: timestamp(10),
          }),
        ],
      };
      expect(isPendingComment(thread)).toBe(true);
    });

    it('handles replies with out-of-order timestamps correctly', () => {
      // Replies may not be in chronological order in the array
      // User posts at T0, then: [agent at T10, user at T5] (array order)
      // Should compare by timestamp, not array order
      // Latest user (T5) < latest agent (T10) → NOT pending
      const thread: CommentThread = {
        comment: createComment({
          id: 'comment-1',
          status: 'open',
          createdAt: timestamp(0),
          authorType: 'user',
          targetAgents: [{ agentId: 'agent-1', name: 'Coder' }],
        }),
        replies: [
          // Agent reply comes first in array but has later timestamp
          createComment({
            id: 'reply-1',
            parentId: 'comment-1',
            authorType: 'agent',
            authorAgentId: 'agent-1',
            authorAgentName: 'Coder',
            createdAt: timestamp(10),
          }),
          // User reply comes second in array but has earlier timestamp
          createComment({
            id: 'reply-2',
            parentId: 'comment-1',
            authorType: 'user',
            authorAgentId: null,
            createdAt: timestamp(5),
          }),
        ],
      };
      expect(isPendingComment(thread)).toBe(false);
    });

    it('handles multiple user follow-ups correctly', () => {
      // User posts at T0, agent at T5, user at T10, user at T15
      // Latest user (T15) > latest agent (T5) → PENDING
      const thread: CommentThread = {
        comment: createComment({
          id: 'comment-1',
          status: 'open',
          createdAt: timestamp(0),
          authorType: 'user',
          targetAgents: [{ agentId: 'agent-1', name: 'Coder' }],
        }),
        replies: [
          createComment({
            id: 'reply-1',
            parentId: 'comment-1',
            authorType: 'agent',
            authorAgentId: 'agent-1',
            authorAgentName: 'Coder',
            createdAt: timestamp(5),
          }),
          createComment({
            id: 'reply-2',
            parentId: 'comment-1',
            authorType: 'user',
            authorAgentId: null,
            createdAt: timestamp(10),
          }),
          createComment({
            id: 'reply-3',
            parentId: 'comment-1',
            authorType: 'user',
            authorAgentId: null,
            createdAt: timestamp(15),
          }),
        ],
      };
      expect(isPendingComment(thread)).toBe(true);
    });

    it('agent-initiated thread (root comment by agent) is not pending', () => {
      // Agent posts root comment → no user message in thread → NOT pending
      const thread: CommentThread = {
        comment: createComment({
          id: 'comment-1',
          status: 'open',
          createdAt: timestamp(0),
          authorType: 'agent',
          authorAgentId: 'agent-1',
          authorAgentName: 'Coder',
          targetAgents: [{ agentId: 'agent-2', name: 'Reviewer' }],
        }),
        replies: [],
      };
      expect(isPendingComment(thread)).toBe(false);
    });

    it('agent-initiated thread with user reply becomes pending', () => {
      // Agent posts at T0, user replies at T5 → PENDING (waiting for agent response)
      const thread: CommentThread = {
        comment: createComment({
          id: 'comment-1',
          status: 'open',
          createdAt: timestamp(0),
          authorType: 'agent',
          authorAgentId: 'agent-1',
          authorAgentName: 'Coder',
          targetAgents: [{ agentId: 'agent-2', name: 'Reviewer' }],
        }),
        replies: [
          createComment({
            id: 'reply-1',
            parentId: 'comment-1',
            authorType: 'user',
            authorAgentId: null,
            createdAt: timestamp(5),
          }),
        ],
      };
      expect(isPendingComment(thread)).toBe(true);
    });
  });
});
