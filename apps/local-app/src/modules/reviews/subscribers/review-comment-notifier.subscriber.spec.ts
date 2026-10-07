import { ReviewCommentNotifierSubscriber } from './review-comment-notifier.subscriber';
import { TeamsService } from '../../teams/services/teams.service';
import type { AgentMessageDeliveryService } from '../../agent-message-delivery/agent-message-delivery.service';
import type { EventLogService } from '../../events/services/event-log.service';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import type { ReviewCommentCreatedEventPayload } from '../../events/catalog/review.comment.created';

const getEventMetadataMock = jest.fn();

jest.mock('../../events/services/events.service', () => ({
  getEventMetadata: (...args: unknown[]) => getEventMetadataMock(...args),
}));

describe('ReviewCommentNotifierSubscriber', () => {
  let eventLogService: {
    recordHandledOk: jest.Mock;
    recordHandledFail: jest.Mock;
  };
  let deliverMock: jest.Mock;
  let messageDelivery: AgentMessageDeliveryService;
  let getRecipientContextMock: jest.Mock;
  let teamsServiceMock: { getRecipientContext: jest.Mock };
  let getAgentMock: jest.Mock;
  let storageService: StorageService;
  let subscriber: ReviewCommentNotifierSubscriber;

  const basePayload: ReviewCommentCreatedEventPayload = {
    commentId: 'comment-1',
    reviewId: 'review-1',
    projectId: 'project-1',
    content: 'Please fix this code style issue',
    commentType: 'issue',
    status: 'open',
    authorType: 'user',
    authorAgentId: null,
    filePath: 'src/utils.ts',
    lineStart: 42,
    lineEnd: 45,
    parentId: null,
    targetAgentIds: ['agent-1'],
    projectName: 'Demo Project',
    reviewTitle: 'Fix authentication bug',
  };

  beforeEach(() => {
    eventLogService = {
      recordHandledOk: jest.fn().mockResolvedValue({ id: 'handler-ok' }),
      recordHandledFail: jest.fn().mockResolvedValue({ id: 'handler-fail' }),
    };

    deliverMock = jest.fn().mockResolvedValue({
      status: 'queued',
      results: [{ agentId: 'agent-1', status: 'queued' }],
    });
    messageDelivery = {
      deliver: deliverMock,
    } as unknown as AgentMessageDeliveryService;

    getRecipientContextMock = jest.fn().mockResolvedValue({
      isTeamLead: false,
      teamNames: [],
      memberRole: null,
    });
    teamsServiceMock = { getRecipientContext: getRecipientContextMock };

    getAgentMock = jest.fn();
    storageService = {
      getAgent: getAgentMock,
    } as unknown as StorageService;

    getEventMetadataMock.mockReturnValue({ id: 'event-1' });

    subscriber = new ReviewCommentNotifierSubscriber(
      eventLogService as unknown as EventLogService,
      messageDelivery,
      teamsServiceMock as unknown as TeamsService,
      storageService,
    );
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  const deliveredBody = (index = 0): string => deliverMock.mock.calls[index][1].body as string;

  it('delivers message for target agent through AMD', async () => {
    await subscriber.handleReviewCommentCreated(basePayload);

    expect(deliverMock).toHaveBeenCalledTimes(1);
    const [recipients, deliveryMessage, policy] = deliverMock.mock.calls[0];
    const message = deliveryMessage.body as string;
    expect(recipients).toEqual(['agent-1']);
    expect(deliveryMessage).toEqual(
      expect.objectContaining({
        kind: 'pooled',
        source: 'review.comment.created',
        projectId: basePayload.projectId,
        senderName: 'User',
      }),
    );
    expect(message).toContain('Review Comment');
    expect(message).toContain('Fix authentication bug');
    expect(message).toContain('src/utils.ts');
    expect(message).toContain('L42-45');
    expect(message).toContain('Please fix this code style issue');
    expect(policy).toEqual({ submitKeys: ['Enter'] });
    expect(eventLogService.recordHandledOk).toHaveBeenCalledWith(
      expect.objectContaining({ handler: 'ReviewCommentNotifier', eventId: 'event-1' }),
    );
  });

  it('notifies multiple target agents', async () => {
    const multiAgentPayload = {
      ...basePayload,
      targetAgentIds: ['agent-1', 'agent-2', 'agent-3'],
    };

    await subscriber.handleReviewCommentCreated(multiAgentPayload);

    expect(deliverMock).toHaveBeenCalledTimes(3);
    expect(deliverMock).toHaveBeenCalledWith(['agent-1'], expect.any(Object), expect.any(Object));
    expect(deliverMock).toHaveBeenCalledWith(['agent-2'], expect.any(Object), expect.any(Object));
    expect(deliverMock).toHaveBeenCalledWith(['agent-3'], expect.any(Object), expect.any(Object));
    expect(eventLogService.recordHandledOk).toHaveBeenCalledWith(
      expect.objectContaining({
        handler: 'ReviewCommentNotifier',
        detail: expect.objectContaining({
          targetAgentIds: ['agent-1', 'agent-2', 'agent-3'],
          results: expect.arrayContaining([
            { agentId: 'agent-1', success: true },
            { agentId: 'agent-2', success: true },
            { agentId: 'agent-3', success: true },
          ]),
        }),
      }),
    );
  });

  it('logs failure when AMD reports delivery failure for some agents', async () => {
    const multiAgentPayload = {
      ...basePayload,
      targetAgentIds: ['agent-1', 'agent-2'],
    };
    deliverMock
      .mockResolvedValueOnce({
        status: 'queued',
        results: [{ agentId: 'agent-1', status: 'queued' }],
      })
      .mockResolvedValueOnce({
        status: 'failed',
        results: [{ agentId: 'agent-2', status: 'failed', error: 'pool failure' }],
      });

    await subscriber.handleReviewCommentCreated(multiAgentPayload);

    expect(eventLogService.recordHandledFail).toHaveBeenCalledWith(
      expect.objectContaining({
        handler: 'ReviewCommentNotifier',
        eventId: 'event-1',
        detail: expect.objectContaining({
          results: expect.arrayContaining([
            { agentId: 'agent-1', success: true },
            { agentId: 'agent-2', success: false, error: 'pool failure' },
          ]),
        }),
      }),
    );
    expect(eventLogService.recordHandledOk).not.toHaveBeenCalled();
  });

  it.each([{ targetAgentIds: [] }, { targetAgentIds: undefined }])(
    'skips target list $targetAgentIds',
    async ({ targetAgentIds }) => {
      await subscriber.handleReviewCommentCreated({ ...basePayload, targetAgentIds } as never);
      expect(deliverMock).not.toHaveBeenCalled();
      expect(eventLogService.recordHandledOk).not.toHaveBeenCalled();
      expect(eventLogService.recordHandledFail).not.toHaveBeenCalled();
    },
  );

  it('resolves author name from storage when authorType is agent', async () => {
    const agentAuthorPayload = {
      ...basePayload,
      authorType: 'agent' as const,
      authorAgentId: 'author-agent-1',
    };
    getAgentMock.mockResolvedValue({ name: 'Reviewer Agent' });

    await subscriber.handleReviewCommentCreated(agentAuthorPayload);

    expect(getAgentMock).toHaveBeenCalledWith('author-agent-1');
    expect(deliveredBody()).toContain('Reviewer Agent');
  });

  it('uses fallback author name when storage lookup fails', async () => {
    const agentAuthorPayload = {
      ...basePayload,
      authorType: 'agent' as const,
      authorAgentId: 'author-agent-1',
    };
    getAgentMock.mockRejectedValue(new Error('Agent not found'));

    await subscriber.handleReviewCommentCreated(agentAuthorPayload);

    expect(deliveredBody()).toContain('Agent');
  });

  it('formats single line correctly', async () => {
    const singleLinePayload = {
      ...basePayload,
      lineStart: 42,
      lineEnd: 42,
    };

    await subscriber.handleReviewCommentCreated(singleLinePayload);

    expect(deliveredBody()).toContain('L42)');
  });

  it('formats message without line info when lineStart is null', async () => {
    const noLinePayload = {
      ...basePayload,
      lineStart: null,
      lineEnd: null,
    };

    await subscriber.handleReviewCommentCreated(noLinePayload);

    const message = deliveredBody();
    expect(message).toContain('src/utils.ts');
    expect(message).not.toContain('(L');
  });

  it('uses reviewId as title fallback when reviewTitle is missing', async () => {
    const noTitlePayload = {
      ...basePayload,
      reviewTitle: undefined,
    };

    await subscriber.handleReviewCommentCreated(noTitlePayload);

    expect(deliveredBody()).toContain('review-1');
  });

  it('uses "(general)" when filePath is null', async () => {
    const noFilePayload = {
      ...basePayload,
      filePath: null,
    };

    await subscriber.handleReviewCommentCreated(noFilePayload);

    expect(deliveredBody()).toContain('(general)');
  });

  it('truncates long content', async () => {
    const longContentPayload = {
      ...basePayload,
      content: 'x'.repeat(600),
    };

    await subscriber.handleReviewCommentCreated(longContentPayload);

    const message = deliveredBody();
    expect(message).toContain('x'.repeat(497) + '...');
    expect(message).not.toContain('x'.repeat(500));
  });

  it('does not record handler result when eventId is missing', async () => {
    getEventMetadataMock.mockReturnValue(null);

    await subscriber.handleReviewCommentCreated(basePayload);

    expect(deliverMock).toHaveBeenCalledTimes(1);
    expect(eventLogService.recordHandledOk).not.toHaveBeenCalled();
    expect(eventLogService.recordHandledFail).not.toHaveBeenCalled();
  });

  describe('de-duplication and author filtering', () => {
    it.each([
      {
        label: 'dedupe',
        targetAgentIds: ['agent-1', 'agent-2', 'agent-1', 'agent-3'],
        authorType: 'user' as const,
        authorAgentId: null,
        expected: ['agent-1', 'agent-2', 'agent-3'],
      },
      {
        label: 'filter author',
        targetAgentIds: ['agent-1', 'agent-2'],
        authorType: 'agent' as const,
        authorAgentId: 'agent-1',
        expected: ['agent-2'],
      },
      {
        label: 'user author',
        targetAgentIds: ['agent-1', 'agent-2'],
        authorType: 'user' as const,
        authorAgentId: 'agent-1',
        expected: ['agent-1', 'agent-2'],
      },
    ])('$label', async ({ targetAgentIds, authorType, authorAgentId, expected }) => {
      await subscriber.handleReviewCommentCreated({
        ...basePayload,
        targetAgentIds,
        authorType,
        authorAgentId,
      });
      expect(deliverMock).toHaveBeenCalledTimes(expected.length);
      expect(deliverMock.mock.calls.map((call) => call[0][0])).toEqual(expected);
    });

    it('exits early without notifications when filtering leaves zero targets', async () => {
      const onlyAuthorPayload = {
        ...basePayload,
        authorType: 'agent' as const,
        authorAgentId: 'agent-1',
        targetAgentIds: ['agent-1'], // Only target is the author themselves
      };

      await subscriber.handleReviewCommentCreated(onlyAuthorPayload);

      // Should not notify anyone (author filtered out, leaving zero targets)
      expect(deliverMock).not.toHaveBeenCalled();
      // Should not record handler result (early exit before eventId processing)
      expect(eventLogService.recordHandledOk).not.toHaveBeenCalled();
      expect(eventLogService.recordHandledFail).not.toHaveBeenCalled();
    });

    it('handles both de-duplication and author filtering together', async () => {
      const complexPayload = {
        ...basePayload,
        authorType: 'agent' as const,
        authorAgentId: 'agent-2',
        targetAgentIds: ['agent-1', 'agent-2', 'agent-2', 'agent-3', 'agent-1'],
      };

      await subscriber.handleReviewCommentCreated(complexPayload);

      // De-duplicated: ['agent-1', 'agent-2', 'agent-3']
      // After filtering author agent-2: ['agent-1', 'agent-3']
      expect(deliverMock).toHaveBeenCalledTimes(2);
      expect(deliverMock).toHaveBeenCalledWith(['agent-1'], expect.any(Object), expect.any(Object));
      expect(deliverMock).toHaveBeenCalledWith(['agent-3'], expect.any(Object), expect.any(Object));
      // Logged results should reflect de-duplicated and filtered targets
      expect(eventLogService.recordHandledOk).toHaveBeenCalledWith(
        expect.objectContaining({
          handler: 'ReviewCommentNotifier',
          detail: expect.objectContaining({
            targetAgentIds: ['agent-1', 'agent-3'],
            results: expect.arrayContaining([
              { agentId: 'agent-1', success: true },
              { agentId: 'agent-3', success: true },
            ]),
          }),
        }),
      );
    });

    it('logs correct target count after filtering', async () => {
      const duplicatePayload = {
        ...basePayload,
        targetAgentIds: ['agent-1', 'agent-1', 'agent-2'],
      };

      await subscriber.handleReviewCommentCreated(duplicatePayload);

      // Log should show count of 2 (de-duplicated), not 3 (with duplicates)
      expect(eventLogService.recordHandledOk).toHaveBeenCalledWith(
        expect.objectContaining({
          detail: expect.objectContaining({
            targetAgentIds: ['agent-1', 'agent-2'],
          }),
        }),
      );
    });
  });
  it('captures exact working-tree review comment message', async () => {
    getAgentMock.mockResolvedValue({ id: 'author-1', name: 'Author Agent' });

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

    expect(deliverMock).toHaveBeenCalledWith(
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
    expect(eventLogService.recordHandledOk).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: 'event-1', handler: 'ReviewCommentNotifier' }),
    );
  });
});
