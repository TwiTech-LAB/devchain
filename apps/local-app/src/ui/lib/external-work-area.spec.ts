import type { ExternalMyWorkResult } from '@/modules/external-integrations/models/external-provider.models';
import { buildExternalWorkAreaBoard } from './external-work-area';

type Snapshot = Extract<ExternalMyWorkResult, { supported: true }>;

function snapshot(provider: 'clickup' | 'jira'): Snapshot {
  const columns =
    provider === 'jira'
      ? [
          {
            remoteId: null,
            remoteStatusIds: ['status-open', 'status-ready'],
            name: 'To do',
            color: '#6b778c',
            category: 'active' as const,
            position: 0,
          },
          {
            remoteId: null,
            remoteStatusIds: ['status-done'],
            name: 'Finished',
            color: '#36b37e',
            category: 'completed' as const,
            position: 1,
          },
        ]
      : [
          {
            remoteId: 'open',
            name: 'OPEN',
            color: '#87909e',
            category: 'active' as const,
            position: 0,
          },
          {
            remoteId: 'done',
            name: 'DONE',
            color: '#36b37e',
            category: 'completed' as const,
            position: 1,
          },
        ];
  const area = {
    remoteId: 'area-1',
    scopeKey: 'scope-1',
    name: 'Delivery',
    kind: 'board' as const,
    description: null,
    assignedTaskCount: 2,
    hierarchy: [],
    workflow: { isOverridden: true, columns },
    refresh: { state: 'fresh' as const, refreshedAt: null, retryable: false, retryAt: null },
  };
  return {
    provider,
    descriptor: { provider, displayName: provider, capabilities: { myWork: true } },
    supported: true,
    capabilities: { timeTrackingEnabled: true },
    workAreas: [area],
    tasks: [
      {
        workArea: area,
        task: {
          remoteId: 'task-1',
          title: 'First',
          status: {
            remoteId: provider === 'jira' ? 'status-ready' : 'open',
            name: provider === 'jira' ? 'Ready for development' : 'OPEN',
            category: 'active',
          },
          updatedAt: '2026-08-19T10:00:00.000Z',
          dueAt: null,
          completedAt: null,
          webUrl: null,
        },
      },
      {
        workArea: area,
        task: {
          remoteId: 'task-2',
          title: 'Second',
          status: {
            remoteId: provider === 'jira' ? 'status-done' : 'unexpected',
            name: provider === 'jira' ? 'Released' : 'BLOCKED',
            category: provider === 'jira' ? 'completed' : 'active',
          },
          updatedAt: '2026-08-19T11:00:00.000Z',
          dueAt: null,
          completedAt: null,
          webUrl: null,
        },
      },
    ],
    refreshedAt: '2026-08-19T12:00:00.000Z',
  };
}

describe('buildExternalWorkAreaBoard', () => {
  it('keeps Jira board configuration order while placing exact remote statuses by id', () => {
    const board = buildExternalWorkAreaBoard('jira', snapshot('jira'), 'area-1');

    expect(board?.columns.map(({ name }) => name)).toEqual(['To do', 'Finished']);
    expect(board?.columns[0].tasks[0]).toMatchObject({
      remoteId: 'task-1',
      statusName: 'Ready for development',
    });
    expect(board?.columns[1].tasks[0]).toMatchObject({
      remoteId: 'task-2',
      statusName: 'Released',
    });
  });

  it('adds ClickUp Other after configured statuses without changing the exact task status', () => {
    const board = buildExternalWorkAreaBoard('clickup', snapshot('clickup'), 'area-1');

    expect(board?.columns.map(({ name }) => name)).toEqual(['OPEN', 'DONE', 'Other']);
    expect(board?.columns[2].tasks[0]).toMatchObject({
      remoteId: 'task-2',
      statusName: 'BLOCKED',
    });
  });

  it('builds other-assigned columns from exact observed Jira statuses in observation order', () => {
    const value = snapshot('jira');
    value.workAreas[0] = {
      ...value.workAreas[0],
      remoteId: 'other-assigned',
      name: 'Other assigned issues',
      workflow: { isOverridden: false, columns: [] },
    };
    value.tasks = value.tasks.map((item) => ({ ...item, workArea: value.workAreas[0] }));

    const board = buildExternalWorkAreaBoard('jira', value, 'other-assigned');

    expect(board?.columns.map(({ name }) => name)).toEqual(['Ready for development', 'Released']);
    expect(board?.columns.flatMap(({ tasks }) => tasks)).toHaveLength(2);
    // Observed status order, so directional movement is not offered.
    expect(board?.workflowOrdered).toBe(false);
  });

  it('reports workflow order for a normal work area', () => {
    expect(buildExternalWorkAreaBoard('jira', snapshot('jira'), 'area-1')?.workflowOrdered).toBe(
      true,
    );
  });
});
