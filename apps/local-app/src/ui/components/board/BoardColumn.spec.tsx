import type { ReactNode } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { BoardColumn, type BoardColumnProps } from '@/ui/components/board/BoardColumn';
import type { Epic, Status } from '@/ui/types';
import type { BoardRelationQuickLinkBindings } from '@/ui/hooks/useBoardRelationQuickLink';

jest.mock('@/ui/components/board/EpicContextMenu', () => ({
  EpicContextMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
jest.mock('@/ui/components/board/EpicCard', () => ({
  EpicCard: ({
    renderPreview,
    isActiveParent,
    source,
    relationQuickLink,
    ...rest
  }: {
    renderPreview?: () => ReactNode;
    isActiveParent: boolean;
    source?: { remoteKey: string };
    relationQuickLink?: BoardRelationQuickLinkBindings;
    'data-relation-epic-id'?: string;
  }) => (
    <div
      data-testid="epic-card"
      data-active-parent={String(isActiveParent)}
      data-source-key={source?.remoteKey ?? ''}
      data-relation-enabled={String(Boolean(relationQuickLink))}
      data-relation-id={rest['data-relation-epic-id'] ?? ''}
    >
      {renderPreview?.()}
    </div>
  ),
}));
jest.mock('@/ui/components/shared/EpicPreview', () => ({
  __esModule: true,
  default: ({ metaRight }: { metaRight?: ReactNode }) => <div>{metaRight}</div>,
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

function quickLinkBindings(): BoardRelationQuickLinkBindings {
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
  };
}

describe('BoardColumn preview adapter', () => {
  it('stops propagation and forwards the epic-shaped detail intent', () => {
    const onOpenEpicDetails = jest.fn();
    const documentClick = jest.fn();
    const props: BoardColumnProps = {
      status,
      epics: [epic],
      onAddEpic: jest.fn(),
      onEditEpic: jest.fn(),
      onDeleteEpic: jest.fn(),
      onDragStart: jest.fn(),
      onDragEnd: jest.fn(),
      onDragOver: jest.fn(),
      onDrop: jest.fn(),
      isActiveDrop: false,
      draggedEpic: null,
      onKeyboardMove: jest.fn(),
      onToggleParentFilter: jest.fn(),
      activeParentId: epic.id,
      statusOrder: [status],
      getAgentName: jest.fn(() => null),
      onCollapseColumn: jest.fn(),
      onBulkEdit: jest.fn(),
      onOpenEpicDetails,
      isLightColor: jest.fn(() => true),
    };
    document.addEventListener('click', documentClick);
    render(<BoardColumn {...props} />);

    fireEvent.click(screen.getByRole('button', { name: 'Open epic details' }));

    expect(onOpenEpicDetails).toHaveBeenCalledWith(epic);
    expect(documentClick).not.toHaveBeenCalled();
    expect(screen.getByTestId('epic-card')).toHaveAttribute('data-active-parent', 'true');
    document.removeEventListener('click', documentClick);
  });

  it('passes one stored source per imported Epic and none for native Epics', () => {
    const nativeEpic = epic;
    const importedEpic = { ...epic, id: 'epic-2' };
    const props: BoardColumnProps = {
      status,
      epics: [nativeEpic, importedEpic],
      onAddEpic: jest.fn(),
      onEditEpic: jest.fn(),
      onDeleteEpic: jest.fn(),
      onDragStart: jest.fn(),
      onDragEnd: jest.fn(),
      onDragOver: jest.fn(),
      onDrop: jest.fn(),
      isActiveDrop: false,
      draggedEpic: null,
      onKeyboardMove: jest.fn(),
      onToggleParentFilter: jest.fn(),
      activeParentId: null,
      statusOrder: [status],
      getAgentName: jest.fn(() => null),
      onCollapseColumn: jest.fn(),
      onBulkEdit: jest.fn(),
      onOpenEpicDetails: jest.fn(),
      isLightColor: jest.fn(() => true),
      externalSources: new Map([['epic-2', { remoteKey: 'ENG-2', provider: 'jira' } as never]]),
    };
    render(<BoardColumn {...props} />);

    const cards = screen.getAllByTestId('epic-card');
    expect(cards).toHaveLength(2);
    expect(cards[0]).toHaveAttribute('data-source-key', '');
    expect(cards[1]).toHaveAttribute('data-source-key', 'ENG-2');
  });

  it('marks only expanded cards as quick-link targets and cancels on vertical scrolling', () => {
    const relationQuickLink = quickLinkBindings();
    const props: BoardColumnProps = {
      status,
      epics: [epic],
      onAddEpic: jest.fn(),
      onEditEpic: jest.fn(),
      onDeleteEpic: jest.fn(),
      onDragStart: jest.fn(),
      onDragEnd: jest.fn(),
      onDragOver: jest.fn(),
      onDrop: jest.fn(),
      isActiveDrop: false,
      draggedEpic: null,
      onKeyboardMove: jest.fn(),
      onToggleParentFilter: jest.fn(),
      activeParentId: null,
      statusOrder: [status],
      getAgentName: jest.fn(() => null),
      onCollapseColumn: jest.fn(),
      onBulkEdit: jest.fn(),
      onOpenEpicDetails: jest.fn(),
      isLightColor: jest.fn(() => true),
      relationQuickLink,
    };
    render(<BoardColumn {...props} />);

    const card = screen.getByTestId('epic-card');
    expect(card).toHaveAttribute('data-relation-enabled', 'true');
    expect(card).toHaveAttribute('data-relation-id', epic.id);
    fireEvent.scroll(card.parentElement!);
    expect(relationQuickLink.cancel).toHaveBeenCalled();
  });
});
