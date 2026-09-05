import { GUARDS_METADATA } from '@nestjs/common/constants';
import { ValidationError } from '../../../common/errors/error-types';
import { IntegrationAdmissionGuard } from '../../../common/guards/integration-admission.guard';
import { ExternalMyWorkController } from './external-my-work.controller';
import type { ExternalMyWorkService } from './external-my-work.service';
import type { ExternalEditSessionService } from './external-edit-session.service';
import type { ExternalTimeMutationService } from './external-time-mutation.service';

describe('ExternalMyWorkController', () => {
  const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
  const service = {
    getMyWork: jest.fn(),
    getTaskDetail: jest.fn(),
    listTaskComments: jest.fn(),
    changeTaskStatus: jest.fn(),
    addTaskComment: jest.fn(),
    getTimeEntryHistory: jest.fn(),
    getTaskLinkStates: jest.fn(),
  };
  const timeMutations = {
    createTimeEntry: jest.fn(),
    updateTimeEntry: jest.fn(),
    deleteTimeEntry: jest.fn(),
    getOperation: jest.fn(),
    verifyOperation: jest.fn(),
    acknowledgeOperation: jest.fn(),
  };
  const editSessions = {
    readRichDescription: jest.fn(),
    createDescriptionSession: jest.fn(),
    createCommentEditSession: jest.fn(),
    createCommentDeleteSession: jest.fn(),
    touchSession: jest.fn(),
    verifySession: jest.fn(),
    saveSession: jest.fn(),
    reloadSession: jest.fn(),
    executeCommentDelete: jest.fn(),
  };
  const controller = new ExternalMyWorkController(
    service as unknown as ExternalMyWorkService,
    editSessions as unknown as ExternalEditSessionService,
    timeMutations as unknown as ExternalTimeMutationService,
  );

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('applies integration admission to the generic controller', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, ExternalMyWorkController)).toContain(
      IntegrationAdmissionGuard,
    );
  });

  it.each([
    ['My Work', () => controller.getMyWork('clickup', {})],
    ['task detail', () => controller.getTaskDetail('clickup', 'task-1', undefined)],
    ['comments', () => controller.listTaskComments('clickup', 'task-1', {})],
    ['time history', () => controller.listTaskTimeEntries('clickup', 'task-1', '4', undefined)],
    [
      'status change',
      () => controller.changeTaskStatus('clickup', 'task-1', { status: 'Done' }, undefined),
    ],
    [
      'comment add',
      () => controller.addTaskComment('clickup', 'task-1', { text: 'Done' }, undefined),
    ],
    [
      'time create',
      () =>
        controller.addTaskTimeEntry(
          'clickup',
          'task-1',
          '4',
          'op-1',
          { startedAt: '2026-08-19T10:00:00.000Z', durationMs: 60_000 },
          'workspace-1',
          undefined,
        ),
    ],
    [
      'time delete',
      () =>
        controller.deleteTaskTimeEntry(
          'clickup',
          'task-1',
          'entry-1',
          '4',
          'op-1',
          'workspace-1',
          undefined,
        ),
    ],
    ['time receipt', () => controller.getTimeOperation('clickup', 'op-1', '4', undefined)],
    ['time verify', () => controller.verifyTimeOperation('clickup', 'op-1', '4', undefined)],
    [
      'time acknowledge',
      () => controller.acknowledgeTimeOperation('clickup', 'op-1', '4', undefined),
    ],
    [
      'link lookup',
      () =>
        controller.getTaskLinkStates(
          'clickup',
          { items: [{ scopeKey: 'scope', taskId: 'task-1' }] },
          undefined,
        ),
    ],
    [
      'description session create',
      () => controller.createDescriptionSession('clickup', 'task-1', undefined),
    ],
    [
      'delete session create',
      () => controller.createCommentDeleteSession('clickup', 'task-1', 'c1', {}, undefined),
    ],
    [
      'session touch',
      () => controller.touchSession('3f2a1b8e-0000-4000-8000-000000000000', undefined),
    ],
    [
      'session verify',
      () => controller.verifySession('3f2a1b8e-0000-4000-8000-000000000000', undefined),
    ],
    [
      'session save',
      () =>
        controller.saveSession(
          '3f2a1b8e-0000-4000-8000-000000000000',
          { document: { version: 1, blocks: [] }, revision: 0 },
          undefined,
        ),
    ],
    [
      'session reload',
      () => controller.reloadSession('3f2a1b8e-0000-4000-8000-000000000000', undefined),
    ],
    ['rich description', () => controller.readRichDescription('clickup', 'task-1', undefined)],
    [
      'comment edit session',
      () => controller.createCommentEditSession('clickup', 'task-1', 'c1', {}, undefined),
    ],
    [
      'comment delete execute',
      () => controller.executeCommentDelete('3f2a1b8e-0000-4000-8000-000000000000', undefined),
    ],
  ])('requires projectId for the %s route', async (_route, operation) => {
    await expect(operation()).rejects.toBeInstanceOf(ValidationError);
    for (const spy of [
      ...Object.values(service),
      ...Object.values(timeMutations),
      ...Object.values(editSessions),
    ]) {
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it('parses the provider and include-completed query before generic dispatch', async () => {
    service.getMyWork.mockResolvedValue({ supported: true });

    await controller.getMyWork('clickup', { projectId: PROJECT_ID, includeCompleted: 'true' });

    expect(service.getMyWork).toHaveBeenCalledWith(PROJECT_ID, 'clickup', {
      includeCompleted: true,
    });
  });

  it.each([
    ['unknown provider', 'github', { projectId: PROJECT_ID }],
    [
      'unknown query field',
      'clickup',
      { projectId: PROJECT_ID, includeCompleted: 'false', vendor: 'clickup' },
    ],
    ['invalid boolean', 'clickup', { projectId: PROJECT_ID, includeCompleted: 'yes' }],
  ])('rejects %s without dispatch', async (_case, provider, query) => {
    await expect(controller.getMyWork(provider, query)).rejects.toBeInstanceOf(ValidationError);
    expect(service.getMyWork).not.toHaveBeenCalled();
  });

  it('dispatches the generic task-detail route with validated identifiers', async () => {
    service.getTaskDetail.mockResolvedValue({ remoteId: 'task-1' });

    await controller.getTaskDetail('clickup', 'task-1', PROJECT_ID);

    expect(service.getTaskDetail).toHaveBeenCalledWith(PROJECT_ID, 'clickup', 'task-1');
  });

  it('parses status and plain-text comment inputs', async () => {
    service.changeTaskStatus.mockResolvedValue({ succeeded: true });
    service.addTaskComment.mockResolvedValue({ succeeded: true });

    await controller.changeTaskStatus('clickup', 'task-1', { status: 'In Progress' }, PROJECT_ID);
    await controller.changeTaskStatus('jira', 'ENG-1', { status: '31' }, PROJECT_ID);
    await controller.addTaskComment('clickup', 'task-1', { text: 'Ready for review' }, PROJECT_ID);

    expect(service.changeTaskStatus).toHaveBeenCalledWith(PROJECT_ID, 'clickup', 'task-1', {
      status: 'In Progress',
    });
    // The Jira actionValue is a transition id, but it travels in the same
    // generic `{ status: string }` body with no provider-specific route.
    expect(service.changeTaskStatus).toHaveBeenCalledWith(PROJECT_ID, 'jira', 'ENG-1', {
      status: '31',
    });
    expect(service.addTaskComment).toHaveBeenCalledWith(PROJECT_ID, 'clickup', 'task-1', {
      text: 'Ready for review',
      notifyAll: false,
    });
  });

  it('dispatches the task-time-entry history route with a required epoch header', async () => {
    service.getTimeEntryHistory.mockResolvedValue({
      windowDays: 30,
      entries: [],
      truncated: false,
      hasRunningTimer: false,
    });

    await controller.listTaskTimeEntries('jira', 'ENG-1', '4', PROJECT_ID);

    expect(service.getTimeEntryHistory).toHaveBeenCalledWith(PROJECT_ID, 'jira', 'ENG-1', 4);
    await expect(
      controller.listTaskTimeEntries('github', 'ENG-1', '4', PROJECT_ID),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      controller.listTaskTimeEntries('jira', ' ', '4', PROJECT_ID),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      controller.listTaskTimeEntries('jira', 'ENG-1', undefined, PROJECT_ID),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      controller.listTaskTimeEntries('jira', 'ENG-1', 'not-a-number', PROJECT_ID),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(service.getTimeEntryHistory).toHaveBeenCalledTimes(1);
  });

  it('dispatches receipt-bound time-entry create, update, and delete with both headers', async () => {
    timeMutations.createTimeEntry.mockResolvedValue({ outcome: 'created' });
    timeMutations.updateTimeEntry.mockResolvedValue({ outcome: 'updated' });
    timeMutations.deleteTimeEntry.mockResolvedValue({ outcome: 'deleted' });
    const input = {
      startedAt: '2026-08-19T10:00:00.000Z',
      durationMs: 3_600_000,
      note: 'Implementation',
    };

    await controller.addTaskTimeEntry(
      'clickup',
      'task-1',
      '4',
      'op-1',
      input,
      'workspace-1',
      PROJECT_ID,
    );
    expect(timeMutations.createTimeEntry).toHaveBeenCalledWith(
      PROJECT_ID,
      'clickup',
      'task-1',
      input,
      'op-1',
      4,
      'workspace-1',
    );

    await controller.updateTaskTimeEntry(
      'clickup',
      'task-1',
      'entry-1',
      '4',
      'op-update',
      input,
      'workspace-1',
      PROJECT_ID,
    );
    expect(timeMutations.updateTimeEntry).toHaveBeenCalledWith(
      PROJECT_ID,
      'clickup',
      'task-1',
      'entry-1',
      input,
      'op-update',
      4,
      'workspace-1',
    );

    await controller.deleteTaskTimeEntry(
      'jira',
      'ENG-1',
      '10001',
      '7',
      'op-2',
      'acme.atlassian.net',
      PROJECT_ID,
    );
    expect(timeMutations.deleteTimeEntry).toHaveBeenCalledWith(
      PROJECT_ID,
      'jira',
      'ENG-1',
      '10001',
      'op-2',
      7,
      'acme.atlassian.net',
    );

    // Missing or malformed headers never reach the service.
    await expect(
      controller.addTaskTimeEntry('clickup', 'task-1', '4', '', input, 'workspace-1', PROJECT_ID),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      controller.addTaskTimeEntry(
        'clickup',
        'task-1',
        'x',
        'op-3',
        input,
        'workspace-1',
        PROJECT_ID,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      controller.deleteTaskTimeEntry(
        'jira',
        'ENG-1',
        '10001',
        '4',
        undefined,
        'acme.atlassian.net',
        PROJECT_ID,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      controller.addTaskTimeEntry('clickup', 'task-1', '4', 'op-4', input, '', PROJECT_ID),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(timeMutations.createTimeEntry).toHaveBeenCalledTimes(1);
    expect(timeMutations.deleteTimeEntry).toHaveBeenCalledTimes(1);
  });

  it('dispatches time-operation read, verify, and acknowledge routes', async () => {
    const receipt = { operationId: 'op-1', phase: 'outcome_unknown' };
    timeMutations.getOperation.mockResolvedValue(receipt);
    timeMutations.verifyOperation.mockResolvedValue({
      receipt,
      resolved: true,
      resolution: 'not_applied',
    });
    timeMutations.acknowledgeOperation.mockResolvedValue({
      operationId: 'op-1',
      phase: 'abandoned_unknown',
    });

    await controller.getTimeOperation('jira', 'op-1', '4', PROJECT_ID);
    expect(timeMutations.getOperation).toHaveBeenCalledWith(PROJECT_ID, 'jira', 'op-1', 4);

    await controller.verifyTimeOperation('jira', 'op-1', '4', PROJECT_ID);
    expect(timeMutations.verifyOperation).toHaveBeenCalledWith(PROJECT_ID, 'jira', 'op-1', 4);

    await controller.acknowledgeTimeOperation('jira', 'op-1', '4', PROJECT_ID);
    expect(timeMutations.acknowledgeOperation).toHaveBeenCalledWith(PROJECT_ID, 'jira', 'op-1', 4);

    await expect(
      controller.verifyTimeOperation('jira', 'op-1', 'bad', PROJECT_ID),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      controller.getTimeOperation('github', 'op-1', '4', PROJECT_ID),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(timeMutations.verifyOperation).toHaveBeenCalledTimes(1);
    expect(timeMutations.getOperation).toHaveBeenCalledTimes(1);
  });

  it('dispatches the task-comments route with a validated optional cursor', async () => {
    service.listTaskComments.mockResolvedValue({ comments: [], nextCursor: null });

    await controller.listTaskComments('clickup', 'task-1', { projectId: PROJECT_ID });
    expect(service.listTaskComments).toHaveBeenCalledWith(PROJECT_ID, 'clickup', 'task-1', null);

    await controller.listTaskComments('jira', 'ENG-1', { projectId: PROJECT_ID, cursor: 'MTA' });
    expect(service.listTaskComments).toHaveBeenLastCalledWith(PROJECT_ID, 'jira', 'ENG-1', 'MTA');
  });

  it.each([
    ['unknown provider', 'github', 'task-1', { projectId: PROJECT_ID }],
    ['blank task id', 'clickup', ' ', { projectId: PROJECT_ID }],
    ['oversized cursor', 'clickup', 'task-1', { projectId: PROJECT_ID, cursor: 'x'.repeat(1_025) }],
    ['empty cursor', 'clickup', 'task-1', { projectId: PROJECT_ID, cursor: '' }],
    [
      'unknown query field',
      'clickup',
      'task-1',
      { projectId: PROJECT_ID, cursor: 'MTA', limit: '10' },
    ],
  ])(
    'rejects %s on the comments route without dispatch',
    async (_case, provider, taskId, query) => {
      await expect(controller.listTaskComments(provider, taskId, query)).rejects.toBeInstanceOf(
        ValidationError,
      );
      expect(service.listTaskComments).not.toHaveBeenCalled();
    },
  );

  it('validates and dispatches one bounded batch link-state request', async () => {
    service.getTaskLinkStates.mockResolvedValue({ items: [] });
    const items = [
      { scopeKey: 'acme.atlassian.net', taskId: 'ENG-1' },
      { scopeKey: 'acme.atlassian.net', taskId: 'ENG-2' },
    ];

    await controller.getTaskLinkStates('jira', { items }, PROJECT_ID);

    expect(service.getTaskLinkStates).toHaveBeenCalledWith(PROJECT_ID, 'jira', items, {
      includeLoggedMinutes: false,
    });

    await controller.getTaskLinkStates('jira', { items, includeLoggedMinutes: true }, PROJECT_ID);
    expect(service.getTaskLinkStates).toHaveBeenLastCalledWith(PROJECT_ID, 'jira', items, {
      includeLoggedMinutes: true,
    });

    await expect(
      controller.getTaskLinkStates(
        'jira',
        { items: [{ scopeKey: 'site', taskId: 'ENG-1', epicId: 'browser-controlled' }] },
        PROJECT_ID,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      controller.getTaskLinkStates('jira', { items, includeLoggedMinutes: 'yes' }, PROJECT_ID),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      controller.getTaskLinkStates('jira', { items: [], includeLoggedMinutes: true }, PROJECT_ID),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it.each([
    ['blank task id', 'getTaskDetail', 'clickup', ' ', undefined],
    [
      'unknown status field',
      'changeTaskStatus',
      'clickup',
      'task-1',
      { status: 'Done', workspaceId: 'browser-controlled' },
    ],
    [
      'rich comment object',
      'addTaskComment',
      'clickup',
      'task-1',
      { text: { content: 'not plain text' } },
    ],
  ])('rejects %s before action dispatch', async (_case, method, provider, taskId, body) => {
    const operation = (
      controller[method as keyof ExternalMyWorkController] as unknown as (
        provider: string,
        taskId: string,
        body?: unknown,
      ) => Promise<unknown>
    ).bind(controller);

    await expect(operation(provider, taskId, body)).rejects.toBeInstanceOf(ValidationError);
    expect(service.getTaskDetail).not.toHaveBeenCalled();
    expect(service.changeTaskStatus).not.toHaveBeenCalled();
    expect(service.addTaskComment).not.toHaveBeenCalled();
  });

  it.each([
    [
      'browser Workspace authority',
      {
        startedAt: '2026-08-19T10:00:00.000Z',
        durationMs: 60_000,
        workspaceId: 'browser-controlled',
      },
    ],
    ['negative duration', { startedAt: '2026-08-19T10:00:00.000Z', durationMs: -1 }],
  ])('rejects a time-entry create with %s before dispatch', async (_case, body) => {
    await expect(
      controller.addTaskTimeEntry(
        'clickup',
        'task-1',
        '4',
        'op-1',
        body,
        'workspace-1',
        PROJECT_ID,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(timeMutations.createTimeEntry).not.toHaveBeenCalled();
  });

  describe('gated rich content routes', () => {
    const SESSION_ID = '3f2a1b8e-0000-4000-8000-000000000000';

    it('dispatches the stateless rich-description read', async () => {
      editSessions.readRichDescription.mockResolvedValue({ supported: true });
      await controller.readRichDescription('jira', 'KAN-1', PROJECT_ID);
      expect(editSessions.readRichDescription).toHaveBeenCalledWith(PROJECT_ID, 'jira', 'KAN-1');
    });

    it('rejects an unknown provider on the rich-description read', async () => {
      await expect(
        controller.readRichDescription('github', 'KAN-1', PROJECT_ID),
      ).rejects.toBeInstanceOf(ValidationError);
      expect(editSessions.readRichDescription).not.toHaveBeenCalled();
    });

    it('dispatches the comment-edit session with an optional lookup token', async () => {
      editSessions.createCommentEditSession.mockResolvedValue({ sessionId: SESSION_ID });
      await controller.createCommentEditSession(
        'clickup',
        'task-1',
        'c1',
        { lookupToken: 'v1:abc' },
        PROJECT_ID,
      );
      expect(editSessions.createCommentEditSession).toHaveBeenCalledWith(
        PROJECT_ID,
        'clickup',
        'task-1',
        'c1',
        'v1:abc',
      );
      await controller.createCommentEditSession('jira', 'ENG-1', 'c1', {}, PROJECT_ID);
      expect(editSessions.createCommentEditSession).toHaveBeenLastCalledWith(
        PROJECT_ID,
        'jira',
        'ENG-1',
        'c1',
        null,
      );
    });

    it('rejects a malformed lookup token without dispatch', async () => {
      await expect(
        controller.createCommentEditSession(
          'clickup',
          'task-1',
          'c1',
          { lookupToken: '' },
          PROJECT_ID,
        ),
      ).rejects.toBeInstanceOf(ValidationError);
      expect(editSessions.createCommentEditSession).not.toHaveBeenCalled();
    });

    it('dispatches save with a validated revision and reload by session id', async () => {
      editSessions.saveSession.mockResolvedValue({ outcome: 'saved', revision: 1 });
      editSessions.reloadSession.mockResolvedValue({ status: 'reloaded' });
      const document = { version: 1, blocks: [] };

      await controller.saveSession(SESSION_ID, { document, revision: 0 }, PROJECT_ID);
      expect(editSessions.saveSession).toHaveBeenCalledWith(PROJECT_ID, SESSION_ID, document, 0);

      await controller.reloadSession(SESSION_ID, PROJECT_ID);
      expect(editSessions.reloadSession).toHaveBeenCalledWith(PROJECT_ID, SESSION_ID);
    });

    it('rejects save bodies with a missing revision or unknown fields', async () => {
      await expect(
        controller.saveSession(SESSION_ID, { document: {} }, PROJECT_ID),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        controller.saveSession(
          SESSION_ID,
          {
            document: { version: 1, blocks: [] },
            revision: 0,
            force: true,
          },
          PROJECT_ID,
        ),
      ).rejects.toBeInstanceOf(ValidationError);
      expect(editSessions.saveSession).not.toHaveBeenCalled();
    });

    it('rejects a non-uuid session id on every session route', async () => {
      await expect(controller.touchSession('not-a-uuid', PROJECT_ID)).rejects.toBeInstanceOf(
        ValidationError,
      );
      await expect(controller.verifySession('not-a-uuid', PROJECT_ID)).rejects.toBeInstanceOf(
        ValidationError,
      );
      await expect(
        controller.saveSession('not-a-uuid', { document: {}, revision: 0 }, PROJECT_ID),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(controller.reloadSession('not-a-uuid', PROJECT_ID)).rejects.toBeInstanceOf(
        ValidationError,
      );
      await expect(
        controller.executeCommentDelete('not-a-uuid', PROJECT_ID),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });
});
