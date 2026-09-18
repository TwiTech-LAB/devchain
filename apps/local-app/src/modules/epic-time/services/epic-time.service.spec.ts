import { ConflictError, NotFoundError, ValidationError } from '../../../common/errors/error-types';
import type { EventsService } from '../../events/services/events.service';
import type { EpicTimeStore, EpicTimeSummarySegment } from './epic-time.store';
import { EpicTimeService } from './epic-time.service';

// Layer: backend unit. Quantization, timezone projection, and response invariants
// are pure over the store projection, so mocking SQL is the cheapest reliable layer.
describe('EpicTimeService', () => {
  type SourceSegmentOverrides = Partial<EpicTimeSummarySegment> & {
    attributionSource?: 'direct' | 'team';
    teamId?: string | null;
    teamName?: string | null;
  };
  let store: jest.Mocked<
    Pick<
      EpicTimeStore,
      | 'getEpicTimeScope'
      | 'getEpicTimeScopes'
      | 'listResolvedScope'
      | 'listAgentTimeBuffers'
      | 'assignAgentTimeBuffer'
      | 'resetAgentTimeBuffer'
    >
  >;
  let events: { publish: jest.Mock };
  let service: EpicTimeService;

  beforeEach(() => {
    store = {
      getEpicTimeScope: jest.fn(),
      getEpicTimeScopes: jest.fn(),
      listResolvedScope: jest
        .fn()
        .mockReturnValue({ segments: [], routedRootIdsByFocal: new Map() }),
      listAgentTimeBuffers: jest.fn(),
      assignAgentTimeBuffer: jest.fn(),
      resetAgentTimeBuffer: jest.fn(),
    };
    events = { publish: jest.fn().mockResolvedValue(null) };
    service = new EpicTimeService(store as unknown as EpicTimeStore, events as EventsService);
  });

  const segment = (id: string, overrides: SourceSegmentOverrides = {}): EpicTimeSummarySegment =>
    ({
      id,
      rootEpicId: null,
      epicId: 'root',
      epicTitle: 'Root task',
      groupEpicId: 'root',
      groupEpicTitle: 'Root task',
      isDirect: true,
      agentId: 'agent-1',
      agentName: 'Coder',
      attributionSource: 'direct',
      teamId: null,
      teamName: null,
      durationMs: 60_000,
      lastActivityAt: '2026-01-02T00:30:00.000Z',
      updatedAt: '2026-01-02T00:30:00.000Z',
      ...overrides,
    }) as EpicTimeSummarySegment;

  it('quantizes complete root and direct groups once', () => {
    store.getEpicTimeScope.mockReturnValue({ id: 'root', parentId: null });
    store.listResolvedScope.mockReturnValue({
      segments: [
        segment('direct-a', { durationMs: 40_000 }),
        segment('direct-b', { durationMs: 30_000 }),
        segment('child', {
          epicId: 'child',
          epicTitle: 'Child task',
          durationMs: 60_000,
          isDirect: false,
        }),
      ],
      routedRootIdsByFocal: new Map(),
    });

    expect(service.getDetail('root', 'UTC')).toEqual({
      isRoot: true,
      directMinutes: 1,
      totalMinutes: 2,
      includesRelatedTime: false,
      items: [
        {
          activityDate: '2026-01-02',
          agentId: 'agent-1',
          agentName: 'Coder',
          attributionSource: 'direct',
          teamId: null,
          teamName: null,
          minutes: 2,
        },
      ],
      taskItems: [
        {
          epicId: 'root',
          epicTitle: 'Root task',
          groupEpicId: 'root',
          groupEpicTitle: 'Root task',
          isDirect: true,
          minutes: 1,
        },
        {
          epicId: 'child',
          epicTitle: 'Child task',
          groupEpicId: 'root',
          groupEpicTitle: 'Root task',
          isDirect: false,
          minutes: 1,
        },
      ],
    });
    expect(store.listResolvedScope).toHaveBeenCalledWith(['root']);
  });

  it('keeps different agents separate and omits their zero-minute groups', () => {
    store.getEpicTimeScope.mockReturnValue({ id: 'root', parentId: null });
    store.listResolvedScope.mockReturnValue({
      segments: [
        segment('agent-a', { agentId: 'agent-a', durationMs: 40_000 }),
        segment('agent-b', { agentId: 'agent-b', durationMs: 40_000 }),
      ],
      routedRootIdsByFocal: new Map(),
    });

    expect(service.getDetail('root', 'UTC')).toEqual({
      isRoot: true,
      directMinutes: 0,
      totalMinutes: 0,
      includesRelatedTime: false,
      items: [],
      taskItems: [],
    });
  });

  it('uses the last-activity local date and latest deterministic name snapshot', () => {
    store.getEpicTimeScope.mockReturnValue({ id: 'child', parentId: 'root' });
    store.listResolvedScope.mockReturnValue({
      segments: [
        segment('a', {
          epicId: 'child',
          epicTitle: 'Child task',
          groupEpicId: 'child',
          groupEpicTitle: 'Child task',
          durationMs: 30_000,
          agentName: 'Old name',
          lastActivityAt: '2026-01-02T00:15:00.000Z',
        }),
        segment('b', {
          epicId: 'child',
          epicTitle: 'Child task',
          groupEpicId: 'child',
          groupEpicTitle: 'Child task',
          durationMs: 30_000,
          agentName: 'New name',
          lastActivityAt: '2026-01-02T00:30:00.000Z',
        }),
      ],
      routedRootIdsByFocal: new Map(),
    });

    expect(service.getDetail('child', 'America/Los_Angeles')).toEqual({
      isRoot: false,
      directMinutes: 1,
      includesRelatedTime: false,
      totalMinutes: 1,
      items: [
        {
          activityDate: '2026-01-01',
          agentId: 'agent-1',
          agentName: 'New name',
          attributionSource: 'direct',
          teamId: null,
          teamName: null,
          minutes: 1,
        },
      ],
      taskItems: [
        {
          epicId: 'child',
          epicTitle: 'Child task',
          groupEpicId: 'child',
          groupEpicTitle: 'Child task',
          isDirect: true,
          minutes: 1,
        },
      ],
    });
    expect(store.listResolvedScope).toHaveBeenCalledWith(['child']);
  });

  it('returns the same quantized totals for batch and detail', () => {
    const segments = [
      segment('direct', { rootEpicId: 'root', durationMs: 30_000 }),
      segment('child', {
        rootEpicId: 'root',
        epicId: 'child',
        epicTitle: 'Child task',
        durationMs: 30_000,
        isDirect: false,
      }),
    ];
    store.getEpicTimeScope.mockReturnValue({ id: 'root', parentId: null });
    store.getEpicTimeScopes.mockReturnValue([{ id: 'root', parentId: null }]);
    store.listResolvedScope.mockReturnValue({ segments, routedRootIdsByFocal: new Map() });

    const detail = service.getDetail('root', 'UTC');
    expect(detail.totalMinutes).toBe(1);
    expect(detail.taskItems).toEqual([
      {
        epicId: 'child',
        epicTitle: 'Child task',
        groupEpicId: 'root',
        groupEpicTitle: 'Root task',
        isDirect: false,
        minutes: 1,
      },
    ]);
    expect(service.getBatch(['root'], 'UTC')).toEqual({
      items: [{ epicId: 'root', totalMinutes: 1 }],
    });
    expect(store.listResolvedScope).toHaveBeenNthCalledWith(1, ['root']);
    expect(store.listResolvedScope).toHaveBeenNthCalledWith(2, ['root']);
  });

  it('includes routed contributor segments in detail and batch through the same loader', () => {
    store.getEpicTimeScope.mockReturnValue({ id: 'root', parentId: null });
    store.getEpicTimeScopes.mockReturnValue([{ id: 'root', parentId: null }]);
    store.listResolvedScope.mockReturnValue({
      segments: [
        segment('direct', { rootEpicId: 'root', durationMs: 60_000 }),
        segment('routed', {
          rootEpicId: 'root',
          epicId: 'routed-root',
          epicTitle: 'Routed task',
          groupEpicId: 'routed-root',
          groupEpicTitle: 'Routed task',
          durationMs: 90_000,
          isDirect: false,
        }),
      ],
      routedRootIdsByFocal: new Map(),
    });

    const detail = service.getDetail('root', 'UTC');
    expect(detail).toMatchObject({ isRoot: true, directMinutes: 1, totalMinutes: 2 });
    expect(detail.taskItems).toEqual([
      {
        epicId: 'root',
        epicTitle: 'Root task',
        groupEpicId: 'root',
        groupEpicTitle: 'Root task',
        isDirect: true,
        minutes: 1,
      },
      {
        epicId: 'routed-root',
        epicTitle: 'Routed task',
        groupEpicId: 'routed-root',
        groupEpicTitle: 'Routed task',
        isDirect: false,
        minutes: 1,
      },
    ]);
    expect(detail.taskItems.reduce((total, item) => total + item.minutes, 0)).toBe(
      detail.totalMinutes,
    );
    expect(service.getBatch(['root'], 'UTC')).toEqual({
      items: [{ epicId: 'root', totalMinutes: 2 }],
    });
  });

  it('derives routed scope from the same single resolved snapshot as the totals', () => {
    store.getEpicTimeScope.mockReturnValue({ id: 'child', parentId: 'root' });
    store.listResolvedScope.mockReturnValue({
      segments: [segment('child-seg', { epicId: 'child', epicTitle: 'Child task' })],
      routedRootIdsByFocal: new Map(),
    });
    expect(service.getDetail('child', 'UTC').includesRelatedTime).toBe(false);

    store.getEpicTimeScope.mockReturnValue({ id: 'root', parentId: null });
    store.listResolvedScope.mockReturnValue({
      segments: [
        segment('root-seg'),
        segment('routed-seg', { epicId: 'routed-root', epicTitle: 'Routed task', isDirect: false }),
      ],
      routedRootIdsByFocal: new Map([['root', ['routed-root']]]),
    });
    store.listResolvedScope.mockClear();
    const detail = service.getDetail('root', 'UTC');
    expect(detail.includesRelatedTime).toBe(true);
    // One traversal per detail call: the flag and the totals ride the same
    // statement result, never a second route query.
    expect(store.listResolvedScope).toHaveBeenCalledTimes(1);
    expect(store.listResolvedScope).toHaveBeenCalledWith(['root']);
  });

  it('floors once per date-agent bucket and allocates source-team remainders deterministically', () => {
    const segments = [
      segment('direct', { rootEpicId: 'root', durationMs: 70_000 }),
      segment('team-alpha', {
        rootEpicId: 'root',
        attributionSource: 'team',
        teamId: 'team-alpha',
        teamName: 'Alpha',
        durationMs: 50_000,
      }),
      segment('team-beta', {
        rootEpicId: 'root',
        attributionSource: 'team',
        teamId: 'team-beta',
        teamName: 'Beta',
        durationMs: 30_000,
      }),
    ];
    store.getEpicTimeScope.mockReturnValue({ id: 'root', parentId: null });
    store.getEpicTimeScopes.mockReturnValue([{ id: 'root', parentId: null }]);
    store.listResolvedScope.mockReturnValue({ segments, routedRootIdsByFocal: new Map() });

    const detail = service.getDetail('root', 'UTC');
    expect(detail).toMatchObject({ directMinutes: 2, totalMinutes: 2 });
    expect(detail.items).toEqual([
      {
        activityDate: '2026-01-02',
        agentId: 'agent-1',
        agentName: 'Coder',
        attributionSource: 'direct',
        teamId: null,
        teamName: null,
        minutes: 1,
      },
      {
        activityDate: '2026-01-02',
        agentId: 'agent-1',
        agentName: 'Coder',
        attributionSource: 'team',
        teamId: 'team-alpha',
        teamName: 'Alpha',
        minutes: 1,
      },
    ]);
    expect(detail.items.reduce((total, item) => total + item.minutes, 0)).toBe(detail.totalMinutes);
    expect(detail.taskItems.reduce((total, item) => total + item.minutes, 0)).toBe(
      detail.totalMinutes,
    );
    expect(service.getBatch(['root'], 'UTC')).toEqual({
      items: [{ epicId: 'root', totalMinutes: detail.totalMinutes }],
    });
  });

  it('breaks equal source remainders by source and team ID without emitting zero-minute rows', () => {
    store.getEpicTimeScope.mockReturnValue({ id: 'root', parentId: null });
    store.listResolvedScope.mockReturnValue({
      segments: [
        segment('team-z', {
          attributionSource: 'team',
          teamId: 'team-z',
          teamName: 'Zulu',
          durationMs: 30_000,
        }),
        segment('team-a', {
          attributionSource: 'team',
          teamId: 'team-a',
          teamName: 'Alpha',
          durationMs: 30_000,
        }),
      ],
      routedRootIdsByFocal: new Map(),
    });

    expect(service.getDetail('root', 'UTC').items).toEqual([
      expect.objectContaining({
        attributionSource: 'team',
        teamId: 'team-a',
        teamName: 'Alpha',
        minutes: 1,
      }),
    ]);
  });

  it('uses Epic ID to break equal 90-second remainders and keeps the requested Epic first', () => {
    store.getEpicTimeScope.mockReturnValue({ id: 'root', parentId: null });
    store.listResolvedScope.mockReturnValue({
      segments: [
        segment('root-segment', { durationMs: 90_000 }),
        segment('child-segment', {
          epicId: 'child',
          epicTitle: 'Alpha task',
          durationMs: 90_000,
          isDirect: false,
        }),
      ],
      routedRootIdsByFocal: new Map(),
    });

    const detail = service.getDetail('root', 'UTC');
    expect(detail.totalMinutes).toBe(3);
    expect(detail.taskItems).toEqual([
      {
        epicId: 'root',
        epicTitle: 'Root task',
        groupEpicId: 'root',
        groupEpicTitle: 'Root task',
        isDirect: true,
        minutes: 1,
      },
      {
        epicId: 'child',
        epicTitle: 'Alpha task',
        groupEpicId: 'root',
        groupEpicTitle: 'Root task',
        isDirect: false,
        minutes: 2,
      },
    ]);
    expect(detail.taskItems.reduce((total, item) => total + item.minutes, 0)).toBe(
      detail.totalMinutes,
    );
  });

  it('sorts non-requested task items by title and then Epic ID', () => {
    store.getEpicTimeScope.mockReturnValue({ id: 'root', parentId: null });
    store.listResolvedScope.mockReturnValue({
      segments: [
        segment('root-segment'),
        segment('child-b', {
          epicId: 'child-b',
          epicTitle: 'Alpha task',
          isDirect: false,
        }),
        segment('child-a', {
          epicId: 'child-a',
          epicTitle: 'Alpha task',
          isDirect: false,
        }),
        segment('child-c', {
          epicId: 'child-c',
          epicTitle: 'Beta task',
          isDirect: false,
        }),
      ],
      routedRootIdsByFocal: new Map(),
    });

    expect(service.getDetail('root', 'UTC').taskItems.map((item) => item.epicId)).toEqual([
      'root',
      'child-a',
      'child-b',
      'child-c',
    ]);
  });

  it('labels focal rows with the focal group and routed rows with the routed-root group', () => {
    store.getEpicTimeScope.mockReturnValue({ id: 'root', parentId: null });
    store.listResolvedScope.mockReturnValue({
      segments: [
        segment('root-segment'),
        segment('focal-child-segment', {
          epicId: 'focal-child',
          epicTitle: 'Focal child task',
          isDirect: false,
        }),
        segment('routed-segment', {
          epicId: 'routed-root',
          epicTitle: 'Routed task',
          groupEpicId: 'routed-root',
          groupEpicTitle: 'Routed task',
          isDirect: false,
        }),
        segment('routed-child-segment', {
          epicId: 'routed-child',
          epicTitle: 'Routed child task',
          groupEpicId: 'routed-root',
          groupEpicTitle: 'Routed task',
          isDirect: false,
        }),
      ],
      routedRootIdsByFocal: new Map([['root', ['routed-root']]]),
    });

    const detail = service.getDetail('root', 'UTC');
    expect(
      detail.taskItems.map((item) => [item.epicId, item.groupEpicId, item.groupEpicTitle]),
    ).toEqual([
      ['root', 'root', 'Root task'],
      ['focal-child', 'root', 'Root task'],
      ['routed-child', 'routed-root', 'Routed task'],
      ['routed-root', 'routed-root', 'Routed task'],
    ]);
    // Group totals are sums over the already allocated rows, so they add up
    // to the detail total without a second quantization pass.
    const groupTotals = new Map<string, number>();
    for (const item of detail.taskItems) {
      groupTotals.set(
        item.groupEpicId ?? '',
        (groupTotals.get(item.groupEpicId ?? '') ?? 0) + item.minutes,
      );
    }
    expect([...groupTotals.values()].reduce((total, minutes) => total + minutes, 0)).toBe(
      detail.totalMinutes,
    );
  });

  it('rejects invalid time zones and missing detail Epics', () => {
    expect(() => service.getDetail('root', 'Not/A_Zone')).toThrow(ValidationError);
    expect(() => service.getDetail('root', '+01:00')).toThrow(ValidationError);
    store.getEpicTimeScope.mockReturnValue(null);
    expect(() => service.getDetail('missing', 'UTC')).toThrow(NotFoundError);
  });

  it.each([
    ['empty', []],
    ['duplicates', ['root', 'root']],
    ['over limit', Array.from({ length: 1_001 }, (_, index) => `root-${index}`)],
  ])('rejects %s batch input before reading segments', (_label, epicIds) => {
    expect(() => service.getBatch(epicIds, 'UTC')).toThrow(ValidationError);
    expect(store.listResolvedScope).not.toHaveBeenCalled();
  });

  it('rejects missing batch IDs with bounded details while accepting sub-Epics', () => {
    store.getEpicTimeScopes.mockReturnValue([
      { id: 'root', parentId: null },
      { id: 'child', parentId: 'root' },
    ]);
    let thrown: unknown;
    try {
      service.getBatch(['root', 'child', 'missing'], 'UTC');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ValidationError);
    expect((thrown as ValidationError).details).toEqual({
      invalidCount: 1,
      invalidEpicIds: ['missing'],
    });
    expect(store.listResolvedScope).not.toHaveBeenCalled();
  });

  it('sums mixed root and child focals independently through one resolved-scope read', () => {
    store.getEpicTimeScopes.mockReturnValue([
      { id: 'root', parentId: null },
      { id: 'child', parentId: 'root' },
    ]);
    store.listResolvedScope.mockReturnValue({
      segments: [
        segment('root-direct', { rootEpicId: 'root', epicId: 'root', durationMs: 60_000 }),
        segment('child-under-root', {
          rootEpicId: 'root',
          epicId: 'child',
          epicTitle: 'Child task',
          durationMs: 60_000,
          isDirect: false,
        }),
        segment('child-self', {
          rootEpicId: 'child',
          epicId: 'child',
          epicTitle: 'Child task',
          durationMs: 60_000,
          isDirect: true,
        }),
      ],
      routedRootIdsByFocal: new Map(),
    });

    // The child's minutes count once under its root focal's rollup and once
    // under its own self-only focal — never merged into one total.
    expect(service.getBatch(['root', 'child'], 'UTC')).toEqual({
      items: [
        { epicId: 'root', totalMinutes: 2 },
        { epicId: 'child', totalMinutes: 1 },
      ],
    });
    expect(store.listResolvedScope).toHaveBeenCalledTimes(1);
    expect(store.listResolvedScope).toHaveBeenCalledWith(['root', 'child']);
  });

  describe('getDailyProjection', () => {
    it('groups the detail items by activity date and sums all agents and attribution sources', () => {
      store.getEpicTimeScope.mockReturnValue({ id: 'root', parentId: null });
      store.listResolvedScope.mockReturnValue({
        segments: [
          segment('direct', {
            durationMs: 70_000,
            lastActivityAt: '2026-01-02T00:30:00.000Z',
          }),
          segment('team-alpha', {
            attributionSource: 'team',
            teamId: 'team-alpha',
            teamName: 'Alpha',
            durationMs: 50_000,
            lastActivityAt: '2026-01-02T00:30:00.000Z',
          }),
          segment('other-agent', {
            agentId: 'agent-2',
            agentName: 'Reviewer',
            durationMs: 60_000,
            lastActivityAt: '2026-01-04T00:30:00.000Z',
          }),
        ],
        routedRootIdsByFocal: new Map(),
      });

      const detail = service.getDetail('root', 'UTC');
      const projection = service.getDailyProjection('root', 'UTC');

      // The projection reuses the detail quantization: grouping the detail
      // items reproduces currentByDate exactly.
      const grouped = new Map<string, number>();
      for (const item of detail.items) {
        grouped.set(item.activityDate, (grouped.get(item.activityDate) ?? 0) + item.minutes);
      }
      expect(projection.totalMinutes).toBe(detail.totalMinutes);
      expect(projection.currentByDate.reduce((total, day) => total + day.minutes, 0)).toBe(
        projection.totalMinutes,
      );
      expect(projection.currentByDate).toEqual(
        [...grouped.entries()]
          .map(([activityDate, minutes]) => ({ activityDate, minutes }))
          .sort((left, right) => left.activityDate.localeCompare(right.activityDate)),
      );
    });

    it('reads the resolved scope exactly once per projection', () => {
      store.getEpicTimeScope.mockReturnValue({ id: 'root', parentId: null });
      store.listResolvedScope.mockReturnValue({
        segments: [segment('direct-a')],
        routedRootIdsByFocal: new Map(),
      });

      service.getDailyProjection('root', 'UTC');
      expect(store.listResolvedScope).toHaveBeenCalledTimes(1);
      expect(store.listResolvedScope).toHaveBeenCalledWith(['root']);
    });

    it('sorts dates oldest first and canonicalizes the requested zone', () => {
      store.getEpicTimeScope.mockReturnValue({ id: 'root', parentId: null });
      store.listResolvedScope.mockReturnValue({
        segments: [
          segment('late', { lastActivityAt: '2026-03-02T00:30:00.000Z' }),
          segment('early', { lastActivityAt: '2026-01-02T00:30:00.000Z' }),
        ],
        routedRootIdsByFocal: new Map(),
      });

      const projection = service.getDailyProjection('root', 'Etc/UTC');
      expect(projection.canonicalTimeZone).toBe('UTC');
      expect(projection.currentByDate.map((day) => day.activityDate)).toEqual([
        '2026-01-02',
        '2026-03-02',
      ]);
    });

    it('projects a child focal self-only through the same loader', () => {
      store.getEpicTimeScope.mockReturnValue({ id: 'child', parentId: 'root' });
      store.listResolvedScope.mockReturnValue({
        segments: [
          segment('child-seg', { epicId: 'child', epicTitle: 'Child task', rootEpicId: 'child' }),
        ],
        routedRootIdsByFocal: new Map(),
      });

      const projection = service.getDailyProjection('child', 'UTC');
      expect(projection.totalMinutes).toBe(1);
      expect(projection.currentByDate).toEqual([{ activityDate: '2026-01-02', minutes: 1 }]);
      expect(store.listResolvedScope).toHaveBeenCalledWith(['child']);
    });

    it('rejects invalid zones and missing Epics like getDetail', () => {
      expect(() => service.getDailyProjection('root', 'Not/A_Zone')).toThrow(ValidationError);
      expect(() => service.getDailyProjection('root', '+01:00')).toThrow(ValidationError);
      store.getEpicTimeScope.mockReturnValue(null);
      expect(() => service.getDailyProjection('missing', 'UTC')).toThrow(NotFoundError);
    });
  });

  describe('agent time buffers', () => {
    it('returns the storage snapshot untouched', () => {
      const snapshot = { capturedAt: '2026-01-02T00:00:00.000Z', items: [] };
      store.listAgentTimeBuffers.mockReturnValue(snapshot);

      expect(service.getAgentTimeBuffers('project-1')).toBe(snapshot);
      expect(store.listAgentTimeBuffers).toHaveBeenCalledWith('project-1');
    });

    it('publishes the scope invalidation only after the assignment commits', async () => {
      store.assignAgentTimeBuffer.mockResolvedValue({ workspaceId: 'workspace-1' });
      const input = {
        projectId: '11111111-1111-4111-8111-111111111111',
        agentId: 'agent-1',
        targetEpicId: '22222222-2222-4222-8222-222222222222',
        capturedAt: '2026-01-02T00:00:00.000Z',
        snapshotToken: 'a'.repeat(64),
      };

      await expect(service.assignAgentTimeBuffer(input)).resolves.toEqual({
        workspaceId: 'workspace-1',
      });
      expect(events.publish).toHaveBeenCalledTimes(1);
      expect(events.publish).toHaveBeenCalledWith('epic.time.scope.invalidated', {
        workspaceId: 'workspace-1',
      });
    });

    it('never publishes when the assignment fails closed', async () => {
      store.assignAgentTimeBuffer.mockRejectedValue(new ConflictError('stale'));
      const input = {
        projectId: '11111111-1111-4111-8111-111111111111',
        agentId: 'agent-1',
        targetEpicId: '22222222-2222-4222-8222-222222222222',
        capturedAt: '2026-01-02T00:00:00.000Z',
        snapshotToken: 'a'.repeat(64),
      };

      await expect(service.assignAgentTimeBuffer(input)).rejects.toThrow(ConflictError);
      expect(events.publish).not.toHaveBeenCalled();
    });

    it('publishes the scope invalidation only after the reset commits', async () => {
      store.resetAgentTimeBuffer.mockResolvedValue({ workspaceId: 'workspace-1' });
      const input = {
        projectId: '11111111-1111-4111-8111-111111111111',
        agentId: 'agent-1',
        capturedAt: '2026-01-02T00:00:00.000Z',
        snapshotToken: 'a'.repeat(64),
      };

      await expect(service.resetAgentTimeBuffer(input)).resolves.toEqual({
        workspaceId: 'workspace-1',
      });
      expect(events.publish).toHaveBeenCalledTimes(1);
      expect(events.publish).toHaveBeenCalledWith('epic.time.scope.invalidated', {
        workspaceId: 'workspace-1',
      });
    });

    it('never publishes when the reset fails closed', async () => {
      store.resetAgentTimeBuffer.mockRejectedValue(new ConflictError('stale'));
      const input = {
        projectId: '11111111-1111-4111-8111-111111111111',
        agentId: 'agent-1',
        capturedAt: '2026-01-02T00:00:00.000Z',
        snapshotToken: 'a'.repeat(64),
      };

      await expect(service.resetAgentTimeBuffer(input)).rejects.toThrow(ConflictError);
      expect(events.publish).not.toHaveBeenCalled();
    });
  });
});
