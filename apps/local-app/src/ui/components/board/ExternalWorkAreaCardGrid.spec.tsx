import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ExternalWorkAreaCardGrid } from '@/ui/components/board/ExternalWorkAreaCardGrid';
import type { ExternalWorkAreaCardModel } from '@/ui/hooks/board/useExternalMyWorkLanding';

// Layer: UI component unit. Pure presentation — the card model arrives fully derived,
// so no data hooks are involved and no mocks are needed.
function card(overrides: Partial<ExternalWorkAreaCardModel> = {}): ExternalWorkAreaCardModel {
  return {
    key: 'team-1:list-1',
    remoteId: 'list-1',
    scopeKey: 'team-1',
    name: 'Sprint board',
    kindLabel: 'List',
    description: 'Current sprint work',
    assignedTaskCount: 3,
    linkedTaskCount: null,
    locationLabel: 'Workspace / Product',
    workflowSummary: 'To do → Doing',
    refreshState: 'fresh',
    ...overrides,
  };
}

describe('ExternalWorkAreaCardGrid', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders name, location, workflow summary, count, and description', () => {
    render(<ExternalWorkAreaCardGrid cards={[card()]} onSelect={jest.fn()} />);

    expect(screen.getByRole('button', { name: /sprint board/i })).toBeInTheDocument();
    expect(screen.getByText('Workspace / Product')).toBeInTheDocument();
    expect(screen.getByText('List · To do → Doing')).toBeInTheDocument();
    expect(screen.getByText('Current sprint work')).toBeInTheDocument();
    expect(screen.getByText('3 assigned tasks · linked count unavailable')).toBeInTheDocument();
  });

  it('degrades gracefully when the description is missing', () => {
    render(<ExternalWorkAreaCardGrid cards={[card({ description: null })]} onSelect={jest.fn()} />);

    expect(screen.getByRole('button', { name: /sprint board/i })).toBeInTheDocument();
    expect(screen.getByText('3 assigned tasks · linked count unavailable')).toBeInTheDocument();
    expect(screen.queryByText('Current sprint work')).not.toBeInTheDocument();
  });

  it('renders the singular count for one assigned task', () => {
    render(
      <ExternalWorkAreaCardGrid cards={[card({ assignedTaskCount: 1 })]} onSelect={jest.fn()} />,
    );

    expect(screen.getByText('1 assigned task · linked count unavailable')).toBeInTheDocument();
  });

  it('renders singular and plural linked counts on the same compact line', () => {
    render(
      <ExternalWorkAreaCardGrid
        cards={[
          card({ key: 'k1', assignedTaskCount: 1, linkedTaskCount: 1 }),
          card({ key: 'k2', remoteId: 'list-2', assignedTaskCount: 3, linkedTaskCount: 2 }),
          card({ key: 'k3', remoteId: 'list-3', assignedTaskCount: 2, linkedTaskCount: 0 }),
        ]}
        onSelect={jest.fn()}
      />,
    );

    expect(screen.getByText('1 assigned task · 1 linked task')).toBeInTheDocument();
    expect(screen.getByText('3 assigned tasks · 2 linked tasks')).toBeInTheDocument();
    expect(screen.getByText('2 assigned tasks · 0 linked tasks')).toBeInTheDocument();
  });

  it('never renders a numeric zero while the linked count is unknown', () => {
    render(
      <ExternalWorkAreaCardGrid cards={[card({ linkedTaskCount: null })]} onSelect={jest.fn()} />,
    );

    expect(screen.getByText('3 assigned tasks · linked count unavailable')).toBeInTheDocument();
    expect(screen.queryByText(/0 linked/)).not.toBeInTheDocument();
  });

  it('renders remote text as plain text without interpreting markup', () => {
    render(
      <ExternalWorkAreaCardGrid
        cards={[
          card({
            name: '<img src=x onerror=alert(1)>',
            description: '<script>alert(2)</script>',
          }),
        ]}
        onSelect={jest.fn()}
      />,
    );

    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
    expect(screen.getByText('<script>alert(2)</script>')).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('script')).toBeNull();
  });

  it('marks stale and error refresh states without hiding the card', () => {
    render(
      <ExternalWorkAreaCardGrid
        cards={[
          card({ refreshState: 'stale' }),
          card({ key: 'k2', remoteId: 'b2', refreshState: 'error' }),
        ]}
        onSelect={jest.fn()}
      />,
    );

    expect(screen.getByText('Stale')).toBeInTheDocument();
    expect(screen.getByText('Refresh failed')).toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(2);
  });

  it('renders the other-assigned pseudo area as a normal card', () => {
    render(
      <ExternalWorkAreaCardGrid
        cards={[
          card({
            key: 'site:other-assigned',
            remoteId: 'other-assigned',
            name: 'Other assigned issues',
            kindLabel: 'Board',
            workflowSummary: 'Workflow unavailable',
          }),
        ]}
        onSelect={jest.fn()}
      />,
    );

    const cardButton = screen.getByRole('button', { name: /other assigned issues/i });
    expect(cardButton).toBeInTheDocument();
    expect(screen.getByText('Board · Workflow unavailable')).toBeInTheDocument();
  });

  it('reports card selection with the full model', async () => {
    const user = userEvent.setup();
    const onSelect = jest.fn();
    const model = card();
    render(<ExternalWorkAreaCardGrid cards={[model]} onSelect={onSelect} />);

    await user.click(screen.getByRole('button', { name: /sprint board/i }));

    expect(onSelect).toHaveBeenCalledWith(model);
  });

  it('shows the filtered-empty state when no cards match', () => {
    render(<ExternalWorkAreaCardGrid cards={[]} onSelect={jest.fn()} />);

    expect(screen.getByText('No matching work areas')).toBeInTheDocument();
  });
});
