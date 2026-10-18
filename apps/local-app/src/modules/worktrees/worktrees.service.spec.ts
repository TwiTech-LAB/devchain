import { WorktreeAdmissionService } from './worktree-admission.service';
import { FileSyncService } from '../file-sync/file-sync.service';
import { FakeFileSyncService } from '../file-sync/testing/fake-file-sync.service';
import { GitCoordinatorService } from '../remotes/git-coordinator/git-coordinator.service';
// Mocked external boundaries are the cheapest layer for authorization and input rejection.
import { Test } from '@nestjs/testing';
import { createMockProject } from '../../../test/factories/project';
import { createMockEpic } from '../../../test/factories/epic';
import { ProjectWriteGate } from '../storage/write-gate/project-write-gate';
import { STORAGE_SERVICE } from '../storage/interfaces/storage.interface';
import { TeamsStore } from '../teams/storage/teams.store';
import { FakeProcessExecutor } from '../terminal/services/process-executor/fake-process-executor';
import { ProcessExecutor } from '../terminal/services/process-executor/process-executor.port';
import { ProjectGitMutex } from './project-git-mutex';
import { WorktreeGitRunner } from './worktree-git-runner';
import { WorktreesService } from './worktrees.service';

describe('WorktreesService admission', () => {
  let service: WorktreesService;
  let gate: ProjectWriteGate;
  let files: FakeFileSyncService;
  let teams: { getTeamLeadTeams: jest.Mock };
  let storage: { getProject: jest.Mock; listWorktrees: jest.Mock; getEpic: jest.Mock };
  const project = createMockProject();

  beforeEach(async () => {
    files = new FakeFileSyncService();
    teams = { getTeamLeadTeams: jest.fn().mockResolvedValue([{ projectId: project.id }]) };
    storage = {
      getProject: jest.fn().mockResolvedValue(project),
      listWorktrees: jest.fn().mockResolvedValue([]),
      getEpic: jest.fn(),
    };
    const module = await Test.createTestingModule({
      providers: [
        WorktreesService,
        WorktreeAdmissionService,
        { provide: FileSyncService, useValue: files },
        { provide: GitCoordinatorService, useValue: {} },
        ProjectGitMutex,
        ProjectWriteGate,
        WorktreeGitRunner,
        { provide: TeamsStore, useValue: teams },
        { provide: STORAGE_SERVICE, useValue: storage },
        { provide: ProcessExecutor, useValue: new FakeProcessExecutor() },
      ],
    }).compile();
    service = module.get(WorktreesService);
    gate = module.get(ProjectWriteGate);
  });

  it.each(['create', 'list', 'remove', 'commit', 'merge'] as const)(
    'refuses %s from a lead of another project',
    async (operation) => {
      teams.getTeamLeadTeams.mockResolvedValue([{ projectId: 'another-project' }]);
      const operations = {
        create: () => service.create(project.id, 'agent'),
        list: () => service.list(project.id, 'agent'),
        remove: () => service.remove(project.id, 'agent', 'lane'),
        commit: () => service.commit(project.id, 'agent', 'lane', 'message'),
        merge: () => service.merge(project.id, 'agent', 'lane', 'a'.repeat(40)),
      };
      await expect(operations[operation]()).rejects.toMatchObject({
        code: 'FORBIDDEN_NOT_TEAM_LEAD',
      });
    },
  );

  it('checks frozen admission before lead authorization', async () => {
    gate.markFrozen(project.id, '2026-10-11T00:00:00Z');
    teams.getTeamLeadTeams.mockResolvedValue([]);
    await expect(service.create(project.id, 'agent')).rejects.toMatchObject({
      code: 'PROJECT_FROZEN',
    });
  });

  it.each(['create', 'commit', 'merge', 'remove'] as const)(
    'fails %s closed when Syncthing is unreachable',
    async (operation) => {
      jest.spyOn(files, 'folderConfiguration').mockRejectedValue(new Error('unreachable'));
      const calls = {
        create: () => service.create(project.id, 'agent'),
        commit: () => service.commit(project.id, 'agent', 'lane', 'message'),
        merge: () => service.merge(project.id, 'agent', 'lane', 'a'.repeat(40)),
        remove: () => service.remove(project.id, 'agent', 'lane'),
      };
      await expect(calls[operation]()).rejects.toMatchObject({ code: 'GIT_OWNERSHIP_UNKNOWN' });
      expect(storage.listWorktrees).not.toHaveBeenCalled();
    },
  );

  it.each(['', 'Uppercase', '../escape', 'a'.repeat(41)])(
    'rejects invalid lane name %s',
    async (name) => {
      await expect(service.create(project.id, 'agent', { name })).rejects.toMatchObject({
        code: 'WORKTREE_INVALID_NAME',
      });
    },
  );

  it('rejects an epic from another project', async () => {
    storage.getEpic.mockResolvedValue(createMockEpic({ projectId: 'other' }));
    await expect(service.create(project.id, 'agent', { epicId: 'epic' })).rejects.toMatchObject({
      code: 'WORKTREE_INVALID_EPIC',
    });
  });
});
