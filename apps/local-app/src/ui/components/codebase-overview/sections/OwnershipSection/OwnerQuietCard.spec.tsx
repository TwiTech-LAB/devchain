import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DistrictSignals } from '@devchain/codebase-overview';
import { OwnerQuietCard } from './OwnerQuietCard';

function makeSignal(overrides: Partial<DistrictSignals> & { districtId: string }): DistrictSignals {
  return {
    name: overrides.districtId,
    path: `src/${overrides.districtId}`,
    regionId: 'r1',
    regionName: 'src',
    files: 10,
    sourceFileCount: 8,
    supportFileCount: 2,
    hasSourceFiles: true,
    loc: 500,
    churn7d: 2,
    churn30d: 5,
    testCoverageRate: 0.5,
    sourceCoverageMeasured: true,
    complexityAvg: 10.0,
    inboundWeight: 3,
    outboundWeight: 2,
    blastRadius: 1,
    couplingScore: 5,
    ownershipHHI: 0.6,
    ownershipMeasured: true,
    primaryAuthorName: 'Dev',
    primaryAuthorShare: 0.8,
    primaryAuthorRecentlyActive: true,
    fileTypeBreakdown: { kind: 'extension', counts: { ts: 8, json: 2 } },
    ...overrides,
  };
}

const onSelectDistrict = jest.fn();

function makeQuietSignals(count: number): DistrictSignals[] {
  return Array.from({ length: count }, (_, i) =>
    makeSignal({
      districtId: `d${i}`,
      name: `quiet-${i}`,
      ownershipMeasured: true,
      ownershipHHI: 0.8 + i * 0.005,
      primaryAuthorRecentlyActive: false,
      primaryAuthorName: `Author ${i}`,
      inboundWeight: 10 + i,
    }),
  );
}

describe('OwnerQuietCard', () => {
  beforeEach(() => {
    onSelectDistrict.mockClear();
  });

  it('renders rows for high-HHI districts with inactive primary author', () => {
    const signals = makeQuietSignals(8);
    render(<OwnerQuietCard signals={signals} onSelectDistrict={onSelectDistrict} />);

    expect(screen.getByText('Owner-Quiet Districts')).toBeInTheDocument();
    expect(screen.getByText('quiet-0')).toBeInTheDocument();
  });

  it('shows "No commits in 30d" label', () => {
    const signals = makeQuietSignals(8);
    render(<OwnerQuietCard signals={signals} onSelectDistrict={onSelectDistrict} />);

    expect(screen.getAllByText('No commits in 30d').length).toBeGreaterThan(0);
  });

  it('hides when ownershipMeasured is false', () => {
    const signals = Array.from({ length: 8 }, (_, i) =>
      makeSignal({
        districtId: `d${i}`,
        ownershipMeasured: false,
        ownershipHHI: 0.9,
        primaryAuthorRecentlyActive: false,
      }),
    );
    const { container } = render(
      <OwnerQuietCard signals={signals} onSelectDistrict={onSelectDistrict} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('hides when primaryAuthorRecentlyActive is true for all', () => {
    const signals = Array.from({ length: 8 }, (_, i) =>
      makeSignal({
        districtId: `d${i}`,
        ownershipMeasured: true,
        ownershipHHI: 0.9,
        primaryAuthorRecentlyActive: true,
      }),
    );
    const { container } = render(
      <OwnerQuietCard signals={signals} onSelectDistrict={onSelectDistrict} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('hides when HHI <= 0.7', () => {
    const signals = Array.from({ length: 8 }, (_, i) =>
      makeSignal({
        districtId: `d${i}`,
        ownershipMeasured: true,
        ownershipHHI: 0.5,
        primaryAuthorRecentlyActive: false,
      }),
    );
    const { container } = render(
      <OwnerQuietCard signals={signals} onSelectDistrict={onSelectDistrict} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('hides when fewer than 5 signals pass filter', () => {
    const signals = makeQuietSignals(3);
    const { container } = render(
      <OwnerQuietCard signals={signals} onSelectDistrict={onSelectDistrict} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('sorts by ownershipHHI desc, then inboundWeight desc', () => {
    const signals = [
      ...makeQuietSignals(5),
      makeSignal({
        districtId: 'top',
        name: 'top',
        ownershipMeasured: true,
        ownershipHHI: 0.99,
        primaryAuthorRecentlyActive: false,
        inboundWeight: 50,
      }),
    ];
    render(<OwnerQuietCard signals={signals} onSelectDistrict={onSelectDistrict} />);

    const buttons = screen.getAllByRole('button').filter((b) => !b.hasAttribute('aria-label'));
    expect(buttons[0]!.textContent).toContain('top');
  });

  it('caps at 15 entries', () => {
    const signals = makeQuietSignals(20);
    render(<OwnerQuietCard signals={signals} onSelectDistrict={onSelectDistrict} />);

    const buttons = screen.getAllByRole('button').filter((b) => !b.hasAttribute('aria-label'));
    expect(buttons.length).toBeLessThanOrEqual(15);
  });

  it('click row calls onSelectDistrict', async () => {
    const user = userEvent.setup();
    const signals = makeQuietSignals(8);
    render(<OwnerQuietCard signals={signals} onSelectDistrict={onSelectDistrict} />);

    const buttons = screen.getAllByRole('button').filter((b) => !b.hasAttribute('aria-label'));
    await user.click(buttons[0]!);
    expect(onSelectDistrict).toHaveBeenCalled();
  });

  it('row button has min-h-10 touch target', () => {
    const signals = makeQuietSignals(8);
    render(<OwnerQuietCard signals={signals} onSelectDistrict={onSelectDistrict} />);
    const rowButtons = screen.getAllByRole('button').filter((b) => !b.hasAttribute('aria-label'));
    expect(rowButtons[0]).toHaveClass('min-h-10');
  });

  it('help icon button has h-10 w-10 touch target', () => {
    const signals = makeQuietSignals(8);
    render(<OwnerQuietCard signals={signals} onSelectDistrict={onSelectDistrict} />);
    const helpBtn = screen.getByRole('button', { name: /about owner-quiet districts/i });
    expect(helpBtn).toHaveClass('h-10');
    expect(helpBtn).toHaveClass('w-10');
  });
});
