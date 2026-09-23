import { describeBlocking, parseStatusLabels, resolveStatusGuard } from './epic-status-guard';
import type { Status } from '../../storage/models/domain.models';

const PROJECT_ID = 'project-1';

function makeStatus(id: string, label: string): Status {
  return {
    id,
    projectId: PROJECT_ID,
    label,
    color: '#123456',
    position: 1,
    mcpHidden: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('parseStatusLabels', () => {
  it('returns an empty array for an empty string', () => {
    expect(parseStatusLabels('')).toEqual([]);
  });

  it('returns an empty array for non-string values', () => {
    expect(parseStatusLabels(null)).toEqual([]);
    expect(parseStatusLabels(undefined)).toEqual([]);
    expect(parseStatusLabels(42)).toEqual([]);
    expect(parseStatusLabels(['Review'])).toEqual([]);
    expect(parseStatusLabels({ value: 'Review' })).toEqual([]);
  });

  it('returns an empty array for whitespace-only input', () => {
    expect(parseStatusLabels('   ')).toEqual([]);
    expect(parseStatusLabels(' , , ')).toEqual([]);
  });

  it('splits on commas, trims each part, and drops empty parts including trailing commas', () => {
    expect(parseStatusLabels(' In Progress , Review ,,')).toEqual(['In Progress', 'Review']);
  });

  it('deduplicates case-insensitively and keeps the first spelling', () => {
    expect(parseStatusLabels('Review, REVIEW, review, In Progress, in progress')).toEqual([
      'Review',
      'In Progress',
    ]);
  });
});

describe('resolveStatusGuard', () => {
  let storage: {
    listStatuses: jest.Mock;
    listProjectEpics: jest.Mock;
  };

  beforeEach(() => {
    storage = {
      listStatuses: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      listProjectEpics: jest.fn().mockResolvedValue({ items: [], total: 0 }),
    };
  });

  it('loads statuses with the fixed 1000-entry window', async () => {
    storage.listStatuses.mockResolvedValue({
      items: [makeStatus('status-review', 'Review')],
      total: 1,
    });
    storage.listProjectEpics.mockResolvedValue({ items: [], total: 0 });

    await resolveStatusGuard(storage, PROJECT_ID, 'Review');

    expect(storage.listStatuses).toHaveBeenCalledWith(PROJECT_ID, {
      limit: 1000,
      offset: 0,
    });
  });

  it('returns no guard without touching storage when no labels are given', async () => {
    const result = await resolveStatusGuard(storage, PROJECT_ID, '');

    expect(result).toEqual({ ok: true, blocking: [] });
    expect(storage.listStatuses).not.toHaveBeenCalled();
    expect(storage.listProjectEpics).not.toHaveBeenCalled();
  });

  it('fails closed listing every unknown label and counts nothing', async () => {
    storage.listStatuses.mockResolvedValue({
      items: [makeStatus('status-review', 'Review')],
      total: 1,
    });

    const result = await resolveStatusGuard(storage, PROJECT_ID, 'Review, Nope, Missing');

    expect(result).toEqual({ ok: false, unknownLabels: ['Nope', 'Missing'] });
    expect(storage.listProjectEpics).not.toHaveBeenCalled();
  });

  it('matches labels case-insensitively after trimming on both sides', async () => {
    storage.listStatuses.mockResolvedValue({
      items: [makeStatus('status-review', '  REVIEW ')],
      total: 1,
    });
    storage.listProjectEpics.mockResolvedValue({ items: [], total: 3 });

    const result = await resolveStatusGuard(storage, PROJECT_ID, ' review ');

    expect(result).toEqual({
      ok: true,
      blocking: [{ statusId: 'status-review', label: 'review', count: 3 }],
    });
  });

  it('counts per matched status id with excludeMcpHidden and a zero-row window', async () => {
    storage.listStatuses.mockResolvedValue({
      items: [makeStatus('status-review', 'Review')],
      total: 1,
    });
    storage.listProjectEpics.mockResolvedValue({ items: [], total: 2 });

    await resolveStatusGuard(storage, PROJECT_ID, 'Review');

    expect(storage.listProjectEpics).toHaveBeenCalledTimes(1);
    expect(storage.listProjectEpics).toHaveBeenCalledWith(PROJECT_ID, {
      statusId: 'status-review',
      excludeMcpHidden: true,
      limit: 0,
      offset: 0,
    });
  });

  it('reports one entry per matching status when a label is not unique, ordered by status id', async () => {
    storage.listStatuses.mockResolvedValue({
      items: [makeStatus('status-b', 'In Progress'), makeStatus('status-a', 'In Progress')],
      total: 2,
    });
    storage.listProjectEpics.mockImplementation(
      (
        _projectId: string,
        options: {
          statusId: string;
        },
      ) =>
        Promise.resolve({
          items: [],
          total: options.statusId === 'status-a' ? 2 : 3,
        }),
    );

    const result = await resolveStatusGuard(storage, PROJECT_ID, 'In Progress');

    expect(storage.listProjectEpics).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      ok: true,
      blocking: [
        { statusId: 'status-a', label: 'In Progress', count: 2 },
        { statusId: 'status-b', label: 'In Progress', count: 3 },
      ],
    });
    if (result.ok) {
      expect(describeBlocking(result.blocking)).toBe('Skipped: 5 epic(s) still in In Progress');
    }
  });

  it('orders blocking entries by input label order then status id', async () => {
    storage.listStatuses.mockResolvedValue({
      items: [makeStatus('status-z', 'Review'), makeStatus('status-a', 'In Progress')],
      total: 2,
    });
    storage.listProjectEpics.mockResolvedValue({ items: [], total: 1 });

    const result = await resolveStatusGuard(storage, PROJECT_ID, 'Review, In Progress');

    expect(result).toEqual({
      ok: true,
      blocking: [
        { statusId: 'status-z', label: 'Review', count: 1 },
        { statusId: 'status-a', label: 'In Progress', count: 1 },
      ],
    });
  });

  it('returns an empty blocking list when every matched status counts zero', async () => {
    storage.listStatuses.mockResolvedValue({
      items: [makeStatus('status-review', 'Review')],
      total: 1,
    });
    storage.listProjectEpics.mockResolvedValue({ items: [], total: 0 });

    const result = await resolveStatusGuard(storage, PROJECT_ID, 'Review');

    expect(result).toEqual({ ok: true, blocking: [] });
  });

  it('omits zero-count statuses from blocking while keeping non-zero ones', async () => {
    storage.listStatuses.mockResolvedValue({
      items: [makeStatus('status-a', 'In Progress'), makeStatus('status-b', 'In Progress')],
      total: 2,
    });
    storage.listProjectEpics.mockImplementation(
      (
        _projectId: string,
        options: {
          statusId: string;
        },
      ) =>
        Promise.resolve({
          items: [],
          total: options.statusId === 'status-b' ? 4 : 0,
        }),
    );

    const result = await resolveStatusGuard(storage, PROJECT_ID, 'In Progress');

    expect(result).toEqual({
      ok: true,
      blocking: [{ statusId: 'status-b', label: 'In Progress', count: 4 }],
    });
  });
});

describe('describeBlocking', () => {
  it('renders the exact skip message with summed counts and distinct labels', () => {
    expect(
      describeBlocking([
        { statusId: 'status-a', label: 'In Progress', count: 2 },
        { statusId: 'status-b', label: 'Review', count: 1 },
      ]),
    ).toBe('Skipped: 3 epic(s) still in In Progress, Review');
  });

  it('deduplicates repeated labels and sums their counts', () => {
    expect(
      describeBlocking([
        { statusId: 'status-a', label: 'Review', count: 2 },
        { statusId: 'status-b', label: 'Review', count: 3 },
      ]),
    ).toBe('Skipped: 5 epic(s) still in Review');
  });
});
