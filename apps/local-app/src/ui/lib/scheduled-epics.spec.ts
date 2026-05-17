import {
  ScheduledEpicApiError,
  CRON_PRESETS,
  fetchScheduledEpics,
  fetchScheduledEpic,
  createScheduledEpic,
  updateScheduledEpic,
  deleteScheduledEpic,
  toggleScheduledEpic,
  runScheduledEpicNow,
  fetchScheduledEpicRuns,
} from './scheduled-epics';

const originalFetch = global.fetch;

afterEach(() => {
  if (originalFetch) {
    global.fetch = originalFetch;
  } else {
    delete (global as unknown as { fetch?: unknown }).fetch;
  }
  jest.clearAllMocks();
});

function mockFetch(ok: boolean, body: unknown, status = ok ? 200 : 400) {
  (global as unknown as { fetch: unknown }).fetch = jest.fn(async () => ({
    ok,
    status,
    json: async () => body,
  }));
}

const baseSchedule = {
  id: 'sched-1',
  projectId: 'proj-1',
  name: 'Weekly sync',
  cronExpression: '0 9 * * 1',
  timezone: 'UTC',
  enabled: true,
  titleTemplate: 'Weekly sync {{date}}',
  descriptionTemplate: null,
  templateStatusId: null,
  templateParentEpicId: null,
  templateAgentId: null,
  templateTags: [],
  allowOverlap: false,
  missedRunPolicy: 'skip' as const,
  configVersion: 1,
  runCount: 5,
  nextRunAt: '2026-05-18T09:00:00.000Z',
  lastRunAt: null,
  lastRunStatus: null,
  lastError: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const baseRun = {
  id: 'run-1',
  scheduleId: 'sched-1',
  plannedFor: '2026-05-18T09:00:00.000Z',
  source: 'scheduler' as const,
  status: 'completed' as const,
  createdEpicId: 'epic-1',
  startedAt: '2026-05-18T09:00:00.100Z',
  finishedAt: '2026-05-18T09:00:01.500Z',
  errorMessage: null,
  createdAt: '2026-05-18T09:00:00.000Z',
  updatedAt: '2026-05-18T09:00:01.500Z',
};

// ============================================
// ScheduledEpicApiError
// ============================================

describe('ScheduledEpicApiError', () => {
  it('stores status code and message', () => {
    const err = new ScheduledEpicApiError('not found', 404);
    expect(err.message).toBe('not found');
    expect(err.status).toBe(404);
    expect(err.name).toBe('ScheduledEpicApiError');
    expect(err).toBeInstanceOf(Error);
  });

  it('isVersionConflict returns true for 409', () => {
    const err = new ScheduledEpicApiError('conflict', 409);
    expect(err.isVersionConflict).toBe(true);
  });

  it('isVersionConflict returns false for other status codes', () => {
    expect(new ScheduledEpicApiError('bad request', 400).isVersionConflict).toBe(false);
    expect(new ScheduledEpicApiError('not found', 404).isVersionConflict).toBe(false);
    expect(new ScheduledEpicApiError('server error', 500).isVersionConflict).toBe(false);
  });
});

// ============================================
// CRON_PRESETS
// ============================================

describe('CRON_PRESETS', () => {
  it('contains at least one preset', () => {
    expect(CRON_PRESETS.length).toBeGreaterThan(0);
  });

  it('every preset has label, expression, and description', () => {
    for (const preset of CRON_PRESETS) {
      expect(typeof preset.label).toBe('string');
      expect(preset.label.length).toBeGreaterThan(0);
      expect(typeof preset.expression).toBe('string');
      expect(preset.expression.length).toBeGreaterThan(0);
      expect(typeof preset.description).toBe('string');
      expect(preset.description.length).toBeGreaterThan(0);
    }
  });

  it('includes a daily and weekly preset', () => {
    const expressions = CRON_PRESETS.map((p) => p.expression);
    expect(expressions).toContain('0 0 * * *');
    expect(expressions.some((e) => e.includes('* * 1'))).toBe(true);
  });
});

// ============================================
// fetchScheduledEpics
// ============================================

describe('fetchScheduledEpics', () => {
  it('calls correct URL with projectId', async () => {
    mockFetch(true, [baseSchedule]);
    const result = await fetchScheduledEpics('proj-1');
    expect(result).toEqual([baseSchedule]);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/scheduled-epics?projectId=proj-1'),
    );
  });

  it('appends enabled=true filter when provided', async () => {
    mockFetch(true, [baseSchedule]);
    await fetchScheduledEpics('proj-1', { enabled: true });
    const url = String((global.fetch as jest.Mock).mock.calls[0][0]);
    expect(url).toContain('enabled=true');
  });

  it('appends enabled=false filter when provided', async () => {
    mockFetch(true, []);
    await fetchScheduledEpics('proj-1', { enabled: false });
    const url = String((global.fetch as jest.Mock).mock.calls[0][0]);
    expect(url).toContain('enabled=false');
  });

  it('throws ScheduledEpicApiError on failure', async () => {
    mockFetch(false, { message: 'Server error' }, 500);
    await expect(fetchScheduledEpics('proj-1')).rejects.toBeInstanceOf(ScheduledEpicApiError);
  });

  it('surfaces status code from error response', async () => {
    mockFetch(false, { message: 'Not found' }, 404);
    try {
      await fetchScheduledEpics('proj-1');
    } catch (err) {
      expect((err as ScheduledEpicApiError).status).toBe(404);
    }
  });
});

