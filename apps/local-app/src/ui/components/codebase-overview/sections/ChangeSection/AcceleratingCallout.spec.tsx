import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CodebaseOverviewSnapshot, DistrictSignals } from '@devchain/codebase-overview';
import { AcceleratingCallout } from './AcceleratingCallout';

const onSelectDistrict = jest.fn();

function makeSignal(
  districtId: string,
  churn7d: number,
  churn30d: number,
  overrides: Partial<DistrictSignals> = {},
): DistrictSignals {
  return {
    districtId,
    name: districtId,
    loc: 100,
    churn7d,
    churn30d,
    ownerQuiet: false,
    ...overrides,
  };
}

function makeSnapshot(
  signals: DistrictSignals[],
  dailyChurn?: Record<string, Record<string, number>>,
): CodebaseOverviewSnapshot {
  const activity = dailyChurn
    ? Object.entries(dailyChurn).map(([targetId, churn]) => ({
        targetId,
        targetKind: 'district' as const,
        modifiedCount1d: 0,
        modifiedCount7d: 0,
        buildFailures7d: null,
        testFailures7d: null,
        latestTimestamp: null,
        recentContributors7d: [],
        recentContributors30d: [],
        dailyChurn: churn,
      }))
    : [];

  return {
    snapshotId: 'snap-1',
    projectKey: 'proj-1',
    name: 'Test',
    regions: [],
    districts: [],
    dependencies: [],
    hotspots: [],
    activity,
    metrics: {
      totalRegions: 1,
      totalDistricts: signals.length,
      totalFiles: 0,
      gitHistoryDaysAvailable: 90,
      shallowHistoryDetected: false,
      dependencyCoverage: 1,
      warnings: [],
      excludedAuthorCount: 0,
      scopeConfigHash: 'test',
    },
    signals,
    globalContributors: [],
  };
}

