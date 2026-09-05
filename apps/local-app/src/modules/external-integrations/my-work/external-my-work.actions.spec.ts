import { ValidationError } from '../../../common/errors/error-types';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import type { ExternalTaskLink } from '../../storage/models/domain.models';
import { ExternalTaskProviderRegistry } from '../external-task-provider.registry';
import type { ExternalTaskProvider } from '../ports/external-task-provider';
import { ExternalMyWorkService } from './external-my-work.service';

describe('ExternalMyWorkService task details and actions', () => {
  const projectId = 'project-1';
  const discover = jest.fn();
  const getTaskDetail = jest.fn();
  const listComments = jest.fn();
  const changeStatus = jest.fn();
  const addComment = jest.fn();
  const getTimeEntryHistory = jest.fn();
  const clickup: ExternalTaskProvider = {
    provider: 'clickup',
    descriptor: {
      provider: 'clickup',
      displayName: 'ClickUp',
      capabilities: { myWork: true },
    },
    verifyCredentials: jest.fn(),
    myWork: {
      discover,
      getTaskDetail,
      listComments,
      changeStatus,
      addComment,
      getTimeEntryHistory,
    },
  } as ExternalTaskProvider;
  const jira: ExternalTaskProvider = {
    provider: 'jira',
    descriptor: {
      provider: 'jira',
      displayName: 'Jira',
      capabilities: { myWork: false },
    },
    verifyCredentials: jest.fn(),
  };
  const connection = {
    id: 'connection-clickup',
    projectId,
    legacySourceConnectionId: null,
    provider: 'clickup' as const,
    generation: 4,
    createdAt: '2026-08-19T10:00:00.000Z',
    updatedAt: '2026-08-19T11:00:00.000Z',
  };
  const credentials = { provider: 'clickup' as const, token: 'secret-token' };
  const detail = {
    remoteId: 'task-1',
    remoteKey: 'DEV-1',
    title: 'Ship generic actions',
    description: 'Bounded plain text',
    descriptionTruncated: false,
    status: {
      remoteId: 'progress',
      name: 'In Progress',
      color: '#7c4dff',
      category: 'active' as const,
      position: 1,
    },
    dueAt: '2026-08-22T12:00:00.000Z',
    priority: { name: 'normal', color: '#f8ae00' },
    subtasks: [
      {
        remoteId: 'child-1',
        remoteKey: 'DEV-2',
        title: 'Child task',
        status: { remoteId: 'todo', name: 'To Do', category: 'active' as const },
        webUrl: 'https://app.clickup.com/t/child-1',
      },
    ],
    subtasksTruncated: false,
    taskTotalDurationMs: 3_600_000,
    webUrl: 'https://app.clickup.com/t/task-1',
    location: {
      scopeKey: 'workspace-1',
      workAreaId: 'list-1',
      workAreaName: 'Sprint',
    },
    allowedStatuses: [
      {
        actionValue: 'In Progress',
        remoteId: 'progress',
        remoteStatusIds: ['progress'],
        name: 'In Progress',
        color: '#7c4dff',
        category: 'active' as const,
        position: 1,
      },
    ],
    actions: [
      { action: 'change_status' as const, supported: true },
      { action: 'add_comment' as const, supported: true },
      { action: 'log_time' as const, supported: true },
    ],
  };

  let storage: jest.Mocked<
    Pick<
      StorageService,
      | 'getIntegrationConnection'
      | 'getIntegrationConnectionCredentials'
      | 'findExternalTaskLink'
      | 'listExternalTaskLinksByRemoteScope'
      | 'listExternalEstimateLoggedMinutes'
      | 'getEpic'
      | 'getProject'
    >
  >;
  let service: ExternalMyWorkService;

  beforeEach(() => {
    jest.clearAllMocks();
    storage = {
      getIntegrationConnection: jest.fn().mockResolvedValue(connection),
      getIntegrationConnectionCredentials: jest.fn().mockResolvedValue(credentials),
      findExternalTaskLink: jest.fn().mockResolvedValue(null),
      listExternalTaskLinksByRemoteScope: jest.fn().mockResolvedValue([]),
      listExternalEstimateLoggedMinutes: jest.fn().mockResolvedValue([]),
      getEpic: jest.fn(),
      getProject: jest.fn().mockResolvedValue({ id: projectId, name: 'Product' }),
    };
    service = new ExternalMyWorkService(
      storage as unknown as StorageService,
      new ExternalTaskProviderRegistry([clickup, jira]),
    );
  });

  it('combines provider detail with the current DevChain link state', async () => {
    const link: ExternalTaskLink = {
      id: 'link-1',
      epicId: 'epic-1',
      connectionId: 'connection-clickup',
      provider: 'clickup',
      remoteScopeKey: 'workspace-1',
      remoteTaskId: 'task-1',
      sourceSnapshot: {},
      createdAt: '2026-08-19T10:00:00.000Z',
      updatedAt: '2026-08-19T10:00:00.000Z',
    };
    getTaskDetail.mockResolvedValue(detail);
    storage.findExternalTaskLink.mockResolvedValue(link);
    storage.getEpic.mockResolvedValue({ id: 'epic-1', projectId });

    await expect(service.getTaskDetail(projectId, 'clickup', 'task-1')).resolves.toEqual({
      ...detail,
      linkState: { linked: true, epicId: 'epic-1' },
    });
    expect(getTaskDetail).toHaveBeenCalledWith(
      credentials,
      { connectionId: 'connection-clickup', connectionGeneration: 4 },
      'task-1',
    );
    expect(storage.findExternalTaskLink).toHaveBeenCalledWith('clickup', 'workspace-1', 'task-1');
  });

  it('returns an unlinked state without exposing storage or vendor extras', async () => {
    getTaskDetail.mockResolvedValue({
      ...detail,
      subtasks: detail.subtasks.map((subtask) => ({
        ...subtask,
        providerExtra: 'child-secret',
        status: { ...subtask.status, providerStatusExtra: 'status-secret' },
      })),
      allowedStatuses: detail.allowedStatuses.map((option) => ({
        ...option,
        vendorExtra: 'internal',
        transitionUrl: 'secret',
      })),
    });

    const result = await service.getTaskDetail(projectId, 'clickup', 'task-1');

    expect(result.linkState).toEqual({ linked: false, epicId: null });
    expect(result.subtasks).toEqual(detail.subtasks);
    expect(result.allowedStatuses).toEqual(detail.allowedStatuses);
    expect(JSON.stringify(result)).not.toMatch(
      /connectionId|sourceSnapshot|secret-token|vendorExtra|transitionUrl|providerExtra|child-secret|providerStatusExtra|status-secret/,
    );
  });

  it('does not expose a global task link owned by another project connection', async () => {
    getTaskDetail.mockResolvedValue(detail);
    storage.findExternalTaskLink.mockResolvedValue({
      id: 'other-link',
      epicId: 'other-epic',
      connectionId: 'project-2-clickup-connection',
      provider: 'clickup',
      remoteScopeKey: 'workspace-1',
      remoteTaskId: 'task-1',
      sourceSnapshot: {},
      createdAt: '',
      updatedAt: '',
    });

    await expect(service.getTaskDetail(projectId, 'clickup', 'task-1')).resolves.toMatchObject({
      linkState: { linked: false, epicId: null },
    });

    expect(storage.getEpic).not.toHaveBeenCalled();
  });

  it('suppresses batch links fenced to another project connection', async () => {
    storage.listExternalTaskLinksByRemoteScope.mockResolvedValue([
      {
        id: 'other-link',
        epicId: 'other-epic',
        connectionId: 'project-2-clickup-connection',
        provider: 'clickup',
        remoteScopeKey: 'workspace-1',
        remoteTaskId: 'task-1',
        sourceSnapshot: {},
        createdAt: '',
        updatedAt: '',
      },
    ]);

    await expect(
      service.getTaskLinkStates(projectId, 'clickup', [
        { scopeKey: 'workspace-1', taskId: 'task-1' },
      ]),
    ).resolves.toEqual({
      items: [
        {
          scopeKey: 'workspace-1',
          taskId: 'task-1',
          linked: false,
          epicId: null,
          projectId: null,
          projectName: null,
          loggedMinutes: null,
        },
      ],
    });
    expect(storage.getEpic).not.toHaveBeenCalled();
    expect(storage.listExternalEstimateLoggedMinutes).not.toHaveBeenCalled();
  });

  it('resolves card link state in one lookup per remote scope with linked project names', async () => {
    storage.listExternalTaskLinksByRemoteScope.mockResolvedValue([
      {
        id: 'link-1',
        epicId: 'epic-1',
        connectionId: connection.id,
        provider: 'clickup',
        remoteScopeKey: 'workspace-1',
        remoteTaskId: 'task-1',
        sourceSnapshot: {},
        createdAt: '2026-08-19T10:00:00.000Z',
        updatedAt: '2026-08-19T10:00:00.000Z',
      },
    ]);
    storage.getEpic.mockResolvedValue({ id: 'epic-1', projectId });

    await expect(
      service.getTaskLinkStates(projectId, 'clickup', [
        { scopeKey: 'workspace-1', taskId: 'task-1' },
        { scopeKey: 'workspace-1', taskId: 'task-2' },
      ]),
    ).resolves.toEqual({
      items: [
        {
          scopeKey: 'workspace-1',
          taskId: 'task-1',
          linked: true,
          epicId: 'epic-1',
          projectId: 'project-1',
          projectName: 'Product',
          loggedMinutes: null,
        },
        {
          scopeKey: 'workspace-1',
          taskId: 'task-2',
          linked: false,
          epicId: null,
          projectId: null,
          projectName: null,
          loggedMinutes: null,
        },
      ],
    });
    expect(storage.listExternalTaskLinksByRemoteScope).toHaveBeenCalledTimes(1);
    expect(storage.listExternalEstimateLoggedMinutes).not.toHaveBeenCalled();
  });

  it('projects logged minutes from one set-based read when includeLoggedMinutes is requested', async () => {
    storage.listExternalTaskLinksByRemoteScope.mockResolvedValue([
      {
        id: 'link-1',
        epicId: 'epic-1',
        connectionId: connection.id,
        provider: 'clickup',
        remoteScopeKey: 'workspace-1',
        remoteTaskId: 'task-1',
        sourceSnapshot: {},
        createdAt: '2026-08-19T10:00:00.000Z',
        updatedAt: '2026-08-19T10:00:00.000Z',
      },
      {
        id: 'link-2',
        epicId: 'epic-2',
        connectionId: connection.id,
        provider: 'clickup',
        remoteScopeKey: 'workspace-1',
        remoteTaskId: 'task-2',
        sourceSnapshot: {},
        createdAt: '2026-08-19T10:00:00.000Z',
        updatedAt: '2026-08-19T10:00:00.000Z',
      },
    ]);
    storage.getEpic.mockImplementation(async (epicId: string) =>
      epicId === 'epic-1' ? { id: 'epic-1', projectId } : { id: 'epic-2', projectId },
    );
    storage.listExternalEstimateLoggedMinutes.mockResolvedValue([
      { remoteScopeKey: 'workspace-1', remoteTaskId: 'task-1', loggedMinutes: 75 },
    ]);

    await expect(
      service.getTaskLinkStates(
        projectId,
        'clickup',
        [
          { scopeKey: 'workspace-1', taskId: 'task-1' },
          { scopeKey: 'workspace-1', taskId: 'task-2' },
          { scopeKey: 'workspace-1', taskId: 'task-3' },
        ],
        { includeLoggedMinutes: true },
      ),
    ).resolves.toEqual({
      items: [
        {
          scopeKey: 'workspace-1',
          taskId: 'task-1',
          linked: true,
          epicId: 'epic-1',
          projectId: 'project-1',
          projectName: 'Product',
          loggedMinutes: 75,
        },
        {
          scopeKey: 'workspace-1',
          taskId: 'task-2',
          linked: true,
          epicId: 'epic-2',
          projectId: 'project-1',
          projectName: 'Product',
          loggedMinutes: 0,
        },
        {
          scopeKey: 'workspace-1',
          taskId: 'task-3',
          linked: false,
          epicId: null,
          projectId: null,
          projectName: null,
          loggedMinutes: null,
        },
      ],
    });
    // Only the authorized linked identities reach the checkpoint read.
    expect(storage.listExternalEstimateLoggedMinutes).toHaveBeenCalledTimes(1);
    expect(storage.listExternalEstimateLoggedMinutes).toHaveBeenCalledWith('clickup', [
      { remoteScopeKey: 'workspace-1', remoteTaskId: 'task-1' },
      { remoteScopeKey: 'workspace-1', remoteTaskId: 'task-2' },
    ]);
  });

  it('never lets an orphan checkpoint row establish linkage or leak minutes', async () => {
    storage.getEpic.mockResolvedValue({ id: 'epic-1', projectId });
    storage.listExternalEstimateLoggedMinutes.mockResolvedValue([
      { remoteScopeKey: 'workspace-1', remoteTaskId: 'task-1', loggedMinutes: 55 },
    ]);

    const result = await service.getTaskLinkStates(
      projectId,
      'clickup',
      [{ scopeKey: 'workspace-1', taskId: 'task-1' }],
      { includeLoggedMinutes: true },
    );

    expect(result.items).toEqual([
      {
        scopeKey: 'workspace-1',
        taskId: 'task-1',
        linked: false,
        epicId: null,
        projectId: null,
        projectName: null,
        loggedMinutes: null,
      },
    ]);
    // No linked identity survived the authority checks, so no checkpoint read ran.
    expect(storage.listExternalEstimateLoggedMinutes).not.toHaveBeenCalled();
  });

  it('projects normalized comment pages without exposing vendor extras', async () => {
    listComments.mockResolvedValue({
      comments: [
        {
          remoteId: 'comment-1',
          author: { remoteId: '183', displayName: 'John Doe' },
          body: 'Ready for review',
          bodyTruncated: false,
          rich: {
            document: { version: 1, blocks: [] },
            supported: true,
          },
          lookupToken: 'v1:lookup-token',
          createdAt: '2026-08-19T12:00:00.000Z',
          updatedAt: null,
          email: 'vendor-extra@example.com',
        },
      ],
      nextCursor: 'MTA',
    });

    await expect(service.listTaskComments(projectId, 'clickup', 'task-1', 'MTA')).resolves.toEqual({
      comments: [
        {
          remoteId: 'comment-1',
          author: { remoteId: '183', displayName: 'John Doe' },
          body: 'Ready for review',
          bodyTruncated: false,
          rich: {
            document: { version: 1, blocks: [] },
            supported: true,
          },
          lookupToken: 'v1:lookup-token',
          owned: false,
          createdAt: '2026-08-19T12:00:00.000Z',
          updatedAt: null,
        },
      ],
      nextCursor: 'MTA',
    });
    expect(listComments).toHaveBeenCalledWith(
      credentials,
      { connectionId: 'connection-clickup', connectionGeneration: 4 },
      'task-1',
      'MTA',
    );
    expect(
      JSON.stringify(await service.listTaskComments(projectId, 'clickup', 'task-1', null)),
    ).not.toMatch(/vendor-extra/);
  });

  it('projects the time-entry history without exposing vendor extras', async () => {
    getTimeEntryHistory.mockResolvedValue({
      windowDays: 30,
      entries: [
        {
          remoteId: '10001',
          durationMs: 3_600_000,
          startedAt: '2026-08-19T10:00:00.000Z',
          note: 'Implementation',
          noteTruncated: false,
          canEdit: true,
          canDelete: true,
          billable: true,
          authorEmail: 'vendor-extra@example.com',
          taskUrl: 'https://vendor.example/task',
        },
      ],
      truncated: false,
      hasRunningTimer: true,
    });

    await expect(service.getTimeEntryHistory(projectId, 'clickup', 'task-1', 4)).resolves.toEqual({
      windowDays: 30,
      entries: [
        {
          remoteId: '10001',
          durationMs: 3_600_000,
          startedAt: '2026-08-19T10:00:00.000Z',
          note: 'Implementation',
          noteTruncated: false,
          canEdit: true,
          canDelete: true,
        },
      ],
      truncated: false,
      hasRunningTimer: true,
    });
    expect(getTimeEntryHistory).toHaveBeenCalledWith(
      credentials,
      { connectionId: 'connection-clickup', connectionGeneration: 4 },
      'task-1',
    );
    expect(
      JSON.stringify(await service.getTimeEntryHistory(projectId, 'clickup', 'task-1', 4)),
    ).not.toMatch(/billable|authorEmail|taskUrl|vendor-extra/);
  });

  it('never dispatches time history through credentials from a replacement generation', async () => {
    storage.getIntegrationConnection
      .mockResolvedValueOnce(connection)
      .mockResolvedValueOnce({ ...connection, generation: 5 });
    storage.getIntegrationConnectionCredentials.mockResolvedValue({
      provider: 'clickup',
      token: 'replacement-token',
    });

    await expect(
      service.getTimeEntryHistory(projectId, 'clickup', 'task-1', 4),
    ).rejects.toMatchObject({
      code: 'conflict',
      details: {
        projectId,
        provider: 'clickup',
        reason: 'connection_epoch_mismatch',
        expectedEpoch: 4,
        currentEpoch: 5,
      },
    });

    expect(storage.getIntegrationConnectionCredentials).toHaveBeenCalledWith({
      projectId,
      provider: 'clickup',
    });
    expect(getTimeEntryHistory).not.toHaveBeenCalled();
  });

  it('delegates each supported write once and returns normalized refresh hints', async () => {
    await expect(
      service.changeTaskStatus(projectId, 'clickup', 'task-1', { status: 'Complete' }),
    ).resolves.toEqual({
      remoteTaskId: 'task-1',
      action: 'change_status',
      succeeded: true,
      refresh: ['my_work', 'task_detail'],
    });
    await expect(
      service.addTaskComment(projectId, 'clickup', 'task-1', {
        text: 'Ready for review',
        notifyAll: false,
      }),
    ).resolves.toEqual({
      remoteTaskId: 'task-1',
      action: 'add_comment',
      succeeded: true,
      refresh: ['my_work', 'task_detail'],
    });
    const context = { connectionId: 'connection-clickup', connectionGeneration: 4 };
    expect(changeStatus).toHaveBeenCalledTimes(1);
    expect(changeStatus).toHaveBeenCalledWith(credentials, context, 'task-1', {
      status: 'Complete',
    });
    expect(addComment).toHaveBeenCalledTimes(1);
    expect(addComment).toHaveBeenCalledWith(credentials, context, 'task-1', {
      text: 'Ready for review',
      notifyAll: false,
    });
  });

  it('rejects unsupported detail and action capabilities with safe errors', async () => {
    storage.getIntegrationConnection.mockResolvedValue({
      ...connection,
      id: 'connection-jira',
      provider: 'jira',
    });
    storage.getIntegrationConnectionCredentials.mockResolvedValue({
      provider: 'jira',
      siteUrl: 'https://acme.atlassian.net',
      email: 'private@example.com',
      token: 'jira-secret-token',
    });

    for (const operation of [
      () => service.getTaskDetail(projectId, 'jira', 'TASK-1'),
      () => service.changeTaskStatus(projectId, 'jira', 'TASK-1', { status: 'Done' }),
      () =>
        service.addTaskComment(projectId, 'jira', 'TASK-1', { text: 'Comment', notifyAll: false }),
      () => service.getTimeEntryHistory(projectId, 'jira', 'TASK-1', 4),
    ]) {
      const promise = operation();
      await expect(promise).rejects.toBeInstanceOf(ValidationError);
      await expect(promise).rejects.not.toThrow(/token|email|atlassian/i);
    }
    expect(getTaskDetail).not.toHaveBeenCalled();
    expect(changeStatus).not.toHaveBeenCalled();
    expect(addComment).not.toHaveBeenCalled();
    expect(getTimeEntryHistory).not.toHaveBeenCalled();
  });
});
