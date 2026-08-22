import { BusyError, ConflictError, NotFoundError } from '../../../common/errors/error-types';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import { ClickUpProviderError } from '../errors/external-provider.errors';
import { ExternalTaskProviderRegistry } from '../external-task-provider.registry';
import type { ExternalTaskProvider } from '../ports/external-task-provider';
import { ExternalTimeMutationStore } from '../sessions/external-time-mutation.store';
import { ProviderOperationGate } from '../sessions/provider-operation-gate';
import { ExternalTimeMutationService } from './external-time-mutation.service';

const credentials = { provider: 'clickup' as const, token: 'secret-token' };
const connection = {
  id: 'connection-clickup',
  provider: 'clickup' as const,
  generation: 4,
  createdAt: '2026-08-19T10:00:00.000Z',
  updatedAt: '2026-08-19T11:00:00.000Z',
};
const createInput = {
  startedAt: '2026-08-19T10:00:00.000Z',
  durationMs: 3_600_000,
  note: 'Implementation',
};
const dispatchedTimeout = () => new ClickUpProviderError('timeout', undefined, true);

describe('ExternalTimeMutationService', () => {
  let storage: jest.Mocked<
    Pick<StorageService, 'getIntegrationConnection' | 'getIntegrationConnectionCredentials'>
  >;
  let gate: ProviderOperationGate;
  let store: ExternalTimeMutationStore;
  let service: ExternalTimeMutationService;
  let createTimeEntry: jest.Mock;
  let deleteTimeEntry: jest.Mock;
  let readTimeEntryExact: jest.Mock;
  let listOwnTimeEntryIdsInRange: jest.Mock;
  let assertTimeEntryDeletable: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    storage = {
      getIntegrationConnection: jest
        .fn()
        .mockImplementation(async (provider: string) =>
          provider === 'clickup'
            ? connection
            : { ...connection, id: 'connection-jira', provider: 'jira' as const },
        ),
      getIntegrationConnectionCredentials: jest.fn().mockResolvedValue(credentials),
    };
    gate = new ProviderOperationGate();
    store = new ExternalTimeMutationStore();
    createTimeEntry = jest.fn();
    deleteTimeEntry = jest.fn();
    readTimeEntryExact = jest.fn();
    listOwnTimeEntryIdsInRange = jest.fn();
    assertTimeEntryDeletable = jest.fn();
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
        deleteTimeEntry,
        readTimeEntryExact,
        listOwnTimeEntryIdsInRange,
        assertTimeEntryDeletable,
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
    };
    service = new ExternalTimeMutationService(
      storage as unknown as StorageService,
      new ExternalTaskProviderRegistry([clickup, jira]),
      gate,
      store,
    );
  });

  describe('create', () => {
    it('stores the baseline before dispatch and returns the provider proof', async () => {
      listOwnTimeEntryIdsInRange.mockResolvedValue({ ids: ['9001'], complete: true });
      createTimeEntry.mockResolvedValue({ remoteEntryId: '9100' });

      const result = await service.createTimeEntry('clickup', 'task-1', createInput, 'op-1', 4);

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
    });

    it('validates the epoch before credentials load', async () => {
      await expect(
        service.createTimeEntry('clickup', 'task-1', createInput, 'op-1', 3),
      ).rejects.toBeInstanceOf(ConflictError);
      expect(storage.getIntegrationConnectionCredentials).not.toHaveBeenCalled();
      expect(listOwnTimeEntryIdsInRange).not.toHaveBeenCalled();
    });

    it('rechecks the epoch inside the gate and refuses to dispatch after replacement', async () => {
      storage.getIntegrationConnection
        .mockResolvedValueOnce(connection)
        .mockResolvedValueOnce({ ...connection, generation: 5 });

      await expect(
        service.createTimeEntry('clickup', 'task-1', createInput, 'op-1', 4),
      ).rejects.toMatchObject({
        code: 'conflict',
        details: { reason: 'connection_superseded' },
      });
      expect(createTimeEntry).not.toHaveBeenCalled();
    });

    it('records an unknown outcome without any retry', async () => {
      listOwnTimeEntryIdsInRange.mockResolvedValue({ ids: [], complete: true });
      createTimeEntry.mockRejectedValue(dispatchedTimeout());

      const result = await service.createTimeEntry('clickup', 'task-1', createInput, 'op-1', 4);

      expect(result.outcome).toBe('outcome_unknown');
      expect(result.receipt.phase).toBe('outcome_unknown');
      expect(createTimeEntry).toHaveBeenCalledTimes(1);
    });

    it('replays a terminal succeeded create and never re-dispatches', async () => {
      listOwnTimeEntryIdsInRange.mockResolvedValue({ ids: [], complete: true });
      createTimeEntry.mockResolvedValue({ remoteEntryId: '9100' });

      await service.createTimeEntry('clickup', 'task-1', createInput, 'op-1', 4);
      const replay = await service.createTimeEntry('clickup', 'task-1', createInput, 'op-1', 4);

      expect(replay.outcome).toBe('created');
      expect(createTimeEntry).toHaveBeenCalledTimes(1);
    });

    it('returns a confirmed null-id create without converting it to unknown', async () => {
      listOwnTimeEntryIdsInRange.mockResolvedValue({ ids: [], complete: true });
      createTimeEntry.mockResolvedValue({ remoteEntryId: null });

      const result = await service.createTimeEntry('clickup', 'task-1', createInput, 'op-1', 4);

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

      await service.createTimeEntry('clickup', 'task-1', createInput, 'op-1', 4);
      const replay = await service.createTimeEntry('clickup', 'task-1', createInput, 'op-1', 4);

      expect(replay.outcome).toBe('created');
      if (replay.outcome === 'created') {
        expect(replay.remoteEntryId).toBeNull();
      }
      expect(createTimeEntry).toHaveBeenCalledTimes(1);
    });

    it('returns the standing unknown for a retry of the same tuple', async () => {
      listOwnTimeEntryIdsInRange.mockResolvedValue({ ids: [], complete: true });
      createTimeEntry.mockRejectedValueOnce(dispatchedTimeout());

      await service.createTimeEntry('clickup', 'task-1', createInput, 'op-1', 4);
      const retry = await service.createTimeEntry('clickup', 'task-1', createInput, 'op-1', 4);

      expect(retry.outcome).toBe('outcome_unknown');
      expect(createTimeEntry).toHaveBeenCalledTimes(1);
    });

    it('conflicts on a reused operation id with a different tuple', async () => {
      listOwnTimeEntryIdsInRange.mockResolvedValue({ ids: [], complete: true });
      createTimeEntry.mockResolvedValue({ remoteEntryId: '9100' });
      await service.createTimeEntry('clickup', 'task-1', createInput, 'op-1', 4);

      await expect(
        service.createTimeEntry(
          'clickup',
          'task-1',
          { ...createInput, durationMs: 60_000 },
          'op-1',
          4,
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

      await constrained.createTimeEntry('clickup', 'task-1', createInput, 'op-1', 4);
      await expect(
        constrained.createTimeEntry('clickup', 'task-1', createInput, 'op-2', 4),
      ).rejects.toBeInstanceOf(BusyError);
    });

    it('fails busy while the provider gate is held', async () => {
      let release: () => void = () => undefined;
      const held = gate.run('clickup', () => new Promise<void>((resolve) => (release = resolve)));
      listOwnTimeEntryIdsInRange.mockResolvedValue({ ids: [], complete: true });

      const pending = service.createTimeEntry('clickup', 'task-1', createInput, 'op-1', 4);
      await expect(pending).rejects.toBeInstanceOf(BusyError);
      release();
      await held;
    });
  });

  describe('delete', () => {
    it('runs the provider preflight then one delete', async () => {
      assertTimeEntryDeletable.mockResolvedValue(undefined);
      deleteTimeEntry.mockResolvedValue(undefined);

      const result = await service.deleteTimeEntry('clickup', 'task-1', '9100', 'op-1', 4);

      expect(result.outcome).toBe('deleted');
      expect(result.receipt.phase).toBe('succeeded');
      expect(assertTimeEntryDeletable.mock.invocationCallOrder[0]).toBeLessThan(
        deleteTimeEntry.mock.invocationCallOrder[0],
      );
    });

    it('treats a classified delete 404 as already deleted', async () => {
      assertTimeEntryDeletable.mockResolvedValue(undefined);
      deleteTimeEntry.mockRejectedValue(new ClickUpProviderError('not_found'));

      const result = await service.deleteTimeEntry('clickup', 'task-1', '9100', 'op-1', 4);

      expect(result.outcome).toBe('already_deleted');
    });

    it('records an unknown delete without retry', async () => {
      assertTimeEntryDeletable.mockResolvedValue(undefined);
      deleteTimeEntry.mockRejectedValue(dispatchedTimeout());

      const result = await service.deleteTimeEntry('clickup', 'task-1', '9100', 'op-1', 4);

      expect(result.outcome).toBe('outcome_unknown');
      expect(deleteTimeEntry).toHaveBeenCalledTimes(1);
    });

    it('fails the preflight rejection without a receipt', async () => {
      assertTimeEntryDeletable.mockRejectedValue(new ClickUpProviderError('not_found'));

      await expect(
        service.deleteTimeEntry('clickup', 'task-1', '9100', 'op-1', 4),
      ).rejects.toMatchObject({ code: 'clickup_not_found' });
      expect(deleteTimeEntry).not.toHaveBeenCalled();
      await expect(service.getOperation('clickup', 'op-1', 4)).rejects.toBeInstanceOf(
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

      await service.createTimeEntry('clickup', 'task-1', createInput, 'op-1', 4);
      const verified = await service.verifyOperation('clickup', 'op-1', 4);

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

      await service.createTimeEntry('clickup', 'task-1', createInput, 'op-1', 4);
      const verified = await service.verifyOperation('clickup', 'op-1', 4);

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

      await service.createTimeEntry('clickup', 'task-1', createInput, 'op-1', 4);
      const verified = await service.verifyOperation('clickup', 'op-1', 4);

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

      await service.createTimeEntry('clickup', 'task-1', createInput, 'op-1', 4);
      const verified = await service.verifyOperation('clickup', 'op-1', 4);

      expect(verified.resolution).toBe('unresolved');
      expect(verified.receipt.phase).toBe('outcome_unknown');
    });

    it('resolves an unknown delete from the exact-resource read only', async () => {
      assertTimeEntryDeletable.mockResolvedValue(undefined);
      deleteTimeEntry.mockRejectedValue(dispatchedTimeout());

      await service.deleteTimeEntry('clickup', 'task-1', '9100', 'op-1', 4);
      readTimeEntryExact.mockResolvedValue(null);
      const verified = await service.verifyOperation('clickup', 'op-1', 4);
      expect(verified.resolution).toBe('already_deleted');
      expect(verified.receipt.phase).toBe('already_deleted');

      // A second unknown delete whose entry still exists never landed.
      await service.deleteTimeEntry('clickup', 'task-1', '9101', 'op-2', 4);
      readTimeEntryExact.mockResolvedValue({
        remoteId: '9101',
        startedAt: createInput.startedAt,
        durationMs: 60_000,
        owned: true,
      });
      const present = await service.verifyOperation('clickup', 'op-2', 4);
      expect(present.resolution).toBe('not_applied');
      expect(present.receipt.phase).toBe('not_applied');
    });

    it('keeps a delete unknown when the exact read fails', async () => {
      assertTimeEntryDeletable.mockResolvedValue(undefined);
      deleteTimeEntry.mockRejectedValue(dispatchedTimeout());
      await service.deleteTimeEntry('clickup', 'task-1', '9100', 'op-1', 4);

      readTimeEntryExact.mockRejectedValue(new Error('transport'));
      const verified = await service.verifyOperation('clickup', 'op-1', 4);

      expect(verified.resolution).toBe('verify_failed');
      expect(verified.receipt.phase).toBe('outcome_unknown');
    });

    it('refuses verification across a replaced connection', async () => {
      assertTimeEntryDeletable.mockResolvedValue(undefined);
      deleteTimeEntry.mockRejectedValue(dispatchedTimeout());
      await service.deleteTimeEntry('clickup', 'task-1', '9100', 'op-1', 4);

      storage.getIntegrationConnection.mockResolvedValue({ ...connection, generation: 5 });
      // The epoch precheck fails first against the current connection.
      await expect(service.verifyOperation('clickup', 'op-1', 4)).rejects.toBeInstanceOf(
        ConflictError,
      );
    });

    it('reports an already-terminal receipt without provider calls', async () => {
      assertTimeEntryDeletable.mockResolvedValue(undefined);
      deleteTimeEntry.mockResolvedValue(undefined);
      await service.deleteTimeEntry('clickup', 'task-1', '9100', 'op-1', 4);

      const verified = await service.verifyOperation('clickup', 'op-1', 4);

      expect(verified.resolution).toBe('already_terminal');
      expect(readTimeEntryExact).not.toHaveBeenCalled();
    });
  });

  describe('acknowledge and read', () => {
    it('transitions a live unknown receipt to abandoned_unknown', async () => {
      listOwnTimeEntryIdsInRange.mockResolvedValue({ ids: [], complete: false });
      createTimeEntry.mockRejectedValue(dispatchedTimeout());
      await service.createTimeEntry('clickup', 'task-1', createInput, 'op-1', 4);

      const acked = await service.acknowledgeOperation('clickup', 'op-1', 4);

      expect(acked.phase).toBe('abandoned_unknown');
      await expect(service.acknowledgeOperation('clickup', 'op-1', 4)).rejects.toBeInstanceOf(
        ConflictError,
      );
    });

    it('reads a receipt only for its own provider', async () => {
      listOwnTimeEntryIdsInRange.mockResolvedValue({ ids: [], complete: false });
      createTimeEntry.mockRejectedValue(dispatchedTimeout());
      await service.createTimeEntry('clickup', 'task-1', createInput, 'op-1', 4);

      await expect(service.getOperation('jira', 'op-1', 4)).rejects.toBeInstanceOf(NotFoundError);
      await expect(service.getOperation('clickup', 'op-1', 4)).resolves.toMatchObject({
        operationId: 'op-1',
        phase: 'outcome_unknown',
      });
    });
  });
});
