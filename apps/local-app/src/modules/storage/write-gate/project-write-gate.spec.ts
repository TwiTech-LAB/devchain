// Unit tests with a storage read port are the cheapest layer for synchronous
// admission, persisted-state loading and in-memory freeze updates.
import { Test, type TestingModule } from '@nestjs/testing';
import {
  NotFoundError,
  ProjectFrozenError,
  ProjectRemoteError,
} from '../../../common/errors/error-types';
import type { ProjectHostStorage, RemoteStorage } from '../interfaces/storage.interface';
import type { RemoteProjectBinding } from '../models/domain.models';
import { ProjectWriteGate } from './project-write-gate';

const frozenAt = '2026-09-22T10:00:00.000Z';

function binding(projectId: string, state: RemoteProjectBinding['state']): RemoteProjectBinding {
  return {
    projectId,
    remoteId: 'remote-1',
    state,
    hostCursor: null,
    syncError: null,
    syncFailedAt: null,
    createdAt: frozenAt,
    updatedAt: frozenAt,
  };
}

describe('ProjectWriteGate', () => {
  let module: TestingModule;
  let gate: ProjectWriteGate;
  let storage: jest.Mocked<
    Pick<RemoteStorage, 'listRemoteProjectBindings' | 'getRemote'> &
      Pick<ProjectHostStorage, 'listFrozenProjects'>
  >;

  beforeEach(async () => {
    storage = {
      listRemoteProjectBindings: jest.fn().mockResolvedValue([]),
      getRemote: jest.fn().mockResolvedValue({ id: 'remote-1', name: 'Build VM' }),
      listFrozenProjects: jest.fn().mockResolvedValue([]),
    };
    module = await Test.createTestingModule({ providers: [ProjectWriteGate] }).compile();
    gate = module.get(ProjectWriteGate);
    gate.bindStorage(storage);
  });

  afterEach(async () => {
    await module.close();
  });

  it('restores remote ownership and freezes at module initialization', async () => {
    storage.listRemoteProjectBindings.mockResolvedValue([
      binding('attaching', 'attaching'),
      binding('remote', 'remote'),
      binding('detaching', 'detaching'),
      binding('failed', 'failed'),
    ]);
    storage.listFrozenProjects.mockResolvedValue([
      { projectId: 'remote', frozenAt },
      { projectId: 'frozen', frozenAt },
    ]);

    await module.init();

    expect(gate.listRemoteOwnedProjectIds()).toEqual(['attaching', 'remote', 'detaching']);
    expect(gate.listNonWritableProjectIds()).toEqual([
      'remote',
      'frozen',
      'attaching',
      'detaching',
    ]);
    expect(gate.getRemoteOwner('remote')).toEqual({
      projectId: 'remote',
      remoteId: 'remote-1',
      remoteName: 'Build VM',
      state: 'remote',
    });
    expect(gate.getRemoteOwner('failed')).toBeNull();
    expect(gate.isWritable('failed')).toBe(true);
    expect(gate.frozenProjectIds()).toEqual(['remote', 'frozen']);
    expect(gate.getFrozenAt('frozen')).toBe(frozenAt);
    expect(() => gate.assertWritable('frozen')).toThrow(ProjectFrozenError);
    expect(gate.isWritable('frozen')).toBe(false);
  });

  it('reports remote ownership before a simultaneous freeze', async () => {
    storage.listRemoteProjectBindings.mockResolvedValue([binding('project-1', 'remote')]);
    storage.listFrozenProjects.mockResolvedValue([{ projectId: 'project-1', frozenAt }]);

    await module.init();

    expect(() => gate.assertWritable('project-1')).toThrow(
      new ProjectRemoteError('project-1', 'remote-1', 'Build VM'),
    );
    expect(gate.isWritable('project-1')).toBe(false);
  });

  it.each([null, undefined])('admits a global row with projectId %s', async (projectId) => {
    await module.init();

    expect(gate.assertWritable(projectId)).toBeUndefined();
  });

  it('refreshes bindings and names while retaining the current freeze state', async () => {
    storage.listRemoteProjectBindings.mockResolvedValue([binding('old', 'remote')]);
    await module.init();
    gate.markFrozen('held', frozenAt);
    storage.listRemoteProjectBindings.mockResolvedValue([binding('new', 'detaching')]);
    storage.getRemote.mockResolvedValue({
      ...(await storage.getRemote('remote-1')),
      name: 'Renamed VM',
    });

    await gate.refresh();

    expect(gate.getRemoteOwner('old')).toBeNull();
    expect(gate.isWritable('old')).toBe(true);
    expect(gate.getRemoteOwner('new')).toMatchObject({
      state: 'detaching',
      remoteName: 'Renamed VM',
    });
    expect(gate.listRemoteOwnedProjectIds()).toEqual(['new']);
    expect(gate.getFrozenAt('held')).toBe(frozenAt);
    expect(() => gate.assertWritable('held')).toThrow(ProjectFrozenError);
  });

  it('updates admission synchronously when marked frozen and thawed', async () => {
    await module.init();

    gate.markFrozen('project-1', frozenAt);

    expect(gate.isFrozen('project-1')).toBe(true);
    expect(gate.getFrozenAt('project-1')).toBe(frozenAt);
    expect(gate.listNonWritableProjectIds()).toEqual(['project-1']);
    expect(() => gate.assertWritable('project-1')).toThrow(new ProjectFrozenError('project-1'));

    gate.markThawed('project-1');

    expect(gate.isFrozen('project-1')).toBe(false);
    expect(gate.getFrozenAt('project-1')).toBeNull();
    expect(gate.frozenProjectIds()).toEqual([]);
    expect(gate.listNonWritableProjectIds()).toEqual([]);
    expect(gate.isWritable('project-1')).toBe(true);
  });

  it('reports whether any project is blocked by a freeze or remote ownership', async () => {
    await module.init();
    expect(gate.hasBlockedProjects()).toBe(false);

    gate.markFrozen('project-1', frozenAt);
    expect(gate.hasBlockedProjects()).toBe(true);

    gate.markThawed('project-1');
    expect(gate.hasBlockedProjects()).toBe(false);

    storage.listRemoteProjectBindings.mockResolvedValue([binding('project-2', 'remote')]);
    await gate.refresh();
    expect(gate.hasBlockedProjects()).toBe(true);
  });

  it('retains ownership when a remote row is missing', async () => {
    storage.listRemoteProjectBindings.mockResolvedValue([binding('project-1', 'remote')]);
    storage.getRemote.mockRejectedValue(new NotFoundError('Remote', 'remote-1'));

    await module.init();

    expect(gate.getRemoteOwner('project-1')).toMatchObject({ remoteName: null });
    expect(() => gate.assertWritable('project-1')).toThrow(
      new ProjectRemoteError('project-1', 'remote-1', null),
    );
  });

  it('retains the last ownership snapshot when a refresh fails', async () => {
    storage.listRemoteProjectBindings.mockResolvedValue([binding('project-1', 'remote')]);
    await module.init();
    storage.getRemote.mockRejectedValue(new Error('storage unavailable'));

    await expect(gate.refresh()).rejects.toThrow('storage unavailable');

    expect(gate.listRemoteOwnedProjectIds()).toEqual(['project-1']);
    expect(() => gate.assertWritable('project-1')).toThrow(ProjectRemoteError);
  });
});
