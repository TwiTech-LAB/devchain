/**
 * The claimed VM's import and unlink routes: what they refuse before storage, and the
 * epic.created event they announce after commit.
 * Test layer: unit, with fake storage, events and integration cache.
 */
import { ConflictError, NotFoundError } from '../../../common/errors/error-types';
import { HostService } from './host.service';

const body = {
  idempotencyKey: 'import:jira:acme:ENG-1',
  epic: { statusId: 'status-1', title: 'Imported', description: null },
  link: {
    connectionId: 'connection-1',
    connectionGeneration: 1,
    provider: 'jira' as const,
    remoteScopeKey: 'acme',
    remoteTaskId: 'ENG-1',
    sourceSnapshot: {},
  },
};

function setup(claimed = true) {
  const storage = {
    getStatus: jest.fn(async () => ({ id: 'status-1', projectId: 'P', label: 'New' })),
    getEpic: jest.fn(async () => ({ id: 'epic-1', projectId: 'P', version: 4 })),
    updateEpic: jest.fn(async (_id: string, _data: unknown, _version: number, factory) =>
      factory({ id: 'epic-1', projectId: 'P', parentId: null, version: 5, title: 'Epic' }),
    ),
    runInTransaction: jest.fn((fn: () => Promise<unknown>) => fn()),
    importHostedExternalTask: jest.fn(),
    deleteExternalTaskLink: jest.fn(async () => ({
      link: { id: 'link-1', sourceSnapshot: { remoteKey: 'ENG-1' } },
    })),
  };
  const events = {
    prepareCommitted: jest.fn((name: string, payload: unknown) => ({ name, payload })),
    emitCommitted: jest.fn(),
  };
  const none = {} as never;
  const service = new HostService(
    none,
    none,
    none,
    storage as never,
    none,
    none,
    none,
    none,
    none,
    { isClaimedHost: () => claimed } as never,
    events as never,
  );
  return { service, storage, events };
}

describe('HostService external task routes', () => {
  it('refuses both writes with HOST_NOT_CLAIMED on an instance that is not a claimed VM', async () => {
    const { service, storage } = setup(false);

    for (const write of [
      () => service.importExternalTask('P', body),
      () => service.unlinkExternalTask('P', 'epic-1', 'link-1'),
    ]) {
      const error: unknown = await write().catch((e) => e);
      expect(error).toBeInstanceOf(ConflictError);
      expect((error as ConflictError).details).toMatchObject({ code: 'HOST_NOT_CLAIMED' });
    }
    expect(storage.importHostedExternalTask).not.toHaveBeenCalled();
    expect(storage.deleteExternalTaskLink).not.toHaveBeenCalled();
  });

  it('refuses a status or epic of another project as not found', async () => {
    const { service, storage } = setup();

    await expect(service.importExternalTask('Q', body)).rejects.toBeInstanceOf(NotFoundError);
    await expect(service.unlinkExternalTask('Q', 'epic-1', 'link-1')).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(storage.importHostedExternalTask).not.toHaveBeenCalled();
    expect(storage.deleteExternalTaskLink).not.toHaveBeenCalled();
  });

  it('announces epic.created after commit only for an epic the import created', async () => {
    const { service, storage, events } = setup();
    storage.importHostedExternalTask.mockImplementation(async (_data, factory) => {
      factory({ id: 'epic-9', projectId: 'P', title: 'Imported', statusId: 'status-1' });
      return { epicId: 'epic-9', link: { id: 'link-9' }, created: true };
    });

    const created = await service.importExternalTask('P', body);
    storage.importHostedExternalTask.mockResolvedValue({
      epicId: 'epic-9',
      link: { id: 'link-9' },
      created: false,
    });
    const existing = await service.importExternalTask('P', body);

    expect([created, existing]).toEqual([
      { epicId: 'epic-9', linkId: 'link-9', created: true },
      { epicId: 'epic-9', linkId: 'link-9', created: false },
    ]);
    expect(storage.importHostedExternalTask).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: body.idempotencyKey,
        epic: expect.objectContaining({
          projectId: 'P',
          data: { idempotencyKey: body.idempotencyKey },
        }),
      }),
      expect.any(Function),
    );
    expect(events.emitCommitted).toHaveBeenCalledTimes(1);
    expect(events.emitCommitted).toHaveBeenCalledWith({
      name: 'epic.created',
      payload: expect.objectContaining({ epicId: 'epic-9', projectId: 'P', statusName: 'New' }),
    });
  });

  it('removes the exact link as a VM write and advances the epic version in the same transaction', async () => {
    const { service, storage, events } = setup();
    let inTransaction = false;
    storage.runInTransaction.mockImplementation(async (fn: () => Promise<unknown>) => {
      inTransaction = true;
      try {
        return await fn();
      } finally {
        inTransaction = false;
      }
    });
    const seen: boolean[] = [];
    storage.deleteExternalTaskLink.mockImplementation(async () => {
      seen.push(inTransaction);
      return { link: { id: 'link-1', sourceSnapshot: { remoteKey: 'ENG-1' } } };
    });

    await service.unlinkExternalTask('P', 'epic-1', 'link-1');

    expect(storage.deleteExternalTaskLink).toHaveBeenCalledWith('epic-1', 'link-1', undefined, {
      vmHosted: true,
    });
    expect(storage.updateEpic).toHaveBeenCalledWith('epic-1', {}, 4, expect.any(Function));
    expect(seen).toEqual([true]);
    expect(events.emitCommitted).toHaveBeenCalledWith({
      name: 'epic.updated',
      payload: expect.objectContaining({
        epicId: 'epic-1',
        version: 5,
        changes: { externalTask: { previous: 'link-1', current: null, previousKey: 'ENG-1' } },
      }),
    });
  });

  it('leaves the version alone and announces nothing when the exact link is refused', async () => {
    const { service, storage, events } = setup();
    storage.deleteExternalTaskLink.mockRejectedValue(new ConflictError('stale'));

    await expect(service.unlinkExternalTask('P', 'epic-1', 'link-1')).rejects.toThrow('stale');

    expect(storage.updateEpic).not.toHaveBeenCalled();
    expect(events.emitCommitted).not.toHaveBeenCalled();
  });
});
