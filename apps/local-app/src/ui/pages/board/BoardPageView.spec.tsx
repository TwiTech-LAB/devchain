import { fireEvent, render, screen } from '@testing-library/react';
import { BoardPageView } from '@/ui/pages/board/BoardPageView';
import type { BoardPagePresentation } from '@/ui/pages/board/board-page-presentation';
import type { BoardBulkEditController } from '@/ui/types/board-bulk-edit';
import type { Epic, Status } from '@/ui/types';

jest.mock('@/ui/components/board/BoardToolbar', () => ({
  BoardToolbar: () => <div>Toolbar fixture</div>,
}));
jest.mock('@/ui/components/board/CollapsedColumn', () => ({
  CollapsedColumn: ({
    status,
    timeTotals,
  }: {
    status: Status;
    timeTotals?: ReadonlyMap<string, number>;
  }) => <div data-has-time-totals={timeTotals?.size ?? 0}>Collapsed {status.label}</div>,
}));
jest.mock('@/ui/components/board/BoardColumn', () => ({
  BoardColumn: ({
    status,
    activeParentId,
    externalSources,
    timeTotals,
  }: {
    status: Status;
    activeParentId: string | null;
    externalSources?: ReadonlyMap<string, unknown>;
    timeTotals?: ReadonlyMap<string, number>;
  }) => (
    <div
      data-active-parent-id={activeParentId ?? ''}
      data-has-sources={externalSources?.size ?? 0}
      data-has-time-totals={timeTotals?.size ?? 0}
    >
      Expanded {status.label}
    </div>
  ),
}));
jest.mock('@/ui/components/board/BoardListView', () => ({
  BoardListView: ({
    epics,
    externalSources,
    timeTotals,
  }: {
    epics: Epic[];
    externalSources?: ReadonlyMap<string, unknown>;
    timeTotals?: ReadonlyMap<string, number>;
  }) => (
    <div data-has-sources={externalSources?.size ?? 0} data-has-time-totals={timeTotals?.size ?? 0}>
      List fixture: {epics.map((epic) => epic.title).join(', ')}
    </div>
  ),
}));
jest.mock('@/ui/components/board/BulkEditDialog', () => ({
  BulkEditDialog: ({ controller }: { controller: BoardBulkEditController }) => (
    <div>Bulk dialog {controller.isOpen ? 'open' : 'closed'}</div>
  ),
}));
jest.mock('@/ui/components/board/EpicFormDialog', () => ({
  EpicFormDialog: ({ open, onCancel }: { open: boolean; onCancel: () => void }) =>
    open ? <button onClick={onCancel}>Cancel create fixture</button> : null,
}));
jest.mock('@/ui/components/board/MoveToWorktreeDialog', () => ({
  MoveToWorktreeDialog: ({ open }: { open: boolean }) => (
    <div>Move dialog {open ? 'open' : 'closed'}</div>
  ),
}));

