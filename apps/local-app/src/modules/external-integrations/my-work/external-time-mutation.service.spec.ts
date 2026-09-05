import { BusyError, ConflictError, NotFoundError } from '../../../common/errors/error-types';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import { ClickUpProviderError } from '../errors/external-provider.errors';
import { ExternalTaskProviderRegistry } from '../external-task-provider.registry';
import type { ExternalTaskProvider } from '../ports/external-task-provider';
import {
  ExternalTimeMutationStore,
  timeEntryNoteFingerprint,
} from '../sessions/external-time-mutation.store';
import { ProviderOperationGate } from '../sessions/provider-operation-gate';
import { TIME_OPERATION_RECEIPT_TTL_MS } from '../models/external-time-mutation.models';
import { ExternalTimeMutationService } from './external-time-mutation.service';

const credentials = { provider: 'clickup' as const, token: 'secret-token' };
const projectId = 'project-1';
const remoteScopeKey = 'workspace-1';
const connection = {
  id: 'connection-clickup',
  projectId,
  legacySourceConnectionId: null,
  provider: 'clickup' as const,
  generation: 4,
  subtaskSyncEnabled: false,
  syncSettingRevision: 1,
  createdAt: '2026-08-19T10:00:00.000Z',
  updatedAt: '2026-08-19T11:00:00.000Z',
};
const pendingEstimateState = {
  provider: 'clickup' as const,
  remoteScopeKey,
  remoteTaskId: 'task-1',
  loggedMinutes: 0,
  revision: 2,
  aggregationTimeZone: null,
  pendingOperationId: 'estimate-operation-1',
  pendingDeltaMinutes: 30,
  pendingEstimateTotalMinutes: 90,
  pendingStartedAt: '2026-08-19T09:30:00.000Z',
  pendingConnectionId: connection.id,
  pendingConnectionGeneration: connection.generation,
  pendingPhase: 'outcome_unknown' as const,
  pendingResolution: null,
  pendingActivityDate: null,
  createdAt: '2026-08-19T09:00:00.000Z',
  updatedAt: '2026-08-19T09:31:00.000Z',
};
const authoritativeLink = {
  id: 'link-1',
  epicId: 'epic-1',
  connectionId: connection.id,
  provider: 'clickup' as const,
  remoteScopeKey,
  remoteTaskId: 'task-1',
  sourceSnapshot: { title: 'Task 1' },
  createdAt: '2026-08-19T09:00:00.000Z',
  updatedAt: '2026-08-19T09:00:00.000Z',
};
const createInput = {
  startedAt: '2026-08-19T10:00:00.000Z',
  durationMs: 3_600_000,
  note: 'Implementation',
};
const dispatchedTimeout = () => new ClickUpProviderError('timeout', undefined, true);

