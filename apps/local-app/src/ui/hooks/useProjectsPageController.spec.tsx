import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type {
  CreateFromTemplateResponse,
  ProjectsQueryData,
  ProjectWithStats,
  ProjectWorkspace,
  SetupPreviewResponse,
} from '@/ui/pages/projects/lib/project-contracts';
import { projectsQueryKeys } from '@/ui/pages/projects/lib/project-query-keys';
import { InMemoryProjectsPageApi } from '../../../test/helpers/in-memory-projects-page-api';
import { useProjectsPageController } from './useProjectsPageController';

const mockToast = jest.fn();
const mockNavigate = jest.fn();
const mockSetSelectedProjectId = jest.fn();
const mockActivateProject = jest.fn();
let mockSelectedProjectId: string | undefined;
let mockBindings = new Map<string, { projectId: string; remoteId: string; state: string }>();
const mockRemotes = [{ id: 'remote-1', name: 'vm-1' }];
jest.mock('@/ui/hooks/useRemotes', () => ({
  useRemotes: () => ({ bindingByProjectId: mockBindings, remotes: mockRemotes }),
}));

jest.mock('@/ui/hooks/use-toast', () => ({ useToast: () => ({ toast: mockToast }) }));
jest.mock('@/ui/hooks/useProjectSelection', () => ({
  useSelectedProject: () => ({
    selectedProjectId: mockSelectedProjectId,
    setSelectedProjectId: mockSetSelectedProjectId,
    activateProject: mockActivateProject,
  }),
}));
jest.mock('react-router-dom', () => {
  const actual = jest.requireActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

const project = (id: string, rootPath = `/work/${id}`): ProjectWithStats => ({
  id,
  workspaceId: 'default',
  name: `Project ${id}`,
  description: null,
  rootPath,
  createdAt: '2025-01-01T00:00:00.000Z',
  updatedAt: '2025-01-01T00:00:00.000Z',
});

const template = {
  slug: 'starter',
  name: 'Starter',
  source: 'bundled' as const,
  versions: null,
  latestVersion: null,
};
const registryTemplate = {
  ...template,
  source: 'registry' as const,
  versions: ['2.0.0', '1.0.0'],
  latestVersion: '2.0.0',
};

const workspace = (
  id: string,
  position: number,
  options: Partial<ProjectWorkspace> = {},
): ProjectWorkspace => ({
  id,
  name: id === 'default' ? 'Default' : id,
  isDefault: id === 'default',
  position,
  projectCount: 0,
  deviceGrantCount: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...options,
});

function emptyPreview(): SetupPreviewResponse {
  return {
    payload: {
      version: 1,
      prompts: [],
      profiles: [],
      agents: [],
      statuses: [],
      watchers: [],
      subscribers: [],
      teams: [],
      providerModels: [],
      providerEfforts: [],
      presets: [],
      scheduledEpics: [],
    },
    providerSummary: [],
    familyAlternatives: [],
    presetProviderCoverage: [],
    localAvailability: { installedProviders: [] },
  };
}

function configuredPreview(): SetupPreviewResponse {
  return {
    payload: {
      version: 1,
      prompts: [],
      profiles: [
        {
          id: 'profile-1',
          name: 'Coder Profile',
          provider: { name: 'codex' },
          providerConfigs: [{ name: 'main', providerName: 'codex' }],
        },
      ],
      agents: [
        {
          name: 'Coder',
          profileId: 'profile-1',
          isProjectOwner: false,
          providerConfigName: 'main',
        },
      ],
      statuses: [],
      watchers: [],
      subscribers: [],
      teams: [
        {
          name: 'Core',
          memberAgentNames: ['Coder'],
          allowTeamLeadCreateAgents: true,
          profileNames: ['Coder Profile'],
        },
      ],
      providerModels: [],
      providerEfforts: [],
      presets: [
        {
          name: 'balanced',
          agentConfigs: [{ agentName: 'Coder', providerConfigName: 'main' }],
        },
      ],
      scheduledEpics: [],
    },
    providerSummary: [{ name: 'codex', available: true, families: ['reasoning'], agentCount: 1 }],
    familyAlternatives: [
      {
        familySlug: 'reasoning',
        defaultProvider: 'codex',
        defaultProviderAvailable: true,
        availableProviders: ['codex'],
        hasAlternatives: true,
      },
    ],
    presetProviderCoverage: [
      {
        presetName: 'balanced',
        referencedProviders: ['codex'],
        coversAllAgents: true,
        coveredAgentNames: ['Coder'],
        agentResolvedProviders: { Coder: 'codex' },
      },
    ],
    localAvailability: { installedProviders: [{ id: 'codex', name: 'codex' }] },
  };
}

function renderController(api: InMemoryProjectsPageApi, options: { initialEntry?: string } = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <MemoryRouter initialEntries={[options.initialEntry ?? '/projects']}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </MemoryRouter>
  );
  return { ...renderHook(() => useProjectsPageController(api), { wrapper }), queryClient };
}

async function readyRows(result: ReturnType<typeof renderController>['result']) {
  await waitFor(() => expect(result.current.table.content.kind).toBe('ready'));
  if (result.current.table.content.kind !== 'ready') throw new Error('expected ready projects');
  return result.current.table.content.groups.flatMap((group) => group.rows);
}

async function submitCreate(
  result: ReturnType<typeof renderController>['result'],
  expectedSteps: number,
) {
  act(() => result.current.table.openCreate());
  await waitFor(() =>
    expect(result.current.dialogs.create.source.values.templateId).toBe('starter'),
  );
  act(() => {
    result.current.dialogs.create.source.changeName('Created');
    result.current.dialogs.create.source.changeRootPath('/work/created');
  });
  act(() => result.current.dialogs.create.source.submit());
  await waitFor(() => expect(result.current.dialogs.create.wizard.isLoading).toBe(false));
  expect(result.current.dialogs.create.wizard.open).toBe(true);
  for (let index = 1; index < expectedSteps; index += 1) {
    act(() => result.current.dialogs.create.wizard.controller.goNext());
    await waitFor(() =>
      expect(result.current.dialogs.create.wizard.controller.currentIndex).toBe(index),
    );
  }
  act(() => result.current.dialogs.create.wizard.controller.submit());
}

describe('useProjectsPageController semantic presentation', () => {
  beforeEach(() => {
    mockBindings = new Map();
    mockSelectedProjectId = undefined;
    mockToast.mockReset();
    mockNavigate.mockReset();
    mockSetSelectedProjectId.mockReset();
    mockActivateProject.mockReset();
  });

  it('returns only table and dialogs and opens a project selection before navigation', async () => {
    const api = new InMemoryProjectsPageApi({ projects: { items: [project('one')] } });
    const { result } = renderController(api);
    const [row] = await readyRows(result);

    act(() => row.open());

    expect(Object.keys(result.current)).toEqual(['table', 'dialogs']);
    expect(mockActivateProject).toHaveBeenCalledWith(project('one'));
    expect(mockNavigate).toHaveBeenCalledWith('/board');
    expect(mockActivateProject.mock.invocationCallOrder[0]).toBeLessThan(
      mockNavigate.mock.invocationCallOrder[0],
    );
  });

  it.each(['attaching', 'remote', 'detaching', 'failed'])(
    'locks rows in binding state %s from useRemotes',
    async (state) => {
      mockBindings.set('two', { projectId: 'two', remoteId: 'remote-1', state });
      const api = new InMemoryProjectsPageApi({
        projects: { items: [project('one'), project('two')] },
        remoteOwners: [
          { projectId: 'two', remoteId: 'remote-1', remoteName: 'vm-1', state: 'remote' },
        ],
      });
      const { result } = renderController(api);

      await waitFor(async () => {
        const rows = await readyRows(result);
        expect(rows.find((row) => row.id === 'two')?.remoteLock).not.toBeNull();
      });
      const rows = await readyRows(result);
      expect(rows.find((row) => row.id === 'one')?.remoteLock).toBeNull();
    },
  );

  it('optimistically updates, then closes and reports success', async () => {
    let resolveUpdate!: (value: {
      project: ProjectWithStats;
      provisioningWarnings: never[];
    }) => void;
    const pendingUpdate = new Promise<{
      project: ProjectWithStats;
      provisioningWarnings: never[];
    }>((resolve) => {
      resolveUpdate = resolve;
    });
    const api = new InMemoryProjectsPageApi({
      projects: { items: [project('one')] },
      overrides: { updateProject: () => pendingUpdate },
    });
    const { result, queryClient } = renderController(api);
    const [row] = await readyRows(result);
    act(() => row.edit());
    act(() => result.current.dialogs.edit.changeName('Renamed'));
    act(() => result.current.dialogs.edit.submit());

    await waitFor(() =>
      expect(
        queryClient.getQueryData<{ items: ProjectWithStats[] }>(projectsQueryKeys.list())?.items[0]
          .name,
      ).toBe('Renamed'),
    );
    await act(async () => {
      resolveUpdate({ project: { ...project('one'), name: 'Renamed' }, provisioningWarnings: [] });
      await pendingUpdate;
    });
    await waitFor(() => expect(result.current.dialogs.edit.open).toBe(false));
    expect(api.calls.updateProject[0]).toEqual([
      'one',
      expect.objectContaining({ name: 'Renamed' }),
    ]);
    expect(mockToast).toHaveBeenCalledWith({
      title: 'Success',
      description: 'Project updated successfully',
    });
  });

  it('rolls an update back and keeps the editor open on error', async () => {
    const api = new InMemoryProjectsPageApi({
      projects: { items: [project('one')] },
      overrides: { updateProject: new Error('Update unavailable') },
    });
    const { result, queryClient } = renderController(api);
    const [row] = await readyRows(result);
    act(() => row.edit());
    act(() => result.current.dialogs.edit.changeName('Renamed'));
    act(() => result.current.dialogs.edit.submit());

    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith({
        title: 'Error',
        description: 'Update unavailable',
        variant: 'destructive',
      }),
    );
    expect(result.current.dialogs.edit.open).toBe(true);
    expect(
      queryClient.getQueryData<{ items: ProjectWithStats[] }>(projectsQueryKeys.list())?.items[0]
        .name,
    ).toBe('Project one');
  });

  it('preserves selection when deleting an unselected project', async () => {
    mockSelectedProjectId = 'one';
    const api = new InMemoryProjectsPageApi({
      projects: { items: [project('one'), project('two')] },
    });
    const { result } = renderController(api);
    const rows = await readyRows(result);
    act(() => rows[1].requestDelete());
    act(() => result.current.dialogs.delete.confirm());

    await waitFor(() => expect(result.current.dialogs.delete.open).toBe(false));
    expect(mockSetSelectedProjectId).not.toHaveBeenCalled();
    expect(api.calls.listProjects.length).toBeGreaterThan(1);
  });

  it('selects a replacement before refetch when deleting the selected project', async () => {
    mockSelectedProjectId = 'one';
    const api = new InMemoryProjectsPageApi({
      projects: { items: [project('one'), project('two')] },
    });
    const { result } = renderController(api);
    const rows = await readyRows(result);
    let listCallsAtSelection = 0;
    mockSetSelectedProjectId.mockImplementation(() => {
      listCallsAtSelection = api.calls.listProjects.length;
    });
    act(() => rows[0].requestDelete());
    act(() => result.current.dialogs.delete.confirm());

    await waitFor(() => expect(result.current.dialogs.delete.open).toBe(false));
    expect(mockSetSelectedProjectId).toHaveBeenCalledWith('two');
    expect(listCallsAtSelection).toBe(1);
    expect(api.calls.listProjects.length).toBeGreaterThan(1);
  });

  it('toggles the active sort and resets a newly selected field to ascending', async () => {
    const api = new InMemoryProjectsPageApi({ projects: { items: [project('one')] } });
    const { result } = renderController(api);
    await readyRows(result);
    act(() => result.current.table.toggleSort('name'));
    expect(result.current.table.sortOrder).toBe('desc');
    act(() => result.current.table.toggleSort('rootPath'));
    expect(result.current.table.sortField).toBe('rootPath');
    expect(result.current.table.sortOrder).toBe('asc');
  });

  it('temporarily derives disclosure state from search and restores saved collapses when cleared', async () => {
    const api = new InMemoryProjectsPageApi({
      projects: {
        items: [project('one'), { ...project('two'), workspaceId: 'labs' }],
      },
      workspaces: [
        workspace('default', 0, { projectCount: 1 }),
        workspace('labs', 1, { name: 'Labs', projectCount: 1 }),
      ],
    });
    const { result } = renderController(api);
    await readyRows(result);
    if (result.current.table.content.kind !== 'ready') throw new Error('expected ready projects');
    expect(result.current.table.content.groups.every((group) => group.isExpanded)).toBe(true);

    act(
      () =>
        result.current.table.content.kind === 'ready' &&
        result.current.table.content.groups[0]?.toggleExpanded(),
    );
    expect(result.current.table.content.kind).toBe('ready');
    if (result.current.table.content.kind !== 'ready') throw new Error('expected ready projects');
    expect(result.current.table.content.groups[0]?.isExpanded).toBe(false);

    act(() => result.current.table.changeSearch('Project one'));
    expect(result.current.table.content.kind).toBe('ready');
    if (result.current.table.content.kind !== 'ready') throw new Error('expected ready projects');
    expect(result.current.table.content.groups.map((group) => group.isExpanded)).toEqual([
      true,
      false,
    ]);

    act(() => result.current.table.changeSearch(''));
    expect(result.current.table.content.kind).toBe('ready');
    if (result.current.table.content.kind !== 'ready') throw new Error('expected ready projects');
    expect(result.current.table.content.groups.map((group) => group.isExpanded)).toEqual([
      false,
      true,
    ]);
  });

  it('reveals workspace controls after creating a second workspace without moving projects', async () => {
    const api = new InMemoryProjectsPageApi({
      projects: { items: [project('one')] },
      workspaces: [workspace('default', 0, { projectCount: 1 })],
      pairedDevices: [{ kid: 'kid-1', label: 'Pixel' }],
    });
    const { result } = renderController(api);
    await readyRows(result);
    if (result.current.table.content.kind !== 'ready') throw new Error('expected ready projects');
    expect(result.current.table.content.groups.map((group) => group.name)).toEqual(['Default']);

    act(() => result.current.table.openCreateWorkspace());
    await waitFor(() =>
      expect(result.current.dialogs.workspaces.create.secondWorkspaceImpact).toEqual(
        expect.objectContaining({
          isLoading: false,
          devices: [{ kid: 'kid-1', label: 'Pixel' }],
        }),
      ),
    );
    act(() => result.current.dialogs.workspaces.create.changeName('Labs'));
    act(() => result.current.dialogs.workspaces.create.submit());

    await waitFor(() => {
      expect(result.current.table.content.kind).toBe('ready');
      if (result.current.table.content.kind !== 'ready') return;
      expect(result.current.table.content.groups.map((item) => item.name)).toEqual([
        'Default',
        'Labs',
      ]);
    });
    expect(api.calls.listPairedDevices).toHaveLength(1);
    await expect(api.listProjects()).resolves.toEqual(
      expect.objectContaining({
        items: [expect.objectContaining({ id: 'one', workspaceId: 'default' })],
      }),
    );
  });

  it('keeps workspace assignment in create intents and out of Edit Project PUT bodies', async () => {
    const labs = workspace('labs', 1, { name: 'Labs' });
    const api = new InMemoryProjectsPageApi({
      projects: { items: [project('one')] },
      workspaces: [workspace('default', 0, { projectCount: 1 }), labs],
      templates: [template],
      setupPreview: emptyPreview(),
      createResult: {
        success: true,
        project: { id: 'created', name: 'Created', workspaceId: 'default' },
      },
    });
    const { result } = renderController(api);
    const [row] = await readyRows(result);

    await submitCreate(result, 2);
    await waitFor(() => expect(api.calls.createFromTemplate).toHaveLength(1));
    expect(api.calls.createFromTemplate[0][0]).toEqual(
      expect.objectContaining({ workspaceId: 'default' }),
    );
    await waitFor(() =>
      expect(mockActivateProject).toHaveBeenCalledWith({
        id: 'created',
        name: 'Created',
        workspaceId: 'default',
      }),
    );

    act(() => row.edit());
    expect(result.current.dialogs.edit.values).not.toHaveProperty('workspaceId');
    act(() => result.current.dialogs.edit.changeName('Renamed'));
    act(() => result.current.dialogs.edit.submit());
    await waitFor(() => expect(api.calls.updateProject).toHaveLength(1));
    expect(api.calls.updateProject[0]).toEqual([
      'one',
      expect.not.objectContaining({ workspaceId: expect.anything() }),
    ]);

    act(() => result.current.table.openCreateInWorkspace('labs'));
    expect(result.current.dialogs.create.source.values.workspaceId).toBe('labs');
  });

  it('routes a valid drag through move confirmation, then expands and restores focus', async () => {
    let resolveMove!: (value: { project: ProjectWithStats; provisioningWarnings: never[] }) => void;
    const pendingMove = new Promise<{
      project: ProjectWithStats;
      provisioningWarnings: never[];
    }>((resolve) => {
      resolveMove = resolve;
    });
    const labs = workspace('labs', 1, { name: 'Labs' });
    const api = new InMemoryProjectsPageApi({
      projects: { items: [project('one')] },
      workspaces: [workspace('default', 0, { projectCount: 1 }), labs],
      pairedDevices: [{ kid: 'kid-1', label: 'Pixel' }],
      overrides: { updateProject: () => pendingMove },
    });
    const { result, queryClient } = renderController(api);
    const actionsButton = document.createElement('button');
    actionsButton.id = 'project-actions-one';
    document.body.append(actionsButton);
    await readyRows(result);

    act(() => result.current.table.requestProjectMove('one', 'default'));
    expect(result.current.dialogs.move.open).toBe(false);
    expect(api.calls.updateProject).toHaveLength(0);

    act(() => {
      result.current.table.drag.start('one', 'default');
      result.current.table.drag.enterWorkspace('labs');
    });
    expect(result.current.table.drag).toMatchObject({
      projectId: 'one',
      sourceWorkspaceId: 'default',
      targetWorkspaceId: 'labs',
    });
    act(() => result.current.table.drag.dropOnWorkspace('labs'));
    expect(result.current.dialogs.move.open).toBe(true);
    expect(result.current.table.drag.projectId).toBeNull();
    expect(api.calls.updateProject).toHaveLength(0);
    await waitFor(() =>
      expect(result.current.dialogs.move.pairedDeviceImpact.devices).toEqual([
        { kid: 'kid-1', label: 'Pixel' },
      ]),
    );

    act(() => result.current.dialogs.move.confirm());
    await waitFor(() => expect(api.calls.updateProject).toHaveLength(1));
    expect(api.calls.updateProject[0]).toEqual(['one', { workspaceId: 'labs' }]);
    expect(
      queryClient.getQueryData<ProjectsQueryData>(projectsQueryKeys.list())?.items[0]?.workspaceId,
    ).toBe('labs');

    await act(async () => {
      resolveMove({
        project: { ...project('one'), workspaceId: 'labs' },
        provisioningWarnings: [],
      });
      await pendingMove;
    });
    await waitFor(() => expect(result.current.dialogs.move.open).toBe(false));
    expect(result.current.table.content.kind).toBe('ready');
    if (result.current.table.content.kind !== 'ready') throw new Error('expected ready projects');
    expect(result.current.table.content.groups.find((item) => item.id === 'labs')?.isExpanded).toBe(
      true,
    );
    expect(result.current.table.statusMessage).toBe('Project one moved to Labs.');
    expect(api.calls.listProjects.length).toBeGreaterThan(1);
    expect(api.calls.listWorkspaces.length).toBeGreaterThan(1);
    await waitFor(() => expect(actionsButton).toHaveFocus());
    actionsButton.remove();
  });

  it('clears a source-workspace drop without opening confirmation or mutating', async () => {
    const api = new InMemoryProjectsPageApi({
      projects: { items: [project('one')] },
      workspaces: [workspace('default', 0, { projectCount: 1 }), workspace('labs', 1)],
    });
    const { result } = renderController(api);
    await readyRows(result);

    act(() => result.current.table.drag.start('one', 'default'));
    expect(result.current.table.drag.projectId).toBe('one');
    act(() => result.current.table.drag.dropOnWorkspace('default'));

    expect(result.current.table.drag.projectId).toBeNull();
    expect(result.current.dialogs.move.open).toBe(false);
    expect(api.calls.updateProject).toHaveLength(0);
  });

  it('rolls a failed move back, refreshes both queries, and announces the failure', async () => {
    const api = new InMemoryProjectsPageApi({
      projects: { items: [project('one')] },
      workspaces: [workspace('default', 0, { projectCount: 1 }), workspace('labs', 1)],
      overrides: { updateProject: new Error('Move unavailable') },
    });
    const { result, queryClient } = renderController(api);
    await readyRows(result);

    act(() => result.current.table.requestProjectMove('one', 'labs'));
    act(() => {
      result.current.dialogs.move.confirm();
      result.current.dialogs.move.confirm();
    });

    await waitFor(() => expect(result.current.dialogs.move.open).toBe(false));
    expect(api.calls.updateProject).toHaveLength(1);
    expect(
      queryClient.getQueryData<ProjectsQueryData>(projectsQueryKeys.list())?.items[0]?.workspaceId,
    ).toBe('default');
    expect(result.current.table.statusMessage).toBe('Couldn’t move Project one. Move unavailable');
    expect(api.calls.listProjects.length).toBeGreaterThan(1);
    expect(api.calls.listWorkspaces.length).toBeGreaterThan(1);
  });

  it('renames and reorders by stable workspace identity, then deletes with explicit replacement', async () => {
    const api = new InMemoryProjectsPageApi({
      projects: { items: [{ ...project('one'), workspaceId: 'labs' }] },
      workspaces: [
        workspace('default', 0),
        workspace('labs', 1, {
          name: 'Labs',
          projectCount: 1,
          deviceGrantCount: 2,
        }),
      ],
    });
    const { result } = renderController(api);
    await readyRows(result);
    if (result.current.table.content.kind !== 'ready') throw new Error('expected ready projects');
    const labs = result.current.table.content.groups.find((item) => item.id === 'labs');
    act(() => labs?.rename());
    act(() => result.current.dialogs.workspaces.rename.changeName('Research'));
    act(() => result.current.dialogs.workspaces.rename.submit());
    await waitFor(() => {
      expect(result.current.table.content.kind).toBe('ready');
      if (result.current.table.content.kind !== 'ready') return;
      expect(result.current.table.content.groups[1]?.name).toBe('Research');
    });
    if (result.current.table.content.kind !== 'ready') throw new Error('expected ready projects');
    expect(result.current.table.content.groups[1]?.id).toBe('labs');

    act(() => {
      if (result.current.table.content.kind === 'ready') {
        result.current.table.content.groups[1]?.moveUp?.();
      }
    });
    await waitFor(() => expect(api.calls.reorderWorkspaces).toEqual([[['labs', 'default']]]));
    await waitFor(() => {
      expect(result.current.table.content.kind).toBe('ready');
      if (result.current.table.content.kind !== 'ready') return;
      expect(result.current.table.content.groups[0]?.id).toBe('labs');
    });

    act(() => {
      if (result.current.table.content.kind === 'ready') {
        result.current.table.content.groups.find((item) => item.id === 'labs')?.requestDelete?.();
      }
    });
    expect(result.current.dialogs.workspaces.delete.projectCount).toBe(1);
    expect(result.current.dialogs.workspaces.delete.deviceGrantCount).toBe(2);
    expect(result.current.dialogs.workspaces.delete.replacementWorkspaceId).toBe('default');
    act(() => result.current.dialogs.workspaces.delete.confirm());
    await waitFor(() => {
      expect(result.current.table.content.kind).toBe('ready');
      if (result.current.table.content.kind !== 'ready') return;
      expect(result.current.table.content.groups).toHaveLength(1);
    });
    expect(api.calls.deleteWorkspace).toEqual([['labs', 'default']]);
    await expect(api.listProjects()).resolves.toEqual(
      expect.objectContaining({
        items: [expect.objectContaining({ id: 'one', workspaceId: 'default' })],
      }),
    );
  });

  it.each([
    ['registry', undefined, [registryTemplate], 'Upgrade'],
    ['bundled', '2.0.0', [], 'Update'],
  ] as const)(
    'opens and cancels the %s upgrade through the configured wizard boundary',
    async (source, bundledUpgradeAvailable, templates, actionName) => {
      const upgradeProject: ProjectWithStats = {
        ...project('one'),
        bundledUpgradeAvailable,
        templateMetadata: { slug: 'starter', version: '1.0.0', source },
      };
      const api = new InMemoryProjectsPageApi({
        projects: { items: [upgradeProject] },
        templates: [...templates],
        upgradePreview: emptyPreview(),
      });
      const { result } = renderController(api);
      const [row] = await readyRows(result);

      act(() => row.upgrade?.());

      await waitFor(() => expect(result.current.dialogs.upgrade.wizard.open).toBe(true));
      await waitFor(() => expect(result.current.dialogs.upgrade.wizard.isLoading).toBe(false));
      expect(result.current.dialogs.upgrade.wizard.title).toBe(`${actionName} Project one`);
      expect(api.calls.loadUpgradePreview).toEqual([['one', '2.0.0']]);

      act(() => result.current.dialogs.upgrade.wizard.controller.cancel());
      await waitFor(() => expect(result.current.dialogs.upgrade.wizard.open).toBe(false));
    },
  );

  it('honors an HTTP-success path result whose exists field is false', async () => {
    const api = new InMemoryProjectsPageApi({
      projects: { items: [project('one')] },
      pathStats: { '/work/missing': { exists: false, isFile: false } },
    });
    const { result } = renderController(api);
    const [row] = await readyRows(result);
    act(() => row.edit());
    await act(async () => {
      await result.current.dialogs.edit.changeRootPath('/work/missing');
    });
    expect(result.current.dialogs.edit.pathValidation).toEqual({
      isAbsolute: true,
      exists: false,
      checked: true,
    });
  });

  it('rolls delete back, closes confirmation, and reports the current error', async () => {
    const api = new InMemoryProjectsPageApi({
      projects: { items: [project('one')] },
      overrides: { deleteProject: new Error('Delete unavailable') },
    });
    const { result, queryClient } = renderController(api);
    const [row] = await readyRows(result);
    act(() => row.requestDelete());
    act(() => result.current.dialogs.delete.confirm());

    await waitFor(() => expect(result.current.dialogs.delete.open).toBe(false));
    expect(
      queryClient.getQueryData<{ items: ProjectWithStats[] }>(projectsQueryKeys.list())?.items,
    ).toHaveLength(1);
    expect(mockToast).toHaveBeenCalledWith({
      title: 'Error',
      description: 'Delete unavailable',
      variant: 'destructive',
    });
  });

  it('waits for list success before URL creation and permits a later successful retry', async () => {
    let attempts = 0;
    const api = new InMemoryProjectsPageApi({
      overrides: {
        listProjects: () => {
          attempts += 1;
          if (attempts === 1) throw new Error('Offline');
          return { items: [] };
        },
      },
    });
    const { result } = renderController(api, {
      initialEntry: '/projects?newProjectPath=/work/new/',
    });
    await waitFor(() => expect(result.current.table.content.kind).toBe('unavailable'));
    expect(result.current.dialogs.create.source.open).toBe(false);

    if (result.current.table.content.kind !== 'unavailable') {
      throw new Error('expected unavailable projects');
    }
    act(
      () =>
        result.current.table.content.kind === 'unavailable' && result.current.table.content.retry(),
    );
    await waitFor(() => expect(result.current.dialogs.create.source.open).toBe(true));
    expect(result.current.dialogs.create.source.values.rootPath).toBe('/work/new/');
    expect(api.calls.listProjects.length).toBeGreaterThan(1);
    expect(api.calls.listWorkspaces.length).toBeGreaterThan(1);
  });

  it('does not URL-open creation for an existing normalized path', async () => {
    const api = new InMemoryProjectsPageApi({
      projects: { items: [project('one', '/work/existing')] },
    });
    const { result } = renderController(api, {
      initialEntry: '/projects?projectPath=/work/existing/',
    });
    await readyRows(result);
    expect(result.current.dialogs.create.source.open).toBe(false);
  });

  it('retries provider mapping with the complete submitted wizard payload', async () => {
    let createCount = 0;
    const mappingRequired: CreateFromTemplateResponse = {
      success: false,
      providerMappingRequired: {
        missingProviders: ['claude'],
        familyAlternatives: [
          {
            familySlug: 'reasoning',
            defaultProvider: 'claude',
            defaultProviderAvailable: false,
            availableProviders: ['codex'],
            hasAlternatives: true,
          },
        ],
        canImport: true,
      },
    };
    const api = new InMemoryProjectsPageApi({
      projects: { items: [project('one')] },
      templates: [template],
      setupPreview: configuredPreview(),
      overrides: {
        createFromTemplate: () => {
          createCount += 1;
          return createCount === 1
            ? mappingRequired
            : {
                success: true,
                project: { id: 'created', name: 'Created', workspaceId: 'default' },
              };
        },
      },
    });
    const { result } = renderController(api);
    await readyRows(result);
    await submitCreate(result, 3);
    await waitFor(() => expect(result.current.dialogs.create.providerMapping).not.toBeNull());
    const firstPayload = api.calls.createFromTemplate[0][0];
    expect(firstPayload.selectedProviderNames).toEqual(['codex']);
    expect(firstPayload.presetName).toBe('balanced');
    expect(firstPayload.teamOverrides).toHaveLength(1);

    act(() => result.current.dialogs.create.providerMapping?.confirm({ reasoning: 'codex' }));
    await waitFor(() => expect(api.calls.createFromTemplate).toHaveLength(2));
    expect(api.calls.createFromTemplate[1][0]).toEqual({
      ...firstPayload,
      familyProviderMappings: { reasoning: 'codex' },
    });
  });

  it('hands template and file import sources to the active import wizard', async () => {
    const api = new InMemoryProjectsPageApi({
      projects: { items: [project('one')] },
      templates: [template],
      setupPreview: emptyPreview(),
    });
    const { result } = renderController(api);
    let [row] = await readyRows(result);
    act(() => row.startImport());
    act(() => result.current.dialogs.import.source.selectTemplate('starter'));
    act(() => result.current.dialogs.import.source.importTemplate());
    await waitFor(() => expect(api.calls.loadSetupPreview).toHaveLength(1));
    expect(api.calls.loadSetupPreview[0][0]).toEqual({ slug: 'starter' });

    act(() => result.current.dialogs.import.wizard.onOpenChange(false));
    [row] = await readyRows(result);
    act(() => row.startImport());
    await act(async () => {
      await result.current.dialogs.import.selectFile({
        text: async () => JSON.stringify({ version: 1, teams: [] }),
      } as File);
    });
    await waitFor(() => expect(api.calls.loadSetupPreview).toHaveLength(2));
    expect(api.calls.loadSetupPreview[1][0]).toEqual({
      rawContent: { version: 1, teams: [] },
    });
  });

  it('uses the exact destructive toast for invalid import JSON', async () => {
    const api = new InMemoryProjectsPageApi({ projects: { items: [project('one')] } });
    const { result } = renderController(api);
    const [row] = await readyRows(result);
    act(() => row.startImport());
    await act(async () => {
      await result.current.dialogs.import.selectFile({ text: async () => '{invalid' } as File);
    });
    expect(mockToast).toHaveBeenCalledWith({
      title: 'Import failed',
      description: 'Unable to read or parse the selected JSON file.',
      variant: 'destructive',
    });
  });

  it('reports prompt-transfer success and routes provider warnings semantically', async () => {
    const api = new InMemoryProjectsPageApi({
      projects: { items: [project('one')] },
      templates: [template],
      setupPreview: emptyPreview(),
      createResult: {
        success: true,
        project: { id: 'created', name: 'Created', workspaceId: 'default' },
        promptTransfer: { imported: 2, deleted: 0, preserved: 1, skipped: 1 },
        warnings: [
          {
            type: 'provider_mismatch',
            originalProvider: 'claude',
            substituteProvider: 'codex',
            agentNames: ['Coder'],
          },
        ],
      },
    });
    const { result } = renderController(api);
    await readyRows(result);
    await submitCreate(result, 2);
    await waitFor(() => expect(result.current.dialogs.create.warning.open).toBe(true));
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Success',
        description: expect.stringContaining('1 preserved, 1 skipped'),
      }),
    );
    expect(mockNavigate).not.toHaveBeenCalled();
    act(() => result.current.dialogs.create.warning.navigate('/chat'));
    expect(mockNavigate).toHaveBeenCalledWith('/chat');
  });

  it('keeps structured prompt failure destructive and terminally closes the rendered flow', async () => {
    const api = new InMemoryProjectsPageApi({
      projects: { items: [project('one')] },
      templates: [template],
      setupPreview: emptyPreview(),
      overrides: {
        createFromTemplate: {
          success: false,
          mutationStarted: false,
          error: 'Template profiles reference excluded prompts',
          promptReferenceValidation: {
            code: 'skipped_prompt_references',
            promptTitles: ['Private SOP'],
            issues: [{ promptTitle: 'Private SOP', profileNames: ['Coder'] }],
          },
        },
      },
    });
    const { result } = renderController(api);
    await readyRows(result);
    await submitCreate(result, 2);

    await waitFor(() => expect(result.current.dialogs.create.wizard.open).toBe(false));
    expect(result.current.dialogs.create.source.open).toBe(false);
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Project creation blocked',
        description: expect.stringContaining('"Private SOP" (profiles: Coder)'),
        variant: 'destructive',
      }),
    );
  });
});
