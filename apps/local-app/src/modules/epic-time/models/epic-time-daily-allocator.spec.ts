import type { EpicTimeDailyTotal } from './epic-time.models';
import { allocateDailyEstimateExport } from './epic-time-daily-allocator';

// Layer: backend unit. The allocator is a pure shared plan (browser and
// server); plain input/output assertions are the cheapest reliable layer.
describe('allocateDailyEstimateExport', () => {
  const totals = (entries: Record<string, number>): EpicTimeDailyTotal[] =>
    Object.entries(entries).map(([activityDate, minutes]) => ({ activityDate, minutes }));

  const input = (overrides: Partial<Parameters<typeof allocateDailyEstimateExport>[0]> = {}) => ({
    liveByDate: [] as EpicTimeDailyTotal[],
    capturedByDate: [] as EpicTimeDailyTotal[],
    ledgerByDate: [] as EpicTimeDailyTotal[],
    unallocatedCreditMinutes: 0,
    storedCanonicalTimeZone: null,
    currentCanonicalTimeZone: 'UTC',
    ...overrides,
  });

  it('exports the full captured projection when nothing is persisted', () => {
    const allocation = allocateDailyEstimateExport(
      input({
        liveByDate: totals({ '2026-01-02': 90, '2026-01-03': 30 }),
        capturedByDate: totals({ '2026-01-02': 90, '2026-01-03': 30 }),
      }),
    );
    expect(allocation.status).toBe('ok');
    expect(allocation.totalNewMinutes).toBe(120);
    expect(allocation.datedDeltas).toEqual(totals({ '2026-01-02': 90, '2026-01-03': 30 }));
    expect(allocation.materializedCredit).toEqual([]);
    expect(allocation.entryChunks).toEqual([
      {
        activityDate: '2026-01-02',
        startedAt: '2026-01-02T00:00:00.000Z',
        durationMs: 90 * 60_000,
        minutes: 90,
      },
      {
        activityDate: '2026-01-03',
        startedAt: '2026-01-03T00:00:00.000Z',
        durationMs: 30 * 60_000,
        minutes: 30,
      },
    ]);
    expect(allocation.rebaseline).toEqual({ required: false, reason: null });
  });

  it('keeps live growth beyond the capture for a later request', () => {
    const allocation = allocateDailyEstimateExport(
      input({
        liveByDate: totals({ '2026-01-02': 200 }),
        capturedByDate: totals({ '2026-01-02': 100 }),
      }),
    );
    expect(allocation.status).toBe('ok');
    expect(allocation.totalNewMinutes).toBe(100);
    expect(allocation.datedDeltas).toEqual(totals({ '2026-01-02': 100 }));
  });

  it('materializes legacy credit oldest-first and exports only the remainder', () => {
    const allocation = allocateDailyEstimateExport(
      input({
        liveByDate: totals({ '2026-01-01': 60, '2026-01-02': 80 }),
        capturedByDate: totals({ '2026-01-01': 60, '2026-01-02': 80 }),
        unallocatedCreditMinutes: 100,
      }),
    );
    expect(allocation.status).toBe('ok');
    expect(allocation.materializedCredit).toEqual(totals({ '2026-01-01': 60, '2026-01-02': 40 }));
    expect(allocation.datedDeltas).toEqual(totals({ '2026-01-02': 40 }));
    expect(allocation.totalNewMinutes).toBe(40);
  });

  it('never moves persisted ledger minutes', () => {
    const allocation = allocateDailyEstimateExport(
      input({
        liveByDate: totals({ '2026-01-01': 60, '2026-01-02': 90 }),
        capturedByDate: totals({ '2026-01-01': 60, '2026-01-02': 90 }),
        ledgerByDate: totals({ '2026-01-01': 60 }),
        storedCanonicalTimeZone: 'UTC',
      }),
    );
    expect(allocation.status).toBe('ok');
    expect(allocation.materializedCredit).toEqual([]);
    expect(allocation.datedDeltas).toEqual(totals({ '2026-01-02': 90 }));
  });

  it('absorbs credit into uncovered ledger dates before computing deltas', () => {
    const allocation = allocateDailyEstimateExport(
      input({
        liveByDate: totals({ '2026-01-01': 60, '2026-01-02': 20 }),
        capturedByDate: totals({ '2026-01-01': 60, '2026-01-02': 20 }),
        ledgerByDate: totals({ '2026-01-01': 30 }),
        unallocatedCreditMinutes: 50,
        storedCanonicalTimeZone: 'UTC',
      }),
    );
    expect(allocation.status).toBe('ok');
    expect(allocation.materializedCredit).toEqual(totals({ '2026-01-01': 30, '2026-01-02': 20 }));
    expect(allocation.datedDeltas).toEqual([]);
    expect(allocation.totalNewMinutes).toBe(0);
  });

  it('splits oversized same-date totals into overlapping chunks at the local day start', () => {
    const allocation = allocateDailyEstimateExport(
      input({
        capturedByDate: totals({ '2026-01-02': 2_900 }),
        liveByDate: totals({ '2026-01-02': 2_900 }),
      }),
    );
    expect(allocation.entryChunks).toEqual([
      {
        activityDate: '2026-01-02',
        startedAt: '2026-01-02T00:00:00.000Z',
        durationMs: 1_440 * 60_000,
        minutes: 1_440,
      },
      {
        activityDate: '2026-01-02',
        startedAt: '2026-01-02T00:00:00.000Z',
        durationMs: 1_440 * 60_000,
        minutes: 1_440,
      },
      {
        activityDate: '2026-01-02',
        startedAt: '2026-01-02T00:00:00.000Z',
        durationMs: 20 * 60_000,
        minutes: 20,
      },
    ]);
  });

  it('caps chunks at the shorter length of a 23-hour DST day', () => {
    const allocation = allocateDailyEstimateExport(
      input({
        capturedByDate: totals({ '2026-03-08': 1_500 }),
        liveByDate: totals({ '2026-03-08': 1_500 }),
        currentCanonicalTimeZone: 'America/New_York',
      }),
    );
    expect(allocation.entryChunks).toEqual([
      {
        activityDate: '2026-03-08',
        startedAt: '2026-03-08T05:00:00.000Z',
        durationMs: 1_380 * 60_000,
        minutes: 1_380,
      },
      {
        activityDate: '2026-03-08',
        startedAt: '2026-03-08T05:00:00.000Z',
        durationMs: 120 * 60_000,
        minutes: 120,
      },
    ]);
  });

  it('caps chunks at the length of a 24.5-hour DST day', () => {
    const allocation = allocateDailyEstimateExport(
      input({
        capturedByDate: totals({ '2026-04-05': 1_500 }),
        liveByDate: totals({ '2026-04-05': 1_500 }),
        currentCanonicalTimeZone: 'Australia/Lord_Howe',
      }),
    );
    expect(allocation.entryChunks.map((chunk) => chunk.minutes)).toEqual([1_470, 30]);
    expect(
      allocation.entryChunks.every((chunk) => chunk.startedAt === '2026-04-04T13:00:00.000Z'),
    ).toBe(true);
  });

  it('treats a covered zone change as a safe rebind that continues incrementally', () => {
    const allocation = allocateDailyEstimateExport(
      input({
        capturedByDate: totals({ '2026-01-02': 100 }),
        liveByDate: totals({ '2026-01-02': 100 }),
        ledgerByDate: totals({ '2026-01-02': 60 }),
        storedCanonicalTimeZone: 'America/New_York',
        currentCanonicalTimeZone: 'UTC',
      }),
    );
    expect(allocation.status).toBe('ok');
    expect(allocation.safeZoneRebind).toBe(true);
    expect(allocation.rebaseline).toEqual({ required: false, reason: null });
    expect(allocation.datedDeltas).toEqual(totals({ '2026-01-02': 40 }));
    expect(allocation.entryChunks).toHaveLength(1);
  });

  it('treats an empty-ledger zone change as a safe rebind with legacy credit', () => {
    const allocation = allocateDailyEstimateExport(
      input({
        capturedByDate: totals({ '2026-01-01': 60 }),
        liveByDate: totals({ '2026-01-01': 60 }),
        unallocatedCreditMinutes: 40,
        storedCanonicalTimeZone: 'America/New_York',
        currentCanonicalTimeZone: 'UTC',
      }),
    );
    expect(allocation.status).toBe('ok');
    expect(allocation.safeZoneRebind).toBe(true);
    expect(allocation.materializedCredit).toEqual(totals({ '2026-01-01': 40 }));
    expect(allocation.datedDeltas).toEqual(totals({ '2026-01-01': 20 }));
    expect(allocation.totalNewMinutes).toBe(20);
  });

  it('directs a destructive rebaseline when a zone change meets a dated deficit', () => {
    const allocation = allocateDailyEstimateExport(
      input({
        capturedByDate: totals({ '2026-01-02': 60 }),
        liveByDate: totals({ '2026-01-02': 60 }),
        ledgerByDate: totals({ '2026-01-01': 60 }),
        storedCanonicalTimeZone: 'UTC',
        currentCanonicalTimeZone: 'America/New_York',
      }),
    );
    expect(allocation.status).toBe('zone_rebind_required');
    expect(allocation.rebaseline).toEqual({ required: true, reason: 'zone_rebind' });
    expect(allocation.safeZoneRebind).toBe(false);
    expect(allocation.datedDeltas).toEqual([]);
    expect(allocation.entryChunks).toEqual([]);
    expect(allocation.totalNewMinutes).toBe(0);
  });

  it('treats UTC aliases as the same canonical zone without a rebind', () => {
    const allocation = allocateDailyEstimateExport(
      input({
        capturedByDate: totals({ '2026-01-02': 100 }),
        liveByDate: totals({ '2026-01-02': 100 }),
        ledgerByDate: totals({ '2026-01-02': 60 }),
        storedCanonicalTimeZone: 'Etc/UTC',
        currentCanonicalTimeZone: 'utc',
      }),
    );
    expect(allocation.status).toBe('ok');
    expect(allocation.safeZoneRebind).toBe(false);
    expect(allocation.datedDeltas).toEqual(totals({ '2026-01-02': 40 }));
  });

  it('reports real shrink for a cross-date deficit even when totals match', () => {
    const allocation = allocateDailyEstimateExport(
      input({
        liveByDate: totals({ '2026-01-02': 60 }),
        capturedByDate: totals({ '2026-01-02': 60 }),
        ledgerByDate: totals({ '2026-01-01': 60 }),
        storedCanonicalTimeZone: 'UTC',
      }),
    );
    expect(allocation.status).toBe('real_shrink');
    expect(allocation.rebaseline).toEqual({ required: true, reason: 'dated_deficit' });
    expect(allocation.safeZoneRebind).toBe(false);
    expect(allocation.totalNewMinutes).toBe(0);
  });

  it('does not let scalar credit hide a dated deficit', () => {
    const allocation = allocateDailyEstimateExport(
      input({
        liveByDate: totals({ '2026-01-02': 90 }),
        capturedByDate: totals({ '2026-01-02': 90 }),
        ledgerByDate: totals({ '2026-01-01': 60 }),
        unallocatedCreditMinutes: 30,
        storedCanonicalTimeZone: 'UTC',
      }),
    );
    expect(allocation.status).toBe('real_shrink');
    expect(allocation.rebaseline).toEqual({ required: true, reason: 'dated_deficit' });
  });

  it('reports real shrink when live time is below the persisted total', () => {
    const allocation = allocateDailyEstimateExport(
      input({
        liveByDate: totals({ '2026-01-02': 90 }),
        capturedByDate: totals({ '2026-01-02': 90 }),
        ledgerByDate: totals({ '2026-01-02': 100 }),
        storedCanonicalTimeZone: 'UTC',
      }),
    );
    expect(allocation.status).toBe('real_shrink');
    expect(allocation.rebaseline).toEqual({ required: true, reason: 'dated_deficit' });
    expect(allocation.safeZoneRebind).toBe(false);
    expect(allocation.totalNewMinutes).toBe(0);
  });

  it('counts scalar credit inside the persisted total for the shrink check', () => {
    const allocation = allocateDailyEstimateExport(
      input({
        liveByDate: totals({ '2026-01-02': 90 }),
        capturedByDate: totals({ '2026-01-02': 90 }),
        ledgerByDate: totals({ '2026-01-02': 40 }),
        unallocatedCreditMinutes: 60,
        storedCanonicalTimeZone: 'UTC',
      }),
    );
    expect(allocation.status).toBe('real_shrink');
  });

  it('reports stale capture instead of rebaseline when the capture trails the ledger', () => {
    const allocation = allocateDailyEstimateExport(
      input({
        liveByDate: totals({ '2026-01-02': 150 }),
        capturedByDate: totals({ '2026-01-02': 80 }),
        ledgerByDate: totals({ '2026-01-02': 100 }),
        storedCanonicalTimeZone: 'UTC',
      }),
    );
    expect(allocation.status).toBe('stale_capture');
    expect(allocation.rebaseline).toEqual({ required: false, reason: null });
    expect(allocation.safeZoneRebind).toBe(false);
    expect(allocation.entryChunks).toEqual([]);
  });

  it('reports stale capture per date when live covers the ledger but the capture drops it', () => {
    const allocation = allocateDailyEstimateExport(
      input({
        liveByDate: totals({ '2026-01-01': 60, '2026-01-02': 30 }),
        capturedByDate: totals({ '2026-01-02': 30 }),
        ledgerByDate: totals({ '2026-01-01': 60 }),
        storedCanonicalTimeZone: 'UTC',
      }),
    );
    expect(allocation.status).toBe('stale_capture');
    expect(allocation.rebaseline).toEqual({ required: false, reason: null });
  });

  it('sorts every output oldest-date first regardless of input order', () => {
    const allocation = allocateDailyEstimateExport(
      input({
        liveByDate: totals({ '2026-03-01': 10, '2026-01-01': 10, '2026-02-01': 10 }),
        capturedByDate: totals({ '2026-02-01': 10, '2026-03-01': 10, '2026-01-01': 10 }),
        ledgerByDate: totals({ '2026-03-01': 5 }),
        storedCanonicalTimeZone: 'UTC',
      }),
    );
    expect(allocation.datedDeltas.map((delta) => delta.activityDate)).toEqual([
      '2026-01-01',
      '2026-02-01',
      '2026-03-01',
    ]);
    expect(allocation.entryChunks.map((chunk) => chunk.activityDate)).toEqual([
      '2026-01-01',
      '2026-02-01',
      '2026-03-01',
    ]);
  });

  it('returns an empty ok plan when the capture is fully persisted', () => {
    const allocation = allocateDailyEstimateExport(
      input({
        liveByDate: totals({ '2026-01-02': 60 }),
        capturedByDate: totals({ '2026-01-02': 60 }),
        ledgerByDate: totals({ '2026-01-02': 60 }),
        storedCanonicalTimeZone: 'UTC',
      }),
    );
    expect(allocation.status).toBe('ok');
    expect(allocation.totalNewMinutes).toBe(0);
    expect(allocation.datedDeltas).toEqual([]);
    expect(allocation.entryChunks).toEqual([]);
  });

  it('rejects malformed dates, negative minutes, and invalid zones', () => {
    expect(() =>
      allocateDailyEstimateExport(
        input({ capturedByDate: [{ activityDate: '2026-1-2', minutes: 5 }] }),
      ),
    ).toThrow();
    expect(() =>
      allocateDailyEstimateExport(
        input({ capturedByDate: [{ activityDate: '2026-01-02', minutes: -1 }] }),
      ),
    ).toThrow();
    expect(() =>
      allocateDailyEstimateExport(
        input({ capturedByDate: [{ activityDate: '2026-01-02', minutes: 1.5 }] }),
      ),
    ).toThrow();
    expect(() => allocateDailyEstimateExport(input({ unallocatedCreditMinutes: -5 }))).toThrow();
    expect(() =>
      allocateDailyEstimateExport(input({ currentCanonicalTimeZone: '+01:00' })),
    ).toThrow();
    expect(() =>
      allocateDailyEstimateExport(input({ storedCanonicalTimeZone: 'Not/A_Zone' })),
    ).toThrow();
  });
});
