import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DistrictSignals } from '@devchain/codebase-overview';
import { CouplingOutliersCard } from './CouplingOutliersCard';

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
    complexityAvg: 10,
    inboundWeight: 3,
    outboundWeight: 2,
    blastRadius: 1,
    couplingScore: 0,
    ownershipHHI: 0.6,
    ownershipMeasured: true,
    primaryAuthorName: 'Dev',
    primaryAuthorShare: 0.8,
    primaryAuthorRecentlyActive: true,
    fileTypeBreakdown: { kind: 'extension', counts: {} },
    ...overrides,
  };
}

const onSelectDistrict = jest.fn();

describe('CouplingOutliersCard', () => {
  beforeEach(() => onSelectDistrict.mockClear());

  it('renders rows for signals above P75 coupling', () => {
    const signals = [
      ...Array.from({ length: 14 }, (_, i) =>
        makeSignal({ districtId: `low-${i}`, couplingScore: 1 + i * 0.1 }),
      ),
      ...Array.from({ length: 6 }, (_, i) =>
        makeSignal({ districtId: `high-${i}`, name: `high-${i}`, couplingScore: 20 + i }),
      ),
    ];
    render(<CouplingOutliersCard signals={signals} onSelectDistrict={onSelectDistrict} />);
    expect(screen.getByText('Coupling Outliers')).toBeInTheDocument();
  });

  it('hides when all couplingScore is 0', () => {
    const signals = Array.from({ length: 10 }, (_, i) =>
      makeSignal({ districtId: `d${i}`, couplingScore: 0 }),
    );
    const { container } = render(
      <CouplingOutliersCard signals={signals} onSelectDistrict={onSelectDistrict} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('hides when fewer than 5 above P75', () => {
    const signals = Array.from({ length: 5 }, (_, i) =>
      makeSignal({ districtId: `d${i}`, couplingScore: 1 + i }),
    );
    const { container } = render(
      <CouplingOutliersCard signals={signals} onSelectDistrict={onSelectDistrict} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('sorts by couplingScore desc', () => {
    const signals = [
      ...Array.from({ length: 14 }, (_, i) =>
        makeSignal({ districtId: `low-${i}`, couplingScore: 1 }),
      ),
      makeSignal({ districtId: 'top', name: 'top', couplingScore: 50 }),
      ...Array.from({ length: 5 }, (_, i) =>
        makeSignal({ districtId: `mid-${i}`, couplingScore: 20 + i }),
      ),
    ];
    render(<CouplingOutliersCard signals={signals} onSelectDistrict={onSelectDistrict} />);
    const buttons = screen.getAllByRole('button').filter((b) => !b.hasAttribute('aria-label'));
    expect(buttons[0]!.textContent).toContain('top');
  });

  it('click row calls onSelectDistrict', async () => {
    const user = userEvent.setup();
    const signals = [
      ...Array.from({ length: 14 }, (_, i) =>
        makeSignal({ districtId: `low-${i}`, couplingScore: 1 }),
      ),
      ...Array.from({ length: 6 }, (_, i) =>
        makeSignal({ districtId: `high-${i}`, couplingScore: 20 + i }),
      ),
    ];
    render(<CouplingOutliersCard signals={signals} onSelectDistrict={onSelectDistrict} />);
    const buttons = screen.getAllByRole('button').filter((b) => !b.hasAttribute('aria-label'));
    await user.click(buttons[0]!);
    expect(onSelectDistrict).toHaveBeenCalled();
  });
});
