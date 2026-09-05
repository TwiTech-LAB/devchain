import type { ReactNode } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { EpicCard, type EpicCardProps } from '@/ui/components/board/EpicCard';
import type { ExternalTaskSourceSummary } from '@/modules/external-integrations/models/external-provider.models';
import type { Epic, Status } from '@/ui/types';
import type { BoardRelationQuickLinkBindings } from '@/ui/hooks/useBoardRelationQuickLink';

// Layer: card composition unit. The relation-detail hook and project selection
// are stubbed because this spec owns card-level intent wiring and drag fences;
// the preview's own suites own navigation and focus behavior.
const useEpicRelationsMock = jest.fn();
jest.mock('@/ui/hooks/useEpicRelations', () => ({
  useEpicRelations: (...args: unknown[]) => useEpicRelationsMock(...args),
}));

const mockProjectSelection = {
  selectedWorkspace: { id: 'workspace-1', name: 'Workspace One' },
  activateProject: jest.fn(),
};

jest.mock('@/ui/hooks/useProjectSelection', () => ({
  useSelectedProject: () => mockProjectSelection,
}));

jest.mock('@/ui/components/shared/EpicTooltipWrapper', () => ({
  EpicTooltipWrapper: ({
    children,
    onViewDetails,
  }: {
    children: ReactNode;
    onViewDetails?: (event: React.MouseEvent) => void;
  }) => (
    <div>
      {children}
      <button
        type="button"
        onClick={(event) => onViewDetails?.(event)}
        aria-label="Tooltip epic details"
      >
        Details
      </button>
    </div>
  ),
}));

beforeEach(() => {
  useEpicRelationsMock.mockReset();
  useEpicRelationsMock.mockReturnValue({ data: undefined, isLoading: false, isError: false });
  mockProjectSelection.activateProject.mockClear();
  mockProjectSelection.selectedWorkspace = { id: 'workspace-1', name: 'Workspace One' };
});

