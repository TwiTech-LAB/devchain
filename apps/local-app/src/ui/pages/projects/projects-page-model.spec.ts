import type { ProjectTemplate, ProjectWithStats, ProjectWorkspace } from './lib/project-contracts';
import {
  buildProjectsTableModel,
  describeRemoteLock,
  filterAndSortProjects,
  getProjectUpgradeVersion,
  type ProjectsTableActions,
} from './projects-page-model';
import { getWorkspaceIdentity } from '@/ui/lib/workspace-identity';

const workspaces: ProjectWorkspace[] = [
  {
    id: 'default',
    name: 'Default',
    isDefault: true,
    position: 0,
    projectCount: 1,
    deviceGrantCount: 0,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
  },
  {
    id: 'labs',
    name: 'Labs',
    isDefault: false,
    position: 1,
    projectCount: 1,
    deviceGrantCount: 0,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
  },
];

const projects: ProjectWithStats[] = [
  {
    id: 'beta',
    workspaceId: 'labs',
    name: 'Beta',
    description: 'Planning workspace',
    rootPath: '/work/zeta',
    createdAt: '2025-02-01T00:00:00.000Z',
    updatedAt: '2025-02-01T00:00:00.000Z',
    templateMetadata: { slug: 'registry', version: '1.0.0', source: 'registry' },
  },
  {
    id: 'alpha',
    workspaceId: 'default',
    name: 'Alpha',
    description: null,
    rootPath: '/work/alpha',
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    bundledUpgradeAvailable: '3.0.0',
    templateMetadata: { slug: 'bundled', version: '2.0.0', source: 'bundled' },
  },
];

const templates: ProjectTemplate[] = [
  {
    slug: 'registry',
    name: 'Registry',
    source: 'registry',
    versions: ['2.0.0', '1.0.0'],
    latestVersion: '2.0.0',
  },
];

const actions: ProjectsTableActions = {
  changeSearch: jest.fn(),
  toggleSort: jest.fn(),
  openCreate: jest.fn(),
  openCreateInWorkspace: jest.fn(),
  openCreateWorkspace: jest.fn(),
  startProjectDrag: jest.fn(),
  enterDragWorkspace: jest.fn(),
  leaveDragWorkspace: jest.fn(),
  dropProjectOnWorkspace: jest.fn(),
  endProjectDrag: jest.fn(),
  toggleWorkspace: jest.fn(),
  retry: jest.fn(),
  renameWorkspace: jest.fn(),
  requestDeleteWorkspace: jest.fn(),
  moveWorkspace: jest.fn(),
  openProject: jest.fn(),
  editProject: jest.fn(),
  requestDelete: jest.fn(),
  startImport: jest.fn(),
  exportProject: jest.fn(),
  configureProject: jest.fn(),
  upgradeProject: jest.fn(),
  requestProjectMove: jest.fn(),
};

function build(overrides: Partial<Parameters<typeof buildProjectsTableModel>[0]> = {}) {
  return buildProjectsTableModel({
    data: { items: projects },
    isLoading: false,
    search: '',
    sortField: 'name',
    sortOrder: 'asc',
    templates,
    workspaces,
    actions,
    ...overrides,
  });
}