const status: Status = {
  id: 'todo',
  projectId: 'project-1',
  label: 'Todo',
  color: '#ffffff',
  position: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const epic: Epic = {
  id: 'epic-1',
  projectId: 'project-1',
  title: 'Fixture epic',
  description: null,
  statusId: status.id,
  version: 1,
  parentId: null,
  agentId: null,
  createdBy: null,
  tags: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const noop = jest.fn();
const asyncNoop = jest.fn(async () => undefined);
const bulkController: BoardBulkEditController = {
  isOpen: false,
  rows: [],
  error: null,
  isLoading: false,
  isSubmitting: false,
  canSubmit: false,
  open: noop,
  close: noop,
  changeRow: noop,
  submit: noop,
};

function createPresentation(
  content: BoardPagePresentation['content'],
  options: { createOpen?: boolean; bulkOpen?: boolean } = {},
): BoardPagePresentation {
  return {
    header: {
      hasProject: content.kind !== 'no-project',
      projectName: content.kind === 'no-project' ? null : 'Project Alpha',
    },
    toolbar: null,
    parentBanner: null,
    content,
    dialogs: {
      create: {
        isOpen: options.createOpen ?? false,
        activeProjectName: 'Project Alpha',
        formData: { title: '', description: '', tags: '', parentId: 'none' },
        parentCandidates: [],
        hasParentFilter: false,
        activeParent: null,
        isSubmitting: false,
        changeOpen: noop,
        changeForm: noop,
        cancel: noop,
        submit: noop,
      },
      deleteEpic: {
        epic: null,
        isSubmitting: false,
        changeOpen: noop,
        close: noop,
        confirm: noop,
      },
      bulkDelete: {
        epicCount: 0,
        isOpen: false,
        isSubmitting: false,
        changeOpen: noop,
        close: noop,
        confirm: noop,
      },
      bulkEdit: {
        controller: { ...bulkController, isOpen: options.bulkOpen ?? false },
        statuses: [status],
        agents: [],
      },
      moveToWorktree: {
        epic: null,
        statuses: [status],
        agents: [],
        changeOpen: noop,
      },
    },
  };
}

const columnBase = {
  status,
  epics: [epic],
  activeParentId: epic.id,
  isActiveDrop: false,
  statusOrder: [status],
  subEpicCounts: {},
  subEpicStatusCountsByEpicId: {},
  hasRunningWorktrees: false,
  timeTotals: new Map([['epic-1', 90]]),
  getAgentName: () => null,
  addEpic: noop,
  editEpic: noop,
  deleteEpic: noop,
  openBulkEdit: noop,
  openEpicDetails: noop,
  toggleParentFilter: noop,
  moveToWorktree: noop,
  dragStart: noop,
  dragEnd: noop,
  dragOver: noop,
  drop: noop,
};

describe('BoardPageView presentation', () => {
  beforeEach(() => jest.clearAllMocks());

  it('renders each discriminated content state from presentation facts', () => {
    const openStatusManagement = jest.fn();
    const { rerender } = render(
      <BoardPageView presentation={createPresentation({ kind: 'no-project' })} />,
    );
    expect(screen.getByText('No Project Selected')).toBeInTheDocument();

    rerender(<BoardPageView presentation={createPresentation({ kind: 'loading' })} />);
    expect(screen.getByText('Loading board...')).toBeInTheDocument();

    rerender(
      <BoardPageView
        presentation={createPresentation({ kind: 'no-statuses', openStatusManagement })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Go to Status Management' }));
    expect(openStatusManagement).toHaveBeenCalledTimes(1);

    rerender(
      <BoardPageView
        presentation={createPresentation({
          kind: 'kanban',
          columns: [
            { ...columnBase, kind: 'collapsed', expand: noop },
            {
              ...columnBase,
              status: { ...status, id: 'done', label: 'Done' },
              kind: 'expanded',
              draggedEpic: null,
              externalSources: new Map([['epic-1', { remoteKey: 'ENG-1' }]]),
              collapse: noop,
              keyboardMove: noop,
            },
          ],
        })}
      />,
    );
    expect(screen.getByText('Collapsed Todo')).toBeInTheDocument();
    expect(screen.getByText('Collapsed Todo')).toHaveAttribute('data-has-time-totals', '1');
    expect(screen.getByText('Expanded Done')).toHaveAttribute('data-active-parent-id', epic.id);
    expect(screen.getByText('Expanded Done')).toHaveAttribute('data-has-sources', '1');
    expect(screen.getByText('Expanded Done')).toHaveAttribute('data-has-time-totals', '1');

    rerender(
      <BoardPageView
        presentation={createPresentation({
          kind: 'list',
          epics: [epic],
          statuses: [status],
          agents: [],
          pageSize: 25,
          currentPage: 1,
          subEpicCounts: {},
          hasRunningWorktrees: false,
          changePage: noop,
          changePageSize: noop,
          editEpic: noop,
          deleteEpic: noop,
          deleteEpics: noop,
          openEpicDetails: noop,
          openBulkEdit: noop,
          toggleParentFilter: noop,
          changeStatus: asyncNoop,
          changeAgent: asyncNoop,
          moveToWorktree: noop,
          externalSources: new Map(),
          timeTotals: new Map([['epic-1', 90]]),
        })}
      />,
    );
    expect(screen.getByText('List fixture: Fixture epic')).toBeInTheDocument();
    expect(screen.getByText('List fixture: Fixture epic')).toHaveAttribute('data-has-sources', '0');
    expect(screen.getByText('List fixture: Fixture epic')).toHaveAttribute(
      'data-has-time-totals',
      '1',
    );
  });

  it('wires paired dialog models without receiving implementation objects', () => {
    render(
      <BoardPageView
        presentation={createPresentation(
          { kind: 'no-project' },
          { createOpen: true, bulkOpen: true },
        )}
      />,
    );

    expect(screen.getByText('Bulk dialog open')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel create fixture' }));
    expect(noop).toHaveBeenCalled();
    expect(screen.getByText('Move dialog closed')).toBeInTheDocument();
  });
});