// ============================================
// fetchScheduledEpic
// ============================================

describe('fetchScheduledEpic', () => {
  it('calls correct URL', async () => {
    mockFetch(true, baseSchedule);
    const result = await fetchScheduledEpic('sched-1');
    expect(result).toEqual(baseSchedule);
    expect(global.fetch).toHaveBeenCalledWith('/api/scheduled-epics/sched-1');
  });

  it('throws ScheduledEpicApiError on 404', async () => {
    mockFetch(false, { message: 'Not found' }, 404);
    await expect(fetchScheduledEpic('sched-1')).rejects.toBeInstanceOf(ScheduledEpicApiError);
  });
});

// ============================================
// createScheduledEpic
// ============================================

describe('createScheduledEpic', () => {
  it('POSTs to /api/scheduled-epics with JSON body', async () => {
    mockFetch(true, baseSchedule);
    const data = {
      projectId: 'proj-1',
      name: 'Weekly sync',
      cronExpression: '0 9 * * 1',
      timezone: 'UTC',
      titleTemplate: 'Weekly sync',
    };
    const result = await createScheduledEpic(data);
    expect(result).toEqual(baseSchedule);
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/scheduled-epics',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }),
    );
  });

  it('throws ScheduledEpicApiError on validation failure', async () => {
    mockFetch(false, { message: 'Validation failed' }, 400);
    await expect(
      createScheduledEpic({
        projectId: 'proj-1',
        name: '',
        cronExpression: 'invalid',
        timezone: 'UTC',
        titleTemplate: 'x',
      }),
    ).rejects.toBeInstanceOf(ScheduledEpicApiError);
  });
});

// ============================================
// updateScheduledEpic
// ============================================

describe('updateScheduledEpic', () => {
  it('PUTs to /api/scheduled-epics/:id with configVersion in body', async () => {
    const updated = { ...baseSchedule, name: 'Updated', configVersion: 2 };
    mockFetch(true, updated);
    const data = { configVersion: 1, name: 'Updated' };
    const result = await updateScheduledEpic('sched-1', data);
    expect(result.name).toBe('Updated');
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/scheduled-epics/sched-1',
      expect.objectContaining({
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }),
    );
  });

  it('throws ScheduledEpicApiError with status 409 on version conflict', async () => {
    mockFetch(false, { message: 'Version conflict' }, 409);
    try {
      await updateScheduledEpic('sched-1', { configVersion: 1 });
    } catch (err) {
      expect(err).toBeInstanceOf(ScheduledEpicApiError);
      expect((err as ScheduledEpicApiError).status).toBe(409);
      expect((err as ScheduledEpicApiError).isVersionConflict).toBe(true);
    }
  });
});

// ============================================
// deleteScheduledEpic
// ============================================

