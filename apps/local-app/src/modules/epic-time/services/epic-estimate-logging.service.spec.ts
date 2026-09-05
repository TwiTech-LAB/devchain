import { createHash } from 'node:crypto';
import {
  BusyError,
  ConflictError,
  OptimisticLockError,
  ValidationError,
} from '../../../common/errors/error-types';
import type { ExternalTimeMutationService } from '../../external-integrations/my-work/external-time-mutation.service';
import {
  timeOperationCanVerify,
  type ExternalTimeCreateBaseline,
  type ExternalTimeOperationInspection,
} from '../../external-integrations/models/external-time-mutation.models';
import { timeEntryNoteFingerprint } from '../../external-integrations/sessions/external-time-mutation.store';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import type {
  ExternalEstimateLogDailyCheckpoint,
  ExternalEstimateLogState,
} from '../../storage/models/domain.models';
import {
  EXTERNAL_ESTIMATE_TIME_ENTRY_NOTE,
  type CreateExternalEstimateTimeEntryInput,
  type EpicTimeDailyProjection,
} from '../models/epic-time.models';
import { resolveLocalDayInterval } from '../models/epic-time-local-day';
import { EpicEstimateLoggingService } from './epic-estimate-logging.service';
import type { EpicTimeService } from './epic-time.service';

const context = {
  projectId: 'project-1',
  provider: 'jira' as const,
  remoteScopeKey: 'acme.atlassian.net',
  remoteTaskId: 'ENG-1',
  expectedEpoch: 4,
};
const connection = {
  id: 'connection-1',
  projectId: context.projectId,
  provider: context.provider,
  legacySourceConnectionId: null,
  generation: 4,
  subtaskSyncEnabled: false,
  syncSettingRevision: 1,
  createdAt: '2026-08-30T08:00:00.000Z',
  updatedAt: '2026-08-30T08:00:00.000Z',
};
const link = {
  id: 'link-1',
  epicId: 'epic-1',
  connectionId: connection.id,
  provider: context.provider,
  remoteScopeKey: context.remoteScopeKey,
  remoteTaskId: context.remoteTaskId,
  sourceSnapshot: {},
  createdAt: '2026-08-30T08:00:00.000Z',
  updatedAt: '2026-08-30T08:00:00.000Z',
};
const epic = { id: link.epicId, projectId: context.projectId };
const startedAt = '2026-08-30T10:30:00.000Z';

const ready = (loggedMinutes: number, revision: number): ExternalEstimateLogState => ({
  provider: context.provider,
  remoteScopeKey: context.remoteScopeKey,
  remoteTaskId: context.remoteTaskId,
  loggedMinutes,
  revision,
  aggregationTimeZone: null,
  pendingOperationId: null,
  pendingDeltaMinutes: null,
  pendingEstimateTotalMinutes: null,
  pendingStartedAt: null,
  pendingConnectionId: null,
  pendingConnectionGeneration: null,
  pendingPhase: null,
  pendingResolution: null,
  pendingActivityDate: null,
  createdAt: '2026-08-30T08:00:00.000Z',
  updatedAt: '2026-08-30T08:00:00.000Z',
});

const pending = (
  overrides: Partial<Extract<ExternalEstimateLogState, { pendingOperationId: string }>> = {},
): Extract<ExternalEstimateLogState, { pendingOperationId: string }> => ({
  provider: context.provider,
  remoteScopeKey: context.remoteScopeKey,
  remoteTaskId: context.remoteTaskId,
  loggedMinutes: 0,
  revision: 1,
  aggregationTimeZone: null,
  pendingOperationId: 'operation-1',
  pendingDeltaMinutes: 90,
  pendingEstimateTotalMinutes: 90,
  pendingStartedAt: startedAt,
  pendingConnectionId: connection.id,
  pendingConnectionGeneration: connection.generation,
  pendingPhase: 'prepared',
  pendingResolution: null,
  pendingActivityDate: null,
  createdAt: '2026-08-30T08:00:00.000Z',
  updatedAt: '2026-08-30T08:00:00.000Z',
  ...overrides,
});

const inspection = (
  state: Extract<ExternalEstimateLogState, { pendingOperationId: string }>,
  phase: ExternalTimeOperationInspection['phase'],
  overrides: Partial<ExternalTimeOperationInspection['tuple']> = {},
  baseline: ExternalTimeCreateBaseline | null = { matchingIds: [], complete: true },
): ExternalTimeOperationInspection => ({
  operationId: state.pendingOperationId,
  kind: 'create',
  phase,
  canVerify: timeOperationCanVerify({ kind: 'create', phase, baseline }),
  expiresAt: '2026-08-31T12:00:00.000Z',
  tuple: {
    provider: state.provider,
    connectionId: state.pendingConnectionId,
    connectionGeneration: state.pendingConnectionGeneration,
    remoteTaskId: state.remoteTaskId,
    remoteEntryId: null,
    effectiveStartedAt: state.pendingStartedAt,
    durationMs: state.pendingDeltaMinutes * 60_000,
    noteFingerprint: timeEntryNoteFingerprint(EXTERNAL_ESTIMATE_TIME_ENTRY_NOTE),
    ...overrides,
  },
});

const receiptView = (phase: 'succeeded' | 'outcome_unknown') => ({
  operationId: 'operation-1',
  kind: 'create' as const,
  provider: context.provider,
  remoteTaskId: context.remoteTaskId,
  remoteEntryId: phase === 'succeeded' ? 'entry-1' : null,
  phase,
  canVerify: phase === 'outcome_unknown',
  createdAt: '2026-08-30T12:00:00.000Z',
  updatedAt: '2026-08-30T12:00:00.000Z',
  expiresAt: '2026-08-31T12:00:00.000Z',
});

