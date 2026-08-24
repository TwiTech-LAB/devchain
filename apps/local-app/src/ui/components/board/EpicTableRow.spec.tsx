import type { ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BoardListView } from '@/ui/components/board/BoardListView';
import { EpicTableRow } from '@/ui/components/board/EpicTableRow';
import type { Epic, Status } from '@/ui/types';

// Layer: component unit. The fetch factory and tooltip wrapper are stubbed
// because this spec owns the root-row time badge, the child-row exclusion,
// and the List-view forwarding — not tooltip or transport composition.
const fetchMock = jest.fn();

jest.mock('@/ui/hooks/useFetchFactory', () => ({
  useFetchFactory: () => fetchMock,
}));

jest.mock('@/ui/components/shared/EpicTooltipWrapper', () => ({
  EpicTooltipWrapper: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

// Radix Select checks pointer capture APIs that JSDOM does not implement
if (!HTMLElement.prototype.hasPointerCapture) {
  HTMLElement.prototype.hasPointerCapture = () => false;
  HTMLElement.prototype.releasePointerCapture = () => {};
}

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

function renderRow(epic: Epic, timeTotalMinutes?: number) {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <table>
        <tbody>
          <EpicTableRow
            epic={epic}
            statuses={[status]}
            agents={[]}
            timeTotalMinutes={timeTotalMinutes}
          />
        </tbody>
      </table>
    </QueryClientProvider>,
  );
}

describe('EpicTableRow estimated-time badge', () => {
  it('badges a root row next to the title', () => {
    renderRow(createEpic(), 90);

    const badge = screen.getByTitle('Estimated agent time');
    expect(badge).toHaveTextContent('1h 30m');
  });

  it('renders no badge without a positive total', () => {
    renderRow(createEpic(), 0);

    expect(screen.queryByTitle('Estimated agent time')).not.toBeInTheDocument();
  });
});

describe('EpicTableRow expanded sub-epic rows', () => {
  it('never badges child rows even after expansion', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [createEpic({ id: 'child-1', title: 'Child epic', parentId: 'epic-1' })],
      }),
    });

    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <table>
          <tbody>
            <EpicTableRow
              epic={createEpic()}
              statuses={[status]}
              agents={[]}
              isExpanded
              onToggleExpand={jest.fn()}
              subEpicCount={1}
              timeTotalMinutes={90}
            />
          </tbody>
        </table>
      </QueryClientProvider>,
    );

    expect(await screen.findByText('Child epic')).toBeInTheDocument();

    // Exactly one badge: the parent row. Child rows receive no time prop.
    expect(screen.getAllByTitle('Estimated agent time')).toHaveLength(1);
  });

  it('still expands through the chevron while badged', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [createEpic({ id: 'child-1', title: 'Child epic', parentId: 'epic-1' })],
      }),
    });

    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <table>
          <tbody>
            <EpicTableRow
              epic={createEpic()}
              statuses={[status]}
              agents={[]}
              subEpicCount={1}
              timeTotalMinutes={90}
            />
          </tbody>
        </table>
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: /expand sub-epics/i }));

    await waitFor(() => expect(screen.getByText('Child epic')).toBeInTheDocument());
    expect(screen.getAllByTitle('Estimated agent time')).toHaveLength(1);
    expect(screen.getByTitle('Estimated agent time')).toHaveTextContent('1h 30m');
  });
});

describe('BoardListView time forwarding', () => {
  it('forwards root totals to rows', () => {
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <BoardListView
          epics={[createEpic()]}
          statuses={[status]}
          agents={[]}
          timeTotals={new Map([['epic-1', 90]])}
        />
      </QueryClientProvider>,
    );

    expect(screen.getByTitle('Estimated agent time')).toHaveTextContent('1h 30m');
  });
});
