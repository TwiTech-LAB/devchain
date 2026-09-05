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
  includesRelatedTime: false,
  items: [
    { activityDate: '2026-08-22', agentId: 'agent-1', agentName: 'Alpha', minutes: 60 },
    { activityDate: '2026-08-21', agentId: 'agent-2', agentName: 'Bravo', minutes: 45 },
  ],
  taskItems: [],
};

// Same date and lead across a direct and a team row: the trickiest key case.
const teamRowSummary: EpicTimeDetailSummary = {
  isRoot: true,
  directMinutes: 45,
  totalMinutes: 90,
  includesRelatedTime: false,
  items: [
    { activityDate: '2026-08-22', agentId: 'agent-1', agentName: 'Alpha', minutes: 60 },
    {
      activityDate: '2026-08-22',
      agentId: 'agent-1',
      agentName: 'Alpha',
      minutes: 30,
      attributionSource: 'team',
      teamId: 'team-builders',
      teamName: 'Builders',
    },
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
    // A child focal is self-only on the server, so its direct and total match.
    render(
      <EpicTimeCard
        isRoot={false}
        summary={{ ...summary, directMinutes: summary.totalMinutes }}
        isLoading={false}
        isError={false}
      />,
    );

    expect(screen.getByText('Total')).toBeInTheDocument();
    expect(screen.queryByText('Direct')).not.toBeInTheDocument();
    expect(screen.getByText('1h 45m')).toBeInTheDocument();
  });

  it('names related scope in the total label when the rollup admits routed roots', () => {
    render(
      <EpicTimeCard
        isRoot
        summary={{ ...summary, includesRelatedTime: true }}
        isLoading={false}
        isError={false}
      />,
    );

    expect(screen.getByText('Total (incl. sub-epics and related Epics)')).toBeInTheDocument();
    expect(screen.queryByText('Total (incl. sub-epics)')).not.toBeInTheDocument();
    expect(screen.getByText('Direct')).toBeInTheDocument();
  });

  it('hides the direct split when the total contains no indirect time', () => {
    render(
      <EpicTimeCard
        isRoot
        summary={{ ...summary, directMinutes: summary.totalMinutes }}
        isLoading={false}
        isError={false}
      />,
    );

    expect(screen.getByText('Total (incl. sub-epics)')).toBeInTheDocument();
    expect(screen.queryByText('Direct')).not.toBeInTheDocument();
  });

  it('labels team work rows with the credited lead and team', () => {
    render(<EpicTimeCard isRoot summary={teamRowSummary} isLoading={false} isError={false} />);

    expect(screen.getByText('2026-08-22 · Alpha')).toBeInTheDocument();
    expect(screen.getByText('2026-08-22 · Alpha · Team work: Builders')).toBeInTheDocument();
    expect(screen.getByText('1h')).toBeInTheDocument();
    expect(screen.getByText('30m')).toBeInTheDocument();
  });

  it('keeps same-date direct and team rows distinct without duplicate key warnings', () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      render(<EpicTimeCard isRoot summary={teamRowSummary} isLoading={false} isError={false} />);

      const warnings = consoleError.mock.calls.map((args) => args.join(' '));
      expect(warnings.some((text) => text.includes('unique "key"'))).toBe(false);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('falls back to the direct label when team fields are missing', () => {
    const degradedSummary: EpicTimeDetailSummary = {
      isRoot: true,
      directMinutes: 4,
      totalMinutes: 15,
      includesRelatedTime: false,
      items: [
        {
          activityDate: '2026-08-22',
          agentId: 'agent-1',
          agentName: 'Alpha',
          minutes: 10,
          attributionSource: 'team',
          teamId: undefined,
          teamName: undefined,
        },
        {
          activityDate: '2026-08-21',
          agentId: 'agent-2',
          agentName: 'Bravo',
          minutes: 5,
          attributionSource: 'team',
          teamId: 'team-2',
          teamName: null,
        },
      ],
      taskItems: [],
    };
    render(<EpicTimeCard isRoot summary={degradedSummary} isLoading={false} isError={false} />);

    expect(screen.getByText('2026-08-22 · Alpha')).toBeInTheDocument();
    expect(screen.getByText('2026-08-21 · Bravo')).toBeInTheDocument();
    expect(screen.queryByText(/undefined/)).not.toBeInTheDocument();
    expect(screen.getByText('10m')).toBeInTheDocument();
    expect(screen.getByText('5m')).toBeInTheDocument();
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
        summary={{
          isRoot: true,
          directMinutes: 0,
          totalMinutes: 0,
          includesRelatedTime: false,
          items: [],
          taskItems: [],
        }}
        isLoading={false}
        isError={false}
      />,
    );
    expect(screen.getByText('No estimated time recorded yet.')).toBeInTheDocument();
  });

  it('passes composed accessibility checks', async () => {
    const { container } = render(
      <EpicTimeCard isRoot summary={teamRowSummary} isLoading={false} isError={false} />,
    );

    expect(await axe(container)).toHaveNoViolations();
  });
});
