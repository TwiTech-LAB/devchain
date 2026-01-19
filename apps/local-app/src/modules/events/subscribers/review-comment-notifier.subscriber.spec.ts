import { ReviewCommentNotifierSubscriber } from './review-comment-notifier.subscriber';
import type { EventLogService } from '../services/event-log.service';
import type { SessionsService } from '../../sessions/services/sessions.service';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import type { SessionCoordinatorService } from '../../sessions/services/session-coordinator.service';
import type { SessionsMessagePoolService } from '../../sessions/services/sessions-message-pool.service';
import type { ModuleRef } from '@nestjs/core';
import type { ReviewCommentCreatedEventPayload } from '../catalog/review.comment.created';

const getEventMetadataMock = jest.fn();

jest.mock('../services/events.service', () => ({
  getEventMetadata: (...args: unknown[]) => getEventMetadataMock(...args),
}));

describe('ReviewCommentNotifierSubscriber', () => {
  let eventLogService: {
    recordHandledOk: jest.Mock;
    recordHandledFail: jest.Mock;
  };
  let listActiveSessionsMock: jest.Mock;
  let launchSessionMock: jest.Mock;
  let sessionsService: SessionsService;
  let moduleRef: ModuleRef;
  let enqueueMock: jest.Mock;
  let messagePoolService: SessionsMessagePoolService;
  let getAgentMock: jest.Mock;
  let storageService: StorageService;
  let sessionCoordinator: SessionCoordinatorService;
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

    listActiveSessionsMock = jest.fn().mockResolvedValue([]);
    launchSessionMock = jest
      .fn()
      .mockResolvedValue({ id: 'session-2', tmuxSessionId: 'tmux-session' });
    sessionsService = {
      listActiveSessions: listActiveSessionsMock,
      launchSession: launchSessionMock,
    } as unknown as SessionsService;

    moduleRef = {
      get: jest.fn().mockImplementation((serviceClass) => {
        if (serviceClass.name === 'SessionsService') {
          return sessionsService;
        }
        return null;
      }),
    } as unknown as ModuleRef;

    enqueueMock = jest.fn().mockResolvedValue({ status: 'queued', poolSize: 1 });
    messagePoolService = {
      enqueue: enqueueMock,
    } as unknown as SessionsMessagePoolService;

    sessionCoordinator = {
      withAgentLock: jest.fn().mockImplementation(async (_agentId, callback) => {
        return callback();
      }),
    } as unknown as SessionCoordinatorService;

    getAgentMock = jest.fn();
    storageService = {
      getAgent: getAgentMock,
    } as unknown as StorageService;

    getEventMetadataMock.mockReturnValue({ id: 'event-1' });

    subscriber = new ReviewCommentNotifierSubscriber(
      eventLogService as unknown as EventLogService,
      moduleRef,
      sessionCoordinator,
      messagePoolService,
      storageService,
    );
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  it('enqueues message for target agent with existing session', async () => {
    listActiveSessionsMock.mockResolvedValue([
      {
        id: 'session-1',
        agentId: 'agent-1',
        tmuxSessionId: 'tmux-session',
        status: 'running',
        startedAt: new Date().toISOString(),
        endedAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]);

    await subscriber.handleReviewCommentCreated(basePayload);

    expect(launchSessionMock).not.toHaveBeenCalled();
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    const [agentId, message, options] = enqueueMock.mock.calls[0];
    expect(agentId).toBe('agent-1');
    expect(message).toContain('Review Comment');
    expect(message).toContain('Fix authentication bug');
    expect(message).toContain('src/utils.ts');
    expect(message).toContain('L42-45');
    expect(message).toContain('Please fix this code style issue');
    expect(options).toEqual({
      source: 'review.comment.created',
      submitKeys: ['Enter'],
      projectId: basePayload.projectId,
    });
    expect(eventLogService.recordHandledOk).toHaveBeenCalledWith(
      expect.objectContaining({ handler: 'ReviewCommentNotifier', eventId: 'event-1' }),
    );
  });

  it('launches session when none exist and enqueues message', async () => {
    await subscriber.handleReviewCommentCreated(basePayload);

    expect(launchSessionMock).toHaveBeenCalledWith({
      projectId: basePayload.projectId,
      agentId: 'agent-1',
    });
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock).toHaveBeenCalledWith(
      'agent-1',
      expect.any(String),
      expect.objectContaining({
        source: 'review.comment.created',
        submitKeys: ['Enter'],
        projectId: basePayload.projectId,
      }),
    );
  });

  it('notifies multiple target agents', async () => {
    const multiAgentPayload = {
      ...basePayload,
      targetAgentIds: ['agent-1', 'agent-2', 'agent-3'],
    };

    await subscriber.handleReviewCommentCreated(multiAgentPayload);

    expect(enqueueMock).toHaveBeenCalledTimes(3);
    expect(enqueueMock).toHaveBeenCalledWith('agent-1', expect.any(String), expect.any(Object));
    expect(enqueueMock).toHaveBeenCalledWith('agent-2', expect.any(String), expect.any(Object));
    expect(enqueueMock).toHaveBeenCalledWith('agent-3', expect.any(String), expect.any(Object));
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

  it('logs failure when enqueue throws for some agents', async () => {
    const multiAgentPayload = {
      ...basePayload,
      targetAgentIds: ['agent-1', 'agent-2'],
    };
    enqueueMock
      .mockResolvedValueOnce({ status: 'queued', poolSize: 1 })
      .mockRejectedValueOnce(new Error('pool failure'));

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

  it('skips processing when no targetAgentIds', async () => {
    const noTargetPayload = {
      ...basePayload,
      targetAgentIds: [],
    };

    await subscriber.handleReviewCommentCreated(noTargetPayload);

    expect(enqueueMock).not.toHaveBeenCalled();
    expect(launchSessionMock).not.toHaveBeenCalled();
    expect(eventLogService.recordHandledOk).not.toHaveBeenCalled();
    expect(eventLogService.recordHandledFail).not.toHaveBeenCalled();
  });

  it('skips processing when targetAgentIds is undefined', async () => {
    const undefinedTargetPayload = {
      ...basePayload,
      targetAgentIds: undefined,
    };

    await subscriber.handleReviewCommentCreated(undefinedTargetPayload);

    expect(enqueueMock).not.toHaveBeenCalled();
    expect(launchSessionMock).not.toHaveBeenCalled();
  });

  it('resolves author name from storage when authorType is agent', async () => {
    const agentAuthorPayload = {
      ...basePayload,
      authorType: 'agent' as const,
      authorAgentId: 'author-agent-1',
    };
    getAgentMock.mockResolvedValue({ name: 'Reviewer Agent' });

    await subscriber.handleReviewCommentCreated(agentAuthorPayload);

    expect(getAgentMock).toHaveBeenCalledWith('author-agent-1');
    expect(enqueueMock).toHaveBeenCalledWith(
      'agent-1',
      expect.stringContaining('Reviewer Agent'),
      expect.any(Object),
    );
  });

  it('uses fallback author name when storage lookup fails', async () => {
    const agentAuthorPayload = {
      ...basePayload,
      authorType: 'agent' as const,
      authorAgentId: 'author-agent-1',
    };
    getAgentMock.mockRejectedValue(new Error('Agent not found'));

    await subscriber.handleReviewCommentCreated(agentAuthorPayload);

    expect(enqueueMock).toHaveBeenCalledWith(
      'agent-1',
      expect.stringContaining('Agent'),
      expect.any(Object),
    );
  });

  it('formats single line correctly', async () => {
    const singleLinePayload = {
      ...basePayload,
      lineStart: 42,
      lineEnd: 42,
    };

    await subscriber.handleReviewCommentCreated(singleLinePayload);

    expect(enqueueMock).toHaveBeenCalledWith(
      'agent-1',
      expect.stringContaining('L42)'),
      expect.any(Object),
    );
  });

  it('formats message without line info when lineStart is null', async () => {
    const noLinePayload = {
      ...basePayload,
      lineStart: null,
      lineEnd: null,
    };

    await subscriber.handleReviewCommentCreated(noLinePayload);

    const [, message] = enqueueMock.mock.calls[0];
    expect(message).toContain('src/utils.ts');
    expect(message).not.toContain('(L');
  });

  it('uses reviewId as title fallback when reviewTitle is missing', async () => {
    const noTitlePayload = {
      ...basePayload,
      reviewTitle: undefined,
    };

    await subscriber.handleReviewCommentCreated(noTitlePayload);

    expect(enqueueMock).toHaveBeenCalledWith(
      'agent-1',
      expect.stringContaining('review-1'),
      expect.any(Object),
    );
  });

  it('uses "(general)" when filePath is null', async () => {
    const noFilePayload = {
      ...basePayload,
      filePath: null,
    };

    await subscriber.handleReviewCommentCreated(noFilePayload);

    expect(enqueueMock).toHaveBeenCalledWith(
      'agent-1',
      expect.stringContaining('(general)'),
      expect.any(Object),
    );
  });

  it('truncates long content', async () => {
    const longContentPayload = {
      ...basePayload,
      content: 'x'.repeat(600),
    };

    await subscriber.handleReviewCommentCreated(longContentPayload);

    const [, message] = enqueueMock.mock.calls[0];
    expect(message).toContain('x'.repeat(497) + '...');
    expect(message).not.toContain('x'.repeat(500));
  });

  it('does not record handler result when eventId is missing', async () => {
    getEventMetadataMock.mockReturnValue(null);

    await subscriber.handleReviewCommentCreated(basePayload);

    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect(eventLogService.recordHandledOk).not.toHaveBeenCalled();
    expect(eventLogService.recordHandledFail).not.toHaveBeenCalled();
  });
});