describe('deleteScheduledEpic', () => {
  it('sends DELETE to /api/scheduled-epics/:id', async () => {
    mockFetch(true, { success: true });
    await deleteScheduledEpic('sched-1');
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/scheduled-epics/sched-1',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('throws ScheduledEpicApiError on failure', async () => {
    mockFetch(false, { message: 'Not found' }, 404);
    await expect(deleteScheduledEpic('sched-1')).rejects.toBeInstanceOf(ScheduledEpicApiError);
  });
});

// ============================================
// toggleScheduledEpic
// ============================================

describe('toggleScheduledEpic', () => {
  it('POSTs to /api/scheduled-epics/:id/toggle with enabled and configVersion', async () => {
    const toggled = { ...baseSchedule, enabled: false, configVersion: 2 };
    mockFetch(true, toggled);
    const result = await toggleScheduledEpic('sched-1', false, 1);
    expect(result.enabled).toBe(false);
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/scheduled-epics/sched-1/toggle',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ enabled: false, configVersion: 1 }),
      }),
    );
  });

  it('throws ScheduledEpicApiError with status 409 on version conflict', async () => {
    mockFetch(false, { message: 'Version conflict' }, 409);
    try {
      await toggleScheduledEpic('sched-1', false, 1);
    } catch (err) {
      expect(err).toBeInstanceOf(ScheduledEpicApiError);
      expect((err as ScheduledEpicApiError).isVersionConflict).toBe(true);
    }
  });
});

// ============================================
// runScheduledEpicNow
// ============================================

describe('runScheduledEpicNow', () => {
  it('POSTs to /api/scheduled-epics/:id/run-now with no body', async () => {
    const runResult = { claimed: true, run: baseRun };
    mockFetch(true, runResult);
    const result = await runScheduledEpicNow('sched-1');
    expect(result.claimed).toBe(true);
    expect(result.run).toEqual(baseRun);
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/scheduled-epics/sched-1/run-now',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('returns claimed=false when run is already claimed', async () => {
    mockFetch(true, { claimed: false, run: baseRun });
    const result = await runScheduledEpicNow('sched-1');
    expect(result.claimed).toBe(false);
  });

  it('throws ScheduledEpicApiError on failure', async () => {
    mockFetch(false, { message: 'Server error' }, 500);
    await expect(runScheduledEpicNow('sched-1')).rejects.toBeInstanceOf(ScheduledEpicApiError);
  });
});

// ============================================
// fetchScheduledEpicRuns
// ============================================

describe('fetchScheduledEpicRuns', () => {
  const runsPage = { items: [baseRun], total: 1, limit: 20, offset: 0 };

  it('calls correct URL for schedule runs', async () => {
    mockFetch(true, runsPage);
    const result = await fetchScheduledEpicRuns('sched-1');
    expect(result).toEqual(runsPage);
    expect(global.fetch).toHaveBeenCalledWith('/api/scheduled-epics/sched-1/runs');
  });

  it('appends status filter when provided', async () => {
    mockFetch(true, runsPage);
    await fetchScheduledEpicRuns('sched-1', { status: 'completed' });
    const url = String((global.fetch as jest.Mock).mock.calls[0][0]);
    expect(url).toContain('status=completed');
  });

  it('appends limit and offset when provided', async () => {
    mockFetch(true, runsPage);
    await fetchScheduledEpicRuns('sched-1', { limit: 10, offset: 20 });
    const url = String((global.fetch as jest.Mock).mock.calls[0][0]);
    expect(url).toContain('limit=10');
    expect(url).toContain('offset=20');
  });

  it('returns paginated shape with items/total/limit/offset', async () => {
    mockFetch(true, { items: [baseRun], total: 42, limit: 10, offset: 0 });
    const result = await fetchScheduledEpicRuns('sched-1', { limit: 10 });
    expect(result.items).toHaveLength(1);
    expect(result.total).toBe(42);
    expect(result.limit).toBe(10);
    expect(result.offset).toBe(0);
  });

  it('throws ScheduledEpicApiError on failure', async () => {
    mockFetch(false, { message: 'Not found' }, 404);
    await expect(fetchScheduledEpicRuns('sched-1')).rejects.toBeInstanceOf(ScheduledEpicApiError);
  });
});