// Layer: backend unit. The provider boundary and storage state machine already
// have integration coverage; mocks make every crash/receipt/epoch branch deterministic.
describe('EpicEstimateLoggingService', () => {
  let storage: jest.Mocked<
    Pick<
      StorageService,
      | 'findExternalTaskLink'
      | 'getIntegrationConnection'
      | 'getEpic'
      | 'getExternalEstimateLogState'
      | 'getExternalEstimateLogDailyCheckpoint'
      | 'setExternalEstimateLoggedMinutes'
      | 'prepareExternalEstimateLogOperation'
      | 'markExternalEstimateLogOperationOutcomeUnknown'
      | 'confirmExternalEstimateLogOperation'
      | 'clearExternalEstimateLogOperation'
      | 'storeExternalEstimateLogResolution'
      | 'applyExternalEstimateLogResolution'
    >
  >;
  let epicTime: jest.Mocked<Pick<EpicTimeService, 'getDailyProjection'>>;
  let timeMutations: jest.Mocked<
    Pick<
      ExternalTimeMutationService,
      'inspectOperation' | 'createEstimateTimeEntry' | 'verifyOperation' | 'acknowledgeOperation'
    >
  >;
  let service: EpicEstimateLoggingService;

  beforeEach(() => {
    storage = {
      findExternalTaskLink: jest.fn().mockResolvedValue(link),
      getIntegrationConnection: jest.fn().mockResolvedValue(connection),
      getEpic: jest.fn().mockResolvedValue(epic),
      getExternalEstimateLogState: jest.fn(),
      getExternalEstimateLogDailyCheckpoint: jest.fn(),
      setExternalEstimateLoggedMinutes: jest.fn(),
      prepareExternalEstimateLogOperation: jest.fn(),
      markExternalEstimateLogOperationOutcomeUnknown: jest.fn(),
      confirmExternalEstimateLogOperation: jest.fn(),
      clearExternalEstimateLogOperation: jest.fn(),
      storeExternalEstimateLogResolution: jest.fn(),
      applyExternalEstimateLogResolution: jest.fn(),
    };
    epicTime = { getDailyProjection: jest.fn() };
    timeMutations = {
      inspectOperation: jest.fn(),
      createEstimateTimeEntry: jest.fn(),
      verifyOperation: jest.fn(),
      acknowledgeOperation: jest.fn(),
    };
    service = new EpicEstimateLoggingService(
      storage as unknown as StorageService,
      epicTime as unknown as EpicTimeService,
      timeMutations as unknown as ExternalTimeMutationService,
    );
    jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-08-30T12:00:00.000Z'));
  });

  afterEach(() => jest.restoreAllMocks());

  const REQUEST_KEY = '11111111-1111-4111-8111-111111111111';
  const KEY_HASH = createHash('sha256').update(REQUEST_KEY).digest('hex');
  const childOperationId = (index: number) => `daily:${KEY_HASH}:${index}`;
  /** Queues the ten child-receipt admission checks a fresh request key consumes. */
  const admitFreshKey = () => {
    for (let index = 0; index < 10; index += 1) {
      timeMutations.inspectOperation.mockReturnValueOnce(null);
    }
  };
  const AGGREGATION_ZONE = 'Europe/Madrid';
  const dayStart = (activityDate: string) =>
    new Date(resolveLocalDayInterval(activityDate, AGGREGATION_ZONE).startUtcMs).toISOString();

  const projection = (
    currentByDate: Array<{ activityDate: string; minutes: number }>,
  ): EpicTimeDailyProjection => ({
    canonicalTimeZone: AGGREGATION_ZONE,
    totalMinutes: currentByDate.reduce((total, day) => total + day.minutes, 0),
    currentByDate,
  });

  const checkpoint = (
    state: ExternalEstimateLogState | null,
    days: Array<{ activityDate: string; loggedMinutes: number }> = [],
  ): ExternalEstimateLogDailyCheckpoint | null =>
    state === null
      ? null
      : {
          state,
          days: days.map((day) => ({ ...context, ...day })),
          unallocatedLoggedMinutes: Math.max(
            0,
            state.loggedMinutes - days.reduce((total, day) => total + day.loggedMinutes, 0),
          ),
        };

  const createInput = (
    overrides: Partial<CreateExternalEstimateTimeEntryInput> = {},
  ): CreateExternalEstimateTimeEntryInput => ({
    ...context,
    requestKey: REQUEST_KEY,
    timeZone: AGGREGATION_ZONE,
    estimateTotalMinutes: 90,
    expectedRevision: 0,
    dailySnapshot: [{ activityDate: '2026-08-29', minutes: 90 }],
    ...overrides,
  });

  it('settles one dated entry end to end with a derived child operation id', async () => {
    const activityDate = '2026-08-29';
    const prepared = pending({
      revision: 1,
      loggedMinutes: 0,
      pendingOperationId: childOperationId(0),
      pendingDeltaMinutes: 90,
      pendingEstimateTotalMinutes: 90,
      pendingStartedAt: dayStart(activityDate),
      pendingActivityDate: activityDate,
      aggregationTimeZone: AGGREGATION_ZONE,
    });
    epicTime.getDailyProjection.mockReturnValue(projection([{ activityDate, minutes: 90 }]));
    storage.getExternalEstimateLogDailyCheckpoint
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(
        checkpoint({ ...ready(90, 2), aggregationTimeZone: AGGREGATION_ZONE }, [
          { activityDate, loggedMinutes: 90 },
        ]),
      );
    storage.getExternalEstimateLogState
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(ready(90, 2));
    storage.prepareExternalEstimateLogOperation.mockResolvedValue(prepared);
    storage.confirmExternalEstimateLogOperation.mockResolvedValue(ready(90, 2));
    admitFreshKey();
    timeMutations.inspectOperation.mockReturnValueOnce(inspection(prepared, 'succeeded'));
    timeMutations.createEstimateTimeEntry.mockResolvedValue({
      outcome: 'created',
      remoteEntryId: 'entry-1',
      refresh: ['task_detail'],
      receipt: receiptView('succeeded'),
    });

    const result = await service.createTimeEntry(createInput());

    expect(result).toMatchObject({
      outcome: 'logged',
      entriesLogged: 1,
      minutesLogged: 90,
      hasMore: false,
      stoppedReason: 'completed',
    });
    expect(result.snapshot).toMatchObject({
      aggregationTimeZone: AGGREGATION_ZONE,
      days: [{ activityDate, loggedMinutes: 90 }],
      unallocatedLoggedMinutes: 0,
    });
    expect(storage.prepareExternalEstimateLogOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: childOperationId(0),
        deltaMinutes: 90,
        startedAt: dayStart(activityDate),
        activityDate,
        aggregationTimeZone: AGGREGATION_ZONE,
        capturedDailyTotals: [{ activityDate, minutes: 90 }],
        expectedRevision: 0,
      }),
    );
    expect(timeMutations.createEstimateTimeEntry).toHaveBeenCalledWith(
      context.projectId,
      context.provider,
      context.remoteTaskId,
      {
        durationMs: 90 * 60_000,
        startedAt: dayStart(activityDate),
        note: EXTERNAL_ESTIMATE_TIME_ENTRY_NOTE,
      },
      childOperationId(0),
      context.expectedEpoch,
    );
    expect(storage.confirmExternalEstimateLogOperation).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: childOperationId(0), expectedRevision: 1 }),
    );
  });

  it('settles multi-date entries sequentially with a fresh revision read per item', async () => {
    const firstDate = '2026-08-28';
    const secondDate = '2026-08-29';
    const preparedFirst = pending({
      revision: 1,
      pendingOperationId: childOperationId(0),
      pendingDeltaMinutes: 30,
      pendingEstimateTotalMinutes: 90,
      pendingStartedAt: dayStart(firstDate),
      pendingActivityDate: firstDate,
    });
    const preparedSecond = pending({
      revision: 3,
      loggedMinutes: 30,
      pendingOperationId: childOperationId(1),
      pendingDeltaMinutes: 60,
      pendingEstimateTotalMinutes: 90,
      pendingStartedAt: dayStart(secondDate),
      pendingActivityDate: secondDate,
    });
    epicTime.getDailyProjection.mockReturnValue(
      projection([
        { activityDate: firstDate, minutes: 30 },
        { activityDate: secondDate, minutes: 60 },
      ]),
    );
    storage.getExternalEstimateLogDailyCheckpoint
      .mockResolvedValueOnce(null)
      .mockResolvedValue(checkpoint(ready(90, 3)));
    // Each item reads the revision fresh: item 0 sees the uninitialized
    // state, item 1 sees the settled prefix — never a assumed +1.
    storage.getExternalEstimateLogState
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(ready(30, 2))
      .mockResolvedValue(ready(90, 3));
    storage.prepareExternalEstimateLogOperation
      .mockResolvedValueOnce(preparedFirst)
      .mockResolvedValueOnce(preparedSecond);
    storage.confirmExternalEstimateLogOperation
      .mockResolvedValueOnce(ready(30, 2))
      .mockResolvedValueOnce(ready(90, 3));
    admitFreshKey();
    timeMutations.inspectOperation
      .mockReturnValueOnce(inspection(preparedFirst, 'succeeded'))
      .mockReturnValueOnce(inspection(preparedSecond, 'succeeded'));
    timeMutations.createEstimateTimeEntry.mockResolvedValue({
      outcome: 'created',
      remoteEntryId: 'entry-1',
      refresh: ['task_detail'],
      receipt: receiptView('succeeded'),
    });

    const result = await service.createTimeEntry(
      createInput({
        estimateTotalMinutes: 90,
        dailySnapshot: [
          { activityDate: firstDate, minutes: 30 },
          { activityDate: secondDate, minutes: 60 },
        ],
      }),
    );

    expect(result).toMatchObject({
      outcome: 'logged',
      entriesLogged: 2,
      minutesLogged: 90,
      hasMore: false,
      stoppedReason: 'completed',
    });
    expect(storage.prepareExternalEstimateLogOperation).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ operationId: childOperationId(0), expectedRevision: 0 }),
    );
    expect(storage.prepareExternalEstimateLogOperation).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ operationId: childOperationId(1), expectedRevision: 2 }),
    );
    expect(timeMutations.createEstimateTimeEntry.mock.calls.map((call) => call[4])).toEqual([
      childOperationId(0),
      childOperationId(1),
    ]);
  });

  it('stops at the 10-entry boundary and leaves the remainder for a fresh click', async () => {
    const dates = Array.from({ length: 11 }, (_, index) => ({
      activityDate: `2026-08-${String(index + 1).padStart(2, '0')}`,
      minutes: 60,
    }));
    epicTime.getDailyProjection.mockReturnValue(projection(dates));
    storage.getExternalEstimateLogDailyCheckpoint
      .mockResolvedValueOnce(null)
      .mockImplementation(async () =>
        settledRevision === null ? null : checkpoint(ready(settledMinutes, settledRevision)),
      );
    // Stateful chain: each read returns exactly the revision the prior
    // confirm produced, so the loop's continuity fence stays satisfied.
    let settledRevision: number | null = null;
    let settledMinutes = 0;
    storage.getExternalEstimateLogState.mockImplementation(async () =>
      settledRevision === null ? null : ready(settledMinutes, settledRevision),
    );
    storage.prepareExternalEstimateLogOperation.mockImplementation(async (data) =>
      pending({
        revision: (data.expectedRevision ?? 0) + 1,
        loggedMinutes: settledMinutes,
        pendingOperationId: data.operationId,
        pendingDeltaMinutes: data.deltaMinutes,
        pendingEstimateTotalMinutes: data.estimateTotalMinutes,
        pendingStartedAt: data.startedAt,
        pendingActivityDate: data.activityDate,
        pendingConnectionId: data.connectionId,
        pendingConnectionGeneration: data.connectionGeneration,
      }),
    );
    storage.confirmExternalEstimateLogOperation.mockImplementation(async (data) => {
      settledMinutes += 60;
      settledRevision = (data.expectedRevision ?? 0) + 1;
      return ready(settledMinutes, settledRevision);
    });
    timeMutations.inspectOperation.mockImplementation((operationId) => {
      if (timeMutations.inspectOperation.mock.calls.length <= 10) {
        return null;
      }
      const index = Number(operationId.slice(-1));
      return inspection(
        pending({
          pendingOperationId: operationId,
          pendingDeltaMinutes: 60,
          pendingEstimateTotalMinutes: 660,
          pendingStartedAt: dayStart(dates[index]!.activityDate),
          pendingActivityDate: dates[index]!.activityDate,
        }),
        'succeeded',
      );
    });
    timeMutations.createEstimateTimeEntry.mockResolvedValue({
      outcome: 'created',
      remoteEntryId: 'entry-1',
      refresh: ['task_detail'],
      receipt: receiptView('succeeded'),
    });

    const result = await service.createTimeEntry(
      createInput({ estimateTotalMinutes: 660, dailySnapshot: dates }),
    );

    expect(result).toMatchObject({
      outcome: 'logged',
      entriesLogged: 10,
      minutesLogged: 600,
      hasMore: true,
      stoppedReason: 'entry_cap',
    });
    expect(timeMutations.createEstimateTimeEntry).toHaveBeenCalledTimes(10);
    expect(timeMutations.createEstimateTimeEntry.mock.calls[9]![4]).toBe(childOperationId(9));
  });

  it('lets one multi-chunk date consume every slot with overlapping entries', async () => {
    const activityDate = '2026-08-29';
    epicTime.getDailyProjection.mockReturnValue(projection([{ activityDate, minutes: 15_000 }]));
    storage.getExternalEstimateLogDailyCheckpoint
      .mockResolvedValueOnce(null)
      .mockImplementation(async () =>
        settledRevision === null ? null : checkpoint(ready(settledMinutes, settledRevision)),
      );
    let settledRevision: number | null = null;
    let settledMinutes = 0;
    storage.getExternalEstimateLogState.mockImplementation(async () =>
      settledRevision === null ? null : ready(settledMinutes, settledRevision),
    );
    storage.prepareExternalEstimateLogOperation.mockImplementation(async (data) =>
      pending({
        revision: (data.expectedRevision ?? 0) + 1,
        loggedMinutes: settledMinutes,
        pendingOperationId: data.operationId,
        pendingDeltaMinutes: data.deltaMinutes,
        pendingEstimateTotalMinutes: data.estimateTotalMinutes,
        pendingStartedAt: data.startedAt,
        pendingActivityDate: data.activityDate,
        pendingConnectionId: data.connectionId,
        pendingConnectionGeneration: data.connectionGeneration,
      }),
    );
    storage.confirmExternalEstimateLogOperation.mockImplementation(async (data) => {
      settledMinutes += 1_440;
      settledRevision = (data.expectedRevision ?? 0) + 1;
      return ready(settledMinutes, settledRevision);
    });
    timeMutations.inspectOperation.mockImplementation((operationId) => {
      if (timeMutations.inspectOperation.mock.calls.length <= 10) {
        return null;
      }
      return inspection(
        pending({
          revision: 1,
          pendingOperationId: operationId,
          pendingDeltaMinutes: 1_440,
          pendingEstimateTotalMinutes: 15_000,
          pendingStartedAt: dayStart(activityDate),
          pendingActivityDate: activityDate,
        }),
        'succeeded',
      );
    });
    timeMutations.createEstimateTimeEntry.mockResolvedValue({
      outcome: 'created',
      remoteEntryId: 'entry-1',
      refresh: ['task_detail'],
      receipt: receiptView('succeeded'),
    });

    const result = await service.createTimeEntry(
      createInput({
        estimateTotalMinutes: 15_000,
        dailySnapshot: [{ activityDate, minutes: 15_000 }],
      }),
    );

    expect(result).toMatchObject({
      outcome: 'logged',
      entriesLogged: 10,
      minutesLogged: 14_400,
      hasMore: true,
      stoppedReason: 'entry_cap',
    });
    // Every dispatched chunk starts at the same local day start and stays
    // inside the 1,440-minute ordinary day length.
    const dispatches = timeMutations.createEstimateTimeEntry.mock.calls;
    expect(dispatches).toHaveLength(10);
    for (const call of dispatches) {
      expect(call[3]).toMatchObject({ startedAt: dayStart(activityDate) });
      expect(call[3].durationMs).toBeLessThanOrEqual(1_440 * 60_000);
    }
  });

  it('keeps live growth beyond the capture unlogged', async () => {
    const activityDate = '2026-08-29';
    const prepared = pending({
      revision: 1,
      pendingOperationId: childOperationId(0),
      pendingDeltaMinutes: 100,
      pendingEstimateTotalMinutes: 100,
      pendingStartedAt: dayStart(activityDate),
      pendingActivityDate: activityDate,
    });
    epicTime.getDailyProjection.mockReturnValue(projection([{ activityDate, minutes: 200 }]));
    storage.getExternalEstimateLogDailyCheckpoint.mockResolvedValue(null);
    storage.getExternalEstimateLogState.mockResolvedValue(null);
    storage.prepareExternalEstimateLogOperation.mockResolvedValue(prepared);
    storage.confirmExternalEstimateLogOperation.mockResolvedValue(ready(100, 2));
    admitFreshKey();
    timeMutations.inspectOperation.mockReturnValueOnce(inspection(prepared, 'succeeded'));
    timeMutations.createEstimateTimeEntry.mockResolvedValue({
      outcome: 'created',
      remoteEntryId: 'entry-1',
      refresh: ['task_detail'],
      receipt: receiptView('succeeded'),
    });

    const result = await service.createTimeEntry(
      createInput({ estimateTotalMinutes: 100, dailySnapshot: [{ activityDate, minutes: 100 }] }),
    );

    expect(result).toMatchObject({ outcome: 'logged', minutesLogged: 100 });
    expect(storage.prepareExternalEstimateLogOperation).toHaveBeenCalledWith(
      expect.objectContaining({ deltaMinutes: 100 }),
    );
  });

  it('does not bypass a prepared checkpoint owned by a different estimate operation', async () => {
    epicTime.getDailyProjection.mockReturnValue(
      projection([{ activityDate: '2026-08-29', minutes: 90 }]),
    );
    storage.getExternalEstimateLogDailyCheckpoint.mockResolvedValue(
      checkpoint(pending({ pendingOperationId: 'other-estimate-operation' })),
    );

    await expect(service.createTimeEntry(createInput())).rejects.toMatchObject<BusyError>({
      details: { reason: 'estimate_operation_pending' },
    });
    expect(storage.prepareExternalEstimateLogOperation).not.toHaveBeenCalled();
    expect(timeMutations.createEstimateTimeEntry).not.toHaveBeenCalled();
  });

  it('rejects a reused request key through the derived receipts', async () => {
    epicTime.getDailyProjection.mockReturnValue(
      projection([{ activityDate: '2026-08-29', minutes: 90 }]),
    );
    storage.getExternalEstimateLogDailyCheckpoint.mockResolvedValue(null);
    timeMutations.inspectOperation.mockReturnValue(
      inspection(pending({ pendingOperationId: childOperationId(0) }), 'succeeded'),
    );

    await expect(service.createTimeEntry(createInput())).rejects.toMatchObject<ConflictError>({
      details: { reason: 'request_key_reused' },
    });
    expect(storage.prepareExternalEstimateLogOperation).not.toHaveBeenCalled();
    expect(timeMutations.createEstimateTimeEntry).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'a real live shrink below the dated ledger',
      days: [{ activityDate: '2026-08-28', loggedMinutes: 60 }],
      live: [{ activityDate: '2026-08-29', minutes: 60 }],
      captured: [{ activityDate: '2026-08-29', minutes: 60 }],
      reason: 'rebaseline_required',
    },
    {
      label: 'a stale capture missing a covered ledger date',
      days: [{ activityDate: '2026-08-28', loggedMinutes: 60 }],
      live: [
        { activityDate: '2026-08-28', minutes: 60 },
        { activityDate: '2026-08-29', minutes: 60 },
      ],
      captured: [{ activityDate: '2026-08-29', minutes: 60 }],
      reason: 'estimate_snapshot_stale',
    },
    {
      label: 'a captured date smaller than live but above the live minutes',
      days: [],
      live: [{ activityDate: '2026-08-29', minutes: 60 }],
      captured: [{ activityDate: '2026-08-29', minutes: 90 }],
      total: 90,
      reason: 'estimate_snapshot_ahead',
    },
    {
      label: 'a captured date missing from live entirely',
      days: [],
      live: [{ activityDate: '2026-08-29', minutes: 90 }],
      captured: [
        { activityDate: '2026-08-29', minutes: 30 },
        { activityDate: '2026-08-30', minutes: 60 },
      ],
      total: 90,
      reason: 'estimate_snapshot_ahead',
    },
  ])(
    'blocks $label before any provider write',
    async ({ days, live, captured, reason, total = 60 }) => {
      epicTime.getDailyProjection.mockReturnValue(projection(live));
      storage.getExternalEstimateLogDailyCheckpoint.mockResolvedValue(
        checkpoint(ready(60, 1), days),
      );

      await expect(
        service.createTimeEntry(
          createInput({
            estimateTotalMinutes: total,
            expectedRevision: 1,
            dailySnapshot: captured,
          }),
        ),
      ).rejects.toMatchObject<ValidationError>({ details: { reason } });
      expect(storage.prepareExternalEstimateLogOperation).not.toHaveBeenCalled();
      expect(timeMutations.createEstimateTimeEntry).not.toHaveBeenCalled();
    },
  );

  it('rejects an up-to-date checkpoint with nothing new to log', async () => {
    const activityDate = '2026-08-29';
    epicTime.getDailyProjection.mockReturnValue(projection([{ activityDate, minutes: 90 }]));
    storage.getExternalEstimateLogDailyCheckpoint.mockResolvedValue(
      checkpoint(ready(90, 1), [{ activityDate, loggedMinutes: 90 }]),
    );

    await expect(
      service.createTimeEntry(createInput({ expectedRevision: 1 })),
    ).rejects.toMatchObject<ValidationError>({
      details: { reason: 'estimate_up_to_date' },
    });
    expect(storage.prepareExternalEstimateLogOperation).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'a sum mismatch',
      snapshot: [{ activityDate: '2026-08-29', minutes: 80 }],
      total: 90,
    },
    {
      label: 'non-ascending duplicate dates',
      snapshot: [
        { activityDate: '2026-08-29', minutes: 45 },
        { activityDate: '2026-08-29', minutes: 45 },
      ],
      total: 90,
    },
    {
      label: 'an invalid calendar date',
      snapshot: [{ activityDate: '2026-02-30', minutes: 90 }],
      total: 90,
    },
    {
      label: 'an oversized snapshot',
      snapshot: Array.from({ length: 3_661 }, (_, index) => ({
        activityDate: `2026-${String(Math.floor(index / 200) + 1).padStart(2, '0')}-${String((index % 200) + 1).padStart(2, '0')}`,
        minutes: 1,
      })),
      total: 3_661,
    },
  ])('rejects $label before reading state or providers', async ({ snapshot, total }) => {
    await expect(
      service.createTimeEntry(
        createInput({ estimateTotalMinutes: total, dailySnapshot: snapshot }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(storage.getExternalEstimateLogDailyCheckpoint).not.toHaveBeenCalled();
    expect(storage.prepareExternalEstimateLogOperation).not.toHaveBeenCalled();
    expect(timeMutations.createEstimateTimeEntry).not.toHaveBeenCalled();
  });

  it('clears a known pre-dispatch failure only from the running create call', async () => {
    const activityDate = '2026-08-29';
    const prepared = pending({
      revision: 1,
      pendingOperationId: childOperationId(0),
      pendingStartedAt: dayStart(activityDate),
      pendingActivityDate: activityDate,
    });
    epicTime.getDailyProjection.mockReturnValue(projection([{ activityDate, minutes: 90 }]));
    storage.getExternalEstimateLogDailyCheckpoint.mockResolvedValue(null);
    storage.getExternalEstimateLogState.mockResolvedValue(null);
    storage.prepareExternalEstimateLogOperation.mockResolvedValue(prepared);
    storage.clearExternalEstimateLogOperation.mockResolvedValue(ready(0, 2));
    timeMutations.inspectOperation.mockReturnValue(null);
    timeMutations.createEstimateTimeEntry.mockRejectedValue(new ValidationError('baseline failed'));

    await expect(service.createTimeEntry(createInput())).rejects.toThrow('baseline failed');
    expect(storage.clearExternalEstimateLogOperation).toHaveBeenCalledWith({
      provider: context.provider,
      remoteScopeKey: context.remoteScopeKey,
      remoteTaskId: context.remoteTaskId,
      operationId: childOperationId(0),
      expectedRevision: prepared.revision,
    });
  });

  it('returns partially_logged after a confirmed prefix meets a known provider failure', async () => {
    const firstDate = '2026-08-28';
    const secondDate = '2026-08-29';
    const preparedFirst = pending({
      revision: 1,
      pendingOperationId: childOperationId(0),
      pendingDeltaMinutes: 30,
      pendingEstimateTotalMinutes: 90,
      pendingStartedAt: dayStart(firstDate),
      pendingActivityDate: firstDate,
    });
    const preparedSecond = pending({
      revision: 3,
      loggedMinutes: 30,
      pendingOperationId: childOperationId(1),
      pendingDeltaMinutes: 60,
      pendingEstimateTotalMinutes: 90,
      pendingStartedAt: dayStart(secondDate),
      pendingActivityDate: secondDate,
    });
    epicTime.getDailyProjection.mockReturnValue(
      projection([
        { activityDate: firstDate, minutes: 30 },
        { activityDate: secondDate, minutes: 60 },
      ]),
    );
    storage.getExternalEstimateLogDailyCheckpoint
      .mockResolvedValueOnce(null)
      .mockResolvedValue(checkpoint(ready(30, 3)));
    storage.getExternalEstimateLogState
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(ready(30, 2))
      .mockResolvedValue(ready(30, 2));
    storage.prepareExternalEstimateLogOperation
      .mockResolvedValueOnce(preparedFirst)
      .mockResolvedValueOnce(preparedSecond);
    storage.confirmExternalEstimateLogOperation.mockResolvedValueOnce(ready(30, 2));
    storage.clearExternalEstimateLogOperation.mockResolvedValue(ready(30, 3));
    admitFreshKey();
    timeMutations.inspectOperation
      .mockReturnValueOnce(inspection(preparedFirst, 'succeeded'))
      .mockReturnValue(null);
    timeMutations.createEstimateTimeEntry
      .mockResolvedValueOnce({
        outcome: 'created',
        remoteEntryId: 'entry-1',
        refresh: ['task_detail'],
        receipt: receiptView('succeeded'),
      })
      .mockRejectedValueOnce(new ValidationError('provider rejected the entry'));

    const result = await service.createTimeEntry(
      createInput({
        estimateTotalMinutes: 90,
        dailySnapshot: [
          { activityDate: firstDate, minutes: 30 },
          { activityDate: secondDate, minutes: 60 },
        ],
      }),
    );

    expect(result).toMatchObject({
      outcome: 'partially_logged',
      entriesLogged: 1,
      minutesLogged: 30,
      hasMore: true,
      stoppedReason: 'provider_error',
    });
    expect(storage.clearExternalEstimateLogOperation).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: childOperationId(1), expectedRevision: 3 }),
    );
  });

  it('returns outcome_unknown when an item dispatches unknown and blocks later items', async () => {
    const dates = ['2026-08-28', '2026-08-29', '2026-08-30'].map((activityDate, index) => ({
      activityDate,
      minutes: 30 + index * 30,
    }));
    const preparedFor = (index: number, revision: number) =>
      pending({
        revision,
        loggedMinutes: 30 * index,
        pendingOperationId: childOperationId(index),
        pendingDeltaMinutes: dates[index]!.minutes,
        pendingEstimateTotalMinutes: 120,
        pendingStartedAt: dayStart(dates[index]!.activityDate),
        pendingActivityDate: dates[index]!.activityDate,
      });
    epicTime.getDailyProjection.mockReturnValue(projection(dates));
    storage.getExternalEstimateLogDailyCheckpoint
      .mockResolvedValueOnce(null)
      .mockResolvedValue(
        checkpoint(pending({ ...preparedFor(1, 3), pendingPhase: 'outcome_unknown', revision: 4 })),
      );
    storage.getExternalEstimateLogState
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(ready(30, 2))
      .mockResolvedValue(ready(30, 2));
    storage.markExternalEstimateLogOperationOutcomeUnknown.mockResolvedValue(
      pending({ ...preparedFor(1, 3), pendingPhase: 'outcome_unknown', revision: 4 }),
    );
    storage.prepareExternalEstimateLogOperation
      .mockResolvedValueOnce(preparedFor(0, 1))
      .mockResolvedValueOnce(preparedFor(1, 3));
    storage.confirmExternalEstimateLogOperation.mockResolvedValueOnce(ready(30, 2));
    admitFreshKey();
    timeMutations.inspectOperation
      .mockReturnValueOnce(inspection(preparedFor(0, 1), 'succeeded'))
      .mockReturnValue(inspection(preparedFor(1, 3), 'outcome_unknown'));
    timeMutations.createEstimateTimeEntry
      .mockResolvedValueOnce({
        outcome: 'created',
        remoteEntryId: 'entry-1',
        refresh: ['task_detail'],
        receipt: receiptView('succeeded'),
      })
      .mockResolvedValueOnce({
        outcome: 'outcome_unknown',
        receipt: receiptView('outcome_unknown'),
      });

    const result = await service.createTimeEntry(
      createInput({
        estimateTotalMinutes: 180,
        dailySnapshot: dates.map(({ activityDate, minutes }) => ({ activityDate, minutes })),
      }),
    );

    expect(result).toMatchObject({
      outcome: 'outcome_unknown',
      entriesLogged: 1,
      minutesLogged: 30,
      hasMore: true,
      stoppedReason: 'outcome_unknown',
    });
    // The unknown item blocks every later entry: only two dispatches ran.
    expect(timeMutations.createEstimateTimeEntry).toHaveBeenCalledTimes(2);
    expect(storage.markExternalEstimateLogOperationOutcomeUnknown).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: childOperationId(1) }),
    );
  });

  it('returns partially_logged when a concurrent write moves the revision mid-loop', async () => {
    const firstDate = '2026-08-28';
    const secondDate = '2026-08-29';
    const preparedFirst = pending({
      revision: 1,
      pendingOperationId: childOperationId(0),
      pendingDeltaMinutes: 30,
      pendingEstimateTotalMinutes: 90,
      pendingStartedAt: dayStart(firstDate),
      pendingActivityDate: firstDate,
    });
    const preparedSecond = pending({
      revision: 3,
      loggedMinutes: 30,
      pendingOperationId: childOperationId(1),
      pendingDeltaMinutes: 60,
      pendingEstimateTotalMinutes: 90,
      pendingStartedAt: dayStart(secondDate),
      pendingActivityDate: secondDate,
    });
    epicTime.getDailyProjection.mockReturnValue(
      projection([
        { activityDate: firstDate, minutes: 30 },
        { activityDate: secondDate, minutes: 60 },
      ]),
    );
    storage.getExternalEstimateLogDailyCheckpoint
      .mockResolvedValueOnce(null)
      .mockResolvedValue(checkpoint(ready(35, 4)));
    storage.getExternalEstimateLogState
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(ready(30, 2))
      .mockResolvedValue(ready(35, 4));
    storage.prepareExternalEstimateLogOperation
      .mockResolvedValueOnce(preparedFirst)
      .mockResolvedValueOnce(preparedSecond);
    storage.confirmExternalEstimateLogOperation
      .mockResolvedValueOnce(ready(30, 2))
      .mockRejectedValueOnce(new OptimisticLockError('Estimate state', context.remoteTaskId));
    admitFreshKey();
    timeMutations.inspectOperation
      .mockReturnValueOnce(inspection(preparedFirst, 'succeeded'))
      .mockReturnValueOnce(inspection(preparedSecond, 'succeeded'));
    timeMutations.createEstimateTimeEntry.mockResolvedValue({
      outcome: 'created',
      remoteEntryId: 'entry-1',
      refresh: ['task_detail'],
      receipt: receiptView('succeeded'),
    });

    const result = await service.createTimeEntry(
      createInput({
        estimateTotalMinutes: 90,
        dailySnapshot: [
          { activityDate: firstDate, minutes: 30 },
          { activityDate: secondDate, minutes: 60 },
        ],
      }),
    );

    expect(result).toMatchObject({
      outcome: 'partially_logged',
      entriesLogged: 1,
      minutesLogged: 30,
      hasMore: true,
      stoppedReason: 'concurrent_write',
    });
  });

  it('stops after one dispatch when a manual write lands between confirm and the next prepare', async () => {
    const firstDate = '2026-08-28';
    const secondDate = '2026-08-29';
    const preparedFirst = pending({
      revision: 1,
      pendingOperationId: childOperationId(0),
      pendingDeltaMinutes: 30,
      pendingEstimateTotalMinutes: 90,
      pendingStartedAt: dayStart(firstDate),
      pendingActivityDate: firstDate,
    });
    epicTime.getDailyProjection.mockReturnValue(
      projection([
        { activityDate: firstDate, minutes: 30 },
        { activityDate: secondDate, minutes: 60 },
      ]),
    );
    storage.getExternalEstimateLogDailyCheckpoint
      .mockResolvedValueOnce(null)
      .mockResolvedValue(checkpoint(ready(35, 7)));
    // The manual Set-logged write lands after the first confirm: the second
    // continuity read sees revision 7 instead of the confirmed 2, so the
    // loop stops before any second provider dispatch.
    storage.getExternalEstimateLogState
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(ready(35, 7))
      .mockResolvedValue(ready(35, 7));
    storage.prepareExternalEstimateLogOperation.mockResolvedValueOnce(preparedFirst);
    storage.confirmExternalEstimateLogOperation.mockResolvedValueOnce(ready(30, 2));
    admitFreshKey();
    timeMutations.inspectOperation.mockReturnValueOnce(inspection(preparedFirst, 'succeeded'));
    timeMutations.createEstimateTimeEntry.mockResolvedValue({
      outcome: 'created',
      remoteEntryId: 'entry-1',
      refresh: ['task_detail'],
      receipt: receiptView('succeeded'),
    });

    const result = await service.createTimeEntry(
      createInput({
        estimateTotalMinutes: 90,
        dailySnapshot: [
          { activityDate: firstDate, minutes: 30 },
          { activityDate: secondDate, minutes: 60 },
        ],
      }),
    );

    expect(result).toMatchObject({
      outcome: 'partially_logged',
      entriesLogged: 1,
      minutesLogged: 30,
      hasMore: true,
      stoppedReason: 'concurrent_write',
    });
    expect(timeMutations.createEstimateTimeEntry).toHaveBeenCalledTimes(1);
    expect(storage.prepareExternalEstimateLogOperation).toHaveBeenCalledTimes(1);
  });

  it('stops after a prefix when a prepare loses the revision CAS race', async () => {
    const firstDate = '2026-08-28';
    const secondDate = '2026-08-29';
    const preparedFirst = pending({
      revision: 1,
      pendingOperationId: childOperationId(0),
      pendingDeltaMinutes: 30,
      pendingEstimateTotalMinutes: 90,
      pendingStartedAt: dayStart(firstDate),
      pendingActivityDate: firstDate,
    });
    epicTime.getDailyProjection.mockReturnValue(
      projection([
        { activityDate: firstDate, minutes: 30 },
        { activityDate: secondDate, minutes: 60 },
      ]),
    );
    storage.getExternalEstimateLogDailyCheckpoint
      .mockResolvedValueOnce(null)
      .mockResolvedValue(checkpoint(ready(30, 2)));
    storage.getExternalEstimateLogState
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(ready(30, 2))
      .mockResolvedValue(ready(30, 2));
    storage.prepareExternalEstimateLogOperation
      .mockResolvedValueOnce(preparedFirst)
      .mockRejectedValueOnce(new OptimisticLockError('Estimate state', context.remoteTaskId));
    storage.confirmExternalEstimateLogOperation.mockResolvedValueOnce(ready(30, 2));
    admitFreshKey();
    timeMutations.inspectOperation.mockReturnValueOnce(inspection(preparedFirst, 'succeeded'));
    timeMutations.createEstimateTimeEntry.mockResolvedValue({
      outcome: 'created',
      remoteEntryId: 'entry-1',
      refresh: ['task_detail'],
      receipt: receiptView('succeeded'),
    });

    const result = await service.createTimeEntry(
      createInput({
        estimateTotalMinutes: 90,
        dailySnapshot: [
          { activityDate: firstDate, minutes: 30 },
          { activityDate: secondDate, minutes: 60 },
        ],
      }),
    );

    expect(result).toMatchObject({
      outcome: 'partially_logged',
      entriesLogged: 1,
      minutesLogged: 30,
      hasMore: true,
      stoppedReason: 'concurrent_write',
    });
    expect(timeMutations.createEstimateTimeEntry).toHaveBeenCalledTimes(1);
  });

  it('surfaces the optimistic error with zero dispatches on a first-item admission race', async () => {
    const activityDate = '2026-08-29';
    epicTime.getDailyProjection.mockReturnValue(projection([{ activityDate, minutes: 90 }]));
    storage.getExternalEstimateLogDailyCheckpoint.mockResolvedValue(null);
    // A competing write moved the checkpoint between admission and the
    // first continuity read: no provider work happens at all.
    storage.getExternalEstimateLogState.mockResolvedValue(ready(95, 3));

    await expect(
      service.createTimeEntry(createInput({ expectedRevision: 0 })),
    ).rejects.toBeInstanceOf(OptimisticLockError);
    expect(storage.prepareExternalEstimateLogOperation).not.toHaveBeenCalled();
    expect(timeMutations.createEstimateTimeEntry).not.toHaveBeenCalled();
  });

  it('rejects a request key when any later derived child receipt survives with the first gone', async () => {
    epicTime.getDailyProjection.mockReturnValue(
      projection([{ activityDate: '2026-08-29', minutes: 90 }]),
    );
    storage.getExternalEstimateLogDailyCheckpoint.mockResolvedValue(null);
    // TTL or capacity eviction dropped child :0 while child :3 survived.
    timeMutations.inspectOperation.mockImplementation((operationId) =>
      operationId === childOperationId(3)
        ? inspection(pending({ pendingOperationId: operationId }), 'outcome_unknown')
        : null,
    );

    await expect(service.createTimeEntry(createInput())).rejects.toMatchObject<ConflictError>({
      details: { reason: 'request_key_reused' },
    });
    expect(storage.prepareExternalEstimateLogOperation).not.toHaveBeenCalled();
    expect(timeMutations.createEstimateTimeEntry).not.toHaveBeenCalled();
    expect(timeMutations.inspectOperation).toHaveBeenCalledWith(childOperationId(3));
    expect(timeMutations.inspectOperation).not.toHaveBeenCalledWith(childOperationId(4));
  });

  it('rebuilds the dated baseline through Set logged with the canonical zone and projection', async () => {
    epicTime.getDailyProjection.mockReturnValue(
      projection([{ activityDate: '2026-08-29', minutes: 200 }]),
    );
    const settled = { ...ready(200, 2), aggregationTimeZone: AGGREGATION_ZONE };
    storage.setExternalEstimateLoggedMinutes.mockResolvedValue(settled);
    storage.getExternalEstimateLogDailyCheckpoint.mockResolvedValue(
      checkpoint(settled, [{ activityDate: '2026-08-29', loggedMinutes: 200 }]),
    );

    const result = await service.setLoggedMinutes({
      ...context,
      loggedMinutes: 200,
      expectedRevision: 1,
      timeZone: AGGREGATION_ZONE,
    });

    expect(storage.setExternalEstimateLoggedMinutes).toHaveBeenCalledWith(
      expect.objectContaining({
        loggedMinutes: 200,
        aggregationTimeZone: AGGREGATION_ZONE,
        currentDailyTotals: [{ activityDate: '2026-08-29', minutes: 200 }],
      }),
    );
    expect(result).toMatchObject({
      loggedMinutes: 200,
      aggregationTimeZone: AGGREGATION_ZONE,
      days: [{ activityDate: '2026-08-29', loggedMinutes: 200 }],
      unallocatedLoggedMinutes: 0,
    });
  });

  it('exposes the dated ledger, canonical zone, and derived credit on state projections', async () => {
    const state = { ...ready(90, 2), aggregationTimeZone: AGGREGATION_ZONE };
    storage.getExternalEstimateLogState.mockResolvedValue(state);
    storage.getExternalEstimateLogDailyCheckpoint.mockResolvedValue(
      checkpoint(state, [{ activityDate: '2026-08-29', loggedMinutes: 30 }]),
    );

    await expect(service.getState(context)).resolves.toMatchObject({
      loggedMinutes: 90,
      aggregationTimeZone: AGGREGATION_ZONE,
      days: [{ activityDate: '2026-08-29', loggedMinutes: 30 }],
      unallocatedLoggedMinutes: 60,
      pendingDisposition: 'none',
    });
  });

  it('builds a non-null snapshot from one authoritative checkpoint revision', async () => {
    // The caller's state is one revision behind the authoritative
    // checkpoint read: every wire field must come from the checkpoint.
    const staleState = ready(90, 2);
    const pendingNewer = {
      ...pending({
        loggedMinutes: 120,
        revision: 5,
        pendingOperationId: childOperationId(0),
        pendingDeltaMinutes: 30,
        pendingEstimateTotalMinutes: 150,
        pendingStartedAt: dayStart('2026-08-29'),
        pendingActivityDate: '2026-08-29',
      }),
      aggregationTimeZone: AGGREGATION_ZONE,
    };
    storage.getExternalEstimateLogState.mockResolvedValue(staleState);
    storage.getExternalEstimateLogDailyCheckpoint.mockResolvedValue(
      checkpoint(pendingNewer, [{ activityDate: '2026-08-28', loggedMinutes: 120 }]),
    );
    timeMutations.inspectOperation.mockReturnValue(inspection(pendingNewer, 'outcome_unknown'));

    const snapshot = await service.getState(context);

    expect(snapshot.state).toBe(pendingNewer);
    expect(snapshot.revision).toBe(5);
    expect(snapshot.loggedMinutes).toBe(120);
    expect(snapshot.aggregationTimeZone).toBe(AGGREGATION_ZONE);
    expect(snapshot.days).toEqual([{ ...context, activityDate: '2026-08-28', loggedMinutes: 120 }]);
    expect(snapshot.unallocatedLoggedMinutes).toBe(0);
    // The pending operation appeared between the two historical reads; the
    // snapshot carries its lock and recovery facts, never a stale idle view.
    expect(snapshot.pendingDisposition).toBe('outcome_unknown');
    expect(snapshot.canVerify).toBe(true);
    expect(snapshot.verifyExpiresAt).toBe('2026-08-31T12:00:00.000Z');
    expect(snapshot.state.pendingOperationId).toBe(childOperationId(0));
  });

  it('fails through the internal invariant when a non-null row loses its checkpoint', async () => {
    storage.getExternalEstimateLogState.mockResolvedValue(ready(90, 2));
    storage.getExternalEstimateLogDailyCheckpoint.mockResolvedValue(null);

    await expect(service.getState(context)).rejects.toThrow('External estimate log state');
  });

  it('keeps the null-row linearization without a second state transition', async () => {
    storage.getExternalEstimateLogState.mockResolvedValue(null);

    await expect(service.getState(context)).resolves.toEqual({
      state: null,
      initialized: false,
      revision: 0,
      loggedMinutes: 0,
      aggregationTimeZone: null,
      days: [],
      unallocatedLoggedMinutes: 0,
      pendingDisposition: 'none',
      canVerify: false,
      verifyExpiresAt: null,
    });
    expect(storage.getExternalEstimateLogDailyCheckpoint).not.toHaveBeenCalled();
  });

  it.each([
    { phase: 'succeeded' as const, mutation: 'confirmExternalEstimateLogOperation' as const },
    { phase: 'failed' as const, mutation: 'clearExternalEstimateLogOperation' as const },
  ])('settles a prepared checkpoint from an exact $phase receipt', async ({ phase, mutation }) => {
    const state = pending();
    storage.getExternalEstimateLogState.mockResolvedValue(state);
    timeMutations.inspectOperation.mockReturnValue(inspection(state, phase));
    storage[mutation].mockResolvedValue(phase === 'succeeded' ? ready(90, 2) : ready(0, 2));
    storage.getExternalEstimateLogDailyCheckpoint.mockResolvedValue(
      checkpoint(phase === 'succeeded' ? ready(90, 2) : ready(0, 2)),
    );

    const result = await service.getState(context);

    expect(result.pendingDisposition).toBe('none');
    expect(storage[mutation]).toHaveBeenCalledTimes(1);
  });

  it('treats a prepared checkpoint with no receipt as manual review', async () => {
    storage.getExternalEstimateLogState.mockResolvedValue(pending());
    timeMutations.inspectOperation.mockReturnValue(null);
    storage.getExternalEstimateLogDailyCheckpoint.mockResolvedValue(checkpoint(pending()));

    await expect(service.getState(context)).resolves.toMatchObject({
      pendingDisposition: 'manual_review',
      canVerify: false,
      verifyExpiresAt: null,
    });
    expect(storage.clearExternalEstimateLogOperation).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'same-epoch unknown with a complete baseline',
      connectionGeneration: 4,
      baseline: { matchingIds: [], complete: true },
      expectedDisposition: 'outcome_unknown',
      expectedCanVerify: true,
    },
    {
      label: 'same-epoch unknown with an incomplete baseline',
      connectionGeneration: 4,
      baseline: { matchingIds: [], complete: false },
      expectedDisposition: 'outcome_unknown',
      expectedCanVerify: false,
    },
    {
      label: 'replaced-epoch unknown with a complete baseline',
      connectionGeneration: 5,
      baseline: { matchingIds: [], complete: true },
      expectedDisposition: 'manual_review',
      expectedCanVerify: false,
    },
  ])(
    'advertises canVerify $expectedCanVerify for a $label',
    async ({ connectionGeneration, baseline, expectedDisposition, expectedCanVerify }) => {
      const state = pending({ pendingPhase: 'outcome_unknown' });
      storage.getIntegrationConnection.mockResolvedValue({
        ...connection,
        generation: connectionGeneration,
      });
      storage.getExternalEstimateLogState.mockResolvedValue(state);
      timeMutations.inspectOperation.mockReturnValue(
        inspection(state, 'outcome_unknown', {}, baseline),
      );
      storage.getExternalEstimateLogDailyCheckpoint.mockResolvedValue(checkpoint(state));

      await expect(
        service.getState({ ...context, expectedEpoch: connectionGeneration }),
      ).resolves.toMatchObject({
        pendingDisposition: expectedDisposition,
        canVerify: expectedCanVerify,
        // Only a verifiable same-epoch receipt carries its absolute deadline;
        // clients schedule exactly one transition from it.
        verifyExpiresAt: expectedCanVerify ? '2026-08-31T12:00:00.000Z' : null,
      });
      expect(timeMutations.verifyOperation).not.toHaveBeenCalled();
    },
  );

  it.each([
    { verifiedPhase: 'succeeded' as const, expectedOutcome: 'logged' },
    { verifiedPhase: 'not_applied' as const, expectedOutcome: 'not_logged' },
  ])(
    'maps unknown verification to $expectedOutcome',
    async ({ verifiedPhase, expectedOutcome }) => {
      const state = pending({ pendingPhase: 'outcome_unknown', revision: 2 });
      const after = inspection(state, verifiedPhase);
      storage.getExternalEstimateLogState.mockResolvedValue(state);
      timeMutations.inspectOperation
        .mockReturnValueOnce(inspection(state, 'outcome_unknown'))
        .mockReturnValueOnce(after)
        .mockReturnValueOnce(after);
      timeMutations.verifyOperation.mockResolvedValue({
        receipt: receiptView(verifiedPhase === 'succeeded' ? 'succeeded' : 'outcome_unknown'),
        resolved: true,
        resolution: verifiedPhase === 'succeeded' ? 'created' : 'not_applied',
      });
      storage.confirmExternalEstimateLogOperation.mockResolvedValue(ready(90, 3));
      storage.clearExternalEstimateLogOperation.mockResolvedValue(ready(0, 3));
      storage.getExternalEstimateLogDailyCheckpoint.mockResolvedValue(
        checkpoint(verifiedPhase === 'succeeded' ? ready(90, 3) : ready(0, 3)),
      );

      const result = await service.resolveOperation({
        ...context,
        operationId: state.pendingOperationId,
        action: 'verify',
        expectedRevision: state.revision,
      });

      expect(result.outcome).toBe(expectedOutcome);
      expect(timeMutations.verifyOperation).toHaveBeenCalledTimes(1);
    },
  );

  it('stores, acknowledges, and applies a same-epoch manual logged resolution', async () => {
    const state = pending({ pendingPhase: 'outcome_unknown', revision: 2 });
    const stored = pending({
      pendingPhase: 'outcome_unknown',
      pendingResolution: 'logged',
      revision: 3,
    });
    storage.getExternalEstimateLogState.mockResolvedValue(state);
    storage.storeExternalEstimateLogResolution.mockResolvedValue(stored);
    storage.applyExternalEstimateLogResolution.mockResolvedValue(ready(90, 4));
    timeMutations.inspectOperation.mockReturnValue(inspection(state, 'outcome_unknown'));
    timeMutations.acknowledgeOperation.mockResolvedValue(receiptView('outcome_unknown'));
    storage.getExternalEstimateLogDailyCheckpoint.mockResolvedValue(checkpoint(ready(90, 4)));

    const result = await service.resolveOperation({
      ...context,
      operationId: state.pendingOperationId,
      action: 'logged',
      expectedRevision: state.revision,
    });

    expect(result.outcome).toBe('logged');
    expect(timeMutations.acknowledgeOperation).toHaveBeenCalledTimes(1);
    expect(storage.applyExternalEstimateLogResolution).toHaveBeenCalledWith(
      expect.objectContaining({ expectedRevision: 3 }),
    );
  });

  it.each([
    {
      receiptPhase: 'succeeded' as const,
      requestedAction: 'not_logged' as const,
      expectedOutcome: 'logged',
      expectedMutation: 'confirmExternalEstimateLogOperation' as const,
    },
    {
      receiptPhase: 'failed' as const,
      requestedAction: 'logged' as const,
      expectedOutcome: 'not_logged',
      expectedMutation: 'clearExternalEstimateLogOperation' as const,
    },
    {
      receiptPhase: 'not_applied' as const,
      requestedAction: 'logged' as const,
      expectedOutcome: 'not_logged',
      expectedMutation: 'clearExternalEstimateLogOperation' as const,
    },
  ])(
    'uses exact $receiptPhase receipt truth instead of requested $requestedAction',
    async ({ receiptPhase, requestedAction, expectedOutcome, expectedMutation }) => {
      const state = pending({ pendingPhase: 'outcome_unknown', revision: 2 });
      storage.getExternalEstimateLogState.mockResolvedValue(state);
      timeMutations.inspectOperation.mockReturnValue(inspection(state, receiptPhase));
      storage[expectedMutation].mockResolvedValue(
        receiptPhase === 'succeeded' ? ready(90, 3) : ready(0, 3),
      );
      storage.getExternalEstimateLogDailyCheckpoint.mockResolvedValue(
        checkpoint(receiptPhase === 'succeeded' ? ready(90, 3) : ready(0, 3)),
      );

      const result = await service.resolveOperation({
        ...context,
        operationId: state.pendingOperationId,
        action: requestedAction,
        expectedRevision: state.revision,
      });

      expect(result.outcome).toBe(expectedOutcome);
      expect(storage[expectedMutation]).toHaveBeenCalledTimes(1);
      expect(storage.storeExternalEstimateLogResolution).not.toHaveBeenCalled();
      expect(storage.applyExternalEstimateLogResolution).not.toHaveBeenCalled();
      expect(timeMutations.acknowledgeOperation).not.toHaveBeenCalled();
    },
  );

  it('disables Verify after replacement but still applies manual not-logged resolution', async () => {
    const state = pending({ pendingPhase: 'outcome_unknown', revision: 2 });
    storage.getIntegrationConnection.mockResolvedValue({
      ...connection,
      generation: 5,
    });
    const replacedContext = { ...context, expectedEpoch: 5 };
    storage.getExternalEstimateLogState.mockResolvedValue(state);
    timeMutations.inspectOperation.mockReturnValue(inspection(state, 'outcome_unknown'));

    await expect(
      service.resolveOperation({
        ...replacedContext,
        operationId: state.pendingOperationId,
        action: 'verify',
        expectedRevision: state.revision,
      }),
    ).rejects.toMatchObject<ConflictError>({ details: { reason: 'connection_superseded' } });
    expect(timeMutations.verifyOperation).not.toHaveBeenCalled();

    const stored = pending({ ...state, pendingResolution: 'not_logged', revision: 3 });
    storage.storeExternalEstimateLogResolution.mockResolvedValue(stored);
    storage.applyExternalEstimateLogResolution.mockResolvedValue(ready(0, 4));
    storage.getExternalEstimateLogDailyCheckpoint.mockResolvedValue(checkpoint(ready(0, 4)));
    await expect(
      service.resolveOperation({
        ...replacedContext,
        operationId: state.pendingOperationId,
        action: 'not_logged',
        expectedRevision: state.revision,
      }),
    ).resolves.toMatchObject({ outcome: 'not_logged' });
    expect(timeMutations.acknowledgeOperation).not.toHaveBeenCalled();
  });

  it('rejects a link owned by a different connection before checkpoint or provider access', async () => {
    storage.findExternalTaskLink.mockResolvedValue({
      ...link,
      connectionId: 'stale-connection',
    });

    await expect(service.getState(context)).rejects.toMatchObject<ConflictError>({
      details: { reason: 'link_connection_mismatch' },
    });
    expect(storage.getEpic).not.toHaveBeenCalled();
    expect(storage.getExternalEstimateLogState).not.toHaveBeenCalled();
    expect(timeMutations.inspectOperation).not.toHaveBeenCalled();
    expect(timeMutations.createEstimateTimeEntry).not.toHaveBeenCalled();
    expect(timeMutations.verifyOperation).not.toHaveBeenCalled();
  });

  it('resumes a stored logged choice after receipt loss without acknowledgement', async () => {
    const state = pending({ pendingResolution: 'logged', revision: 3 });
    storage.getExternalEstimateLogState.mockResolvedValue(state);
    storage.applyExternalEstimateLogResolution.mockResolvedValue(ready(90, 4));
    timeMutations.inspectOperation.mockReturnValue(null);
    storage.getExternalEstimateLogDailyCheckpoint.mockResolvedValue(checkpoint(ready(90, 4)));

    const result = await service.getState(context);

    expect(result).toMatchObject({ loggedMinutes: 90, pendingDisposition: 'none' });
    expect(timeMutations.acknowledgeOperation).not.toHaveBeenCalled();
    expect(storage.applyExternalEstimateLogResolution).toHaveBeenCalledTimes(1);
  });

  it('resumes a stored choice after the unknown receipt was already acknowledged', async () => {
    const state = pending({ pendingResolution: 'not_logged', revision: 3 });
    storage.getExternalEstimateLogState.mockResolvedValue(state);
    storage.applyExternalEstimateLogResolution.mockResolvedValue(ready(0, 4));
    timeMutations.inspectOperation.mockReturnValue(inspection(state, 'abandoned_unknown'));
    storage.getExternalEstimateLogDailyCheckpoint.mockResolvedValue(checkpoint(ready(0, 4)));

    await expect(service.getState(context)).resolves.toMatchObject({
      loggedMinutes: 0,
      pendingDisposition: 'none',
    });
    expect(timeMutations.acknowledgeOperation).not.toHaveBeenCalled();
    expect(storage.applyExternalEstimateLogResolution).toHaveBeenCalledTimes(1);
  });

  it.each([
    { storedResolution: 'logged' as const, expectedLoggedMinutes: 90 },
    { storedResolution: 'not_logged' as const, expectedLoggedMinutes: 0 },
  ])(
    'GET completes a crashed stored $storedResolution choice after marking its receipt unknown',
    async ({ storedResolution, expectedLoggedMinutes }) => {
      const state = pending({ pendingResolution: storedResolution, revision: 3 });
      const marked = pending({
        ...state,
        pendingPhase: 'outcome_unknown',
        revision: 4,
      });
      storage.getExternalEstimateLogState.mockResolvedValue(state);
      storage.markExternalEstimateLogOperationOutcomeUnknown.mockResolvedValue(marked);
      storage.applyExternalEstimateLogResolution.mockResolvedValue(ready(expectedLoggedMinutes, 5));
      storage.getExternalEstimateLogDailyCheckpoint.mockResolvedValue(
        checkpoint(ready(expectedLoggedMinutes, 5)),
      );
      timeMutations.inspectOperation.mockReturnValue(inspection(state, 'outcome_unknown'));
      timeMutations.acknowledgeOperation.mockResolvedValue({
        ...receiptView('outcome_unknown'),
        phase: 'abandoned_unknown',
      });

      await expect(service.getState(context)).resolves.toMatchObject({
        loggedMinutes: expectedLoggedMinutes,
        pendingDisposition: 'none',
      });
      expect(storage.markExternalEstimateLogOperationOutcomeUnknown).toHaveBeenCalledTimes(1);
      expect(storage.applyExternalEstimateLogResolution).toHaveBeenCalledWith(
        expect.objectContaining({ expectedRevision: marked.revision }),
      );
    },
  );

  it.each([
    {
      receiptPhase: 'succeeded' as const,
      storedResolution: 'not_logged' as const,
      expectedLoggedMinutes: 90,
      expectedMutation: 'confirmExternalEstimateLogOperation' as const,
    },
    {
      receiptPhase: 'failed' as const,
      storedResolution: 'logged' as const,
      expectedLoggedMinutes: 0,
      expectedMutation: 'clearExternalEstimateLogOperation' as const,
    },
    {
      receiptPhase: 'not_applied' as const,
      storedResolution: 'logged' as const,
      expectedLoggedMinutes: 0,
      expectedMutation: 'clearExternalEstimateLogOperation' as const,
    },
  ])(
    'GET applies exact $receiptPhase truth over stored $storedResolution recovery',
    async ({ receiptPhase, storedResolution, expectedLoggedMinutes, expectedMutation }) => {
      const state = pending({ pendingResolution: storedResolution, revision: 3 });
      storage.getExternalEstimateLogState.mockResolvedValue(state);
      timeMutations.inspectOperation.mockReturnValue(inspection(state, receiptPhase));
      storage[expectedMutation].mockResolvedValue(ready(expectedLoggedMinutes, 4));
      storage.getExternalEstimateLogDailyCheckpoint.mockResolvedValue(
        checkpoint(ready(expectedLoggedMinutes, 4)),
      );
      storage.getExternalEstimateLogDailyCheckpoint.mockResolvedValue(
        checkpoint(ready(expectedLoggedMinutes, 4)),
      );

      await expect(service.getState(context)).resolves.toMatchObject({
        loggedMinutes: expectedLoggedMinutes,
        pendingDisposition: 'none',
      });

      expect(storage[expectedMutation]).toHaveBeenCalledWith(
        expect.objectContaining({ operationId: state.pendingOperationId, expectedRevision: 3 }),
      );
      expect(storage.applyExternalEstimateLogResolution).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      receiptPhase: 'succeeded' as const,
      storedResolution: 'not_logged' as const,
      expectedOutcome: 'logged' as const,
      expectedLoggedMinutes: 90,
      expectedMutation: 'confirmExternalEstimateLogOperation' as const,
    },
    {
      receiptPhase: 'failed' as const,
      storedResolution: 'logged' as const,
      expectedOutcome: 'not_logged' as const,
      expectedLoggedMinutes: 0,
      expectedMutation: 'clearExternalEstimateLogOperation' as const,
    },
    {
      receiptPhase: 'not_applied' as const,
      storedResolution: 'logged' as const,
      expectedOutcome: 'not_logged' as const,
      expectedLoggedMinutes: 0,
      expectedMutation: 'clearExternalEstimateLogOperation' as const,
    },
  ])(
    'resolve reports exact $receiptPhase truth over stored $storedResolution recovery',
    async ({
      receiptPhase,
      storedResolution,
      expectedOutcome,
      expectedLoggedMinutes,
      expectedMutation,
    }) => {
      const state = pending({ pendingResolution: storedResolution, revision: 3 });
      storage.getExternalEstimateLogState.mockResolvedValue(state);
      timeMutations.inspectOperation.mockReturnValue(inspection(state, receiptPhase));
      storage[expectedMutation].mockResolvedValue(ready(expectedLoggedMinutes, 4));
      storage.getExternalEstimateLogDailyCheckpoint.mockResolvedValue(
        checkpoint(ready(expectedLoggedMinutes, 4)),
      );

      const result = await service.resolveOperation({
        ...context,
        operationId: state.pendingOperationId,
        action: 'verify',
        expectedRevision: state.revision,
      });

      expect(result).toMatchObject({
        outcome: expectedOutcome,
        snapshot: { loggedMinutes: expectedLoggedMinutes, pendingDisposition: 'none' },
      });
      expect(storage[expectedMutation]).toHaveBeenCalledTimes(1);
      expect(storage.applyExternalEstimateLogResolution).not.toHaveBeenCalled();
    },
  );

  it('uses terminal Verify truth that appears after storing a conflicting manual choice', async () => {
    const state = pending({ pendingPhase: 'outcome_unknown', revision: 2 });
    const stored = pending({
      ...state,
      pendingResolution: 'not_logged',
      revision: 3,
    });
    storage.getExternalEstimateLogState.mockResolvedValue(state);
    storage.storeExternalEstimateLogResolution.mockResolvedValue(stored);
    timeMutations.inspectOperation
      .mockReturnValueOnce(inspection(state, 'outcome_unknown'))
      .mockReturnValue(inspection(stored, 'succeeded'));
    storage.confirmExternalEstimateLogOperation.mockResolvedValue(ready(90, 4));
    storage.getExternalEstimateLogDailyCheckpoint.mockResolvedValue(checkpoint(ready(90, 4)));

    const result = await service.resolveOperation({
      ...context,
      operationId: state.pendingOperationId,
      action: 'not_logged',
      expectedRevision: state.revision,
    });

    expect(result).toMatchObject({
      outcome: 'logged',
      snapshot: { loggedMinutes: 90, pendingDisposition: 'none' },
    });
    expect(storage.confirmExternalEstimateLogOperation).toHaveBeenCalledWith(
      expect.objectContaining({ expectedRevision: stored.revision }),
    );
    expect(storage.applyExternalEstimateLogResolution).not.toHaveBeenCalled();
    expect(timeMutations.acknowledgeOperation).not.toHaveBeenCalled();
  });

  it('reconciles exact Verify truth after a stored choice wins the first revision race', async () => {
    const state = pending({ pendingPhase: 'outcome_unknown', revision: 2 });
    const concurrentlyStored = pending({
      ...state,
      pendingResolution: 'not_logged',
      revision: 3,
    });
    storage.getExternalEstimateLogState
      .mockResolvedValueOnce(state)
      .mockResolvedValueOnce(concurrentlyStored);
    timeMutations.inspectOperation.mockReturnValue(inspection(state, 'succeeded'));
    storage.confirmExternalEstimateLogOperation
      .mockRejectedValueOnce(new OptimisticLockError('Estimate state', 'ENG-1'))
      .mockResolvedValueOnce(ready(90, 4));
    storage.getExternalEstimateLogDailyCheckpoint.mockResolvedValue(checkpoint(ready(90, 4)));

    const result = await service.resolveOperation({
      ...context,
      operationId: state.pendingOperationId,
      action: 'verify',
      expectedRevision: state.revision,
    });

    expect(result).toMatchObject({
      outcome: 'logged',
      snapshot: { loggedMinutes: 90, pendingDisposition: 'none' },
    });
    expect(storage.confirmExternalEstimateLogOperation).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ expectedRevision: concurrentlyStored.revision }),
    );
    expect(storage.applyExternalEstimateLogResolution).not.toHaveBeenCalled();
  });

  it('rejects a receipt tuple mismatch without settling the checkpoint', async () => {
    const state = pending();
    storage.getExternalEstimateLogState.mockResolvedValue(state);
    timeMutations.inspectOperation.mockReturnValue(
      inspection(state, 'succeeded', { remoteTaskId: 'OTHER-1' }),
    );

    await expect(service.getState(context)).rejects.toMatchObject<ConflictError>({
      details: { reason: 'receipt_tuple_mismatch' },
    });
    expect(storage.confirmExternalEstimateLogOperation).not.toHaveBeenCalled();
    expect(storage.clearExternalEstimateLogOperation).not.toHaveBeenCalled();
  });

  it('reports live pending receipts as busy', async () => {
    const state = pending();
    storage.getExternalEstimateLogState.mockResolvedValue(state);
    timeMutations.inspectOperation.mockReturnValue(inspection(state, 'dispatched'));
    storage.getExternalEstimateLogDailyCheckpoint.mockResolvedValue(checkpoint(state));

    await expect(service.getState(context)).resolves.toMatchObject({
      pendingDisposition: 'busy',
      canVerify: false,
    });
    await expect(
      service.resolveOperation({
        ...context,
        operationId: state.pendingOperationId,
        action: 'verify',
        expectedRevision: state.revision,
      }),
    ).rejects.toBeInstanceOf(BusyError);
  });

  it.each(['pending', 'dispatched'] as const)(
    'keeps a stored choice busy while its matching receipt is still %s',
    async (receiptPhase) => {
      const state = pending({ pendingResolution: 'logged', revision: 3 });
      storage.getExternalEstimateLogState.mockResolvedValue(state);
      timeMutations.inspectOperation.mockReturnValue(inspection(state, receiptPhase));
      storage.getExternalEstimateLogDailyCheckpoint.mockResolvedValue(checkpoint(state));

      await expect(service.getState(context)).resolves.toMatchObject({
        pendingDisposition: 'busy',
        loggedMinutes: 0,
      });
      expect(storage.applyExternalEstimateLogResolution).not.toHaveBeenCalled();
    },
  );
});
