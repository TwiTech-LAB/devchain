import type { ReactNode } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { MemoryRouter } from 'react-router-dom';
import { EpicCard, type EpicCardProps } from '@/ui/components/board/EpicCard';
import type { ExternalTaskSourceSummary } from '@/modules/external-integrations/models/external-provider.models';
import type { Epic, Status } from '@/ui/types';

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
