import { createEvent, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import userEvent from '@testing-library/user-event';
import type {
  ProjectTableRowModel,
  ProjectsTableModel,
  ProjectWorkspaceGroupModel,
} from './projects-page-presentation';
import { ProjectsTable } from './ProjectsTable';

jest.mock('@/ui/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuSub: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuSubTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuSubContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    onClick,
    disabled,
  }: {
    children: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
  }) => (
    <button onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}));

function row(overrides: Partial<ProjectTableRowModel> = {}): ProjectTableRowModel {
  return {
    id: 'project-1',
    name: 'Project One',
    rootPath: '/workspace/project-one',
    description: 'Main project',
    isTemplate: true,
    workspaceId: 'default',
    workspaceName: 'Default',
    epicsCount: 4,
    agentsCount: 2,
    template: {
      slug: 'starter',
      source: 'bundled',
      version: '1.0.0',
      upgradeVersion: '2.0.0',
    },
    open: jest.fn(),
    edit: jest.fn(),
    requestDelete: jest.fn(),
    startImport: jest.fn(),
    export: jest.fn(),
    configure: jest.fn(),
    upgrade: jest.fn(),
    actionsButtonId: 'project-actions-project-1',
    remoteLock: null,
    moveTargets: [],
    ...overrides,
  };
}

function group(overrides: Partial<ProjectWorkspaceGroupModel> = {}): ProjectWorkspaceGroupModel {
  return {
    id: 'default',
    name: 'Default',
    isDefault: true,
    position: 0,
    projectCount: 1,
    visibleMatchCount: 1,
    isExpanded: true,
    canToggle: true,
    identity: {
      initial: 'D',
      baseClassName: 'bg-blue-50 border-blue-200 text-blue-800',
      selectedClassName: 'bg-blue-100 border-blue-300 text-blue-900',
    },
    rows: [row()],
    emptyState: 'none',
    toggleExpanded: jest.fn(),
    openCreate: jest.fn(),
    rename: jest.fn(),
    moveDown: jest.fn(),
    ...overrides,
  };
}

function model(content: ProjectsTableModel['content']): ProjectsTableModel {
  return {
    search: '',
    changeSearch: jest.fn(),
    sortField: 'name',
    sortOrder: 'asc',
    toggleSort: jest.fn(),
    openCreate: jest.fn(),
    openCreateInWorkspace: jest.fn(),
    requestProjectMove: jest.fn(),
    openCreateWorkspace: jest.fn(),
    notice: null,
    statusMessage: '',
    drag: {
      projectId: null,
      sourceWorkspaceId: null,
      targetWorkspaceId: null,
      start: jest.fn(),
      enterWorkspace: jest.fn(),
      leaveWorkspace: jest.fn(),
      dropOnWorkspace: jest.fn(),
      end: jest.fn(),
    },
    content,
  };
}

function ready(groups: ProjectWorkspaceGroupModel[], searchActive = false): ProjectsTableModel {
  return model({ kind: 'ready', groups, searchActive });
}

