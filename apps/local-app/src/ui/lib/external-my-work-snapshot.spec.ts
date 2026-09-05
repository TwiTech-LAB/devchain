import type {
  ExternalMyWorkResult,
  ExternalTaskStatusOption,
} from '@/modules/external-integrations/models/external-provider.models';
import {
  applyExternalTaskStatusSnapshot,
  hasAuthoritativeExternalTaskOccurrence,
  settleExternalTaskStatusSnapshots,
} from './external-my-work-snapshot';

type SupportedSnapshot = Extract<ExternalMyWorkResult, { supported: true }>;

function workArea(remoteId: string, assignedTaskCount: number) {
  return {
    remoteId,
    scopeKey: 'site',
    name: remoteId,
    kind: 'board' as const,
    description: null,
    assignedTaskCount,
    hierarchy: [],
    workflow: { isOverridden: false, columns: [] },
    refresh: {
      state: 'fresh' as const,
      refreshedAt: '2026-08-24T10:00:00.000Z',
      retryable: false,
      retryAt: null,
    },
  };
}

function task(remoteId: string) {
  return {
    remoteId,
    parentRemoteTaskId: null,
    title: remoteId,
    status: { remoteId: 'open', name: 'Open', category: 'active' as const },
    updatedAt: '2026-08-24T10:00:00.000Z',
    dueAt: null,
    completedAt: null,
    webUrl: null,
  };
}

function snapshot(): SupportedSnapshot {
  const first = workArea('board-1', 2);
  const second = workArea('board-2', 1);
  return {
    provider: 'jira',
    descriptor: {
      provider: 'jira',
      displayName: 'Jira',
      capabilities: { myWork: true },
    },
    supported: true,
    capabilities: { timeTrackingEnabled: true },
    workAreas: [first, second],
    tasks: [
      { workArea: first, task: task('CHILD-1') },
      { workArea: first, task: task('OTHER-1') },
      { workArea: second, task: task('CHILD-1') },
    ],
    refreshedAt: '2026-08-24T10:00:00.000Z',
  };
}

function status(category: 'active' | 'completed'): ExternalTaskStatusOption {
  return {
    actionValue: category === 'completed' ? '31' : '21',
    remoteId: category === 'completed' ? 'done' : 'progress',
    remoteStatusIds: [category === 'completed' ? 'done' : 'progress'],
    name: category === 'completed' ? 'Done' : 'In progress',
    color: '#64748b',
    category,
    position: 1,
  };
}

