import { render, screen } from '@testing-library/react';
import { axe } from 'jest-axe';
import type { EpicTimeDetailSummary } from '@/modules/epic-time/models/epic-time.models';
import { EpicTimeCard } from '@/ui/components/epics/EpicTimeCard';

// Layer: component unit. The card is presentational; formatting behavior
// belongs to the lib spec, so this spec owns layout states and labels.
const summary: EpicTimeDetailSummary = {
  isRoot: true,
  directMinutes: 30,
  totalMinutes: 105,
  items: [
    { activityDate: '2026-08-22', agentId: 'agent-1', agentName: 'Alpha', minutes: 60 },
    { activityDate: '2026-08-21', agentId: 'agent-2', agentName: 'Bravo', minutes: 45 },
  ],
  taskItems: [],
};

describe('EpicTimeCard', () => {
  it('shows the inclusive total, direct subtotal, and merged rows for a root epic', () => {
    render(<EpicTimeCard isRoot summary={summary} isLoading={false} isError={false} />);

    expect(screen.getByText('Total (incl. sub-epics)')).toBeInTheDocument();
    expect(screen.getByText('1h 45m')).toBeInTheDocument();
    expect(screen.getByText('Direct')).toBeInTheDocument();
    expect(screen.getByText('30m')).toBeInTheDocument();
    expect(screen.getByText('2026-08-22 · Alpha')).toBeInTheDocument();
    expect(screen.getByText('2026-08-21 · Bravo')).toBeInTheDocument();
    expect(screen.getByText('1h')).toBeInTheDocument();
    expect(screen.getByText('45m')).toBeInTheDocument();
  });

  it('shows only the self total for a sub-epic', () => {
    render(<EpicTimeCard isRoot={false} summary={summary} isLoading={false} isError={false} />);

    expect(screen.getByText('Total')).toBeInTheDocument();
    expect(screen.queryByText('Direct')).not.toBeInTheDocument();
    expect(screen.getByText('1h 45m')).toBeInTheDocument();
  });

  it('renders bounded loading, error, and empty states', () => {
    const { rerender } = render(
      <EpicTimeCard isRoot summary={undefined} isLoading isError={false} />,
    );
    expect(screen.getByText('Loading estimated time…')).toBeInTheDocument();

    rerender(<EpicTimeCard isRoot summary={undefined} isLoading={false} isError />);
    expect(screen.getByText('Estimated time is unavailable.')).toBeInTheDocument();

    rerender(
      <EpicTimeCard
        isRoot
        summary={{ isRoot: true, directMinutes: 0, totalMinutes: 0, items: [], taskItems: [] }}
        isLoading={false}
        isError={false}
      />,
    );
    expect(screen.getByText('No estimated time recorded yet.')).toBeInTheDocument();
  });

  it('passes composed accessibility checks', async () => {
    const { container } = render(
      <EpicTimeCard isRoot summary={summary} isLoading={false} isError={false} />,
    );

    expect(await axe(container)).toHaveNoViolations();
  });
});