describe('ExternalTimeMutationService', () => {
  let storage: jest.Mocked<
    Pick<
      StorageService,
      | 'getProject'
      | 'getIntegrationConnection'
      | 'getIntegrationConnectionCredentials'
      | 'getIntegrationConnectionCredentialsById'
      | 'getExternalEstimateLogState'
      | 'listExternalTaskLinksByRemoteTask'
      | 'listExternalEstimateLogStatesByRemoteTask'
    >
  >;
  let gate: ProviderOperationGate;
  let store: ExternalTimeMutationStore;
  let service: ExternalTimeMutationService;
  let createTimeEntry: jest.Mock;
  let updateTimeEntry: jest.Mock;
  let deleteTimeEntry: jest.Mock;
  let readTimeEntryExact: jest.Mock;
  let listOwnTimeEntryIdsInRange: jest.Mock;
  let assertTimeEntryDeletable: jest.Mock;
  let assertTimeEntryEditable: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    storage = {
      getProject: jest.fn().mockResolvedValue({ id: projectId }),
      getIntegrationConnection: jest.fn().mockImplementation(async (identity) =>
        typeof identity !== 'string' && 'provider' in identity && identity.provider === 'clickup'
          ? connection
          : {
              ...connection,
              id: 'connection-jira',
              provider: 'jira' as const,
            },
      ),
      getIntegrationConnectionCredentials: jest.fn().mockResolvedValue(credentials),
      getIntegrationConnectionCredentialsById: jest.fn().mockResolvedValue(credentials),
      getExternalEstimateLogState: jest.fn().mockResolvedValue(null),
      listExternalTaskLinksByRemoteTask: jest.fn().mockResolvedValue([]),
      listExternalEstimateLogStatesByRemoteTask: jest.fn().mockResolvedValue([]),
    };
    gate = new ProviderOperationGate();
    store = new ExternalTimeMutationStore();
    createTimeEntry = jest.fn();
    updateTimeEntry = jest.fn();
    deleteTimeEntry = jest.fn();
    readTimeEntryExact = jest.fn();
    listOwnTimeEntryIdsInRange = jest.fn();
    assertTimeEntryDeletable = jest.fn();
    assertTimeEntryEditable = jest.fn();
    const clickup: ExternalTaskProvider = {
      provider: 'clickup',
      descriptor: {
        provider: 'clickup',
        displayName: 'ClickUp',
        capabilities: { myWork: false },
      },
      verifyCredentials: jest.fn(),
      timeEntryMutations: {
        createTimeEntry,
        updateTimeEntry,
        deleteTimeEntry,
        readTimeEntryExact,
        listOwnTimeEntryIdsInRange,
        assertTimeEntryDeletable,
        assertTimeEntryEditable,
      },
    };
    const jira: ExternalTaskProvider = {
      provider: 'jira',
      descriptor: {
        provider: 'jira',
        displayName: 'Jira',
        capabilities: { myWork: false },
      },
      verifyCredentials: jest.fn(),
      timeEntryMutations: {
        createTimeEntry,
        updateTimeEntry,
        deleteTimeEntry,
        readTimeEntryExact,
        listOwnTimeEntryIdsInRange,
        assertTimeEntryDeletable,
        assertTimeEntryEditable,
      },
    };
    service = new ExternalTimeMutationService(
      storage as unknown as StorageService,
      new ExternalTaskProviderRegistry([clickup, jira]),
      gate,
      store,
    );
  });

  describe('create', () => {
    it('rejects a stale manual client before provider reads while durable estimate state is pending', async () => {
      storage.getExternalEstimateLogState.mockResolvedValue(pendingEstimateState);

      await expect(
        service.createTimeEntry(
          projectId,
          'clickup',
          'task-1',
          createInput,
          'manual-operation-1',
          4,
          remoteScopeKey,
        ),
      ).rejects.toMatchObject<BusyError>({
        details: {
          reason: 'estimate_operation_pending',
          operationId: 'estimate-operation-1',
        },
      });

      expect(storage.getExternalEstimateLogState).toHaveBeenCalledWith({
        provider: 'clickup',
        remoteScopeKey,
        remoteTaskId: 'task-1',
      });
      expect(listOwnTimeEntryIdsInRange).not.toHaveBeenCalled();
      expect(createTimeEntry).not.toHaveBeenCalled();
      expect(service.inspectOperation('manual-operation-1')).toBeNull();
    });

    it('rejects create when an altered scope hides the current connection pending row', async () => {
      storage.listExternalTaskLinksByRemoteTask.mockResolvedValue([authoritativeLink]);
      storage.listExternalEstimateLogStatesByRemoteTask.mockResolvedValue([pendingEstimateState]);
      storage.getExternalEstimateLogState.mockImplementation(async (identity) =>
        identity.remoteScopeKey === remoteScopeKey ? pendingEstimateState : null,
      );
      listOwnTimeEntryIdsInRange.mockResolvedValue({ ids: [], complete: true });
      createTimeEntry.mockResolvedValue({ remoteEntryId: '9100' });

      await expect(
        service.createTimeEntry(
          projectId,
          'clickup',
          'task-1',
          createInput,
          'manual-operation-1',
          4,
          'altered-workspace',
        ),
      ).rejects.toMatchObject<BusyError>({
        details: {
          reason: 'estimate_operation_pending',
          operationId: 'estimate-operation-1',
        },
      });
      expect(storage.getExternalEstimateLogState).toHaveBeenCalledWith({
        provider: 'clickup',
        remoteScopeKey,
        remoteTaskId: 'task-1',
      });
      expect(listOwnTimeEntryIdsInRange).not.toHaveBeenCalled();
      expect(createTimeEntry).not.toHaveBeenCalled();
    });

    it('does not block an unlinked scope from a same-task checkpoint owned by another connection', async () => {
      const unrelatedState = {
        ...pendingEstimateState,
        remoteScopeKey: 'other-workspace',
        pendingConnectionId: 'other-connection',
      };
      storage.listExternalTaskLinksByRemoteTask.mockResolvedValue([
        {
          ...authoritativeLink,
          id: 'other-link',
          connectionId: 'other-connection',
          remoteScopeKey: unrelatedState.remoteScopeKey,
        },
      ]);
      storage.listExternalEstimateLogStatesByRemoteTask.mockResolvedValue([unrelatedState]);
      storage.getExternalEstimateLogState.mockResolvedValue(null);
      listOwnTimeEntryIdsInRange.mockResolvedValue({ ids: [], complete: true });
      createTimeEntry.mockResolvedValue({ remoteEntryId: '9100' });

      await expect(
        service.createTimeEntry(
          projectId,
          'clickup',
          'task-1',
          createInput,
          'manual-operation-1',
          4,
          'current-unlinked-workspace',
        ),
      ).resolves.toMatchObject({ outcome: 'created' });
      expect(createTimeEntry).toHaveBeenCalledTimes(1);
    });

    it('admits a later manual create only after durable pending state is cleared', async () => {
      storage.getExternalEstimateLogState
        .mockResolvedValueOnce(pendingEstimateState)
        .mockResolvedValueOnce(null);
      listOwnTimeEntryIdsInRange.mockResolvedValue({ ids: [], complete: true });
      createTimeEntry.mockResolvedValue({ remoteEntryId: '9100' });

      await expect(
        service.createTimeEntry(
          projectId,
          'clickup',
          'task-1',
          createInput,
          'manual-operation-1',
          4,
          remoteScopeKey,
        ),
      ).rejects.toBeInstanceOf(BusyError);

      await expect(
        service.createTimeEntry(
          projectId,
          'clickup',
          'task-1',
          createInput,
          'manual-operation-2',
          4,
          remoteScopeKey,
        ),
      ).resolves.toMatchObject({ outcome: 'created' });
      expect(createTimeEntry).toHaveBeenCalledTimes(1);
    });

    it('keeps estimate dispatch explicit so its own prepared checkpoint does not self-block', async () => {
      storage.getExternalEstimateLogState.mockResolvedValue(pendingEstimateState);
      listOwnTimeEntryIdsInRange.mockResolvedValue({ ids: [], complete: true });
      createTimeEntry.mockResolvedValue({ remoteEntryId: '9100' });

      await expect(
        service.createEstimateTimeEntry(
          projectId,
          'clickup',
          'task-1',
          createInput,
          'estimate-operation-1',
          4,
        ),
      ).resolves.toMatchObject({ outcome: 'created' });
      expect(storage.getExternalEstimateLogState).not.toHaveBeenCalled();
    });

    it('rejects an estimate after a manual create becomes outcome unknown', async () => {
      listOwnTimeEntryIdsInRange.mockResolvedValue({ ids: [], complete: true });
      createTimeEntry.mockRejectedValue(dispatchedTimeout());

      await expect(
        service.createTimeEntry(
          projectId,
          'clickup',
          'task-1',
          createInput,
          'manual-operation-1',
          4,
          remoteScopeKey,
        ),
      ).resolves.toMatchObject({ outcome: 'outcome_unknown' });

      await expect(
        service.createEstimateTimeEntry(
          projectId,
          'clickup',
          'task-1',
          createInput,
          'estimate-operation-1',
          4,
        ),
      ).rejects.toMatchObject<BusyError>({
        details: {
          reason: 'operation_in_progress',
          operationId: 'manual-operation-1',
          phase: 'outcome_unknown',
        },
      });
      expect(listOwnTimeEntryIdsInRange).toHaveBeenCalledTimes(1);
      expect(createTimeEntry).toHaveBeenCalledTimes(1);
      expect(service.inspectOperation('estimate-operation-1')).toBeNull();
    });

    it('lets an estimate proceed after a terminal manual receipt', async () => {
      listOwnTimeEntryIdsInRange.mockResolvedValue({ ids: [], complete: true });
      createTimeEntry
        .mockResolvedValueOnce({ remoteEntryId: 'manual-entry' })
        .mockResolvedValueOnce({ remoteEntryId: 'estimate-entry' });

      await service.createTimeEntry(
        projectId,
        'clickup',
        'task-1',
        createInput,
        'manual-operation-1',
        4,
        remoteScopeKey,
      );

      await expect(
        service.createEstimateTimeEntry(
          projectId,
          'clickup',
          'task-1',
          createInput,
          'estimate-operation-1',
          4,
        ),
      ).resolves.toMatchObject({ outcome: 'created', remoteEntryId: 'estimate-entry' });
      expect(createTimeEntry).toHaveBeenCalledTimes(2);
    });

    it('lets an estimate proceed after an unknown manual receipt is acknowledged', async () => {
      listOwnTimeEntryIdsInRange.mockResolvedValue({ ids: [], complete: true });
      createTimeEntry
        .mockRejectedValueOnce(dispatchedTimeout())
        .mockResolvedValueOnce({ remoteEntryId: 'estimate-entry' });

      await service.createTimeEntry(
        projectId,
        'clickup',
        'task-1',
        createInput,
        'manual-operation-1',
        4,
        remoteScopeKey,
      );
      await service.acknowledgeOperation(projectId, 'clickup', 'manual-operation-1', 4);

      await expect(
        service.createEstimateTimeEntry(
          projectId,
          'clickup',
          'task-1',
          createInput,
          'estimate-operation-1',
          4,
        ),
      ).resolves.toMatchObject({ outcome: 'created', remoteEntryId: 'estimate-entry' });
      expect(createTimeEntry).toHaveBeenCalledTimes(2);
    });

    it('isolates estimate admission from a manual receipt on another task', async () => {
      listOwnTimeEntryIdsInRange.mockResolvedValue({ ids: [], complete: true });
      createTimeEntry
        .mockRejectedValueOnce(dispatchedTimeout())
        .mockResolvedValueOnce({ remoteEntryId: 'estimate-entry' });

      await service.createTimeEntry(
        projectId,
        'clickup',
        'task-2',
        createInput,
        'manual-operation-1',
        4,
        remoteScopeKey,
      );

      await expect(
        service.createEstimateTimeEntry(
          projectId,
          'clickup',
          'task-1',
          createInput,
          'estimate-operation-1',
          4,
        ),
      ).resolves.toMatchObject({ outcome: 'created', remoteEntryId: 'estimate-entry' });
    });

    it('isolates estimate admission from a same-task receipt on another connection', async () => {
      store.admit({
        operationId: 'other-connection-operation',
        kind: 'create',
        tuple: {
          provider: 'clickup',
          connectionId: 'connection-other',
          connectionGeneration: 9,
          remoteTaskId: 'task-1',
          remoteEntryId: null,
          effectiveStartedAt: createInput.startedAt,
          durationMs: createInput.durationMs,
          noteFingerprint: timeEntryNoteFingerprint(createInput.note),
        },
        baseline: null,
      });
      store.markUnknown('other-connection-operation');
      listOwnTimeEntryIdsInRange.mockResolvedValue({ ids: [], complete: true });
      createTimeEntry.mockResolvedValue({ remoteEntryId: 'estimate-entry' });

      await expect(
        service.createEstimateTimeEntry(
          projectId,
          'clickup',
          'task-1',
          createInput,
          'estimate-operation-1',
          4,
        ),
      ).resolves.toMatchObject({ outcome: 'created', remoteEntryId: 'estimate-entry' });
    });

    it('rejects an estimate while manual provider dispatch holds the gate', async () => {
      let rejectManual!: (reason?: unknown) => void;
      let markManualStarted!: () => void;
      const manualStarted = new Promise<void>((resolve) => {
        markManualStarted = resolve;
      });
      const manualWrite = new Promise<{ remoteEntryId: string | null }>((_resolve, reject) => {
        rejectManual = reject;
      });
      listOwnTimeEntryIdsInRange.mockResolvedValue({ ids: [], complete: true });
      createTimeEntry.mockImplementationOnce(() => {
        markManualStarted();
        return manualWrite;
      });

      const manual = service.createTimeEntry(
        projectId,
        'clickup',
        'task-1',
        createInput,
        'manual-operation-1',
        4,
        remoteScopeKey,
      );
      await manualStarted;

      await expect(
        service.createEstimateTimeEntry(
          projectId,
          'clickup',
          'task-1',
          createInput,
          'estimate-operation-1',
          4,
        ),
      ).rejects.toMatchObject<BusyError>({ details: { reason: 'operation_in_progress' } });
      expect(createTimeEntry).toHaveBeenCalledTimes(1);

      rejectManual(dispatchedTimeout());
      await expect(manual).resolves.toMatchObject({ outcome: 'outcome_unknown' });
    });

    it('rejects a manual write while estimate provider dispatch holds the gate', async () => {
      let releaseEstimate!: (value: { remoteEntryId: string | null }) => void;
      let markEstimateStarted!: () => void;
      const estimateStarted = new Promise<void>((resolve) => {
        markEstimateStarted = resolve;
      });
      const estimateWrite = new Promise<{ remoteEntryId: string | null }>((resolve) => {
        releaseEstimate = resolve;
      });
      listOwnTimeEntryIdsInRange.mockResolvedValue({ ids: [], complete: true });
      createTimeEntry.mockImplementationOnce(() => {
        markEstimateStarted();
        return estimateWrite;
      });

      const estimate = service.createEstimateTimeEntry(
        projectId,
        'clickup',
        'task-1',
        createInput,
        'estimate-operation-1',
        4,
      );
      await estimateStarted;

      await expect(
        service.createTimeEntry(
          projectId,
          'clickup',
          'task-1',
          createInput,
          'manual-operation-1',
          4,
          remoteScopeKey,
        ),
      ).rejects.toMatchObject<BusyError>({ details: { reason: 'operation_in_progress' } });
      expect(createTimeEntry).toHaveBeenCalledTimes(1);

      releaseEstimate({ remoteEntryId: 'estimate-entry' });
      await expect(estimate).resolves.toMatchObject({ outcome: 'created' });
    });

    it('stores the baseline before dispatch and returns the provider proof', async () => {
      listOwnTimeEntryIdsInRange.mockResolvedValue({ ids: ['9001'], complete: true });
      createTimeEntry.mockResolvedValue({ remoteEntryId: '9100' });

      const result = await service.createTimeEntry(
        projectId,
        'clickup',
        'task-1',
        createInput,
        'op-1',
        4,
        remoteScopeKey,
      );

      expect(result.outcome).toBe('created');
      if (result.outcome === 'created') {
        expect(result.remoteEntryId).toBe('9100');
        expect(result.refresh).toEqual(['task_detail']);
      }
      // The baseline read happens before the dispatch call.
      expect(listOwnTimeEntryIdsInRange.mock.invocationCallOrder[0]).toBeLessThan(
        createTimeEntry.mock.invocationCallOrder[0],
      );
      const rangeArgs = listOwnTimeEntryIdsInRange.mock.calls[0];
      expect(rangeArgs[3]).toBe(Date.parse(createInput.startedAt) - 10 * 60_000);
      expect(rangeArgs[4]).toBe(Date.parse(createInput.startedAt) + 10 * 60_000);
      expect(result.receipt.phase).toBe('succeeded');
      expect(result.receipt.remoteEntryId).toBe('9100');
      expect(storage.getIntegrationConnectionCredentials).toHaveBeenCalledWith({
        projectId,
        provider: 'clickup',
      });
      expect(service.inspectOperation('op-1')).toEqual({
        operationId: 'op-1',
        kind: 'create',
        phase: 'succeeded',
        canVerify: false,
        expiresAt: expect.any(String),
        tuple: {
          provider: 'clickup',
          connectionId: connection.id,
          connectionGeneration: connection.generation,
          remoteTaskId: 'task-1',
          remoteEntryId: null,
          effectiveStartedAt: createInput.startedAt,
          durationMs: createInput.durationMs,
          noteFingerprint: timeEntryNoteFingerprint(createInput.note),
        },
      });
    });

    it('validates the epoch before credentials load', async () => {
      await expect(
        service.createTimeEntry(
          projectId,
          'clickup',
          'task-1',
          createInput,
          'op-1',
          3,
          remoteScopeKey,
        ),
      ).rejects.toBeInstanceOf(ConflictError);
      expect(storage.getIntegrationConnectionCredentials).not.toHaveBeenCalled();
      expect(listOwnTimeEntryIdsInRange).not.toHaveBeenCalled();
    });

    it('rechecks the epoch inside the gate and refuses to dispatch after replacement', async () => {
      storage.getIntegrationConnection
        .mockResolvedValueOnce(connection)
        .mockResolvedValueOnce({ ...connection, generation: 5 });

      await expect(
        service.createTimeEntry(
          projectId,
          'clickup',
          'task-1',
          createInput,
          'op-1',
          4,
          remoteScopeKey,
        ),
      ).rejects.toMatchObject({
        code: 'conflict',
        details: { reason: 'connection_superseded' },
      });
      expect(createTimeEntry).not.toHaveBeenCalled();
    });

    it('records an unknown outcome without any retry', async () => {
      listOwnTimeEntryIdsInRange.mockResolvedValue({ ids: [], complete: true });
      createTimeEntry.mockRejectedValue(dispatchedTimeout());

      const result = await service.createTimeEntry(
        projectId,
        'clickup',
        'task-1',
        createInput,
        'op-1',
        4,
        remoteScopeKey,
      );

      expect(result.outcome).toBe('outcome_unknown');
      expect(result.receipt.phase).toBe('outcome_unknown');
      expect(createTimeEntry).toHaveBeenCalledTimes(1);
    });

    it('replays a terminal succeeded create and never re-dispatches', async () => {
      listOwnTimeEntryIdsInRange.mockResolvedValue({ ids: [], complete: true });
      createTimeEntry.mockResolvedValue({ remoteEntryId: '9100' });

      await service.createTimeEntry(
        projectId,
        'clickup',
        'task-1',
        createInput,
        'op-1',
        4,
        remoteScopeKey,
      );
      const replay = await service.createTimeEntry(
        projectId,
        'clickup',
        'task-1',
        createInput,
        'op-1',
        4,
        remoteScopeKey,
      );

      expect(replay.outcome).toBe('created');
      expect(createTimeEntry).toHaveBeenCalledTimes(1);
    });

    it('returns a confirmed null-id create without converting it to unknown', async () => {
      listOwnTimeEntryIdsInRange.mockResolvedValue({ ids: [], complete: true });
      createTimeEntry.mockResolvedValue({ remoteEntryId: null });

      const result = await service.createTimeEntry(
        projectId,
        'clickup',
        'task-1',
        createInput,
        'op-1',
        4,
        remoteScopeKey,
      );

      expect(result.outcome).toBe('created');
      if (result.outcome === 'created') {
        expect(result.remoteEntryId).toBeNull();
        expect(result.refresh).toEqual(['task_detail']);
      }
      expect(result.receipt.phase).toBe('succeeded');
      expect(result.receipt.remoteEntryId).toBeNull();
    });

    it('replays a successful null-id create as created and never re-dispatches', async () => {
      listOwnTimeEntryIdsInRange.mockResolvedValue({ ids: [], complete: true });
      createTimeEntry.mockResolvedValue({ remoteEntryId: null });

      await service.createTimeEntry(
        projectId,
        'clickup',
        'task-1',
        createInput,
        'op-1',
        4,
        remoteScopeKey,
      );
      const replay = await service.createTimeEntry(
        projectId,
        'clickup',
        'task-1',
        createInput,
        'op-1',
        4,
        remoteScopeKey,
      );

      expect(replay.outcome).toBe('created');
      if (replay.outcome === 'created') {
        expect(replay.remoteEntryId).toBeNull();
      }
      expect(createTimeEntry).toHaveBeenCalledTimes(1);
    });

    it('returns the standing unknown for a retry of the same tuple', async () => {
      listOwnTimeEntryIdsInRange.mockResolvedValue({ ids: [], complete: true });
      createTimeEntry.mockRejectedValueOnce(dispatchedTimeout());

      await service.createTimeEntry(
        projectId,
        'clickup',
        'task-1',
        createInput,
        'op-1',
        4,
        remoteScopeKey,
      );
      const retry = await service.createTimeEntry(
        projectId,
        'clickup',
        'task-1',
        createInput,
        'op-1',
        4,
        remoteScopeKey,
      );

      expect(retry.outcome).toBe('outcome_unknown');
      expect(createTimeEntry).toHaveBeenCalledTimes(1);
    });

    it('conflicts on a reused operation id with a different tuple', async () => {
      listOwnTimeEntryIdsInRange.mockResolvedValue({ ids: [], complete: true });
      createTimeEntry.mockResolvedValue({ remoteEntryId: '9100' });
      await service.createTimeEntry(
        projectId,
        'clickup',
        'task-1',
        createInput,
        'op-1',
        4,
        remoteScopeKey,
      );

      await expect(
        service.createTimeEntry(
          projectId,
          'clickup',
          'task-1',
          { ...createInput, durationMs: 60_000 },
          'op-1',
          4,
          remoteScopeKey,
        ),
      ).rejects.toMatchObject({
        code: 'conflict',
        details: { reason: 'operation_id_conflict' },
      });
      expect(createTimeEntry).toHaveBeenCalledTimes(1);
    });

    it('fails busy when live receipts exhaust the capacity', async () => {
      const smallStore = new ExternalTimeMutationStore(1, 4);
      const constrained = new ExternalTimeMutationService(
        storage as unknown as StorageService,
        (service as unknown as { providers: ExternalTaskProviderRegistry }).providers,
        gate,
        smallStore,
      );
      listOwnTimeEntryIdsInRange.mockResolvedValue({ ids: [], complete: true });
      createTimeEntry.mockRejectedValue(dispatchedTimeout());

      await constrained.createTimeEntry(
        projectId,
        'clickup',
        'task-1',
        createInput,
        'op-1',
        4,
        remoteScopeKey,
      );
      await expect(
        constrained.createTimeEntry(
          projectId,
          'clickup',
          'task-1',
          createInput,
          'op-2',
          4,
          remoteScopeKey,
        ),
      ).rejects.toBeInstanceOf(BusyError);
    });

    it('fails busy while the provider gate is held', async () => {
      let release: () => void = () => undefined;
      const held = gate.run(
        { projectId, provider: 'clickup' },
        () => new Promise<void>((resolve) => (release = resolve)),
      );
      listOwnTimeEntryIdsInRange.mockResolvedValue({ ids: [], complete: true });

      const pending = service.createTimeEntry(
        projectId,
        'clickup',
        'task-1',
        createInput,
        'op-1',
        4,
        remoteScopeKey,
      );
      await expect(pending).rejects.toBeInstanceOf(BusyError);
      release();
      await held;
    });
  });

  describe('update', () => {
    const baseline = {
      remoteId: '9100',
      startedAt: createInput.startedAt,
      durationMs: createInput.durationMs,
      note: createInput.note,
      owned: true,
    };
    const revised = {
      startedAt: '2026-08-19T11:00:00.000Z',
      durationMs: 5_400_000,
      note: 'Revised',
    };

    it('updates once, verifies the exact desired tuple, and leaves checkpoint state read-only', async () => {
      assertTimeEntryEditable.mockResolvedValue(baseline);
      updateTimeEntry.mockResolvedValue(undefined);
      readTimeEntryExact.mockResolvedValue({ ...baseline, ...revised });

      await expect(
        service.updateTimeEntry(
          projectId,
          'clickup',
          'task-1',
          '9100',
          revised,
          'update-operation-1',
          4,
          remoteScopeKey,
        ),
      ).resolves.toMatchObject({ outcome: 'updated', receipt: { kind: 'update' } });

      expect(assertTimeEntryEditable).toHaveBeenCalledTimes(1);
      expect(updateTimeEntry).toHaveBeenCalledTimes(1);
      expect(updateTimeEntry).toHaveBeenCalledWith(
        credentials,
        { connectionId: connection.id, connectionGeneration: connection.generation },
        'task-1',
        '9100',
        revised,
      );
      expect(readTimeEntryExact).toHaveBeenCalledTimes(1);
      expect(storage.getExternalEstimateLogState).toHaveBeenCalledTimes(1);
    });

    it('keeps an ambiguous update verifiable and resolves it from the exact desired tuple', async () => {
      assertTimeEntryEditable.mockResolvedValue(baseline);
      updateTimeEntry.mockRejectedValue(dispatchedTimeout());

      const unknown = await service.updateTimeEntry(
        projectId,
        'clickup',
        'task-1',
        '9100',
        revised,
        'update-operation-1',
        4,
        remoteScopeKey,
      );
      expect(unknown).toMatchObject({
        outcome: 'outcome_unknown',
        receipt: { kind: 'update', canVerify: true },
      });

      readTimeEntryExact.mockResolvedValue({ ...baseline, ...revised });
      await expect(
        service.verifyOperation(projectId, 'clickup', 'update-operation-1', 4),
      ).resolves.toMatchObject({ resolved: true, resolution: 'updated' });
      expect(updateTimeEntry).toHaveBeenCalledTimes(1);
    });

    it('does not dispatch when the requested entry already has the desired values', async () => {
      assertTimeEntryEditable.mockResolvedValue({ ...baseline, ...revised });

      await expect(
        service.updateTimeEntry(
          projectId,
          'clickup',
          'task-1',
          '9100',
          revised,
          'update-operation-1',
          4,
          remoteScopeKey,
        ),
      ).resolves.toMatchObject({ outcome: 'not_applied' });
      expect(updateTimeEntry).not.toHaveBeenCalled();
    });

    it('blocks updates while a durable estimate operation is pending', async () => {
      storage.getExternalEstimateLogState.mockResolvedValue(pendingEstimateState);

      await expect(
        service.updateTimeEntry(
          projectId,
          'clickup',
          'task-1',
          '9100',
          revised,
          'update-operation-1',
          4,
          remoteScopeKey,
        ),
      ).rejects.toMatchObject<BusyError>({
        details: { reason: 'estimate_operation_pending' },
      });
      expect(assertTimeEntryEditable).not.toHaveBeenCalled();
      expect(updateTimeEntry).not.toHaveBeenCalled();
    });
  });

  describe('delete', () => {
    it('rejects manual delete while a stored estimate resolution is still pending', async () => {
      storage.getExternalEstimateLogState.mockResolvedValue({
        ...pendingEstimateState,
        revision: 3,
        pendingResolution: 'logged',
        updatedAt: '2026-08-19T09:32:00.000Z',
      });

      await expect(
        service.deleteTimeEntry(
          projectId,
          'clickup',
          'task-1',
          '9100',
          'manual-operation-1',
          4,
          remoteScopeKey,
        ),
      ).rejects.toMatchObject<BusyError>({
        details: {
          reason: 'estimate_operation_pending',
          operationId: 'estimate-operation-1',
        },
      });
      expect(assertTimeEntryDeletable).not.toHaveBeenCalled();
      expect(deleteTimeEntry).not.toHaveBeenCalled();
    });

    it('rejects delete when an altered scope hides the current connection pending row', async () => {
      storage.listExternalTaskLinksByRemoteTask.mockResolvedValue([authoritativeLink]);
      storage.listExternalEstimateLogStatesByRemoteTask.mockResolvedValue([pendingEstimateState]);
      storage.getExternalEstimateLogState.mockImplementation(async (identity) =>
        identity.remoteScopeKey === remoteScopeKey ? pendingEstimateState : null,
      );
      assertTimeEntryDeletable.mockResolvedValue(undefined);
      deleteTimeEntry.mockResolvedValue(undefined);

      await expect(
        service.deleteTimeEntry(
          projectId,
          'clickup',
          'task-1',
          '9100',
          'manual-operation-1',
          4,
          'altered-workspace',
        ),
      ).rejects.toMatchObject<BusyError>({
        details: {
          reason: 'estimate_operation_pending',
          operationId: 'estimate-operation-1',
        },
      });
      expect(assertTimeEntryDeletable).not.toHaveBeenCalled();
      expect(deleteTimeEntry).not.toHaveBeenCalled();
    });

    it('runs the provider preflight then one delete', async () => {
      assertTimeEntryDeletable.mockResolvedValue(undefined);
      deleteTimeEntry.mockResolvedValue(undefined);

      const result = await service.deleteTimeEntry(
        projectId,
        'clickup',
        'task-1',
        '9100',
        'op-1',
        4,
        remoteScopeKey,
      );

      expect(result.outcome).toBe('deleted');
      expect(result.receipt.phase).toBe('succeeded');
      expect(assertTimeEntryDeletable.mock.invocationCallOrder[0]).toBeLessThan(
        deleteTimeEntry.mock.invocationCallOrder[0],
      );
    });

    it('treats a classified delete 404 as already deleted', async () => {
      assertTimeEntryDeletable.mockResolvedValue(undefined);
      deleteTimeEntry.mockRejectedValue(new ClickUpProviderError('not_found'));

      const result = await service.deleteTimeEntry(
        projectId,
        'clickup',
        'task-1',
        '9100',
        'op-1',
        4,
        remoteScopeKey,
      );

      expect(result.outcome).toBe('already_deleted');
    });

    it('records an unknown delete without retry', async () => {
      assertTimeEntryDeletable.mockResolvedValue(undefined);
      deleteTimeEntry.mockRejectedValue(dispatchedTimeout());

      const result = await service.deleteTimeEntry(
        projectId,
        'clickup',
        'task-1',
        '9100',
        'op-1',
        4,
        remoteScopeKey,
      );

      expect(result.outcome).toBe('outcome_unknown');
      expect(deleteTimeEntry).toHaveBeenCalledTimes(1);
    });

    it('blocks estimate dispatch while a manual delete outcome remains unknown', async () => {
      assertTimeEntryDeletable.mockResolvedValue(undefined);
      deleteTimeEntry.mockRejectedValue(dispatchedTimeout());

      await expect(
        service.deleteTimeEntry(
          projectId,
          'clickup',
          'task-1',
          '9100',
          'manual-delete-operation',
          4,
          remoteScopeKey,
        ),
      ).resolves.toMatchObject({ outcome: 'outcome_unknown' });

      await expect(
        service.createEstimateTimeEntry(
          projectId,
          'clickup',
          'task-1',
          createInput,
          'estimate-operation-1',
          4,
        ),
      ).rejects.toMatchObject<BusyError>({
        details: {
          reason: 'operation_in_progress',
          operationId: 'manual-delete-operation',
          phase: 'outcome_unknown',
        },
      });
      expect(listOwnTimeEntryIdsInRange).not.toHaveBeenCalled();
      expect(createTimeEntry).not.toHaveBeenCalled();
    });

    it('fails the preflight rejection without a receipt', async () => {
      assertTimeEntryDeletable.mockRejectedValue(new ClickUpProviderError('not_found'));

      await expect(
        service.deleteTimeEntry(projectId, 'clickup', 'task-1', '9100', 'op-1', 4, remoteScopeKey),
      ).rejects.toMatchObject({ code: 'clickup_not_found' });
      expect(deleteTimeEntry).not.toHaveBeenCalled();
      await expect(service.getOperation(projectId, 'clickup', 'op-1', 4)).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });
  });

  describe('verify', () => {
    it('resolves an unknown create from one new matching id with complete reads', async () => {
      listOwnTimeEntryIdsInRange
        .mockResolvedValueOnce({ ids: ['9001'], complete: true })
        .mockResolvedValueOnce({ ids: ['9001', '9100'], complete: true });
      createTimeEntry.mockRejectedValue(dispatchedTimeout());
      readTimeEntryExact.mockResolvedValue({
        remoteId: '9100',
        startedAt: '2026-08-19T10:00:30.000Z',
        durationMs: 3_600_000,
        owned: true,
      });

      await service.createTimeEntry(
        projectId,
        'clickup',
        'task-1',
        createInput,
        'op-1',
        4,
        remoteScopeKey,
      );
      const verified = await service.verifyOperation(projectId, 'clickup', 'op-1', 4);

      expect(verified.resolved).toBe(true);
      expect(verified.resolution).toBe('created');
      expect(verified.receipt.phase).toBe('succeeded');
      expect(verified.receipt.remoteEntryId).toBe('9100');
    });

    it('resolves a definitively unapplied create from complete empty delta', async () => {
      listOwnTimeEntryIdsInRange
        .mockResolvedValueOnce({ ids: [], complete: true })
        .mockResolvedValueOnce({ ids: [], complete: true });
      createTimeEntry.mockRejectedValue(dispatchedTimeout());

      await service.createTimeEntry(
        projectId,
        'clickup',
        'task-1',
        createInput,
        'op-1',
        4,
        remoteScopeKey,
      );
      const verified = await service.verifyOperation(projectId, 'clickup', 'op-1', 4);

      expect(verified.resolution).toBe('not_applied');
      expect(verified.receipt.phase).toBe('not_applied');
    });

    it('keeps a create unknown when completeness is not provable', async () => {
      listOwnTimeEntryIdsInRange
        .mockResolvedValueOnce({ ids: ['9001'], complete: false })
        .mockResolvedValueOnce({ ids: ['9001', '9100'], complete: false });
      createTimeEntry.mockRejectedValue(dispatchedTimeout());
      readTimeEntryExact.mockResolvedValue({
        remoteId: '9100',
        startedAt: createInput.startedAt,
        durationMs: createInput.durationMs,
        owned: true,
      });

      await service.createTimeEntry(
        projectId,
        'clickup',
        'task-1',
        createInput,
        'op-1',
        4,
        remoteScopeKey,
      );
      const verified = await service.verifyOperation(projectId, 'clickup', 'op-1', 4);

      expect(verified.resolved).toBe(false);
      expect(verified.resolution).toBe('completeness_not_provable');
      expect(verified.receipt.phase).toBe('outcome_unknown');
      expect(readTimeEntryExact).not.toHaveBeenCalled();
    });

    it('stays unresolved when several new ids match', async () => {
      listOwnTimeEntryIdsInRange
        .mockResolvedValueOnce({ ids: [], complete: true })
        .mockResolvedValueOnce({ ids: ['9100', '9101'], complete: true });
      createTimeEntry.mockRejectedValue(dispatchedTimeout());
      readTimeEntryExact.mockImplementation(async (_c, _ctx, _task, id) => ({
        remoteId: id,
        startedAt: createInput.startedAt,
        durationMs: createInput.durationMs,
        owned: true,
      }));

      await service.createTimeEntry(
        projectId,
        'clickup',
        'task-1',
        createInput,
        'op-1',
        4,
        remoteScopeKey,
      );
      const verified = await service.verifyOperation(projectId, 'clickup', 'op-1', 4);

      expect(verified.resolution).toBe('unresolved');
      expect(verified.receipt.phase).toBe('outcome_unknown');
    });

    it('resolves an unknown delete from the exact-resource read only', async () => {
      assertTimeEntryDeletable.mockResolvedValue(undefined);
      deleteTimeEntry.mockRejectedValue(dispatchedTimeout());

      await service.deleteTimeEntry(
        projectId,
        'clickup',
        'task-1',
        '9100',
        'op-1',
        4,
        remoteScopeKey,
      );
      readTimeEntryExact.mockResolvedValue(null);
      const verified = await service.verifyOperation(projectId, 'clickup', 'op-1', 4);
      expect(verified.resolution).toBe('already_deleted');
      expect(verified.receipt.phase).toBe('already_deleted');

      // A second unknown delete whose entry still exists never landed.
      await service.deleteTimeEntry(
        projectId,
        'clickup',
        'task-1',
        '9101',
        'op-2',
        4,
        remoteScopeKey,
      );
      readTimeEntryExact.mockResolvedValue({
        remoteId: '9101',
        startedAt: createInput.startedAt,
        durationMs: 60_000,
        owned: true,
      });
      const present = await service.verifyOperation(projectId, 'clickup', 'op-2', 4);
      expect(present.resolution).toBe('not_applied');
      expect(present.receipt.phase).toBe('not_applied');
    });

    it('keeps a delete unknown when the exact read fails', async () => {
      assertTimeEntryDeletable.mockResolvedValue(undefined);
      deleteTimeEntry.mockRejectedValue(dispatchedTimeout());
      await service.deleteTimeEntry(
        projectId,
        'clickup',
        'task-1',
        '9100',
        'op-1',
        4,
        remoteScopeKey,
      );

      readTimeEntryExact.mockRejectedValue(new Error('transport'));
      const verified = await service.verifyOperation(projectId, 'clickup', 'op-1', 4);

      expect(verified.resolution).toBe('verify_failed');
      expect(verified.receipt.phase).toBe('outcome_unknown');
    });

    it('refuses verification across a replaced connection', async () => {
      assertTimeEntryDeletable.mockResolvedValue(undefined);
      deleteTimeEntry.mockRejectedValue(dispatchedTimeout());
      await service.deleteTimeEntry(
        projectId,
        'clickup',
        'task-1',
        '9100',
        'op-1',
        4,
        remoteScopeKey,
      );

      storage.getIntegrationConnection.mockResolvedValue({ ...connection, generation: 5 });
      // The epoch precheck fails first against the current connection.
      await expect(service.verifyOperation(projectId, 'clickup', 'op-1', 4)).rejects.toBeInstanceOf(
        ConflictError,
      );
    });

    it('keeps an unknown create unresolved when replacement occurs during credential loading', async () => {
      listOwnTimeEntryIdsInRange.mockResolvedValue({ ids: [], complete: true });
      createTimeEntry.mockRejectedValue(dispatchedTimeout());
      await service.createTimeEntry(
        projectId,
        'clickup',
        'task-1',
        createInput,
        'op-1',
        4,
        remoteScopeKey,
      );
      listOwnTimeEntryIdsInRange.mockClear();
      storage.getIntegrationConnectionCredentialsById.mockImplementation(async () => {
        storage.getIntegrationConnection.mockResolvedValue({ ...connection, generation: 5 });
        return { provider: 'clickup', token: 'replacement-token' };
      });

      await expect(service.verifyOperation(projectId, 'clickup', 'op-1', 4)).rejects.toMatchObject({
        code: 'conflict',
        details: { reason: 'connection_superseded' },
      });

      expect(storage.getIntegrationConnectionCredentialsById).toHaveBeenCalledWith(connection.id);
      expect(listOwnTimeEntryIdsInRange).not.toHaveBeenCalled();
      expect(store.get('op-1')?.phase).toBe('outcome_unknown');
    });

    it('keeps an unknown delete unresolved when replacement occurs during credential loading', async () => {
      assertTimeEntryDeletable.mockResolvedValue(undefined);
      deleteTimeEntry.mockRejectedValue(dispatchedTimeout());
      await service.deleteTimeEntry(
        projectId,
        'clickup',
        'task-1',
        '9100',
        'op-1',
        4,
        remoteScopeKey,
      );
      readTimeEntryExact.mockClear();
      storage.getIntegrationConnectionCredentialsById.mockImplementation(async () => {
        storage.getIntegrationConnection.mockResolvedValue({ ...connection, generation: 5 });
        return { provider: 'clickup', token: 'replacement-token' };
      });

      await expect(service.verifyOperation(projectId, 'clickup', 'op-1', 4)).rejects.toMatchObject({
        code: 'conflict',
        details: { reason: 'connection_superseded' },
      });

      expect(storage.getIntegrationConnectionCredentialsById).toHaveBeenCalledWith(connection.id);
      expect(readTimeEntryExact).not.toHaveBeenCalled();
      expect(store.get('op-1')?.phase).toBe('outcome_unknown');
    });

    it('keeps an unknown create unresolved when replacement occurs during provider proof', async () => {
      listOwnTimeEntryIdsInRange.mockResolvedValueOnce({ ids: [], complete: true });
      createTimeEntry.mockRejectedValue(dispatchedTimeout());
      await service.createTimeEntry(
        projectId,
        'clickup',
        'task-1',
        createInput,
        'op-1',
        4,
        remoteScopeKey,
      );
      listOwnTimeEntryIdsInRange.mockImplementation(async () => {
        storage.getIntegrationConnection.mockResolvedValue({ ...connection, generation: 5 });
        return { ids: [], complete: true };
      });

      await expect(service.verifyOperation(projectId, 'clickup', 'op-1', 4)).rejects.toMatchObject({
        code: 'conflict',
        details: { reason: 'connection_superseded' },
      });

      expect(listOwnTimeEntryIdsInRange).toHaveBeenCalledTimes(2);
      expect(store.get('op-1')?.phase).toBe('outcome_unknown');
    });

    it('keeps an unknown delete unresolved when replacement occurs during provider proof', async () => {
      assertTimeEntryDeletable.mockResolvedValue(undefined);
      deleteTimeEntry.mockRejectedValue(dispatchedTimeout());
      await service.deleteTimeEntry(
        projectId,
        'clickup',
        'task-1',
        '9100',
        'op-1',
        4,
        remoteScopeKey,
      );
      readTimeEntryExact.mockImplementation(async () => {
        storage.getIntegrationConnection.mockResolvedValue({ ...connection, generation: 5 });
        return null;
      });

      await expect(service.verifyOperation(projectId, 'clickup', 'op-1', 4)).rejects.toMatchObject({
        code: 'conflict',
        details: { reason: 'connection_superseded' },
      });

      expect(readTimeEntryExact).toHaveBeenCalledTimes(1);
      expect(store.get('op-1')?.phase).toBe('outcome_unknown');
    });

    it('reports an already-terminal receipt without provider calls', async () => {
      assertTimeEntryDeletable.mockResolvedValue(undefined);
      deleteTimeEntry.mockResolvedValue(undefined);
      await service.deleteTimeEntry(
        projectId,
        'clickup',
        'task-1',
        '9100',
        'op-1',
        4,
        remoteScopeKey,
      );

      const verified = await service.verifyOperation(projectId, 'clickup', 'op-1', 4);

      expect(verified.resolution).toBe('already_terminal');
      expect(readTimeEntryExact).not.toHaveBeenCalled();
    });

    it('returns completeness_not_provable for an unsupported create before credentials load', async () => {
      listOwnTimeEntryIdsInRange.mockResolvedValue({ ids: [], complete: false });
      createTimeEntry.mockRejectedValue(dispatchedTimeout());

      const created = await service.createTimeEntry(
        projectId,
        'clickup',
        'task-1',
        createInput,
        'op-1',
        4,
        remoteScopeKey,
      );

      expect(created.outcome).toBe('outcome_unknown');
      if (created.outcome === 'outcome_unknown') {
        expect(created.receipt.canVerify).toBe(false);
      }

      const verified = await service.verifyOperation(projectId, 'clickup', 'op-1', 4);

      expect(verified.resolved).toBe(false);
      expect(verified.resolution).toBe('completeness_not_provable');
      expect(verified.receipt.phase).toBe('outcome_unknown');
      expect(verified.receipt.canVerify).toBe(false);
      expect(storage.getIntegrationConnectionCredentialsById).not.toHaveBeenCalled();
      expect(listOwnTimeEntryIdsInRange).toHaveBeenCalledTimes(1);
      expect(readTimeEntryExact).not.toHaveBeenCalled();
    });

    it('still reports already_terminal when the receipt settles inside the gate', async () => {
      listOwnTimeEntryIdsInRange.mockResolvedValue({ ids: [], complete: false });
      createTimeEntry.mockRejectedValue(dispatchedTimeout());
      await service.createTimeEntry(
        projectId,
        'clickup',
        'task-1',
        createInput,
        'op-1',
        4,
        remoteScopeKey,
      );

      storage.getIntegrationConnection
        .mockResolvedValueOnce(connection)
        .mockImplementationOnce(async () => {
          store.acknowledgeUnknown('op-1');
          return connection;
        });

      const verified = await service.verifyOperation(projectId, 'clickup', 'op-1', 4);

      expect(verified.resolution).toBe('already_terminal');
      expect(storage.getIntegrationConnectionCredentialsById).not.toHaveBeenCalled();
      expect(listOwnTimeEntryIdsInRange).toHaveBeenCalledTimes(1);
    });

    it('advertises canVerify for a complete-baseline create and unknown deletes', async () => {
      const jiraCredentials = {
        provider: 'jira' as const,
        siteUrl: 'https://acme.atlassian.net',
        email: 'dev@acme.test',
        token: 'secret-token',
      };
      storage.getIntegrationConnectionCredentials.mockImplementation(async (identity) =>
        typeof identity !== 'string' && 'provider' in identity && identity.provider === 'jira'
          ? jiraCredentials
          : { provider: 'clickup' as const, token: 'secret-token' },
      );
      storage.getIntegrationConnectionCredentialsById.mockResolvedValue(jiraCredentials);
      listOwnTimeEntryIdsInRange.mockResolvedValue({ ids: [], complete: true });
      createTimeEntry.mockRejectedValue(dispatchedTimeout());

      const created = await service.createTimeEntry(
        projectId,
        'jira',
        'task-1',
        createInput,
        'op-1',
        4,
        remoteScopeKey,
      );

      expect(created.outcome).toBe('outcome_unknown');
      if (created.outcome === 'outcome_unknown') {
        expect(created.receipt.canVerify).toBe(true);
      }
      expect(service.inspectOperation('op-1')?.canVerify).toBe(true);

      assertTimeEntryDeletable.mockResolvedValue(undefined);
      deleteTimeEntry.mockRejectedValue(dispatchedTimeout());
      const deleted = await service.deleteTimeEntry(
        projectId,
        'clickup',
        'task-1',
        '9100',
        'op-2',
        4,
        remoteScopeKey,
      );

      expect(deleted.outcome).toBe('outcome_unknown');
      if (deleted.outcome === 'outcome_unknown') {
        expect(deleted.receipt.canVerify).toBe(true);
      }
    });
  });

  describe('acknowledge and read', () => {
    it('cannot acknowledge after the real receipt TTL removes the server receipt', async () => {
      // The store clock is injected because the default captures Date.now by
      // reference; the TTL itself is the real production constant.
      let now = 1_756_000_000_000;
      const ttlStore = new ExternalTimeMutationStore(
        32,
        256,
        TIME_OPERATION_RECEIPT_TTL_MS,
        () => now,
      );
      const clickupProvider: ExternalTaskProvider = {
        provider: 'clickup',
        descriptor: {
          provider: 'clickup',
          displayName: 'ClickUp',
          capabilities: { myWork: false },
        },
        verifyCredentials: jest.fn(),
        timeEntryMutations: {
          createTimeEntry,
          deleteTimeEntry,
          readTimeEntryExact,
          listOwnTimeEntryIdsInRange,
          assertTimeEntryDeletable,
        },
      };
      const ttlService = new ExternalTimeMutationService(
        storage as unknown as StorageService,
        new ExternalTaskProviderRegistry([clickupProvider]),
        gate,
        ttlStore,
      );
      listOwnTimeEntryIdsInRange.mockResolvedValue({ ids: [], complete: false });
      createTimeEntry.mockRejectedValue(dispatchedTimeout());
      const unknown = await ttlService.createTimeEntry(
        projectId,
        'clickup',
        'task-1',
        createInput,
        'op-expired',
        4,
        remoteScopeKey,
      );
      expect(unknown.outcome).toBe('outcome_unknown');

      now += TIME_OPERATION_RECEIPT_TTL_MS + 1;
      await expect(
        ttlService.acknowledgeOperation(projectId, 'clickup', 'op-expired', 4),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it('transitions a live unknown receipt to abandoned_unknown', async () => {
      listOwnTimeEntryIdsInRange.mockResolvedValue({ ids: [], complete: false });
      createTimeEntry.mockRejectedValue(dispatchedTimeout());
      await service.createTimeEntry(
        projectId,
        'clickup',
        'task-1',
        createInput,
        'op-1',
        4,
        remoteScopeKey,
      );

      const acked = await service.acknowledgeOperation(projectId, 'clickup', 'op-1', 4);

      expect(acked.phase).toBe('abandoned_unknown');
      await expect(
        service.acknowledgeOperation(projectId, 'clickup', 'op-1', 4),
      ).rejects.toBeInstanceOf(ConflictError);
    });

    it('does not acknowledge an unknown receipt while exact verification is in flight', async () => {
      let releaseProof!: (value: { ids: string[]; complete: boolean }) => void;
      let markProofStarted!: () => void;
      const proofStarted = new Promise<void>((resolve) => {
        markProofStarted = resolve;
      });
      const proof = new Promise<{ ids: string[]; complete: boolean }>((resolve) => {
        releaseProof = resolve;
      });
      listOwnTimeEntryIdsInRange
        .mockResolvedValueOnce({ ids: [], complete: true })
        .mockImplementationOnce(() => {
          markProofStarted();
          return proof;
        });
      createTimeEntry.mockRejectedValue(dispatchedTimeout());
      readTimeEntryExact.mockResolvedValue({
        remoteId: '9100',
        startedAt: createInput.startedAt,
        durationMs: createInput.durationMs,
        owned: true,
      });
      await service.createTimeEntry(
        projectId,
        'clickup',
        'task-1',
        createInput,
        'op-1',
        4,
        remoteScopeKey,
      );

      const verification = service.verifyOperation(projectId, 'clickup', 'op-1', 4);
      await proofStarted;

      await expect(
        service.acknowledgeOperation(projectId, 'clickup', 'op-1', 4),
      ).rejects.toMatchObject<BusyError>({ details: { reason: 'operation_in_progress' } });
      expect(store.get('op-1')?.phase).toBe('outcome_unknown');

      releaseProof({ ids: ['9100'], complete: true });
      await expect(verification).resolves.toMatchObject({
        resolved: true,
        resolution: 'created',
        receipt: { phase: 'succeeded' },
      });
    });

    it('reads a receipt only for its own provider', async () => {
      listOwnTimeEntryIdsInRange.mockResolvedValue({ ids: [], complete: false });
      createTimeEntry.mockRejectedValue(dispatchedTimeout());
      await service.createTimeEntry(
        projectId,
        'clickup',
        'task-1',
        createInput,
        'op-1',
        4,
        remoteScopeKey,
      );

      await expect(service.getOperation(projectId, 'jira', 'op-1', 4)).rejects.toBeInstanceOf(
        NotFoundError,
      );
      await expect(service.getOperation(projectId, 'clickup', 'op-1', 4)).resolves.toMatchObject({
        operationId: 'op-1',
        phase: 'outcome_unknown',
      });
    });

    it('rejects a same-provider receipt from another project connection', async () => {
      listOwnTimeEntryIdsInRange.mockResolvedValue({ ids: [], complete: true });
      createTimeEntry.mockResolvedValue({ remoteEntryId: '9100' });
      await service.createTimeEntry(
        projectId,
        'clickup',
        'task-1',
        createInput,
        'op-1',
        4,
        remoteScopeKey,
      );
      storage.getIntegrationConnection.mockResolvedValue({
        ...connection,
        id: 'project-2-clickup',
        projectId: 'project-2',
      });

      await expect(
        service.getOperation('project-2', 'clickup', 'op-1', 4),
      ).rejects.toMatchObject<ConflictError>({
        details: { reason: 'connection_superseded' },
      });
      await expect(
        service.acknowledgeOperation('project-2', 'clickup', 'op-1', 4),
      ).rejects.toMatchObject<ConflictError>({
        details: { reason: 'connection_superseded' },
      });
    });
  });
});
