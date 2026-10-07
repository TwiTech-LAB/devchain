import type { ProjectWorkspace } from '../../src/ui/pages/projects/lib/project-contracts';
import { InMemoryProjectsPageApi } from './in-memory-projects-page-api';

function workspace(
  id: string,
  position: number,
  options: Partial<ProjectWorkspace> = {},
): ProjectWorkspace {
  return {
    id,
    name: id === 'default' ? 'Default' : id,
    isDefault: id === 'default',
    position,
    projectCount: 0,
    deviceGrantCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...options,
  };
}

describe('InMemoryProjectsPageApi workspaces', () => {
  it('creates, renames, and persists an exact complete order', async () => {
    const api = new InMemoryProjectsPageApi({ workspaces: [workspace('default', 0)] });

    const created = await api.createWorkspace('Labs');
    await api.renameWorkspace(created.id, 'Research');
    const reordered = await api.reorderWorkspaces([created.id, 'default']);

    expect(reordered.map(({ id, name, position }) => ({ id, name, position }))).toEqual([
      { id: created.id, name: 'Research', position: 0 },
      { id: 'default', name: 'Default', position: 1 },
    ]);
    await expect(api.reorderWorkspaces(['default'])).rejects.toThrow(
      'every workspace exactly once',
    );
  });

  it('protects Default and moves projects and grant counts to a distinct replacement', async () => {
    const api = new InMemoryProjectsPageApi({
      workspaces: [
        workspace('default', 0, { projectCount: 1, deviceGrantCount: 1 }),
        workspace('labs', 1, { projectCount: 1, deviceGrantCount: 3 }),
      ],
      projects: {
        items: [
          {
            id: 'project',
            workspaceId: 'labs',
            name: 'Project',
            description: null,
            rootPath: '/project',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      },
      deviceGrantDeviceIds: {
        default: ['shared-device'],
        labs: ['shared-device', 'labs-device-a', 'labs-device-b'],
      },
    });

    await expect(api.deleteWorkspace('default', 'labs')).rejects.toThrow(
      'Default workspace cannot be deleted',
    );
    await expect(api.deleteWorkspace('labs', 'labs')).rejects.toThrow(
      'Replacement must be different',
    );
    await expect(api.deleteWorkspace('labs', 'default')).resolves.toEqual({
      movedProjectCount: 1,
      remappedDeviceGrantCount: 3,
    });
    await expect(api.listProjects()).resolves.toEqual(
      expect.objectContaining({
        items: [expect.objectContaining({ id: 'project', workspaceId: 'default' })],
      }),
    );
    await expect(api.listWorkspaces()).resolves.toEqual([
      expect.objectContaining({
        id: 'default',
        projectCount: 2,
        deviceGrantCount: 3,
      }),
    ]);
  });

  it('updates project and workspace state through the dedicated move payload', async () => {
    const api = new InMemoryProjectsPageApi({
      projects: {
        items: [
          {
            id: 'project',
            workspaceId: 'default',
            name: 'Project',
            description: null,
            rootPath: '/project',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      },
      workspaces: [
        workspace('default', 0, { projectCount: 1 }),
        workspace('labs', 1, { projectCount: 0 }),
      ],
    });

    await api.updateProject('project', { workspaceId: 'labs' });

    expect(api.calls.updateProject).toEqual([['project', { workspaceId: 'labs' }]]);
    await expect(api.listWorkspaces()).resolves.toEqual([
      expect.objectContaining({ id: 'default', projectCount: 0 }),
      expect.objectContaining({ id: 'labs', projectCount: 1 }),
    ]);
  });
});
