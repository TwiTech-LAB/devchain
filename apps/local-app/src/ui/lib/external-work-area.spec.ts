import type {
  ExternalMyWorkResult,
  ExternalTaskSummary,
} from '@/modules/external-integrations/models/external-provider.models';
import { buildExternalWorkAreaBoard, projectExternalTaskHierarchy } from './external-work-area';

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
          parentRemoteTaskId: null,
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
          parentRemoteTaskId: null,
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

function hierarchyTask(
  remoteId: string,
  parentRemoteTaskId: string | null,
  overrides: Partial<ExternalTaskSummary> = {},
): ExternalTaskSummary {
  return {
    remoteId,
    parentRemoteTaskId,
    title: `Task ${remoteId}`,
    status: { remoteId: 'open', name: 'OPEN', category: 'active' },
    updatedAt: '2026-08-19T10:00:00.000Z',
    dueAt: null,
    completedAt: null,
    webUrl: null,
    ...overrides,
  };
}

// Layer: pure unit. The hierarchy projection is a deterministic pure function
// over a plain task array — nesting, grouped counts, and cycle safety are
// visible directly in the returned structures, so no cache or DOM is needed.
describe('projectExternalTaskHierarchy', () => {
  it('nests an eligible child only beneath a present root parent', () => {
    const parent = hierarchyTask('parent', null);
    const child = hierarchyTask('child', 'parent');
    const orphan = hierarchyTask('orphan', 'missing');

    const projection = projectExternalTaskHierarchy([parent, child, orphan]);

    expect(projection.visibleTasks.map(({ remoteId }) => remoteId)).toEqual(['parent', 'orphan']);
    expect([...projection.nestedTaskIds]).toEqual(['child']);
  });

  it('nests the middle task in a three-level chain and keeps deeper descendants visible', () => {
    const root = hierarchyTask('root', null);
    const middle = hierarchyTask('middle', 'root');
    const child = hierarchyTask('child', 'middle');
    const deepest = hierarchyTask('deepest', 'child');

    expect(projectExternalTaskHierarchy([root, middle, child]).visibleTasks).toEqual([root, child]);
    const fourLevel = projectExternalTaskHierarchy([root, middle, child, deepest]);
    expect(fourLevel.visibleTasks).toEqual([root, child, deepest]);
    expect([...fourLevel.nestedTaskIds]).toEqual(['middle']);
  });

  it('keeps self-parent and two-node cycles visible', () => {
    const self = hierarchyTask('self', 'self');
    const left = hierarchyTask('left', 'right');
    const right = hierarchyTask('right', 'left');

    const projection = projectExternalTaskHierarchy([self, left, right]);

    expect(projection.visibleTasks).toEqual([self, left, right]);
    expect(projection.nestedTaskIds.size).toBe(0);
  });

  it('promotes an active child when its completed parent is filtered out', () => {
    const parent = hierarchyTask('parent', null, {
      status: { remoteId: 'done', name: 'DONE', category: 'completed' },
    });
    const child = hierarchyTask('child', 'parent');

    expect(projectExternalTaskHierarchy([parent, child]).visibleTasks).toEqual([parent]);
    expect(projectExternalTaskHierarchy([child]).visibleTasks).toEqual([child]);
  });

  it('counts grouped children only on the parent that hides them', () => {
    const parent = hierarchyTask('parent', null);
    const firstChild = hierarchyTask('first-child', 'parent');
    const secondChild = hierarchyTask('second-child', 'parent');
    const orphan = hierarchyTask('orphan', 'missing');

    const projection = projectExternalTaskHierarchy([parent, firstChild, secondChild, orphan]);

    expect(projection.groupedChildCountByParentId).toEqual(new Map([['parent', 2]]));
  });

  it('keeps self-parent and cyclic tasks out of every grouped count', () => {
    const self = hierarchyTask('self', 'self');
    const left = hierarchyTask('left', 'right');
    const right = hierarchyTask('right', 'left');

    const projection = projectExternalTaskHierarchy([self, left, right]);

    expect(projection.groupedChildCountByParentId.size).toBe(0);
  });

  it('keeps deeper descendants visible without inflating a grouped count', () => {
    const root = hierarchyTask('root', null);
    const middle = hierarchyTask('middle', 'root');
    const child = hierarchyTask('child', 'middle');
    const deepest = hierarchyTask('deepest', 'child');

    const projection = projectExternalTaskHierarchy([root, middle, child, deepest]);

    expect(projection.visibleTasks.map(({ remoteId }) => remoteId)).toEqual([
      'root',
      'child',
      'deepest',
    ]);
    expect(projection.groupedChildCountByParentId).toEqual(new Map([['root', 1]]));
  });

  it('drops a grouped count when the child leaves the snapshot and retains a completed child', () => {
    const parent = hierarchyTask('parent', null);
    const completedChild = hierarchyTask('child', 'parent', {
      status: { remoteId: 'done', name: 'DONE', category: 'completed' },
    });

    // Completed-inclusive data keeps the child, so the parent keeps its count.
    expect(
      projectExternalTaskHierarchy([parent, completedChild]).groupedChildCountByParentId,
    ).toEqual(new Map([['parent', 1]]));
    // Active-only data excludes the completed child, so no count remains.
    expect(projectExternalTaskHierarchy([parent]).groupedChildCountByParentId.size).toBe(0);
  });
});

