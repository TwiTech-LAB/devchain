/**
 * Characterization tests — ReviewCommentNotifierSubscriber.
 *
 * Layer: backend-unit
 * Justification: mocked subscriber tests lock exact notification formatting,
 * de-duplication, self-filtering, and event-log aggregation before relocation.
 */

import { ReviewCommentNotifierSubscriber } from './review-comment-notifier.subscriber';

const getEventMetadataMock = jest.fn();

jest.mock('../../events/services/events.service', () => ({
  getEventMetadata: (...args: unknown[]) => getEventMetadataMock(...args),
}));

describe('ReviewCommentNotifierSubscriber characterization', () => {
  function createHarness() {
    const eventLog = {
      recordHandledOk: jest.fn().mockResolvedValue({ id: 'ok' }),
      recordHandledFail: jest.fn().mockResolvedValue({ id: 'fail' }),
    };
    const delivery = {
      deliver: jest.fn().mockResolvedValue({
        status: 'queued',
        results: [{ agentId: 'agent-1', status: 'queued' }],
      }),
    };
    const teams = {
      getRecipientContext: jest.fn().mockResolvedValue({
        isTeamLead: false,
        teamNames: [],
        memberRole: null,
      }),
    };
    const storage = {
      getAgent: jest.fn().mockResolvedValue({ id: 'author-1', name: 'Author Agent' }),
    };
    const subscriber = new ReviewCommentNotifierSubscriber(
      eventLog as never,
      delivery as never,
      teams as never,
      storage as never,
    );
    getEventMetadataMock.mockReturnValue({ id: 'event-1' });
    return { delivery, eventLog, subscriber };
  }

  afterEach(() => {
    jest.resetAllMocks();
  });

  it('captures exact working-tree review comment message', async () => {
    const { subscriber, delivery, eventLog } = createHarness();

    await subscriber.handleReviewCommentCreated({
      commentId: 'comment-1',
      reviewId: 'review-1',
      projectId: 'project-1',
      content: 'Please fix this.',
      commentType: 'issue',
      status: 'open',
      authorType: 'agent',
      authorAgentId: 'author-1',
      filePath: 'src/file.ts',
      lineStart: 10,
      lineEnd: 12,
      parentId: null,
      targetAgentIds: ['agent-1'],
      reviewTitle: 'Review Title',
      reviewMode: 'working_tree',
    } as never);

    expect(delivery.deliver).toHaveBeenCalledWith(
      ['agent-1'],
      expect.objectContaining({
        kind: 'pooled',
        body: [
          '[Review Comment]',
          'New issue on "Review Title" by Author Agent.',
          '',
          'File: src/file.ts (L10-12)',
          'Context: Working tree changes vs HEAD',
          'Content: Please fix this.',
          '',
          'Actions:',
          '\u2022 Reply: devchain_reply_comment(sessionId="<your-session-id>", reviewId="review-1", parentCommentId="comment-1", content="Your reply")',
          '\u2022 Resolve: devchain_resolve_comment(sessionId="<your-session-id>", commentId="comment-1", version=<comment-version>)',
          '  (Fetch comment first with devchain_get_review_comments to get current version)',
          '\u2022 View review: devchain_get_review(sessionId="<your-session-id>", reviewId="review-1")',
        ].join('\n'),
        source: 'review.comment.created',
        projectId: 'project-1',
      }),
      { submitKeys: ['Enter'] },
    );
    expect(eventLog.recordHandledOk).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: 'event-1', handler: 'ReviewCommentNotifier' }),
    );
  });

  it('deduplicates targets, filters the author, and records mixed failures', async () => {
    const { subscriber, delivery, eventLog } = createHarness();
    delivery.deliver
      .mockResolvedValueOnce({
        status: 'queued',
        results: [{ agentId: 'agent-1', status: 'queued' }],
      })
      .mockResolvedValueOnce({
        status: 'failed',
        results: [{ agentId: 'agent-2', status: 'failed', error: 'pool failed' }],
      });

    await subscriber.handleReviewCommentCreated({
      commentId: 'comment-1',
      reviewId: 'review-1',
      projectId: 'project-1',
      content: 'General comment',
      commentType: 'comment',
      status: 'open',
      authorType: 'agent',
      authorAgentId: 'author-1',
      filePath: null,
      lineStart: null,
      lineEnd: null,
      parentId: null,
      targetAgentIds: ['author-1', 'agent-1', 'agent-1', 'agent-2'],
      reviewTitle: 'Review Title',
      reviewMode: 'commit',
      headSha: 'abcdef123456',
      headRef: 'main',
    } as never);

    expect(delivery.deliver).toHaveBeenCalledTimes(2);
    expect(delivery.deliver.mock.calls.map((call) => call[0][0])).toEqual(['agent-1', 'agent-2']);
    expect(eventLog.recordHandledFail).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({
          targetAgentIds: ['agent-1', 'agent-2'],
          results: [
            { agentId: 'agent-1', success: true },
            { agentId: 'agent-2', success: false, error: 'pool failed' },
          ],
        }),
      }),
    );
  });
});
