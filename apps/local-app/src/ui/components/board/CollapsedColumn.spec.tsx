import type { ReactNode } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { CollapsedColumn } from '@/ui/components/board/CollapsedColumn';
import type { EpicRelationCounts } from '@/ui/hooks/useEpicRelationCountsBatch';
import type { Epic, Status } from '@/ui/types';

// Layer: component unit. The tooltip wrapper is stubbed because this spec
// owns the compact-row time badge and the preserved column interaction
// contract, not tooltip composition.
jest.mock('@/ui/components/shared/EpicTooltipWrapper', () => ({
  EpicTooltipWrapper: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

const status: Status = {
  id: 'todo',
  projectId: 'project-1',
  label: 'Todo',
  color: '#2563eb',
  position: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function createEpic(overrides: Partial<Epic> = {}): Epic {
  return {
    id: 'epic-1',
    projectId: 'project-1',
    title: 'Root epic',
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

function renderColumn(
  epics: Epic[],
  timeTotals?: ReadonlyMap<string, number>,
  handlers: Partial<Parameters<typeof CollapsedColumn>[0]> = {},
) {
  const props = {
    status,
    count: epics.length,
    epics,
    onExpand: jest.fn(),
    onAddEpic: jest.fn(),
    onDragOver: jest.fn(),
    onDrop: jest.fn(),
    isActiveDrop: false,
    onDragStartEpic: jest.fn(),
    onDragEndEpic: jest.fn(),
    getAgentName: () => null,
    onEpicEdit: jest.fn(),
    onEpicDelete: jest.fn(),
    onEpicBulkEdit: jest.fn(),
    onEpicViewDetails: jest.fn(),
    onEpicToggleParentFilter: jest.fn(),
    isLightColor: () => false,
    timeTotals,
    ...handlers,
  };
  render(<CollapsedColumn {...props} />);
  return props;
}

describe('CollapsedColumn relation total badge', () => {
  const counts: EpicRelationCounts = { related: 2, blocks: 1, blockedBy: 0, total: 3 };

  function renderWithRelations(
    epics: Epic[],
    relationCounts?: ReadonlyMap<string, EpicRelationCounts>,
    handlers: Partial<Parameters<typeof CollapsedColumn>[0]> = {},
  ) {
    return renderColumn(epics, undefined, { relationCounts, ...handlers });
  }

  it('shows one compact total badge on the row', () => {
    renderWithRelations([createEpic()], new Map([['epic-1', counts]]));

    const badge = screen.getByTestId('epic-relation-total-badge');
    expect(badge).toHaveTextContent('3');
    expect(badge).not.toHaveTextContent('Related');
    expect(badge).not.toHaveTextContent('Blocks');
  });

  it('explains in the tooltip that counts can include Epics outside the current board', () => {
    renderWithRelations([createEpic()], new Map([['epic-1', counts]]));

    expect(screen.getByTestId('epic-relation-total-badge')).toHaveAttribute(
      'title',
      expect.stringContaining('outside the current board'),
    );
  });

  it('keeps the compact one-line row beside the title like the time badge', () => {
    renderWithRelations([createEpic()], new Map([['epic-1', counts]]));

    const title = screen.getByText('Root epic');
    const badge = screen.getByTestId('epic-relation-total-badge');
    expect(badge.parentElement).toContainElement(title);
    expect(badge.parentElement).toHaveClass('flex', 'items-center');
    expect(title).toHaveClass('truncate');
    expect(title.closest('.rounded')!.querySelector('.mt-1')).toBeNull();
  });

  it('badges child rows too; a zero total renders nothing', () => {
    renderWithRelations(
      [
        createEpic({ id: 'child-1', parentId: 'epic-1' }),
        createEpic({ id: 'zero-1', title: 'Zero epic' }),
      ],
      new Map([
        ['child-1', counts],
        ['zero-1', { related: 0, blocks: 0, blockedBy: 0, total: 0 }],
      ]),
    );

    expect(screen.getAllByTestId('epic-relation-total-badge')).toHaveLength(1);
  });

  it('renders no badge without mapped counts', () => {
    renderWithRelations([createEpic()]);

    expect(screen.queryByTestId('epic-relation-total-badge')).not.toBeInTheDocument();
  });
});

describe('CollapsedColumn estimated-time badge', () => {
  it('badges a root epic row with the mapped total', () => {
    renderColumn([createEpic()], new Map([['epic-1', 90]]));

    const badge = screen.getByTitle('Estimated agent time');
    expect(badge).toHaveTextContent('1h 30m');
  });

  it('keeps the compact one-line row when a timed root has no tags or sub-epic count', () => {
    renderColumn([createEpic()], new Map([['epic-1', 90]]));

    const title = screen.getByText('Root epic');
    const row = title.closest('.rounded')!;
    // No secondary metadata row is introduced by the badge alone.
    expect(row.querySelector('.mt-1')).toBeNull();
    // The badge sits on the title line, not on its own row.
    const badge = screen.getByTitle('Estimated agent time');
    expect(badge.parentElement).toContainElement(title);
    expect(badge.parentElement).toHaveClass('flex', 'items-center');
    // Title truncation survives the inline placement.
    expect(title).toHaveClass('truncate');
  });

  it('still renders the metadata row when tags or sub-epic counts exist', () => {
    renderColumn([createEpic({ tags: ['ops'] })], new Map([['epic-1', 90]]), {
      subEpicCounts: { 'epic-1': 2 },
    });

    const row = screen.getByText('Root epic').closest('.rounded')!;
    expect(row.querySelector('.mt-1')).not.toBeNull();
    expect(screen.getByTitle('ops')).toBeInTheDocument();
    expect(screen.getByTitle('Estimated agent time')).toBeInTheDocument();
  });

  it('never badges child rows even when a total is mapped', () => {
    renderColumn([createEpic({ id: 'child-1', parentId: 'epic-1' })], new Map([['child-1', 90]]));

    expect(screen.queryByTitle('Estimated agent time')).not.toBeInTheDocument();
    // The row still renders with its title intact.
    expect(screen.getByText('Root epic')).toBeInTheDocument();
  });

  it('renders no badge without mapped time', () => {
    renderColumn([createEpic()]);

    expect(screen.queryByTitle('Estimated agent time')).not.toBeInTheDocument();
  });
});

describe('CollapsedColumn interaction contract', () => {
  it('expands on Enter and Space and adds on + from the column keyboard target', () => {
    const props = renderColumn([createEpic()]);
    const column = screen.getByRole('button', { name: /Todo column \(1 epic\)/ });

    column.focus();
    fireEvent.keyDown(column, { key: 'Enter' });
    expect(props.onExpand).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(column, { key: ' ' });
    expect(props.onExpand).toHaveBeenCalledTimes(2);

    fireEvent.keyDown(column, { key: '+' });
    expect(props.onAddEpic).toHaveBeenCalledWith(status.id);
    expect(props.onExpand).toHaveBeenCalledTimes(2);
  });

  it('starts epic drags from the compact row', () => {
    const epic = createEpic();
    const props = renderColumn([epic]);

    fireEvent.dragStart(screen.getByText('Root epic'));

    expect(props.onDragStartEpic).toHaveBeenCalledWith(epic);
  });

  it('keeps the compact title truncation styling', () => {
    renderColumn([createEpic()]);

    expect(screen.getByText('Root epic')).toHaveClass('truncate');
  });
});