// Layer: pure unit. Board building maps already-projected tasks into column
// shapes deterministically; asserting on the returned columns is cheaper and
// more exact than rendering them through a component first.
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

  it('groups before ClickUp Other so a hidden child never reappears', () => {
    const value = snapshot('clickup');
    const workArea = value.workAreas[0];
    value.tasks = [
      { workArea, task: hierarchyTask('parent', null) },
      {
        workArea,
        task: hierarchyTask('child', 'parent', {
          status: { remoteId: 'unexpected', name: 'BLOCKED', category: 'active' },
        }),
      },
    ];

    const board = buildExternalWorkAreaBoard('clickup', value, 'area-1');

    expect(board?.columns.map(({ name }) => name)).toEqual(['OPEN', 'DONE']);
    expect(board?.columns.flatMap(({ tasks }) => tasks).map(({ remoteId }) => remoteId)).toEqual([
      'parent',
    ]);
  });

  it('groups Jira tasks inside each exact board without hiding a cross-board orphan', () => {
    const value = snapshot('jira');
    const firstArea = value.workAreas[0];
    const secondArea = { ...firstArea, remoteId: 'area-2', name: 'Second board' };
    const parent = hierarchyTask('parent', null, {
      status: { remoteId: 'status-ready', name: 'Ready', category: 'active' },
    });
    const child = hierarchyTask('child', 'parent', {
      status: { remoteId: 'status-ready', name: 'Ready', category: 'active' },
    });
    value.workAreas = [firstArea, secondArea];
    value.tasks = [
      { workArea: firstArea, task: child },
      { workArea: secondArea, task: parent },
      { workArea: secondArea, task: child },
    ];

    const firstBoard = buildExternalWorkAreaBoard('jira', value, 'area-1');
    const secondBoard = buildExternalWorkAreaBoard('jira', value, 'area-2');

    expect(firstBoard?.columns.flatMap(({ tasks }) => tasks)).toEqual([
      expect.objectContaining({ remoteId: 'child', isSubtask: true, groupedSubtaskCount: 0 }),
    ]);
    expect(
      secondBoard?.columns.flatMap(({ tasks }) => tasks).map(({ remoteId }) => remoteId),
    ).toEqual(['parent']);
    // The grouped count stays isolated per work area: only the board holding
    // both cards counts the child under its parent.
    expect(
      secondBoard?.columns.flatMap(({ tasks }) =>
        tasks.map(({ groupedSubtaskCount }) => groupedSubtaskCount),
      ),
    ).toEqual([1]);
  });

  it('threads zero, one, and many grouped counts onto top-level parents in workflow columns', () => {
    const value = snapshot('clickup');
    const workArea = value.workAreas[0];
    value.tasks = [
      { workArea, task: hierarchyTask('lonely', null) },
      { workArea, task: hierarchyTask('single-parent', null) },
      { workArea, task: hierarchyTask('single-child', 'single-parent') },
      { workArea, task: hierarchyTask('busy-parent', null) },
      { workArea, task: hierarchyTask('busy-child-a', 'busy-parent') },
      { workArea, task: hierarchyTask('busy-child-b', 'busy-parent') },
    ];

    const board = buildExternalWorkAreaBoard('clickup', value, 'area-1');

    const counts = Object.fromEntries(
      board!.columns[0].tasks.map(({ remoteId, groupedSubtaskCount }) => [
        remoteId,
        groupedSubtaskCount,
      ]),
    );
    expect(counts).toEqual({
      lonely: 0,
      'single-parent': 1,
      'busy-parent': 2,
    });
  });

  it('threads grouped counts into Jira observed other-assigned columns', () => {
    const value = snapshot('jira');
    value.workAreas[0] = {
      ...value.workAreas[0],
      remoteId: 'other-assigned',
      name: 'Other assigned issues',
      workflow: { isOverridden: false, columns: [] },
    };
    const parent = hierarchyTask('parent', null, {
      status: { remoteId: 'status-ready', name: 'Ready', category: 'active' },
    });
    const child = hierarchyTask('child', 'parent', {
      status: { remoteId: 'status-ready', name: 'Ready', category: 'active' },
    });
    value.tasks = [
      { workArea: value.workAreas[0], task: parent },
      { workArea: value.workAreas[0], task: child },
    ];

    const board = buildExternalWorkAreaBoard('jira', value, 'other-assigned');

    expect(board?.columns.flatMap(({ tasks }) => tasks)).toEqual([
      expect.objectContaining({ remoteId: 'parent', groupedSubtaskCount: 1 }),
    ]);
  });

  it('threads grouped counts into the ClickUp Other column', () => {
    const value = snapshot('clickup');
    const workArea = value.workAreas[0];
    const parent = hierarchyTask('parent', null, {
      status: { remoteId: 'unexpected', name: 'BLOCKED', category: 'active' },
    });
    const child = hierarchyTask('child', 'parent', {
      status: { remoteId: 'unexpected', name: 'BLOCKED', category: 'active' },
    });
    value.tasks = [
      { workArea, task: parent },
      { workArea, task: child },
    ];

    const board = buildExternalWorkAreaBoard('clickup', value, 'area-1');

    expect(board?.columns.map(({ name }) => name)).toEqual(['OPEN', 'DONE', 'Other']);
    expect(board?.columns[2].tasks).toEqual([
      expect.objectContaining({ remoteId: 'parent', groupedSubtaskCount: 1 }),
    ]);
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