// Layer: pure unit. The settlement helpers are synchronous data projections
// over plain snapshot objects — no I/O, cache, or DOM — so direct function
// calls are the cheapest layer that can observe restored occurrences, count
// changes, and identity preservation exactly.
describe('applyExternalTaskStatusSnapshot', () => {
  it('patches every matching task while preserving untouched entry identity', () => {
    const before = snapshot();
    const untouched = before.tasks[1];

    const after = applyExternalTaskStatusSnapshot(before, 'CHILD-1', status('active'), true);

    expect(after.tasks.filter((entry) => entry.task.remoteId === 'CHILD-1')).toHaveLength(2);
    expect(after.tasks[0]!.task.status).toEqual({
      remoteId: 'progress',
      name: 'In progress',
      category: 'active',
    });
    expect(after.tasks[1]).toBe(untouched);
    expect(after.workAreas).toBe(before.workAreas);
  });

  it('removes completed tasks only from active data and decrements each affected area', () => {
    const before = snapshot();

    const active = applyExternalTaskStatusSnapshot(before, 'CHILD-1', status('completed'), true);
    const inclusive = applyExternalTaskStatusSnapshot(
      before,
      'CHILD-1',
      status('completed'),
      false,
    );

    expect(active.tasks.map((entry) => entry.task.remoteId)).toEqual(['OTHER-1']);
    expect(active.workAreas.map((area) => area.assignedTaskCount)).toEqual([1, 0]);
    expect(inclusive.tasks).toHaveLength(3);
    expect(
      inclusive.tasks
        .filter((entry) => entry.task.remoteId === 'CHILD-1')
        .every((entry) => entry.task.status.category === 'completed'),
    ).toBe(true);
    expect(inclusive.workAreas).toBe(before.workAreas);
  });

  it('restores every missing active occurrence from completed-inclusive data', () => {
    const inclusive = applyExternalTaskStatusSnapshot(
      snapshot(),
      'CHILD-1',
      status('completed'),
      false,
    );
    const activeOnly: SupportedSnapshot = {
      ...inclusive,
      tasks: inclusive.tasks.filter((entry) => entry.task.remoteId !== 'CHILD-1'),
      workAreas: [
        { ...inclusive.workAreas[0]!, assignedTaskCount: 1 },
        { ...inclusive.workAreas[1]!, assignedTaskCount: 0 },
      ],
    };

    const settled = settleExternalTaskStatusSnapshots(
      { activeOnly, completedInclusive: inclusive },
      'CHILD-1',
      status('active'),
    );

    expect(settled.activeOnly?.tasks.map((entry) => entry.task.remoteId)).toEqual([
      'OTHER-1',
      'CHILD-1',
      'CHILD-1',
    ]);
    expect(settled.activeOnly?.workAreas.map((area) => area.assignedTaskCount)).toEqual([2, 1]);
    expect(
      settled.activeOnly?.tasks
        .filter((entry) => entry.task.remoteId === 'CHILD-1')
        .every((entry) => entry.task.status.category === 'active'),
    ).toBe(true);
    expect(settled.completedInclusive?.tasks).toHaveLength(3);
    expect(
      settled.completedInclusive?.tasks
        .filter((entry) => entry.task.remoteId === 'CHILD-1')
        .every((entry) => entry.task.status.category === 'active'),
    ).toBe(true);
    expect(hasAuthoritativeExternalTaskOccurrence(activeOnly, inclusive, 'CHILD-1')).toBe(true);
    // Inclusive occurrences may point at work areas the active-only cache
    // never discovered; one same-provider occurrence is enough assignment
    // proof, and the restore path attaches only the areas that exist.
    expect(
      hasAuthoritativeExternalTaskOccurrence(
        { ...activeOnly, workAreas: activeOnly.workAreas.slice(0, 1) },
        inclusive,
        'CHILD-1',
      ),
    ).toBe(true);
    expect(
      hasAuthoritativeExternalTaskOccurrence(
        activeOnly,
        {
          ...inclusive,
          tasks: inclusive.tasks.filter((entry) => entry.task.remoteId !== 'CHILD-1'),
        },
        'CHILD-1',
      ),
    ).toBe(false);
    expect(
      hasAuthoritativeExternalTaskOccurrence(
        { ...activeOnly, provider: 'clickup' },
        inclusive,
        'CHILD-1',
      ),
    ).toBe(false);
  });

  it('restores only occurrences whose work areas exist and leaves absent areas unattached', () => {
    const inclusive = applyExternalTaskStatusSnapshot(
      snapshot(),
      'CHILD-1',
      status('completed'),
      false,
    );
    const activeOnly: SupportedSnapshot = {
      ...inclusive,
      workAreas: [{ ...inclusive.workAreas[0]!, assignedTaskCount: 1 }],
      tasks: inclusive.tasks.filter((entry) => entry.task.remoteId !== 'CHILD-1'),
    };

    const settled = settleExternalTaskStatusSnapshots(
      { activeOnly, completedInclusive: inclusive },
      'CHILD-1',
      status('active'),
    );

    expect(settled.activeOnly?.tasks.map((entry) => entry.task.remoteId)).toEqual([
      'OTHER-1',
      'CHILD-1',
    ]);
    expect(settled.activeOnly?.workAreas.map((area) => area.remoteId)).toEqual(['board-1']);
    expect(settled.activeOnly?.workAreas[0]?.assignedTaskCount).toBe(2);
    expect(
      settled.activeOnly?.tasks
        .filter((entry) => entry.task.remoteId === 'CHILD-1')
        .every((entry) => entry.workArea.remoteId === 'board-1'),
    ).toBe(true);
    expect(
      settled.completedInclusive?.tasks
        .filter((entry) => entry.task.remoteId === 'CHILD-1')
        .every((entry) => entry.task.status.category === 'active'),
    ).toBe(true);
    expect(hasAuthoritativeExternalTaskOccurrence(activeOnly, inclusive, 'CHILD-1')).toBe(true);
  });
});
