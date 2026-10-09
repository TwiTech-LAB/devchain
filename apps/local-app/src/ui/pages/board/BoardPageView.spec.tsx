import { act, fireEvent, render, screen } from '@testing-library/react';
import type { BoardCardDragBindings } from '@/ui/hooks/useBoardCardDrag';
import { BoardPageView } from '@/ui/pages/board/BoardPageView';
import type {
  BoardKanbanColumnModel,
  BoardPagePresentation,
} from '@/ui/pages/board/board-page-presentation';
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
// The expanded-column stub doubles as a render probe for the drag tests: the
// gesture must cross columns without causing a single re-render of any column.
const mockColumnRenders: Record<string, number> = {};
jest.mock('@/ui/components/board/BoardColumn', () => ({
  BoardColumn: ({
    status,
    activeParentId,
    externalSources,
    timeTotals,
    relationQuickLink,
    epics,
    cardDrag,
  }: {
    status: Status;
    activeParentId: string | null;
    externalSources?: ReadonlyMap<string, unknown>;
    timeTotals?: ReadonlyMap<string, number>;
    relationQuickLink?: unknown;
    epics: Epic[];
    cardDrag?: BoardCardDragBindings;
  }) => {
    mockColumnRenders[status.id] = (mockColumnRenders[status.id] ?? 0) + 1;
    return (
      <div
        data-active-parent-id={activeParentId ?? ''}
        data-has-sources={externalSources?.size ?? 0}
        data-has-time-totals={timeTotals?.size ?? 0}
        data-has-relation-quick-link={String(Boolean(relationQuickLink))}
        data-board-drop-status-id={status.id}
      >
        Expanded {status.label}
        {epics.map((dragged) => (
          <div
            key={dragged.id}
            data-board-card-drag-source
            onPointerDown={(event) => cardDrag?.pointerDown(dragged, event)}
          >
            {dragged.title}
          </div>
        ))}
      </div>
    );
  },
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
jest.mock('@/ui/components/board/EpicRelationQuickLinkDialog', () => ({
  EpicRelationQuickLinkDialog: () => null,
}));

const status: Status = {
  mcpHidden: false,
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
    },
  };
}

const columnBase = {
  status,
  epics: [epic],
  activeParentId: epic.id,
  statusOrder: [status],
  subEpicCounts: {},
  subEpicStatusCountsByEpicId: {},
  timeTotals: new Map([['epic-1', 90]]),
  getAgentName: () => null,
  addEpic: noop,
  editEpic: noop,
  deleteEpic: noop,
  openBulkEdit: noop,
  openEpicDetails: noop,
  toggleParentFilter: noop,
  draggedEpic: null,
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
          cardDrag: { start: noop, drop: noop, cancel: noop },
          columns: [
            { ...columnBase, kind: 'collapsed', expand: noop },
            {
              ...columnBase,
              status: { ...status, id: 'done', label: 'Done' },
              kind: 'expanded',
              draggedEpic: null,
              externalSources: new Map([
                [
                  'epic-1',
                  {
                    provider: 'jira',
                    remoteTaskId: 'ENG-1',
                    remoteKey: 'ENG-1',
                    title: 'Fixture epic',
                    workAreaName: 'Delivery',
                    statusName: 'In Progress',
                    webUrl: null,
                    linkedAt: '2026-08-21T10:00:00.000Z',
                  },
                ],
              ]),
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
    expect(screen.getByText('Expanded Done')).toHaveAttribute(
      'data-has-relation-quick-link',
      'true',
    );

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
  });
});

describe('BoardPageView kanban card drag', () => {
  const originalElementFromPoint = Object.getOwnPropertyDescriptor(document, 'elementFromPoint');

  beforeEach(() => {
    jest.useFakeTimers();
    for (const key of Object.keys(mockColumnRenders)) delete mockColumnRenders[key];
  });

  afterEach(() => {
    jest.useRealTimers();
    if (originalElementFromPoint)
      Object.defineProperty(document, 'elementFromPoint', originalElementFromPoint);
    else Reflect.deleteProperty(document, 'elementFromPoint');
  });

  function pointer(type: string, x: number, y: number): void {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, { clientX: x, clientY: y, pointerId: 1 });
    act(() => {
      window.dispatchEvent(event);
    });
  }

  function beginDrag(card: Element): void {
    const event = new Event('pointerdown', { bubbles: true, cancelable: true });
    Object.assign(event, { button: 0, isPrimary: true, pointerId: 1, clientX: 100, clientY: 100 });
    act(() => {
      fireEvent(card, event);
    });
  }

  it('crosses columns and the gap between them without re-rendering any column', () => {
    const doingStatus = { ...status, id: 'doing', label: 'Doing' };
    const doneStatus = { ...status, id: 'done', label: 'Done' };
    const expanded = (columnStatus: Status, epics: Epic[]): BoardKanbanColumnModel => ({
      ...columnBase,
      status: columnStatus,
      epics,
      statusOrder: [status, doingStatus, doneStatus],
      kind: 'expanded',
      externalSources: new Map(),
      collapse: noop,
      keyboardMove: noop,
    });
    const start = jest.fn();
    const drop = jest.fn();
    render(
      <BoardPageView
        presentation={createPresentation({
          kind: 'kanban',
          cardDrag: { start, drop, cancel: noop },
          columns: [expanded(status, [epic]), expanded(doingStatus, []), expanded(doneStatus, [])],
        })}
      />,
    );
    const todo = screen.getByText('Expanded Todo');
    const doing = screen.getByText('Expanded Doing');
    const done = screen.getByText('Expanded Done');
    const card = screen.getByText('Fixture epic');
    // Columns at x < 200, 250-400, > 450; the ranges between them are gaps.
    const hit = jest.fn((x: number): Element | null => {
      if (x < 200) return todo;
      if (x < 250) return null;
      if (x < 400) return doing;
      if (x < 450) return null;
      return done;
    });
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: hit });

    beginDrag(card);
    pointer('pointermove', 110, 100);
    expect(start).toHaveBeenCalledTimes(1);
    expect(todo).toHaveAttribute('data-board-drop-active');
    const rendersAfterDragStart = { ...mockColumnRenders };

    pointer('pointermove', 220, 100);
    act(() => jest.advanceTimersByTime(16));
    expect(document.querySelector('[data-board-drop-active]')).toBeNull();

    pointer('pointermove', 300, 100);
    act(() => jest.advanceTimersByTime(16));
    expect(doing).toHaveAttribute('data-board-drop-active');
    expect(document.querySelectorAll('[data-board-drop-active]')).toHaveLength(1);

    pointer('pointermove', 430, 100);
    act(() => jest.advanceTimersByTime(16));
    expect(document.querySelector('[data-board-drop-active]')).toBeNull();

    pointer('pointermove', 500, 100);
    act(() => jest.advanceTimersByTime(16));
    expect(done).toHaveAttribute('data-board-drop-active');
    expect(document.querySelectorAll('[data-board-drop-active]')).toHaveLength(1);

    pointer('pointerup', 500, 100);
    expect(drop).toHaveBeenCalledWith(epic, 'done');
    expect(document.querySelector('[data-board-drop-active]')).toBeNull();
    expect(mockColumnRenders).toEqual(rendersAfterDragStart);
  });
});
