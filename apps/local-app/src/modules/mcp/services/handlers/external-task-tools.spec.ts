import type { ExternalTaskGetResponse } from '../../dtos/mcp.dto';
import type { ExternalTaskToolContext } from './external-task-context';
import { handleExternalTasksGet } from './external-task-tools';

const SESSION_ID = '00000000-0000-0000-0000-000000000001';
const PROJECT_ID = '00000000-0000-0000-0000-000000000002';
const AGENT_ID = '00000000-0000-0000-0000-000000000003';

const resolved = {
  provider: 'jira',
  linkedEpicId: 'epic-1',
  detail: {
    remoteId: 'ENG-1',
    remoteKey: 'ENG-1',
    title: 'Ship links',
    description: 'Body',
    descriptionTruncated: true,
    status: { remoteId: 's', name: 'In Progress', color: '#000', category: 'active', position: 0 },
    dueAt: null,
    priority: { name: 'High', color: '#f00' },
    subtasks: [
      {
        remoteId: 'ENG-2',
        remoteKey: 'ENG-2',
        title: 'Child',
        status: { remoteId: 's2', name: 'Done', category: 'completed' },
        webUrl: 'https://acme.atlassian.net/browse/ENG-2',
      },
    ],
    subtasksTruncated: false,
    taskTotalDurationMs: 60_000,
    webUrl: 'https://acme.atlassian.net/browse/ENG-1',
    location: { scopeKey: 'acme.atlassian.net', workAreaId: 'p', workAreaName: 'Engineering' },
    allowedStatuses: [],
    actions: [],
  },
  link: {
    sourceSnapshot: { webUrl: 'https://acme.atlassian.net/browse/ENG-1' },
  },
};

function ctxWith(overrides: Partial<ExternalTaskToolContext> = {}): ExternalTaskToolContext {
  return {
    externalTaskResolver: { resolve: jest.fn().mockResolvedValue(resolved) } as never,
    admitExternalTasks: () => true,
    resolveSessionContext: jest.fn().mockResolvedValue({
      success: true,
      data: {
        type: 'agent',
        session: { id: SESSION_ID, agentId: AGENT_ID, status: 'running', startedAt: '' },
        agent: { id: AGENT_ID, name: 'Coder', projectId: PROJECT_ID },
        project: { id: PROJECT_ID, name: 'Project', rootPath: '/p' },
      },
    }),
    ...overrides,
  };
}

describe('handleExternalTasksGet', () => {
  it.each([
    ['URL', 'https://acme.atlassian.net/browse/ENG-1', undefined],
    ['key', 'eng-1', 'jira' as const],
    ['id', '10001', undefined],
  ])('reads a task by %s in the session project', async (_name, ref, provider) => {
    const ctx = ctxWith();

    const result = await handleExternalTasksGet(ctx, { sessionId: SESSION_ID, ref, provider });

    expect(ctx.externalTaskResolver.resolve).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      ref,
      provider,
    });
    expect(result.data).toEqual<ExternalTaskGetResponse>({
      provider: 'jira',
      remoteKey: 'ENG-1',
      remoteId: 'ENG-1',
      title: 'Ship links',
      description: 'Body',
      descriptionTruncated: true,
      status: { name: 'In Progress', category: 'active' },
      webUrl: 'https://acme.atlassian.net/browse/ENG-1',
      location: { scopeKey: 'acme.atlassian.net', workAreaId: 'p', workAreaName: 'Engineering' },
      subtasks: [
        {
          remoteId: 'ENG-2',
          remoteKey: 'ENG-2',
          title: 'Child',
          status: { name: 'Done', category: 'completed' },
          webUrl: 'https://acme.atlassian.net/browse/ENG-2',
        },
      ],
      subtasksTruncated: false,
      linkedEpicId: 'epic-1',
    });
  });

  it('refuses with INTEGRATIONS_UNAVAILABLE before any vendor read', async () => {
    const ctx = ctxWith({ admitExternalTasks: () => false });

    const result = await handleExternalTasksGet(ctx, { sessionId: SESSION_ID, ref: 'ENG-1' });

    expect(result.error?.code).toBe('INTEGRATIONS_UNAVAILABLE');
    expect(ctx.externalTaskResolver.resolve).not.toHaveBeenCalled();
  });
});