describe('projects-page-model', () => {
  beforeEach(() => jest.clearAllMocks());

  it.each([
    ['ALPHA', 'alpha'],
    ['ZETA', 'beta'],
    ['PLANNING', 'beta'],
  ])('searches name, path, and description case-insensitively', (query, expectedId) => {
    expect(filterAndSortProjects(projects, query, 'name', 'asc').map((item) => item.id)).toEqual([
      expectedId,
    ]);
  });

  it('sorts supported fields in either direction', () => {
    expect(filterAndSortProjects(projects, '', 'name', 'asc').map((item) => item.id)).toEqual([
      'alpha',
      'beta',
    ]);
    expect(filterAndSortProjects(projects, '', 'rootPath', 'desc').map((item) => item.id)).toEqual([
      'beta',
      'alpha',
    ]);
    expect(filterAndSortProjects(projects, '', 'createdAt', 'desc').map((item) => item.id)).toEqual(
      ['beta', 'alpha'],
    );
  });

  it('derives bundled and registry upgrades', () => {
    expect(getProjectUpgradeVersion(projects[1], templates)).toBe('3.0.0');
    expect(getProjectUpgradeVersion(projects[0], templates)).toBe('2.0.0');
    expect(
      getProjectUpgradeVersion(
        {
          ...projects[0],
          templateMetadata: { slug: 'registry', version: '2.0.0', source: 'registry' },
        },
        templates,
      ),
    ).toBeNull();
  });

  it('builds loading, unavailable, and grouped ready states', () => {
    expect(build({ isLoading: true, data: undefined }).content.kind).toBe('loading');

    const unavailable = build({ data: undefined, workspaces: undefined });
    expect(unavailable.content).toMatchObject({
      kind: 'unavailable',
      failedData: expect.arrayContaining(['projects', 'workspaces']),
    });
    if (unavailable.content.kind !== 'unavailable') throw new Error('expected unavailable');
    unavailable.content.retry();
    expect(actions.retry).toHaveBeenCalled();

    const ready = build({ data: { items: [] } });
    expect(ready.content.kind).toBe('ready');
    if (ready.content.kind !== 'ready') throw new Error('expected ready');
    expect(ready.content.groups.map((group) => group.name)).toEqual(['Default', 'Labs']);
  });

  it('orders workspace groups by position and sorts projects inside each group', () => {
    const anotherLabsProject: ProjectWithStats = {
      ...projects[0],
      id: 'aardvark',
      name: 'Aardvark',
    };
    const model = build({
      data: { items: [...projects, anotherLabsProject] },
      workspaces: [workspaces[1], workspaces[0]],
    });
    if (model.content.kind !== 'ready') throw new Error('expected ready');
    expect(model.content.groups.map((group) => group.id)).toEqual(['default', 'labs']);
    expect(model.content.groups[1]?.rows.map((row) => row.id)).toEqual(['aardvark', 'beta']);
  });

  it('uses search to expand matching groups and collapse non-matching groups', () => {
    const model = build({ search: 'Alpha', collapsedWorkspaceIds: new Set(['default']) });
    if (model.content.kind !== 'ready') throw new Error('expected ready');
    const [defaultGroup, labsGroup] = model.content.groups;
    expect(defaultGroup).toMatchObject({
      isExpanded: true,
      visibleMatchCount: 1,
      projectCount: 1,
      emptyState: 'none',
    });
    expect(labsGroup).toMatchObject({
      isExpanded: false,
      canToggle: false,
      visibleMatchCount: 0,
      projectCount: 1,
      emptyState: 'no-matches',
    });
    defaultGroup!.toggleExpanded();
    expect(actions.toggleWorkspace).not.toHaveBeenCalled();
  });

  it('distinguishes an authoritative empty workspace from scoped project results', () => {
    const model = build({
      data: { items: [] },
      workspaces: [
        { ...workspaces[0], projectCount: 0 },
        { ...workspaces[1], projectCount: 3 },
      ],
    });
    if (model.content.kind !== 'ready') throw new Error('expected ready');
    expect(model.content.groups.map((group) => group.emptyState)).toEqual([
      'workspace-empty',
      'scoped',
    ]);
    expect(model.content.groups[1]?.projectCount).toBe(3);
  });

  it('binds semantic row actions and display-ready values', () => {
    const configurable = {
      ...projects[0],
      isConfigurable: true,
      stats: { epicsCount: 2, agentsCount: 3 },
    };
    const model = build({ data: { items: [configurable] } });
    if (model.content.kind !== 'ready') throw new Error('expected ready');
    const [row] = model.content.groups[1]!.rows;
    row.open();
    row.edit();
    row.requestDelete();
    row.startImport();
    row.export();
    row.configure?.();
    row.upgrade?.();
    row.moveTargets[0]?.requestMove();
    expect(row.epicsCount).toBe(2);
    expect(row.agentsCount).toBe(3);
    expect(row.workspaceName).toBe('Labs');
    expect(actions.openProject).toHaveBeenCalledWith(configurable);
    expect(actions.editProject).toHaveBeenCalledWith(configurable);
    expect(actions.requestDelete).toHaveBeenCalledWith(configurable);
    expect(actions.startImport).toHaveBeenCalledWith(configurable);
    expect(actions.exportProject).toHaveBeenCalledWith(configurable);
    expect(actions.configureProject).toHaveBeenCalledWith(configurable);
    expect(actions.upgradeProject).toHaveBeenCalledWith(configurable, '2.0.0');
    expect(actions.requestProjectMove).toHaveBeenCalledWith(configurable, 'default');
    expect(row.actionsButtonId).toBe('project-actions-beta');
  });

  it('locks delete, move, import and upgrade on a remote-owned project', () => {
    const owned = projects[0];
    const model = build({
      data: { items: [owned] },
      remoteOwners: new Map([
        [
          owned.id,
          { projectId: owned.id, remoteId: 'remote-1', remoteName: 'vm-1', state: 'remote' },
        ],
      ]),
    });
    if (model.content.kind !== 'ready') throw new Error('expected ready');
    const [row] = model.content.groups[1]!.rows;

    expect(row.remoteLock).toEqual({
      message: 'Connected to remote "vm-1"; change this project there.',
    });
    expect(row.moveTargets).toEqual([]);
    expect(row.upgrade).toBeUndefined();
    model.requestProjectMove(owned.id, 'default');
    expect(actions.requestProjectMove).not.toHaveBeenCalled();
  });

  it('describes each remote-owned state', () => {
    const owner = { projectId: 'p', remoteId: 'r', remoteName: null } as const;
    expect(describeRemoteLock({ ...owner, state: 'attaching' })).toBe(
      'Connecting to a remote; changes are paused.',
    );
    expect(describeRemoteLock({ ...owner, state: 'detaching' })).toBe(
      'Disconnecting from a remote; changes are paused.',
    );
  });

  it('binds workspace actions and shares WorkspaceSwitcher identity styling', () => {
    const model = build({ collapsedWorkspaceIds: new Set(['labs']) });
    if (model.content.kind !== 'ready') throw new Error('expected ready');
    const [defaultGroup, labsGroup] = model.content.groups;
    labsGroup!.toggleExpanded();
    labsGroup!.openCreate();
    labsGroup!.rename();
    labsGroup!.moveUp?.();
    labsGroup!.requestDelete?.();
    defaultGroup!.moveDown?.();

    expect(labsGroup).toMatchObject({
      isExpanded: false,
      canToggle: true,
      identity: getWorkspaceIdentity('Labs'),
    });
    expect(actions.toggleWorkspace).toHaveBeenCalledWith('labs');
    expect(actions.openCreateInWorkspace).toHaveBeenCalledWith('labs');
    expect(actions.renameWorkspace).toHaveBeenCalledWith(workspaces[1]);
    expect(actions.moveWorkspace).toHaveBeenCalledWith('labs', -1);
    expect(actions.moveWorkspace).toHaveBeenCalledWith('default', 1);
    expect(actions.requestDeleteWorkspace).toHaveBeenCalledWith(workspaces[1]);
    expect(defaultGroup?.requestDelete).toBeUndefined();
  });

  it('projects controller-owned drag state and intents into the table model', () => {
    const model = build({
      projectDrag: {
        projectId: 'alpha',
        sourceWorkspaceId: 'default',
        targetWorkspaceId: 'labs',
      },
    });

    expect(model.drag).toMatchObject({
      projectId: 'alpha',
      sourceWorkspaceId: 'default',
      targetWorkspaceId: 'labs',
    });
    model.drag.start('alpha', 'default');
    model.drag.enterWorkspace('labs');
    model.drag.leaveWorkspace('labs');
    model.drag.dropOnWorkspace('labs');
    model.drag.end();
    expect(actions.startProjectDrag).toHaveBeenCalledWith('alpha', 'default');
    expect(actions.enterDragWorkspace).toHaveBeenCalledWith('labs');
    expect(actions.leaveDragWorkspace).toHaveBeenCalledWith('labs');
    expect(actions.dropProjectOnWorkspace).toHaveBeenCalledWith('labs');
    expect(actions.endProjectDrag).toHaveBeenCalled();
  });
});
