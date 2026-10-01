import { ProjectsService } from './projects.service';
import { PROJECT_WORKSPACE_CHANGED_EVENT } from '../events/project-workspace-changed.events';
import { createProjectWriteAdmissionStub } from '../../remotes/admission/testing/project-write-admission.stub';

describe('ProjectsService workspace-change event', () => {
  it('publishes the project move synchronously after storage commits it', async () => {
    const before = {
      id: 'project-1',
      workspaceId: 'workspace-1',
      rootPath: '/repo',
    };
    const moved = { ...before, workspaceId: 'workspace-2' };
    const storage = {
      getProject: jest.fn().mockResolvedValue(before),
      updateProject: jest.fn().mockResolvedValue(moved),
    };
    const eventEmitter = { emit: jest.fn() };
    const provisioning = { provisionProject: jest.fn() };
    const service = new ProjectsService(
      storage as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      provisioning as never,
      createProjectWriteAdmissionStub() as never,
      eventEmitter as never,
    );

    await service.updateProject('project-1', { workspaceId: 'workspace-2' });

    expect(eventEmitter.emit).toHaveBeenCalledWith(PROJECT_WORKSPACE_CHANGED_EVENT, {
      projectId: 'project-1',
      previousWorkspaceId: 'workspace-1',
      workspaceId: 'workspace-2',
    });
    expect(provisioning.provisionProject).not.toHaveBeenCalled();
  });
});
