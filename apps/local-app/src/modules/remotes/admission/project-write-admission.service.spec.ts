import {
  NotFoundError,
  ProjectFrozenError,
  ProjectRemoteError,
} from '../../../common/errors/error-types';
import type { RemoteProjectBinding, RemoteBindingState } from '../../storage/models/domain.models';
import type { ProjectFreezeService } from '../host/project-freeze.service';
import { ProjectWriteAdmissionService } from './project-write-admission.service';

function binding(
  projectId: string,
  state: RemoteBindingState,
  remoteId = 'remote-1',
): RemoteProjectBinding {
  return {
    projectId,
    remoteId,
    state,
    hostCursor: null,
    createdAt: '2026-09-22T00:00:00.000Z',
    updatedAt: '2026-09-22T00:00:00.000Z',
  };
}

describe('ProjectWriteAdmissionService', () => {
  let bindings: RemoteProjectBinding[];
  let frozen: Set<string>;
  let storage: { listRemoteProjectBindings: jest.Mock; getRemote: jest.Mock };
  let service: ProjectWriteAdmissionService;

  beforeEach(async () => {
    bindings = [];
    frozen = new Set();
    storage = {
      listRemoteProjectBindings: jest.fn(async () => bindings),
      getRemote: jest.fn(async (id: string) => ({ id, name: `vm-${id}` })),
    };
    const freeze = {
      isFrozen: (projectId: string) => frozen.has(projectId),
      frozenProjectIds: () => [...frozen],
      assertWritable: (projectId: string) => {
        if (frozen.has(projectId)) throw new ProjectFrozenError(projectId);
      },
    } as unknown as ProjectFreezeService;
    service = new ProjectWriteAdmissionService(storage as never, freeze);
    await service.onModuleInit();
  });

  it('admits writes to unbound projects and global rows', () => {
    expect(() => service.assertWritable('project-1')).not.toThrow();
    expect(() => service.assertWritable(null)).not.toThrow();
    expect(service.isWritable('project-1')).toBe(true);
  });

  it.each(['attaching', 'remote', 'detaching'] as const)(
    'refuses a project in binding state %s with PROJECT_REMOTE naming the remote',
    async (state) => {
      bindings = [binding('project-1', state)];
      await service.refreshBindings();

      let thrown: unknown;
      try {
        service.assertWritable('project-1');
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(ProjectRemoteError);
      expect(thrown).toMatchObject({
        statusCode: 423,
        code: 'PROJECT_REMOTE',
        details: { projectId: 'project-1', remoteId: 'remote-1', remoteName: 'vm-remote-1' },
      });
      expect(service.isWritable('project-1')).toBe(false);
      expect(service.getRemoteOwner('project-1')).toMatchObject({
        state,
        remoteName: 'vm-remote-1',
      });
    },
  );

  it('treats a failed attach as home-owned', async () => {
    bindings = [binding('project-1', 'failed')];
    await service.refreshBindings();

    expect(() => service.assertWritable('project-1')).not.toThrow();
    expect(service.getRemoteOwner('project-1')).toBeNull();
  });

  it('refuses a frozen project with PROJECT_FROZEN', () => {
    frozen.add('project-1');

    expect(() => service.assertWritable('project-1')).toThrow(ProjectFrozenError);
    expect(service.isWritable('project-1')).toBe(false);
  });

  it('names the remote when a remote-owned project is also frozen', async () => {
    frozen.add('project-1');
    bindings = [binding('project-1', 'remote')];
    await service.refreshBindings();

    expect(() => service.assertWritable('project-1')).toThrow(ProjectRemoteError);
    expect(service.listNonWritableProjectIds()).toEqual(['project-1']);
  });

  it('admits the project again once a refresh drops its binding', async () => {
    bindings = [binding('project-1', 'remote')];
    await service.refreshBindings();
    bindings = [];
    await service.refreshBindings();

    expect(() => service.assertWritable('project-1')).not.toThrow();
  });

  it('reads each remote name once and tolerates a missing remote', async () => {
    storage.getRemote.mockImplementation(async (id: string) => {
      if (id === 'gone') throw new NotFoundError('Remote', id);
      return { id, name: `vm-${id}` };
    });
    bindings = [
      binding('project-1', 'remote'),
      binding('project-2', 'remote'),
      binding('project-3', 'remote', 'gone'),
    ];
    await service.refreshBindings();

    expect(storage.getRemote).toHaveBeenCalledTimes(2);
    expect(service.getRemoteOwner('project-3')).toMatchObject({
      remoteId: 'gone',
      remoteName: null,
    });
    expect(() => service.assertWritable('project-3')).toThrow('connected to a remote');
  });
});