const status: Status = {
  id: 'todo',
  projectId: 'project-1',
  label: 'Todo',
  color: '#ffffff',
  position: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function createEpic(overrides: Partial<Epic> = {}): Epic {
  return {
    id: 'epic-1',
    projectId: 'project-1',
    title: 'Parent epic',
    description: null,
    statusId: status.id,
    version: 1,
    parentId: null,
    agentId: null,
    createdBy: null,
    tags: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function renderCard(epic = createEpic(), isActiveParent = false) {
  const props: EpicCardProps = {
    epic,
    onEdit: jest.fn(),
    onDelete: jest.fn(),
    onDragStart: jest.fn(),
    onDragEnd: jest.fn(),
    isDragging: false,
    onKeyboardMove: jest.fn(),
    onToggleParentFilter: jest.fn(),
    isActiveParent,
    onOpenEpicDetails: jest.fn(),
    statuses: [status],
  };
  render(<EpicCard {...props} />);
  return props;
}

const externalSource: ExternalTaskSourceSummary = {
  provider: 'jira',
  remoteTaskId: 'ENG-1',
  remoteKey: 'ENG-1',
  title: 'Remote title',
  workAreaName: 'Delivery',
  statusName: 'In Progress',
  webUrl: 'https://acme.atlassian.net/browse/ENG-1',
  linkedAt: '2026-08-19T10:00:00.000Z',
};

function renderSourcedCard(epic = createEpic(), overrides: Partial<EpicCardProps> = {}) {
  const props: EpicCardProps = {
    epic,
    onEdit: jest.fn(),
    onDelete: jest.fn(),
    onDragStart: jest.fn(),
    onDragEnd: jest.fn(),
    isDragging: false,
    onKeyboardMove: jest.fn(),
    onToggleParentFilter: jest.fn(),
    isActiveParent: false,
    onOpenEpicDetails: jest.fn(),
    statuses: [status],
    source: externalSource,
    ...overrides,
  };
  const view = render(
    <MemoryRouter>
      <main>
        <EpicCard {...props} />
      </main>
    </MemoryRouter>,
  );
  return { props, view };
}

describe('EpicCard detail intent', () => {
  it('underlines the active parent title', () => {
    const props = renderCard(createEpic(), true);

    expect(screen.getByTestId(`epic-title-${props.epic.id}`)).toHaveClass(
      'underline',
      'decoration-2',
    );
  });

  it('keeps a parent title click on the parent-filter intent', () => {
    const props = renderCard();

    fireEvent.click(screen.getByRole('button', { name: 'Open epic Parent epic' }));

    expect(props.onToggleParentFilter).toHaveBeenCalledWith(props.epic);
    expect(props.onOpenEpicDetails).not.toHaveBeenCalled();
  });

  it('opens child details from the child title', () => {
    const props = renderCard(createEpic({ title: 'Child epic', parentId: 'parent-1' }));

    fireEvent.click(screen.getByRole('button', { name: 'Open epic Child epic' }));

    expect(props.onOpenEpicDetails).toHaveBeenCalledWith(props.epic);
    expect(props.onToggleParentFilter).not.toHaveBeenCalled();
  });

  it('opens details with Enter using the required epic-shaped intent', () => {
    const props = renderCard();

    fireEvent.keyDown(screen.getByLabelText(/^Epic: Parent epic/), { key: 'Enter' });

    expect(props.onOpenEpicDetails).toHaveBeenCalledWith(props.epic);
  });

  it('opens details from the tooltip action', () => {
    const props = renderCard();

    fireEvent.click(screen.getByRole('button', { name: 'Tooltip epic details' }));

    expect(props.onOpenEpicDetails).toHaveBeenCalledWith(props.epic);
  });
});

describe('EpicCard estimated-time badge', () => {
  function renderCardWithTime(
    epic = createEpic(),
    overrides: Partial<EpicCardProps> = {},
  ): EpicCardProps {
    const props: EpicCardProps = {
      epic,
      onEdit: jest.fn(),
      onDelete: jest.fn(),
      onDragStart: jest.fn(),
      onDragEnd: jest.fn(),
      isDragging: false,
      onKeyboardMove: jest.fn(),
      onToggleParentFilter: jest.fn(),
      isActiveParent: false,
      onOpenEpicDetails: jest.fn(),
      statuses: [status],
      ...overrides,
    };
    render(
      <main>
        <EpicCard {...props} />
      </main>,
    );
    return props;
  }

  it('badges a root card with the estimated total', () => {
    renderCardWithTime(createEpic(), { timeTotalMinutes: 90 });

    const badge = screen.getByTitle('Estimated agent time');
    expect(badge).toHaveTextContent('1h 30m');
  });

  it('places sub-epic counts left and estimated time right in one footer row', () => {
    renderCardWithTime(createEpic(), {
      timeTotalMinutes: 90,
      subEpicCountsByStatus: { [status.id]: 2 },
    });

    const statusSummary = screen.getByTitle(status.label);
    const badge = screen.getByTitle('Estimated agent time');
    const footer = statusSummary.parentElement?.parentElement;
    expect(footer).toBe(badge.parentElement?.parentElement);
    expect(footer).toHaveClass('justify-between');
    expect(statusSummary.parentElement).toHaveClass('flex-wrap');
    expect(badge.parentElement).toHaveClass('ml-auto', 'shrink-0');
  });

  it('never badges child cards even when a total is provided', () => {
    renderCardWithTime(createEpic({ title: 'Child epic', parentId: 'parent-1' }), {
      timeTotalMinutes: 90,
    });

    expect(screen.queryByTitle('Estimated agent time')).not.toBeInTheDocument();
  });

  it('renders no badge without a positive total', () => {
    renderCardWithTime(createEpic(), { timeTotalMinutes: 0 });

    expect(screen.queryByTitle('Estimated agent time')).not.toBeInTheDocument();
  });
});

describe('EpicCard relation badges', () => {
  function renderCardWithRelations(
    epic = createEpic(),
    overrides: Partial<EpicCardProps> = {},
  ): EpicCardProps {
    const props: EpicCardProps = {
      epic,
      onEdit: jest.fn(),
      onDelete: jest.fn(),
      onDragStart: jest.fn(),
      onDragEnd: jest.fn(),
      isDragging: false,
      onKeyboardMove: jest.fn(),
      onToggleParentFilter: jest.fn(),
      isActiveParent: false,
      onOpenEpicDetails: jest.fn(),
      statuses: [status],
      relationCounts: { related: 2, blocks: 0, blockedBy: 1, total: 3 },
      ...overrides,
    };
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <main>
            <EpicCard {...props} />
          </main>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    return props;
  }

  it('shows only the nonzero typed badges with counts', () => {
    renderCardWithRelations();

    expect(screen.getByText('Related 2')).toBeInTheDocument();
    expect(screen.getByText('Blocked by 1')).toBeInTheDocument();
    expect(screen.queryByText('Blocks 0')).not.toBeInTheDocument();
  });

  it('explains in tooltips that counts can include Epics outside the current board', () => {
    renderCardWithRelations();

    for (const badge of [
      screen.getByText('Related 2'),
      screen.getByText('Blocked by 1'),
    ] as HTMLElement[]) {
      expect(badge).toHaveAttribute('title', expect.stringContaining('outside the current board'));
    }
  });

  it('renders no badges when every typed count is zero', () => {
    renderCardWithRelations(createEpic(), {
      relationCounts: { related: 0, blocks: 0, blockedBy: 0, total: 0 },
    });

    expect(screen.queryByTestId('epic-relation-badges')).not.toBeInTheDocument();
  });

  it('badges child cards too, unlike root-only time totals', () => {
    renderCardWithRelations(createEpic({ title: 'Child epic', parentId: 'parent-1' }));

    expect(screen.getByText('Related 2')).toBeInTheDocument();
  });

  it('joins relation badges with the time badge in the footer row', () => {
    renderCardWithRelations(createEpic(), { timeTotalMinutes: 90 });

    const badges = screen.getByTestId('epic-relation-badges');
    const timeBadge = screen.getByTitle('Estimated agent time');
    // Both sit in the same trailing footer container, right-aligned.
    expect(badges.parentElement).toBe(timeBadge.parentElement);
    expect(badges.parentElement).toHaveClass('ml-auto', 'shrink-0');
  });

  it('passes composed accessibility checks with badges present', async () => {
    const { baseElement } = renderCardView(createEpic());
    expect(await axe(baseElement)).toHaveNoViolations();
  });

  function renderCardView(epic: Epic) {
    const props: EpicCardProps = {
      epic,
      onEdit: jest.fn(),
      onDelete: jest.fn(),
      onDragStart: jest.fn(),
      onDragEnd: jest.fn(),
      isDragging: false,
      onKeyboardMove: jest.fn(),
      onToggleParentFilter: jest.fn(),
      isActiveParent: false,
      onOpenEpicDetails: jest.fn(),
      statuses: [status],
      relationCounts: { related: 2, blocks: 0, blockedBy: 1, total: 3 },
    };
    return render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <main>
            <EpicCard {...props} />
          </main>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  // jsdom has no PointerEvent constructor, so the pointer fields travel as
  // own properties on a MouseEvent to reach the React handlers.
  function firePointer(
    element: HTMLElement,
    type: 'pointerdown' | 'pointerup',
    init: { pointerId: number },
  ) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 });
    Object.assign(event, { pointerType: 'mouse', pointerId: init.pointerId });
    fireEvent(element, event);
  }

  it('keeps the preview trigger activation off every card intent', () => {
    const props = renderCardWithRelations();
    const previewTrigger = screen.getByTestId('epic-relation-badges');

    fireEvent.click(previewTrigger);
    fireEvent.keyDown(previewTrigger, { key: 'Enter' });
    fireEvent.keyDown(previewTrigger, { key: 'ArrowRight' });

    expect(props.onOpenEpicDetails).not.toHaveBeenCalled();
    expect(props.onToggleParentFilter).not.toHaveBeenCalled();
    expect(props.onKeyboardMove).not.toHaveBeenCalled();
  });

  it('keeps relation title clicks and drags off every card intent and card drag', () => {
    useEpicRelationsMock.mockReturnValue({
      data: {
        pages: [
          {
            items: [
              {
                relationId: 'rel-1',
                type: 'related',
                sourceEpicId: 'epic-1',
                targetEpicId: 'epic-2',
                relatedEpic: {
                  id: 'epic-2',
                  shortId: 'epic-2',
                  title: 'Related epic',
                  status: { id: 'todo', label: 'Todo', color: '#ffffff' },
                  project: { id: 'project-1', name: 'Current Project' },
                },
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z',
              },
            ],
            total: 1,
            limit: 20,
            offset: 0,
          },
        ],
        pageParams: [0],
      },
      isLoading: false,
      isError: false,
    });
    const props = renderCardWithRelations();
    const previewTrigger = screen.getByTestId('epic-relation-badges');

    previewTrigger.focus();
    fireEvent.focus(previewTrigger);

    const link = screen.getByRole('link', { name: 'Related epic' });
    expect(link).toHaveAttribute('draggable', 'false');

    // The preview portal still bubbles through the card's React tree, so the
    // title must stop both the native drag and the activation intents.
    fireEvent.dragStart(link);
    expect(props.onDragStart).not.toHaveBeenCalled();

    fireEvent.click(link);
    expect(props.onOpenEpicDetails).not.toHaveBeenCalled();
    expect(props.onToggleParentFilter).not.toHaveBeenCalled();
    expect(props.onDelete).not.toHaveBeenCalled();
    expect(props.onEdit).not.toHaveBeenCalled();
  });

  it('suppresses card drag while the preview pointer is down and restores it after release', () => {
    const props = renderCardWithRelations();
    const card = screen.getByRole('group', { name: /^Epic: Parent epic/ });
    const previewTrigger = screen.getByTestId('epic-relation-badges');

    firePointer(previewTrigger, 'pointerdown', { pointerId: 11 });
    expect(fireEvent.dragStart(card)).toBe(false);
    expect(props.onDragStart).not.toHaveBeenCalled();

    // Pointer capture keeps the release on the trigger even outside it; the
    // release clears the fence so a later ordinary card drag starts.
    firePointer(previewTrigger, 'pointerup', { pointerId: 11 });
    expect(fireEvent.dragStart(card)).toBe(true);
    expect(props.onDragStart).toHaveBeenCalledWith(props.epic);
  });

  it('restores card drag when the armed preview badge unmounts', () => {
    const props: EpicCardProps = {
      epic: createEpic(),
      onEdit: jest.fn(),
      onDelete: jest.fn(),
      onDragStart: jest.fn(),
      onDragEnd: jest.fn(),
      isDragging: false,
      onKeyboardMove: jest.fn(),
      onToggleParentFilter: jest.fn(),
      isActiveParent: false,
      onOpenEpicDetails: jest.fn(),
      statuses: [status],
      relationCounts: { related: 2, blocks: 0, blockedBy: 1, total: 3 },
    };
    const queryClient = new QueryClient();
    const view = render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <main>
            <EpicCard {...props} />
          </main>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const previewTrigger = screen.getByTestId('epic-relation-badges');

    firePointer(previewTrigger, 'pointerdown', { pointerId: 13 });
    expect(fireEvent.dragStart(screen.getByRole('group', { name: /^Epic: Parent epic/ }))).toBe(
      false,
    );

    view.rerender(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <main>
            <EpicCard
              {...props}
              relationCounts={{ related: 0, blocks: 0, blockedBy: 0, total: 0 }}
            />
          </main>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(screen.queryByTestId('epic-relation-badges')).not.toBeInTheDocument();
    expect(fireEvent.dragStart(screen.getByRole('group', { name: /^Epic: Parent epic/ }))).toBe(
      true,
    );
    expect(props.onDragStart).toHaveBeenCalledWith(props.epic);
  });

  it('clears the drag fence on card drag-end', () => {
    const props = renderCardWithRelations();
    const card = screen.getByRole('group', { name: /^Epic: Parent epic/ });
    const previewTrigger = screen.getByTestId('epic-relation-badges');

    firePointer(previewTrigger, 'pointerdown', { pointerId: 12 });
    fireEvent.dragEnd(card);

    expect(props.onDragEnd).toHaveBeenCalledTimes(1);
    expect(fireEvent.dragStart(card)).toBe(true);
  });
});

describe('EpicCard sourced composition', () => {
  function cardGroup() {
    return screen.getByRole('group', { name: /^Epic: Parent epic/ });
  }

  it('renders the draggable group and source footer as siblings inside one wrapper', () => {
    const { view } = renderSourcedCard();

    const group = cardGroup();
    const wrapper = group.parentElement!;
    expect(wrapper.tagName).toBe('DIV');
    // Exactly two children: the card group and the source footer.
    expect(wrapper.children).toHaveLength(2);
    expect(group).toHaveAttribute('draggable', 'true');
    expect(
      screen.getByRole('link', { name: 'Open linked task ENG-1 in DevChain' }),
    ).toBeInTheDocument();
    // The source anchor never lives inside the draggable group.
    expect(group.contains(screen.getByRole('link'))).toBe(false);
    void view;
  });

  it('exposes group semantics with direct keyboard shortcuts', () => {
    const { props } = renderSourcedCard();
    const group = cardGroup();

    expect(group).toHaveAttribute('tabindex', '0');

    fireEvent.keyDown(group, { key: 'ArrowRight' });
    expect(props.onKeyboardMove).toHaveBeenCalledWith(props.epic, 'right');

    fireEvent.keyDown(group, { key: 'Enter' });
    expect(props.onOpenEpicDetails).toHaveBeenCalledWith(props.epic);
  });

  it('ignores descendant key events and keeps the title Enter on its own action', async () => {
    const user = userEvent.setup();
    const { props } = renderSourcedCard();

    const title = screen.getByRole('button', { name: 'Open epic Parent epic' });
    await user.click(title);
    expect(props.onToggleParentFilter).toHaveBeenCalledWith(props.epic);
    expect(props.onOpenEpicDetails).not.toHaveBeenCalled();

    // Enter on the title bubbles to the group but must not double-fire.
    fireEvent.keyDown(title, { key: 'Enter' });
    fireEvent.keyDown(title, { key: 'ArrowLeft' });
    expect(props.onOpenEpicDetails).not.toHaveBeenCalled();
    expect(props.onKeyboardMove).not.toHaveBeenCalled();
  });

  it('cannot move or drag the Epic from the source link', () => {
    const { props } = renderSourcedCard();
    const anchor = screen.getByRole('link', { name: 'Open linked task ENG-1 in DevChain' });

    fireEvent.click(anchor);
    fireEvent.keyDown(anchor, { key: 'Enter' });
    const drag = fireEvent.dragStart(anchor);

    expect(props.onOpenEpicDetails).not.toHaveBeenCalled();
    expect(props.onDragStart).not.toHaveBeenCalled();
    expect(drag).toBe(false);
  });

  it('applies drag visuals to the complete sourced wrapper', () => {
    renderSourcedCard(createEpic(), { isDragging: true });

    const wrapper = cardGroup().parentElement!;
    expect(wrapper.className).toContain('opacity-50');
    expect(wrapper.className).toContain('scale-95');
    expect(cardGroup().className).not.toContain('opacity-50');
  });

  it('forwards ref and trigger props to the wrapper for the context menu', () => {
    const ref = jest.fn();
    renderSourcedCard(createEpic(), { ref, id: 'sourced-card' });

    expect(ref).toHaveBeenCalledTimes(1);
    const wrapper = document.getElementById('sourced-card')!;
    expect(wrapper.tagName).toBe('DIV');
    expect(cardGroup().parentElement).toBe(wrapper);
  });

  it('passes composed accessibility checks without nested-interactive violations', async () => {
    const { view } = renderSourcedCard();

    expect(await axe(view.baseElement)).toHaveNoViolations();
  });

  it('keeps the unsourced card directly draggable without a wrapper', () => {
    const props: EpicCardProps = {
      epic: createEpic(),
      onEdit: jest.fn(),
      onDelete: jest.fn(),
      onDragStart: jest.fn(),
      onDragEnd: jest.fn(),
      isDragging: false,
      onKeyboardMove: jest.fn(),
      onToggleParentFilter: jest.fn(),
      isActiveParent: false,
      onOpenEpicDetails: jest.fn(),
      statuses: [status],
    };
    render(
      <main>
        <EpicCard {...props} />
      </main>,
    );

    const group = cardGroup();
    expect(group).toHaveAttribute('draggable', 'true');
    expect(group.parentElement!.tagName).toBe('MAIN');
  });
});

describe('EpicCard relation quick-link connector', () => {
  function quickLinkBindings(
    overrides: Partial<BoardRelationQuickLinkBindings> = {},
  ): BoardRelationQuickLinkBindings {
    return {
      selectionSourceId: null,
      pointerDown: jest.fn(),
      pointerMove: jest.fn(),
      pointerUp: jest.fn(),
      pointerCancel: jest.fn(),
      lostPointerCapture: jest.fn(),
      activate: jest.fn(),
      selectTarget: jest.fn(),
      cancel: jest.fn(),
      ...overrides,
    };
  }

  function renderQuickLinkCard(bindings = quickLinkBindings()) {
    const props: EpicCardProps = {
      epic: createEpic(),
      onEdit: jest.fn(),
      onDelete: jest.fn(),
      onDragStart: jest.fn(),
      onDragEnd: jest.fn(),
      isDragging: false,
      onKeyboardMove: jest.fn(),
      onToggleParentFilter: jest.fn(),
      isActiveParent: false,
      onOpenEpicDetails: jest.fn(),
      statuses: [status],
      relationQuickLink: bindings,
    };
    const view = render(
      <main>
        <EpicCard {...props} />
      </main>,
    );
    return { props, bindings, view };
  }

  it('synchronously suppresses native status drag after connector pointer-down', () => {
    const { props } = renderQuickLinkCard();
    const handle = screen.getByRole('button', { name: 'Link Parent epic to another epic' });
    const card = screen.getByRole('group', { name: /^Epic: Parent epic/ });

    fireEvent.pointerDown(handle, { button: 0, pointerId: 7, clientX: 10, clientY: 10 });
    expect(fireEvent.dragStart(card)).toBe(false);
    expect(props.onDragStart).not.toHaveBeenCalled();

    fireEvent.pointerUp(handle, { pointerId: 7, clientX: 10, clientY: 10 });
    expect(fireEvent.dragStart(card)).toBe(true);
    expect(props.onDragStart).toHaveBeenCalledWith(props.epic);
  });

  it('keeps connector activation and keys out of card shortcuts', () => {
    const { props, bindings } = renderQuickLinkCard();
    const handle = screen.getByRole('button', { name: 'Link Parent epic to another epic' });

    fireEvent.keyDown(handle, { key: 'Enter' });
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    fireEvent.keyDown(handle, { key: 'Delete' });
    fireEvent.click(handle);

    expect(bindings.activate).toHaveBeenCalledTimes(1);
    expect(props.onOpenEpicDetails).not.toHaveBeenCalled();
    expect(props.onKeyboardMove).not.toHaveBeenCalled();
    expect(props.onDelete).not.toHaveBeenCalled();
  });

  it('activates exactly once from Enter, Space, and an assistive click', async () => {
    const user = userEvent.setup();
    const { props, bindings } = renderQuickLinkCard();
    const handle = screen.getByRole('button', { name: 'Link Parent epic to another epic' });
    handle.focus();

    await user.keyboard('{Enter}');
    expect(bindings.activate).toHaveBeenCalledTimes(1);
    (bindings.activate as jest.Mock).mockClear();
    await user.keyboard(' ');
    expect(bindings.activate).toHaveBeenCalledTimes(1);
    (bindings.activate as jest.Mock).mockClear();
    fireEvent.click(handle, { detail: 0 });
    expect(bindings.activate).toHaveBeenCalledTimes(1);
    expect(props.onOpenEpicDetails).not.toHaveBeenCalled();
  });

  it('offers a focusable keyboard-safe target action only on other cards', () => {
    const bindings = quickLinkBindings({ selectionSourceId: 'source-epic' });
    const { props } = renderQuickLinkCard(bindings);
    const target = screen.getByRole('button', { name: 'Link here' });

    fireEvent.keyDown(target, { key: 'Enter' });
    fireEvent.keyDown(target, { key: 'ArrowLeft' });
    fireEvent.click(target);

    expect(bindings.selectTarget).toHaveBeenCalledWith(props.epic);
    expect(props.onOpenEpicDetails).not.toHaveBeenCalled();
    expect(props.onKeyboardMove).not.toHaveBeenCalled();
  });

  it('passes accessibility checks with connector and target action visible', async () => {
    const { view } = renderQuickLinkCard(quickLinkBindings({ selectionSourceId: 'source-epic' }));

    expect(await axe(view.baseElement)).toHaveNoViolations();
  });
});
