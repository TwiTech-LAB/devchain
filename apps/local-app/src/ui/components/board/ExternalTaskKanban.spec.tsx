import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { MemoryRouter } from 'react-router-dom';
import { ExternalTaskKanban } from './ExternalTaskKanban';
import type { ExternalTaskKanbanMoves } from './ExternalTaskKanban';
import { formatEpicTimeMinutes } from '@/ui/lib/epic-time';

const columns = [
  {
    key: 'todo',
    name: 'To do',
    color: '#6b778c',
    remoteId: 'todo',
    remoteStatusIds: ['todo'],
    synthetic: false,
    tasks: [
      {
        remoteId: 'ENG-1',
        isSubtask: false,
        title: 'Render exact status',
        statusName: 'Ready for development',
        statusCategory: 'active' as const,
        updatedAt: '2026-08-19T10:00:00.000Z',
        dueAt: '2026-08-20T10:00:00.000Z',
        webUrl: 'https://acme.atlassian.net/browse/ENG-1',
        groupedSubtaskCount: 0,
      },
    ],
  },
];

// Layer: UI component unit (jsdom + RTL). The card contract is rendered
// output — visible badge text, Subtask marker, accessible names, activation,
// and focus registration — which only a mounted component can prove; the
// move controller is passed in or mocked because its wiring has its own suite.
describe('ExternalTaskKanban', () => {
  it('renders exact task status and activates the card without drag affordances', async () => {
    const user = userEvent.setup();
    const onOpenTask = jest.fn();
    const { container } = render(<ExternalTaskKanban columns={columns} onOpenTask={onOpenTask} />);

    const card = screen.getByRole('button', { name: 'Open Render exact status' });
    expect(card).not.toHaveAttribute('draggable');
    expect(card).not.toHaveAttribute('aria-roledescription', 'sortable');
    expect(
      screen.queryByRole('button', { name: /move.*left|move.*right/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByText('Status:')).toHaveTextContent('Status: Ready for development');

    card.focus();
    await user.keyboard('{Enter}');
    expect(onOpenTask).toHaveBeenCalledWith(columns[0].tasks[0]);

    {
      expect(await axe(container)).toHaveNoViolations();
    }
  });

  it('marks a standalone parented task as a Subtask without changing card activation', async () => {
    const user = userEvent.setup();
    const onOpenTask = jest.fn();
    const subtaskColumns = [
      {
        ...columns[0],
        tasks: [{ ...columns[0].tasks[0], isSubtask: true }],
      },
    ];
    render(<ExternalTaskKanban columns={subtaskColumns} onOpenTask={onOpenTask} />);

    expect(screen.getByText('Subtask')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open Render exact status, Subtask' }));
    expect(onOpenTask).toHaveBeenCalledWith(subtaskColumns[0].tasks[0]);
  });

  it('renders the grouped count badge for one and many children and hides it at zero', () => {
    const countColumns = [
      {
        ...columns[0],
        tasks: [
          { ...columns[0].tasks[0], title: 'Lonely card', groupedSubtaskCount: 0 },
          { ...columns[0].tasks[0], title: 'Single parent', groupedSubtaskCount: 1 },
          { ...columns[0].tasks[0], title: 'Busy parent', groupedSubtaskCount: 3 },
        ],
      },
    ];
    render(<ExternalTaskKanban columns={countColumns} onOpenTask={jest.fn()} />);

    expect(screen.getByText('1 subtask')).toBeInTheDocument();
    expect(screen.getByText('3 subtasks')).toBeInTheDocument();
    expect(screen.queryByText('0 subtasks')).not.toBeInTheDocument();
  });

  it('keeps the Subtask marker and the grouped count separate on a dual-meaning card', () => {
    const dualColumns = [
      {
        ...columns[0],
        tasks: [
          {
            ...columns[0].tasks[0],
            title: 'Dual meaning',
            isSubtask: true,
            groupedSubtaskCount: 2,
          },
        ],
      },
    ];
    render(<ExternalTaskKanban columns={dualColumns} onOpenTask={jest.fn()} />);

    expect(screen.getByText('Subtask')).toBeInTheDocument();
    expect(screen.getByText('2 subtasks')).toBeInTheDocument();
    expect(
      screen.getByRole('button', {
        name: 'Open Dual meaning, Subtask, with 2 subtasks grouped under it',
      }),
    ).toBeInTheDocument();
  });

  it('places the grouped count before the card keyboard instructions in the accessible name', () => {
    render(
      <ExternalTaskKanban
        columns={[
          {
            ...columns[0],
            tasks: [{ ...columns[0].tasks[0], title: 'Grouped parent', groupedSubtaskCount: 1 }],
          },
        ]}
        onOpenTask={jest.fn()}
        moves={{
          keyboardMovesEnabled: true,
          dragSource: null,
          pendingTaskId: null,
          isReceivingColumn: () => false,
          onCardDragStart: jest.fn(),
          onCardDragEnd: jest.fn(),
          onCardDrop: jest.fn(),
          onKeyboardMove: jest.fn(),
          onKeyboardBoundary: jest.fn(),
        }}
      />,
    );

    expect(
      screen.getByRole('button', {
        name: 'Open Grouped parent, with 1 subtask grouped under it. Press Enter for details, press Left or Right arrow keys to move between columns.',
      }),
    ).toBeInTheDocument();
  });

  it('shows the linked DevChain project and a direct open action from batch state', () => {
    render(
      <MemoryRouter>
        <ExternalTaskKanban
          columns={columns}
          onOpenTask={jest.fn()}
          links={[
            {
              scopeKey: 'site',
              taskId: 'ENG-1',
              linked: true,
              epicId: 'epic-1',
              projectId: 'project-1',
              projectName: 'Product',
              loggedMinutes: null,
            },
          ]}
          epicTimeTotals={new Map([['epic-1', 90]])}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText('DevChain project: Product')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open DevChain task' })).toHaveAttribute(
      'href',
      '/epics/epic-1',
    );
  });

  it('registers card buttons by stable task id and accepts a board fallback ref', () => {
    const registry = new Map<string, HTMLButtonElement>();
    const fallbackRef = { current: null };
    const { rerender } = render(
      <ExternalTaskKanban
        columns={columns}
        onOpenTask={jest.fn()}
        cardFocusRegistry={registry}
        boardFocusFallbackRef={fallbackRef}
      />,
    );

    const card = screen.getByRole('button', { name: 'Open Render exact status' });
    expect(card).toHaveAttribute('data-task-id', 'ENG-1');
    expect(registry.get('ENG-1')).toBe(card);
    expect(fallbackRef.current).toBe(screen.getByRole('region', { name: 'Task board' }));

    // A column move remounts the card; the registry tracks the live element.
    const moved = [
      { ...columns[0], tasks: [] },
      { ...columns[0], key: 'done', name: 'Done', tasks: columns[0].tasks },
    ];
    rerender(
      <ExternalTaskKanban
        columns={moved}
        onOpenTask={jest.fn()}
        cardFocusRegistry={registry}
        boardFocusFallbackRef={fallbackRef}
      />,
    );
    const remountedCard = screen.getByRole('button', { name: 'Open Render exact status' });
    expect(remountedCard).not.toBe(card);
    expect(registry.get('ENG-1')).toBe(remountedCard);

    rerender(
      <ExternalTaskKanban
        columns={[{ ...columns[0], tasks: [] }]}
        onOpenTask={jest.fn()}
        cardFocusRegistry={registry}
        boardFocusFallbackRef={fallbackRef}
      />,
    );
    expect(registry.has('ENG-1')).toBe(false);
  });
});

describe('ExternalTaskKanban move interactions', () => {
  const moveColumns = [
    {
      key: 'todo',
      name: 'To do',
      color: '#6b778c',
      remoteId: 'st-todo',
      remoteStatusIds: ['st-todo'],
      synthetic: false,
      tasks: [
        {
          remoteId: 'ENG-1',
          isSubtask: false,
          title: 'Draggable card',
          statusName: 'To do',
          statusCategory: 'active' as const,
          updatedAt: '2026-08-19T10:00:00.000Z',
          dueAt: null,
          webUrl: null,
          groupedSubtaskCount: 0,
        },
      ],
    },
    {
      key: 'progress',
      name: 'In Progress',
      color: '#7c4dff',
      remoteId: 'st-progress',
      remoteStatusIds: ['st-progress'],
      synthetic: false,
      tasks: [],
    },
    {
      key: 'other',
      name: 'Other',
      color: '#6b7280',
      remoteId: null,
      remoteStatusIds: [],
      synthetic: true,
      tasks: [],
    },
  ];

  function movesBinding(overrides: Partial<ExternalTaskKanbanMoves> = {}): ExternalTaskKanbanMoves {
    return {
      keyboardMovesEnabled: true,
      dragSource: null,
      pendingTaskId: null,
      isReceivingColumn: (column) =>
        !column.synthetic && column.key !== 'todo' && column.remoteId !== null,
      onCardDragStart: jest.fn(),
      onCardDragEnd: jest.fn(),
      onCardDrop: jest.fn(),
      onKeyboardMove: jest.fn(),
      onKeyboardBoundary: jest.fn(),
      ...overrides,
    };
  }

  function cardArticle(): HTMLElement {
    return screen.getByRole('button', { name: /Open Draggable card/ }).closest('article')!;
  }

  function columnSection(name: string): HTMLElement {
    return screen.getByRole('heading', { name }).closest('section')!;
  }

  it('marks the article draggable, announces grab, and reports the source column', async () => {
    const moves = movesBinding();
    const { container } = render(
      <ExternalTaskKanban columns={moveColumns} onOpenTask={jest.fn()} moves={moves} />,
    );

    const article = cardArticle();
    expect(article).toHaveAttribute('draggable', 'true');

    fireEvent.dragStart(article);
    expect(moves.onCardDragStart).toHaveBeenCalledWith({
      taskId: 'ENG-1',
      columnKey: 'todo',
    });

    fireEvent.dragEnd(article);
    expect(moves.onCardDragEnd).toHaveBeenCalledTimes(1);

    {
      expect(await axe(container)).toHaveNoViolations();
    }
  });

  it('accepts a drop on a receiving column with the converted target descriptor', () => {
    const moves = movesBinding();
    const { rerender } = render(
      <ExternalTaskKanban columns={moveColumns} onOpenTask={jest.fn()} moves={moves} />,
    );

    fireEvent.dragStart(cardArticle());
    rerender(
      <ExternalTaskKanban
        columns={moveColumns}
        onOpenTask={jest.fn()}
        moves={movesBinding({
          ...moves,
          dragSource: { taskId: 'ENG-1', columnKey: 'todo' },
          onCardDrop: moves.onCardDrop,
        })}
      />,
    );

    const progress = columnSection('In Progress');
    fireEvent.dragOver(progress, { dataTransfer: { dropEffect: 'move' } });
    expect(progress.className).toContain('bg-primary/5');

    fireEvent.drop(progress);
    expect(moves.onCardDrop).toHaveBeenCalledWith(
      { taskId: 'ENG-1', columnKey: 'todo' },
      {
        columnKey: 'progress',
        name: 'In Progress',
        remoteId: 'st-progress',
        remoteStatusIds: ['st-progress'],
        synthetic: false,
      },
    );
  });

  it('never highlights or accepts a drop on a synthetic or source column', () => {
    const moves = movesBinding();
    render(
      <ExternalTaskKanban
        columns={moveColumns}
        onOpenTask={jest.fn()}
        moves={movesBinding({
          ...moves,
          dragSource: { taskId: 'ENG-1', columnKey: 'todo' },
        })}
      />,
    );

    const other = columnSection('Other');
    expect(other.className).not.toContain('border-primary/50');
    fireEvent.dragOver(other);
    expect(other.className).not.toContain('bg-primary/5');
    fireEvent.drop(other);
    expect(moves.onCardDrop).not.toHaveBeenCalled();

    const source = columnSection('To do');
    expect(source.className).not.toContain('border-primary/50');
    fireEvent.dragOver(source);
    expect(source.className).not.toContain('bg-primary/5');
    fireEvent.drop(source);
    expect(moves.onCardDrop).not.toHaveBeenCalled();
  });

  it('moves with arrow keys to the adjacent column and prevents scrolling', () => {
    const moves = movesBinding();
    render(<ExternalTaskKanban columns={moveColumns} onOpenTask={jest.fn()} moves={moves} />);
    const card = screen.getByRole('button', {
      name: /Open Draggable card\. Press Enter for details/,
    });

    fireEvent.keyDown(card, { key: 'ArrowRight' });
    expect(moves.onKeyboardMove).toHaveBeenCalledWith(
      { taskId: 'ENG-1', columnKey: 'todo' },
      {
        columnKey: 'progress',
        name: 'In Progress',
        remoteId: 'st-progress',
        remoteStatusIds: ['st-progress'],
        synthetic: false,
      },
    );

    fireEvent.keyDown(card, { key: 'ArrowLeft' });
    expect(moves.onKeyboardBoundary).toHaveBeenCalledTimes(1);
    expect(moves.onKeyboardMove).toHaveBeenCalledTimes(1);
  });

  it('leaves arrow keys inert when keyboard movement is disabled', () => {
    const moves = movesBinding({ keyboardMovesEnabled: false });
    render(<ExternalTaskKanban columns={moveColumns} onOpenTask={jest.fn()} moves={moves} />);
    const card = screen.getByRole('button', { name: 'Open Draggable card' });
    expect(card).not.toHaveAttribute('aria-label', expect.stringContaining('arrow'));

    fireEvent.keyDown(card, { key: 'ArrowRight' });
    expect(moves.onKeyboardMove).not.toHaveBeenCalled();
    expect(moves.onKeyboardBoundary).not.toHaveBeenCalled();
  });

  it('keeps a pending card focusable with aria-disabled and guarded handlers', () => {
    const onOpenTask = jest.fn();
    const moves = movesBinding({ pendingTaskId: 'ENG-1' });
    render(<ExternalTaskKanban columns={moveColumns} onOpenTask={onOpenTask} moves={moves} />);
    const card = screen.getByRole('button', { name: /Open Draggable card/ });

    expect(card).toHaveAttribute('aria-disabled', 'true');
    expect(card).not.toHaveAttribute('disabled');

    card.focus();
    expect(card).toHaveFocus();
    fireEvent.click(card);
    expect(onOpenTask).not.toHaveBeenCalled();

    fireEvent.keyDown(card, { key: 'ArrowRight' });
    expect(moves.onKeyboardMove).not.toHaveBeenCalled();

    const article = cardArticle();
    expect(article).toHaveAttribute('draggable', 'true');
    fireEvent.dragStart(article);
    expect(moves.onCardDragStart).not.toHaveBeenCalled();
  });
});

describe('ExternalTaskKanban card time metrics', () => {
  const linkedSummary = (loggedMinutes: number | null) => ({
    scopeKey: 'site',
    taskId: 'ENG-1',
    linked: true,
    epicId: 'epic-1',
    projectId: 'project-1',
    projectName: 'Product',
    loggedMinutes,
  });

  function renderTimeBoard(loggedMinutes: number | null, totals?: ReadonlyMap<string, number>) {
    return render(
      <MemoryRouter>
        <ExternalTaskKanban
          columns={columns}
          onOpenTask={jest.fn()}
          links={[linkedSummary(loggedMinutes)]}
          epicTimeTotals={totals}
        />
      </MemoryRouter>,
    );
  }

  it('renders the Current badge and authoritative Logged and New figures', async () => {
    const { container } = renderTimeBoard(30, new Map([['epic-1', 90]]));

    expect(screen.getByTestId('external-card-time')).toHaveTextContent(
      `Logged ${formatEpicTimeMinutes(30)} · New unlogged ${formatEpicTimeMinutes(60)}`,
    );
    expect(screen.getByText(`· New unlogged ${formatEpicTimeMinutes(60)}`)).toHaveClass(
      'bg-status-warn/10',
      'text-status-warn',
    );
    expect(screen.getByTestId('epic-time-badge')).toHaveTextContent(formatEpicTimeMinutes(90));

    {
      expect(screen.getByText('Current DevChain time')).toBeInTheDocument();
      expect(screen.getByTestId('external-card-time')).toHaveTextContent('Logged');
      expect(screen.getByTestId('external-card-time')).toHaveTextContent('New unlogged');
    }
    {
      expect(await axe(container)).toHaveNoViolations();
    }
  });

  it.each([
    { name: 'zero', logged: 0, current: 0, row: null, badge: null },
    {
      name: 'logged above current',
      logged: 90,
      current: 15,
      row: 'Logged 1h 30m · New unlogged 0m',
      badge: '15m',
    },
    { name: 'unknown checkpoint', logged: null, current: 90, row: '', badge: '1h 30m' },
    {
      name: 'current unavailable',
      logged: 75,
      current: undefined,
      row: 'Logged 1h 15m',
      badge: null,
    },
  ])('renders time figures for $name', ({ name, logged, current, row, badge }) => {
    renderTimeBoard(logged, current === undefined ? undefined : new Map([['epic-1', current]]));
    const timeRow = screen.queryByTestId('external-card-time');
    if (row === null) expect(timeRow).not.toBeInTheDocument();
    else {
      expect(timeRow).toBeInTheDocument();
      if (row) expect(timeRow).toHaveTextContent(row);
      if (name === 'unknown checkpoint') {
        expect(timeRow!.textContent).not.toContain('Logged');
        expect(timeRow!.textContent).not.toContain('New');
      }
      if (name === 'current unavailable')
        expect(timeRow!.textContent).not.toContain('New unlogged');
    }
    if (badge === null) expect(screen.queryByTestId('epic-time-badge')).not.toBeInTheDocument();
    else expect(screen.getByTestId('epic-time-badge')).toHaveTextContent(badge);
  });

  it('renders no time row for an unlinked card even with totals present', () => {
    render(
      <MemoryRouter>
        <ExternalTaskKanban
          columns={columns}
          onOpenTask={jest.fn()}
          links={[{ ...linkedSummary(75), linked: false, epicId: null }]}
          epicTimeTotals={new Map([['epic-1', 90]])}
        />
      </MemoryRouter>,
    );

    expect(screen.queryByTestId('external-card-time')).not.toBeInTheDocument();
    expect(screen.queryByTestId('epic-time-badge')).not.toBeInTheDocument();
  });

  it('suppresses every numeric time metric while the link set is placeholder or errored', () => {
    render(
      <MemoryRouter>
        <ExternalTaskKanban
          columns={columns}
          onOpenTask={jest.fn()}
          links={[linkedSummary(30)]}
          epicTimeTotals={new Map([['epic-1', 90]])}
          timeMetricsReady={false}
        />
      </MemoryRouter>,
    );

    // Existing link affordances survive; the time metrics do not.
    expect(screen.getByText('DevChain project: Product')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open DevChain task' })).toBeInTheDocument();
    expect(screen.queryByTestId('external-card-time')).not.toBeInTheDocument();
    expect(screen.queryByTestId('epic-time-badge')).not.toBeInTheDocument();
  });
});

describe('ExternalTaskKanban quick import actions', () => {
  const unlinked = {
    scopeKey: 'site',
    taskId: 'ENG-1',
    linked: false,
    epicId: null,
    projectId: null,
    projectName: null,
    loggedMinutes: null,
  };

  function renderBoard(overrides: Partial<Parameters<typeof ExternalTaskKanban>[0]> = {}) {
    const props: Parameters<typeof ExternalTaskKanban>[0] = {
      columns,
      onOpenTask: jest.fn(),
      links: [unlinked],
      onQuickImport: jest.fn(),
      ...overrides,
    };
    return {
      props,
      ...render(
        <MemoryRouter>
          <ExternalTaskKanban {...props} />
        </MemoryRouter>,
      ),
    };
  }

  it('offers quick import on a confirmed unlinked card and reports the task', async () => {
    const user = userEvent.setup();
    const { props } = renderBoard();

    await user.click(screen.getByRole('button', { name: 'Create DevChain task' }));

    expect(props.onQuickImport).toHaveBeenCalledTimes(1);
    expect(props.onQuickImport).toHaveBeenCalledWith(columns[0].tasks[0]);
  });

  it.each([
    ['the lookup is fetching', { linksFetching: true }],
    ['the lookup failed', { linksError: true }],
    ['the link entry is missing', { links: [] }],
    [
      'the card is linked',
      {
        links: [
          {
            ...unlinked,
            linked: true,
            epicId: 'epic-1',
            projectId: 'project-1',
            projectName: 'Product',
            loggedMinutes: null,
          },
        ],
      },
    ],
  ])('shows no quick action while %s', (_case, overrides) => {
    renderBoard(overrides as Partial<Parameters<typeof ExternalTaskKanban>[0]>);

    expect(screen.queryByRole('button', { name: 'Create DevChain task' })).not.toBeInTheDocument();
  });

  it('keeps a pending quick action focusable with aria-disabled and a guarded handler', () => {
    const onQuickImport = jest.fn();
    renderBoard({ onQuickImport, quickImportPendingTaskId: 'ENG-1' });
    const quick = screen.getByRole('button', { name: 'Create DevChain task' });

    expect(quick).toHaveAttribute('aria-disabled', 'true');
    expect(quick).not.toHaveAttribute('disabled');
    quick.focus();
    expect(quick).toHaveFocus();

    fireEvent.click(quick);
    expect(onQuickImport).not.toHaveBeenCalled();
  });

  it('registers live quick-action buttons by task id and removes them on unmount', () => {
    const registry = new Map<string, HTMLButtonElement>();
    const { rerender } = render(
      <MemoryRouter>
        <ExternalTaskKanban
          columns={columns}
          onOpenTask={jest.fn()}
          links={[unlinked]}
          onQuickImport={jest.fn()}
          quickActionFocusRegistry={registry}
        />
      </MemoryRouter>,
    );

    const quick = screen.getByRole('button', { name: 'Create DevChain task' });
    expect(registry.get('ENG-1')).toBe(quick);

    // A column move remounts the card; the registry tracks the live element.
    const moved = [
      { ...columns[0], tasks: [] },
      { ...columns[0], key: 'done', name: 'Done', tasks: columns[0].tasks },
    ];
    rerender(
      <MemoryRouter>
        <ExternalTaskKanban
          columns={moved}
          onOpenTask={jest.fn()}
          links={[unlinked]}
          onQuickImport={jest.fn()}
          quickActionFocusRegistry={registry}
        />
      </MemoryRouter>,
    );
    const remounted = screen.getByRole('button', { name: 'Create DevChain task' });
    expect(remounted).not.toBe(quick);
    expect(registry.get('ENG-1')).toBe(remounted);

    rerender(
      <MemoryRouter>
        <ExternalTaskKanban
          columns={[{ ...columns[0], tasks: [] }]}
          onOpenTask={jest.fn()}
          links={[unlinked]}
          onQuickImport={jest.fn()}
          quickActionFocusRegistry={registry}
        />
      </MemoryRouter>,
    );
    expect(registry.has('ENG-1')).toBe(false);
  });

  it('has no accessibility violations with the quick action visible or pending', async () => {
    const first = renderBoard();
    expect(await axe(first.container)).toHaveNoViolations();
    cleanup();

    const second = renderBoard({ quickImportPendingTaskId: 'ENG-1' });
    expect(await axe(second.container)).toHaveNoViolations();
  });
});
