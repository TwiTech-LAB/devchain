import { NotFoundError, ValidationError } from '../../../common/errors/error-types';
import type { EpicTimeStore, EpicTimeSummarySegment } from './epic-time.store';
import { EpicTimeService } from './epic-time.service';

// Layer: backend unit. Quantization, timezone projection, and response invariants
// are pure over the store projection, so mocking SQL is the cheapest reliable layer.
describe('EpicTimeService', () => {
  let store: jest.Mocked<
    Pick<
      EpicTimeStore,
      | 'getEpicTimeScope'
      | 'getEpicTimeScopes'
      | 'listClosedSegmentsForEpic'
      | 'listClosedSegmentsForRoots'
    >
  >;
  let service: EpicTimeService;

  beforeEach(() => {
    store = {
      getEpicTimeScope: jest.fn(),
      getEpicTimeScopes: jest.fn(),
      listClosedSegmentsForEpic: jest.fn(),
      listClosedSegmentsForRoots: jest.fn(),
    };
    service = new EpicTimeService(store as unknown as EpicTimeStore);
  });

  const segment = (
    id: string,
    overrides: Partial<EpicTimeSummarySegment> = {},
  ): EpicTimeSummarySegment => ({
    id,
    rootEpicId: null,
    epicId: 'root',
    epicTitle: 'Root task',
    isDirect: true,
    agentId: 'agent-1',
    agentName: 'Coder',
    durationMs: 60_000,
    lastActivityAt: '2026-01-02T00:30:00.000Z',
    updatedAt: '2026-01-02T00:30:00.000Z',
    ...overrides,
  });

  it('quantizes complete root and direct groups once', () => {
    store.getEpicTimeScope.mockReturnValue({ id: 'root', parentId: null });
    store.listClosedSegmentsForEpic.mockReturnValue([
      segment('direct-a', { durationMs: 40_000 }),
      segment('direct-b', { durationMs: 30_000 }),
      segment('child', {
        epicId: 'child',
        epicTitle: 'Child task',
        durationMs: 60_000,
        isDirect: false,
      }),
    ]);

    expect(service.getDetail('root', 'UTC')).toEqual({
      isRoot: true,
      directMinutes: 1,
      totalMinutes: 2,
      items: [
        {
          activityDate: '2026-01-02',
          agentId: 'agent-1',
          agentName: 'Coder',
          minutes: 2,
        },
      ],
      taskItems: [
        { epicId: 'root', epicTitle: 'Root task', isDirect: true, minutes: 1 },
        { epicId: 'child', epicTitle: 'Child task', isDirect: false, minutes: 1 },
      ],
    });
    expect(store.listClosedSegmentsForEpic).toHaveBeenCalledWith('root', true);
  });

  it('keeps different agents separate and omits their zero-minute groups', () => {
    store.getEpicTimeScope.mockReturnValue({ id: 'root', parentId: null });
    store.listClosedSegmentsForEpic.mockReturnValue([
      segment('agent-a', { agentId: 'agent-a', durationMs: 40_000 }),
      segment('agent-b', { agentId: 'agent-b', durationMs: 40_000 }),
    ]);

    expect(service.getDetail('root', 'UTC')).toEqual({
      isRoot: true,
      directMinutes: 0,
      totalMinutes: 0,
      items: [],
      taskItems: [],
    });
  });

  it('uses the last-activity local date and latest deterministic name snapshot', () => {
    store.getEpicTimeScope.mockReturnValue({ id: 'child', parentId: 'root' });
    store.listClosedSegmentsForEpic.mockReturnValue([
      segment('a', {
        epicId: 'child',
        epicTitle: 'Child task',
        durationMs: 30_000,
        agentName: 'Old name',
        lastActivityAt: '2026-01-02T00:15:00.000Z',
      }),
      segment('b', {
        epicId: 'child',
        epicTitle: 'Child task',
        durationMs: 30_000,
        agentName: 'New name',
        lastActivityAt: '2026-01-02T00:30:00.000Z',
      }),
    ]);

    expect(service.getDetail('child', 'America/Los_Angeles')).toEqual({
      isRoot: false,
      directMinutes: 1,
      totalMinutes: 1,
      items: [
        {
          activityDate: '2026-01-01',
          agentId: 'agent-1',
          agentName: 'New name',
          minutes: 1,
        },
      ],
      taskItems: [{ epicId: 'child', epicTitle: 'Child task', isDirect: true, minutes: 1 }],
    });
    expect(store.listClosedSegmentsForEpic).toHaveBeenCalledWith('child', false);
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
    store.listClosedSegmentsForEpic.mockReturnValue(segments);
    store.getEpicTimeScopes.mockReturnValue([{ id: 'root', parentId: null }]);
    store.listClosedSegmentsForRoots.mockReturnValue(segments);

    const detail = service.getDetail('root', 'UTC');
    expect(detail.totalMinutes).toBe(1);
    expect(detail.taskItems).toEqual([
      { epicId: 'child', epicTitle: 'Child task', isDirect: false, minutes: 1 },
    ]);
    expect(service.getBatch(['root'], 'UTC')).toEqual({
      items: [{ epicId: 'root', totalMinutes: 1 }],
    });
  });

  it('uses Epic ID to break equal 90-second remainders and keeps the requested Epic first', () => {
    store.getEpicTimeScope.mockReturnValue({ id: 'root', parentId: null });
    store.listClosedSegmentsForEpic.mockReturnValue([
      segment('root-segment', { durationMs: 90_000 }),
      segment('child-segment', {
        epicId: 'child',
        epicTitle: 'Alpha task',
        durationMs: 90_000,
        isDirect: false,
      }),
    ]);

    const detail = service.getDetail('root', 'UTC');
    expect(detail.totalMinutes).toBe(3);
    expect(detail.taskItems).toEqual([
      { epicId: 'root', epicTitle: 'Root task', isDirect: true, minutes: 1 },
      { epicId: 'child', epicTitle: 'Alpha task', isDirect: false, minutes: 2 },
    ]);
    expect(detail.taskItems.reduce((total, item) => total + item.minutes, 0)).toBe(
      detail.totalMinutes,
    );
  });

  it('sorts non-requested task items by title and then Epic ID', () => {
    store.getEpicTimeScope.mockReturnValue({ id: 'root', parentId: null });
    store.listClosedSegmentsForEpic.mockReturnValue([
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
    ]);

    expect(service.getDetail('root', 'UTC').taskItems.map((item) => item.epicId)).toEqual([
      'root',
      'child-a',
      'child-b',
      'child-c',
    ]);
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
    expect(store.listClosedSegmentsForRoots).not.toHaveBeenCalled();
  });

  it('rejects missing and child batch IDs with bounded details', () => {
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
      invalidCount: 2,
      invalidEpicIds: ['child', 'missing'],
    });
    expect(store.listClosedSegmentsForRoots).not.toHaveBeenCalled();
  });
});