describe('AcceleratingCallout', () => {
  beforeEach(() => {
    onSelectDistrict.mockClear();
  });

  it('renders accelerating districts', () => {
    const snapshot = makeSnapshot([makeSignal('alpha', 5, 10)]);
    render(<AcceleratingCallout snapshot={snapshot} onSelectDistrict={onSelectDistrict} />);
    expect(screen.getByText('Accelerating')).toBeInTheDocument();
    expect(screen.getByText('alpha')).toBeInTheDocument();
  });

  it('returns null when no accelerating districts', () => {
    const snapshot = makeSnapshot([]);
    const { container } = render(
      <AcceleratingCallout snapshot={snapshot} onSelectDistrict={onSelectDistrict} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('filters: churn7d must be > 0', () => {
    const snapshot = makeSnapshot([makeSignal('zero7d', 0, 20)]);
    const { container } = render(
      <AcceleratingCallout snapshot={snapshot} onSelectDistrict={onSelectDistrict} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('filters: churn7d must exceed churn30d/4', () => {
    // churn7d=2, churn30d=10 → 2 is NOT > 10/4=2.5 → excluded
    const snapshot = makeSnapshot([makeSignal('notaccel', 2, 10)]);
    const { container } = render(
      <AcceleratingCallout snapshot={snapshot} onSelectDistrict={onSelectDistrict} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('includes district exactly at boundary (churn7d > churn30d/4)', () => {
    // churn7d=3, churn30d=10 → 3 > 10/4=2.5 → included
    const snapshot = makeSnapshot([makeSignal('boundary', 3, 10)]);
    render(<AcceleratingCallout snapshot={snapshot} onSelectDistrict={onSelectDistrict} />);
    expect(screen.getByText('boundary')).toBeInTheDocument();
  });

  it('sorts by churn7d descending', () => {
    const snapshot = makeSnapshot([
      makeSignal('low', 3, 8),
      makeSignal('high', 10, 20),
      makeSignal('mid', 6, 12),
    ]);
    render(<AcceleratingCallout snapshot={snapshot} onSelectDistrict={onSelectDistrict} />);
    const buttons = screen.getAllByRole('button').filter((b) => b.textContent?.includes('in 7d'));
    expect(buttons[0]!.textContent).toContain('high');
    expect(buttons[1]!.textContent).toContain('mid');
    expect(buttons[2]!.textContent).toContain('low');
  });

  it('tie-break by churn30d descending', () => {
    // churn7d=5, churn30d must be < 20 to pass filter (5 > churn30d/4)
    const snapshot = makeSnapshot([makeSignal('a', 5, 8), makeSignal('b', 5, 16)]);
    render(<AcceleratingCallout snapshot={snapshot} onSelectDistrict={onSelectDistrict} />);
    const buttons = screen.getAllByRole('button').filter((b) => b.textContent?.includes('in 7d'));
    expect(buttons[0]!.textContent).toContain('b');
    expect(buttons[1]!.textContent).toContain('a');
  });

  it('caps at 5 rows', () => {
    const signals = Array.from({ length: 8 }, (_, i) => makeSignal(`d${i}`, 10, 20));
    const snapshot = makeSnapshot(signals);
    render(<AcceleratingCallout snapshot={snapshot} onSelectDistrict={onSelectDistrict} />);
    const buttons = screen.getAllByRole('button').filter((b) => b.textContent?.includes('in 7d'));
    expect(buttons.length).toBe(5);
  });

  it('shows churn7d metric per row', () => {
    const snapshot = makeSnapshot([makeSignal('alpha', 7, 20)]);
    render(<AcceleratingCallout snapshot={snapshot} onSelectDistrict={onSelectDistrict} />);
    expect(screen.getByText('7 in 7d')).toBeInTheDocument();
  });

  it('click row calls onSelectDistrict with districtId', async () => {
    const user = userEvent.setup();
    const snapshot = makeSnapshot([makeSignal('dist-42', 5, 10)]);
    render(<AcceleratingCallout snapshot={snapshot} onSelectDistrict={onSelectDistrict} />);
    const btn = screen.getByText('dist-42').closest('button')!;
    await user.click(btn);
    expect(onSelectDistrict).toHaveBeenCalledWith('dist-42');
  });

  it('shows badge with count', () => {
    const snapshot = makeSnapshot([makeSignal('a', 5, 10), makeSignal('b', 6, 12)]);
    render(<AcceleratingCallout snapshot={snapshot} onSelectDistrict={onSelectDistrict} />);
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('renders sparkline when dailyChurn available with non-zero values', () => {
    const today = new Date();
    const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const snapshot = makeSnapshot([makeSignal('sparky', 5, 10)], { sparky: { [key]: 3 } });
    render(<AcceleratingCallout snapshot={snapshot} onSelectDistrict={onSelectDistrict} />);
    // decorative sparkline: aria-hidden + width=48
    expect(document.querySelector('svg[aria-hidden="true"][width="48"]')).not.toBeNull();
  });

  it('does not render sparkline when dailyChurn is all zeros', () => {
    const today = new Date();
    const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const snapshot = makeSnapshot([makeSignal('flat', 5, 10)], { flat: { [key]: 0 } });
    render(<AcceleratingCallout snapshot={snapshot} onSelectDistrict={onSelectDistrict} />);
    expect(document.querySelector('svg[aria-hidden="true"][width="48"]')).toBeNull();
  });

  it('sparkline inside row button is decorative: no nested focusable element', () => {
    const today = new Date();
    const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const snapshot = makeSnapshot([makeSignal('sparky', 5, 10)], { sparky: { [key]: 3 } });
    render(<AcceleratingCallout snapshot={snapshot} onSelectDistrict={onSelectDistrict} />);
    const rowButton = screen.getByText('sparky').closest('button')!;
    // No focusable children (tabIndex >= 0) inside the row button
    const focusable = rowButton.querySelectorAll('[tabindex]');
    expect(focusable.length).toBe(0);
    // No nested buttons
    expect(rowButton.querySelectorAll('button').length).toBe(0);
  });

  it('row button has min-h-10 touch target', () => {
    const snapshot = makeSnapshot([makeSignal('alpha', 5, 10)]);
    render(<AcceleratingCallout snapshot={snapshot} onSelectDistrict={onSelectDistrict} />);
    const btn = screen.getByText('alpha').closest('button')!;
    expect(btn).toHaveClass('min-h-10');
  });
});