describe('ProjectsTable', () => {
  // Only the Projects-specific lock adaptation belongs here; disclosure behavior is owned by NoticeBanner.
  it('disables the notice Update action and supplies the remote lock reason', async () => {
    const table = ready([]);
    const reason = 'Connected to remote "VM"; change this project there.';
    render(
      <ProjectsTable
        model={{
          ...table,
          notice: {
            items: [
              {
                projectId: 'locked',
                projectName: 'Locked',
                slug: 'starter',
                currentVersion: '1.0.0',
                targetVersion: '2.0.0',
                lockMessage: reason,
              },
            ],
            closeUntilRestart: jest.fn(),
            dismissUntilNewItems: jest.fn(),
          },
        }}
      />,
    );
    await userEvent.setup().click(screen.getByRole('button', { name: 'Show' }));
    const update = screen.getByRole('button', { name: 'Update' });
    expect(update).toBeDisabled();
    expect(update).toHaveAttribute('title', reason);
  });

  it('renders loading, shared unavailable, and no-workspaces states', () => {
    const retry = jest.fn();
    const { rerender } = render(<ProjectsTable model={model({ kind: 'loading' })} />);
    expect(screen.getByText('Loading projects and workspaces…')).toBeInTheDocument();

    rerender(
      <ProjectsTable
        model={model({ kind: 'unavailable', failedData: ['projects', 'workspaces'], retry })}
      />,
    );
    expect(screen.getByText(/Couldn’t load projects and workspaces/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalled();

    rerender(<ProjectsTable model={ready([])} />);
    expect(screen.getByText('No workspaces available')).toBeInTheDocument();
  });

  it('renders one native tbody per workspace with disclosure headers', () => {
    const defaultGroup = group();
    const labsGroup = group({
      id: 'labs',
      name: 'Labs',
      isDefault: false,
      position: 1,
      projectCount: 0,
      visibleMatchCount: 0,
      isExpanded: false,
      rows: [],
      emptyState: 'workspace-empty',
      moveDown: undefined,
      moveUp: jest.fn(),
      requestDelete: jest.fn(),
    });
    const { container } = render(<ProjectsTable model={ready([defaultGroup, labsGroup])} />);

    expect(container.querySelectorAll('tbody[data-workspace-id]')).toHaveLength(2);
    expect(screen.getByRole('button', { name: /Default.*1 project/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(screen.getByRole('button', { name: /Labs.*0 projects/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    fireEvent.click(screen.getByRole('button', { name: /Labs.*0 projects/ }));
    expect(labsGroup.toggleExpanded).toHaveBeenCalled();
  });

  it('offers exact workspace actions, omitting delete for the default workspace', () => {
    const defaultGroup = group();
    const labsGroup = group({
      id: 'labs',
      name: 'Labs',
      isDefault: false,
      position: 1,
      requestDelete: jest.fn(),
      moveUp: jest.fn(),
      moveDown: undefined,
    });
    render(<ProjectsTable model={ready([defaultGroup, labsGroup])} />);

    expect(screen.getAllByRole('button', { name: 'Create project here' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Rename' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Move up' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Move down' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Delete' })).toHaveLength(1);

    fireEvent.click(screen.getAllByRole('button', { name: 'Create project here' })[1]!);
    fireEvent.click(screen.getAllByRole('button', { name: 'Rename' })[1]!);
    fireEvent.click(screen.getAllByRole('button', { name: 'Move up' })[1]!);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(labsGroup.openCreate).toHaveBeenCalled();
    expect(labsGroup.rename).toHaveBeenCalled();
    expect(labsGroup.moveUp).toHaveBeenCalled();
    expect(labsGroup.requestDelete).toHaveBeenCalled();
  });

  it('shows search match totals while preserving all workspace headers', () => {
    render(
      <ProjectsTable
        model={ready(
          [
            group({ visibleMatchCount: 1, projectCount: 4 }),
            group({
              id: 'labs',
              name: 'Labs',
              visibleMatchCount: 0,
              projectCount: 2,
              isExpanded: false,
              rows: [],
              emptyState: 'no-matches',
            }),
          ],
          true,
        )}
      />,
    );
    expect(screen.getByText('1 visible matches · 4 total projects')).toBeInTheDocument();
    expect(screen.getByText('0 visible matches · 2 total projects')).toBeInTheDocument();
    expect(screen.getByText('Labs')).toBeInTheDocument();
  });

  it('uses authoritative empty and scoped-result copy', () => {
    const { rerender } = render(
      <ProjectsTable
        model={ready([
          group({ projectCount: 0, visibleMatchCount: 0, rows: [], emptyState: 'workspace-empty' }),
        ])}
      />,
    );
    expect(screen.getByText('No projects in this workspace.')).toBeInTheDocument();

    rerender(
      <ProjectsTable
        model={ready([
          group({ projectCount: 3, visibleMatchCount: 0, rows: [], emptyState: 'scoped' }),
        ])}
      />,
    );
    expect(
      screen.getByText('3 total projects are outside the current project results.'),
    ).toBeInTheDocument();
  });

  it('renders display-ready metadata, truncation affordances, and table intents', () => {
    const readyRow = row();
    const readyModel = ready([group({ rows: [readyRow] })]);
    render(<ProjectsTable model={readyModel} />);

    expect(screen.getByLabelText('Template project')).toBeInTheDocument();
    expect(screen.getByText('Built-in')).toBeInTheDocument();
    expect(screen.getByText('v1.0.0')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Search projects'), { target: { value: 'next' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Project' }));
    fireEvent.click(screen.getByText('Project One'));
    fireEvent.click(screen.getByRole('button', { name: 'Configure Project One' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit Project One' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete Project One' }));
    fireEvent.click(screen.getByTitle('Upgrade to v2.0.0'));
    fireEvent.click(screen.getByText('Name'));
    fireEvent.click(screen.getByText('Path'));

    expect(readyModel.changeSearch).toHaveBeenCalledWith('next');
    expect(readyModel.openCreate).toHaveBeenCalled();
    expect(readyModel.toggleSort).toHaveBeenNthCalledWith(1, 'name');
    expect(readyModel.toggleSort).toHaveBeenNthCalledWith(2, 'rootPath');
    expect(readyRow.open).toHaveBeenCalled();
    expect(readyRow.configure).toHaveBeenCalled();
    expect(readyRow.edit).toHaveBeenCalled();
    expect(readyRow.requestDelete).toHaveBeenCalled();
    expect(readyRow.upgrade).toHaveBeenCalled();
  });

  it('invokes project menu actions and workspace moves', () => {
    const requestMove = jest.fn();
    const readyRow = row({
      moveTargets: [{ workspaceId: 'labs', workspaceName: 'Labs', requestMove }],
    });
    render(<ProjectsTable model={ready([group({ rows: [readyRow] })])} />);
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    fireEvent.click(screen.getByRole('button', { name: 'Labs' }));
    expect(readyRow.startImport).toHaveBeenCalled();
    expect(readyRow.export).toHaveBeenCalled();
    expect(requestMove).toHaveBeenCalled();
  });

  it('disables delete and import on a remote-owned project and says why', () => {
    const message = 'Connected to remote "vm-1"; change this project there.';
    const lockedRow = row({ remoteLock: { message }, upgrade: undefined, moveTargets: [] });
    render(<ProjectsTable model={ready([group({ rows: [lockedRow] })])} />);

    const deleteButton = screen.getByRole('button', { name: 'Delete Project One' });
    const importItem = screen.getByRole('button', { name: 'Import' });
    expect(deleteButton).toBeDisabled();
    expect(deleteButton).toHaveAttribute('title', message);
    expect(importItem).toBeDisabled();
    expect(screen.getByText('Remote')).toHaveAttribute('title', message);
    expect(screen.queryByTitle('Upgrade to v2.0.0')).not.toBeInTheDocument();
    expect(screen.queryByTestId('project-drag-handle-project-1')).not.toBeInTheDocument();

    fireEvent.click(deleteButton);
    fireEvent.click(importItem);
    expect(lockedRow.requestDelete).not.toHaveBeenCalled();
    expect(lockedRow.startImport).not.toHaveBeenCalled();
  });

  it('uses a pointer-only handle and delegates drag events from the whole workspace group', () => {
    const drag = {
      projectId: null as string | null,
      sourceWorkspaceId: null as string | null,
      targetWorkspaceId: null as string | null,
      start: jest.fn(),
      enterWorkspace: jest.fn(),
      leaveWorkspace: jest.fn(),
      dropOnWorkspace: jest.fn(),
      end: jest.fn(),
    };
    const sourceRow = row({
      moveTargets: [{ workspaceId: 'labs', workspaceName: 'Labs', requestMove: jest.fn() }],
    });
    const labsRow = row({
      id: 'labs-project',
      name: 'Labs Project',
      workspaceId: 'labs',
      workspaceName: 'Labs',
    });
    const groups = [
      group({ rows: [sourceRow] }),
      group({ id: 'labs', name: 'Labs', isDefault: false, position: 1, rows: [labsRow] }),
    ];
    const { container, rerender } = render(<ProjectsTable model={{ ...ready(groups), drag }} />);
    const handle = screen.getByTestId('project-drag-handle-project-1');
    const dataTransfer = {
      effectAllowed: '',
      dropEffect: '',
      setData: jest.fn(),
    };

    fireEvent.dragStart(handle, { dataTransfer });
    expect(dataTransfer.effectAllowed).toBe('move');
    expect(dataTransfer.setData).toHaveBeenCalledWith('text/plain', 'project-1');
    expect(drag.start).toHaveBeenCalledWith('project-1', 'default');
    fireEvent.dragEnd(handle);
    expect(drag.end).toHaveBeenCalled();

    const activeDrag = {
      ...drag,
      projectId: 'project-1',
      sourceWorkspaceId: 'default',
      targetWorkspaceId: 'labs',
    };
    rerender(<ProjectsTable model={{ ...ready(groups), drag: activeDrag }} />);
    const labsBody = container.querySelector('tbody[data-workspace-id="labs"]')!;
    const labsCell = screen.getByText('Labs Project').closest('td')!;
    expect(labsBody).toHaveAttribute('data-drop-state', 'active');
    expect(screen.getByText('Move to Labs')).toBeInTheDocument();
    expect(container.querySelector('table')).toHaveClass('select-none');

    fireEvent.dragEnter(labsBody.querySelector('th')!, { dataTransfer });
    fireEvent.dragOver(labsCell, { dataTransfer });
    fireEvent.drop(labsCell, { dataTransfer });
    expect(drag.enterWorkspace).toHaveBeenCalledWith('labs');
    expect(dataTransfer.dropEffect).toBe('move');
    expect(drag.dropOnWorkspace).toHaveBeenCalledWith('labs');

    drag.leaveWorkspace.mockClear();
    const labsHeader = labsBody.querySelector('th')!;
    const internalLeave = createEvent.dragLeave(labsBody);
    Object.defineProperty(internalLeave, 'relatedTarget', { value: labsHeader });
    fireEvent(labsBody, internalLeave);
    expect(drag.leaveWorkspace).not.toHaveBeenCalled();
    fireEvent.dragLeave(labsBody, { relatedTarget: document.body });
    expect(drag.leaveWorkspace).toHaveBeenCalledWith('labs');

    drag.dropOnWorkspace.mockClear();
    rerender(
      <ProjectsTable
        model={{
          ...ready([groups[0]!, { ...groups[1]!, isExpanded: false }]),
          drag: activeDrag,
        }}
      />,
    );
    const collapsedHeader = container.querySelector('tbody[data-workspace-id="labs"] th')!;
    fireEvent.dragOver(collapsedHeader, { dataTransfer });
    fireEvent.drop(collapsedHeader, { dataTransfer });
    expect(drag.dropOnWorkspace).toHaveBeenCalledWith('labs');

    const archiveGroup = group({
      id: 'archive',
      name: 'Archive',
      isDefault: false,
      position: 2,
      projectCount: 0,
      visibleMatchCount: 0,
      rows: [],
      emptyState: 'workspace-empty',
    });
    drag.dropOnWorkspace.mockClear();
    rerender(
      <ProjectsTable
        model={{
          ...ready([...groups, archiveGroup]),
          drag: { ...activeDrag, targetWorkspaceId: 'archive' },
        }}
      />,
    );
    const emptyCell = screen.getByText('No projects in this workspace.');
    fireEvent.dragOver(emptyCell, { dataTransfer });
    fireEvent.drop(emptyCell, { dataTransfer });
    expect(drag.dropOnWorkspace).toHaveBeenCalledWith('archive');
  });

  it('marks the source workspace invalid and omits handles without a destination', () => {
    const noDestinationRow = row();
    const drag = {
      projectId: 'project-1',
      sourceWorkspaceId: 'default',
      targetWorkspaceId: 'default',
      start: jest.fn(),
      enterWorkspace: jest.fn(),
      leaveWorkspace: jest.fn(),
      dropOnWorkspace: jest.fn(),
      end: jest.fn(),
    };
    const { container } = render(
      <ProjectsTable model={{ ...ready([group({ rows: [noDestinationRow] })]), drag }} />,
    );

    expect(screen.queryByTestId('project-drag-handle-project-1')).not.toBeInTheDocument();
    const sourceBody = container.querySelector('tbody[data-workspace-id="default"]')!;
    expect(sourceBody).toHaveAttribute('data-drop-state', 'invalid');
    expect(screen.getByText('Current workspace · cannot drop')).toBeInTheDocument();
    const dataTransfer = { dropEffect: '', effectAllowed: '', setData: jest.fn() };
    fireEvent.dragOver(sourceBody, { dataTransfer });
    expect(dataTransfer.dropEffect).toBe('none');
    fireEvent.drop(sourceBody, { dataTransfer });
    expect(drag.dropOnWorkspace).toHaveBeenCalledWith('default');
  });
});
