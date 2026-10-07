import { GUARDS_METADATA } from '@nestjs/common/constants';
import { ValidationError } from '../../../common/errors/error-types';
import { IntegrationAdmissionGuard } from '../../../common/guards/integration-admission.guard';
import type {
  CreateExternalEstimateTimeEntryResult,
  ExternalEstimateLogSnapshot,
} from '../models/epic-time.models';
import type { ExternalEstimateLogState } from '../../storage/models/domain.models';
import type { EpicEstimateLoggingService } from '../services/epic-estimate-logging.service';
import { ExternalEstimateLogController } from './external-estimate-log.controller';

// Layer: backend unit. Controller tests prove bounded transport validation and
// the safe checkpoint projection without provider I/O or real storage.
describe('ExternalEstimateLogController', () => {
  const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
  const SCOPE_KEY = 'acme.atlassian.net';
  const TASK_ID = 'ENG-1';
  const OPERATION_ID = 'op-estimate-1';
  const REQUEST_KEY = '11111111-1111-4111-8111-111111111111';

  const state = (
    overrides: Partial<Extract<ExternalEstimateLogState, { pendingOperationId: string }>> = {},
  ): Extract<ExternalEstimateLogState, { pendingOperationId: string }> => ({
    projectId: PROJECT_ID,
    provider: 'jira',
    remoteScopeKey: SCOPE_KEY,
    remoteTaskId: TASK_ID,
    loggedMinutes: 0,
    revision: 1,
    aggregationTimeZone: null,
    pendingOperationId: OPERATION_ID,
    pendingDeltaMinutes: 30,
    pendingEstimateTotalMinutes: 120,
    pendingStartedAt: '2026-08-30T10:30:00.000Z',
    pendingConnectionId: 'connection-1',
    pendingConnectionGeneration: 4,
    pendingPhase: 'outcome_unknown',
    pendingResolution: null,
    pendingActivityDate: null,
    createdAt: '2026-08-30T08:00:00.000Z',
    updatedAt: '2026-08-30T08:00:00.000Z',
    ...overrides,
  });

  const ready = (
    loggedMinutes: number,
    revision: number,
  ): Extract<ExternalEstimateLogState, { pendingOperationId: null }> => ({
    projectId: PROJECT_ID,
    provider: 'jira',
    remoteScopeKey: SCOPE_KEY,
    remoteTaskId: TASK_ID,
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

  const snapshot = (
    stored: ExternalEstimateLogState | null,
    overrides: Partial<ExternalEstimateLogSnapshot> = {},
  ): ExternalEstimateLogSnapshot => ({
    state: stored,
    initialized: stored !== null,
    revision: stored?.revision ?? 0,
    loggedMinutes: stored?.loggedMinutes ?? 0,
    aggregationTimeZone: null,
    days: [],
    unallocatedLoggedMinutes: 0,
    pendingDisposition:
      stored === null || stored.pendingOperationId === null ? 'none' : 'outcome_unknown',
    canVerify: stored?.pendingOperationId != null,
    verifyExpiresAt: null,
    legacyCheckpoint: null,
    ...overrides,
  });

  const service = {
    getState: jest.fn(),
    setLoggedMinutes: jest.fn(),
    createTimeEntry: jest.fn(),
    resolveOperation: jest.fn(),
  };
  const controller = new ExternalEstimateLogController(
    service as unknown as EpicEstimateLoggingService,
  );

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('applies integration admission to the estimate controller', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, ExternalEstimateLogController)).toContain(
      IntegrationAdmissionGuard,
    );
  });

  it('dispatches the state read with the scope query and epoch header', async () => {
    service.getState.mockResolvedValue(snapshot(state()));

    const view = await controller.getEstimateLogState('jira', TASK_ID, '4', {
      projectId: PROJECT_ID,
      scopeKey: SCOPE_KEY,
    });

    expect(service.getState).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      provider: 'jira',
      remoteScopeKey: SCOPE_KEY,
      remoteTaskId: TASK_ID,
      expectedEpoch: 4,
    });
    expect(view).toEqual({
      initialized: true,
      revision: 1,
      loggedMinutes: 0,
      aggregationTimeZone: null,
      days: [],
      unallocatedLoggedMinutes: 0,
      pendingDisposition: 'outcome_unknown',
      canVerify: true,
      verifyExpiresAt: null,
      pending: {
        operationId: OPERATION_ID,
        deltaMinutes: 30,
        estimateTotalMinutes: 120,
        startedAt: '2026-08-30T10:30:00.000Z',
        phase: 'outcome_unknown',
        resolution: null,
        activityDate: null,
      },
      legacyCheckpoint: null,
    });
  });

  it('projects an uninitialized checkpoint without a pending operation', async () => {
    service.getState.mockResolvedValue(snapshot(null));

    await expect(
      controller.getEstimateLogState('jira', TASK_ID, '4', {
        projectId: PROJECT_ID,
        scopeKey: SCOPE_KEY,
      }),
    ).resolves.toEqual({
      initialized: false,
      revision: 0,
      loggedMinutes: 0,
      aggregationTimeZone: null,
      days: [],
      unallocatedLoggedMinutes: 0,
      pendingDisposition: 'none',
      canVerify: false,
      verifyExpiresAt: null,
      pending: null,
      legacyCheckpoint: null,
    });
  });

  it('never projects connection identity or receipt tuple internals', async () => {
    service.getState.mockResolvedValue(snapshot(state()));

    const view = await controller.getEstimateLogState('jira', TASK_ID, '4', {
      projectId: PROJECT_ID,
      scopeKey: SCOPE_KEY,
    });

    expect(JSON.stringify(view)).not.toMatch(
      /connectionId|connectionGeneration|pendingConnection|noteFingerprint|remoteEntryId/,
    );
  });

  it.each([
    [
      'unknown provider',
      () =>
        controller.getEstimateLogState('github', TASK_ID, '4', {
          projectId: PROJECT_ID,
          scopeKey: SCOPE_KEY,
        }),
    ],
    [
      'blank task id',
      () =>
        controller.getEstimateLogState('jira', ' ', '4', {
          projectId: PROJECT_ID,
          scopeKey: SCOPE_KEY,
        }),
    ],
    [
      'missing epoch',
      () =>
        controller.getEstimateLogState('jira', TASK_ID, undefined, {
          projectId: PROJECT_ID,
          scopeKey: SCOPE_KEY,
        }),
    ],
    [
      'malformed epoch',
      () =>
        controller.getEstimateLogState('jira', TASK_ID, 'x', {
          projectId: PROJECT_ID,
          scopeKey: SCOPE_KEY,
        }),
    ],
    [
      'missing scope key',
      () => controller.getEstimateLogState('jira', TASK_ID, '4', { projectId: PROJECT_ID }),
    ],
    [
      'invalid project id',
      () =>
        controller.getEstimateLogState('jira', TASK_ID, '4', {
          projectId: 'not-a-uuid',
          scopeKey: SCOPE_KEY,
        }),
    ],
    [
      'unknown query field',
      () =>
        controller.getEstimateLogState('jira', TASK_ID, '4', {
          projectId: PROJECT_ID,
          scopeKey: SCOPE_KEY,
          force: true,
        }),
    ],
  ])('rejects the state read with a %s', async (_case, operation) => {
    await expect(operation()).rejects.toBeInstanceOf(ValidationError);
    expect(service.getState).not.toHaveBeenCalled();
  });

  it('dispatches the dated estimate create with both headers and a strict body', async () => {
    service.createTimeEntry.mockResolvedValue({
      outcome: 'logged',
      entriesLogged: 1,
      minutesLogged: 120,
      hasMore: false,
      stoppedReason: 'completed',
      snapshot: snapshot(ready(120, 2)),
    } satisfies CreateExternalEstimateTimeEntryResult);

    const response = await controller.createEstimateTimeEntry(
      'jira',
      TASK_ID,
      '4',
      REQUEST_KEY,
      {
        scopeKey: SCOPE_KEY,
        requestKey: REQUEST_KEY,
        timeZone: 'Europe/Madrid',
        estimateTotalMinutes: 120,
        expectedRevision: 1,
        dailySnapshot: [{ activityDate: '2026-08-29', minutes: 120 }],
      },
      PROJECT_ID,
    );

    expect(service.createTimeEntry).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      provider: 'jira',
      remoteScopeKey: SCOPE_KEY,
      remoteTaskId: TASK_ID,
      expectedEpoch: 4,
      requestKey: REQUEST_KEY,
      timeZone: 'Europe/Madrid',
      estimateTotalMinutes: 120,
      expectedRevision: 1,
      dailySnapshot: [{ activityDate: '2026-08-29', minutes: 120 }],
    });
    expect(response).toMatchObject({
      outcome: 'logged',
      entriesLogged: 1,
      minutesLogged: 120,
      hasMore: false,
      stoppedReason: 'completed',
    });
    expect(response.state.loggedMinutes).toBe(120);
  });

  it('rejects an idempotency key that does not match the request key', async () => {
    await expect(
      controller.createEstimateTimeEntry(
        'jira',
        TASK_ID,
        '4',
        OPERATION_ID,
        {
          scopeKey: SCOPE_KEY,
          requestKey: REQUEST_KEY,
          timeZone: 'Europe/Madrid',
          estimateTotalMinutes: 120,
          expectedRevision: 1,
          dailySnapshot: [{ activityDate: '2026-08-29', minutes: 120 }],
        },
        PROJECT_ID,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(service.createTimeEntry).not.toHaveBeenCalled();
  });

  const validCreateBody = (overrides: Record<string, unknown> = {}) => ({
    scopeKey: SCOPE_KEY,
    requestKey: REQUEST_KEY,
    timeZone: 'UTC',
    estimateTotalMinutes: 90,
    expectedRevision: 0,
    dailySnapshot: [{ activityDate: '2026-08-29', minutes: 90 }],
    ...overrides,
  });

  it.each([
    ['missing idempotency key', '4', undefined, validCreateBody()],
    ['malformed idempotency key', '4', 'bad key!', validCreateBody()],
    ['missing epoch', undefined, REQUEST_KEY, validCreateBody()],
    ['blank timezone', '4', REQUEST_KEY, validCreateBody({ timeZone: ' ' })],
    ['negative snapshot', '4', REQUEST_KEY, validCreateBody({ estimateTotalMinutes: -1 })],
    ['fractional snapshot', '4', REQUEST_KEY, validCreateBody({ estimateTotalMinutes: 90.5 })],
    ['unknown body field', '4', REQUEST_KEY, validCreateBody({ force: true })],
    ['non-uuid request key', '4', OPERATION_ID, validCreateBody({ requestKey: OPERATION_ID })],
    [
      'invalid snapshot date',
      '4',
      REQUEST_KEY,
      validCreateBody({
        dailySnapshot: [{ activityDate: '2026-8-29', minutes: 90 }],
      }),
    ],
    [
      'oversized daily snapshot',
      '4',
      REQUEST_KEY,
      validCreateBody({
        estimateTotalMinutes: 3_661,
        dailySnapshot: Array.from({ length: 3_661 }, (_, index) => ({
          activityDate: `2026-${String(Math.floor(index / 200) + 1).padStart(2, '0')}-${String((index % 200) + 1).padStart(2, '0')}`,
          minutes: 1,
        })),
      }),
    ],
  ])('rejects an estimate create with a %s before dispatch', async (_case, epoch, key, body) => {
    await expect(
      controller.createEstimateTimeEntry('jira', TASK_ID, epoch, key, body, PROJECT_ID),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(service.createTimeEntry).not.toHaveBeenCalled();
  });

  it('rejects an idempotency key that does not match the resolved operation id', async () => {
    await expect(
      controller.resolveEstimateOperation(
        'jira',
        TASK_ID,
        OPERATION_ID,
        '4',
        'different-op',
        { scopeKey: SCOPE_KEY, action: 'verify', expectedRevision: 1 },
        PROJECT_ID,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(service.resolveOperation).not.toHaveBeenCalled();
  });
});

describe('ExternalEstimateLogController legacy ownership assignment', () => {
  const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
  const SCOPE_KEY = 'acme.atlassian.net';
  const TASK_ID = 'ENG-1';

  const service = {
    assignLegacyCheckpoint: jest.fn(),
  };
  const controller = new ExternalEstimateLogController(
    service as unknown as EpicEstimateLoggingService,
  );

  beforeEach(() => jest.clearAllMocks());

  it.each([
    ['negative revision', '4', { scopeKey: SCOPE_KEY, expectedLegacyRevision: -1 }],
    ['missing scope key', '4', { expectedLegacyRevision: 4 }],
    ['unknown body field', '4', { scopeKey: SCOPE_KEY, expectedLegacyRevision: 4, force: true }],
  ])('rejects an assignment request with a %s before dispatch', async (_case, epoch, body) => {
    await expect(
      controller.assignLegacyCheckpoint('jira', TASK_ID, epoch, body, PROJECT_ID),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(service.assignLegacyCheckpoint).not.toHaveBeenCalled();
  });
});
