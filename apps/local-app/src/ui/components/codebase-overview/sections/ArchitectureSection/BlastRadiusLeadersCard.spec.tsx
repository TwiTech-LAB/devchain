import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DistrictSignals } from '@devchain/codebase-overview';
import { BlastRadiusLeadersCard } from './BlastRadiusLeadersCard';

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
    blastRadius: 0,
    couplingScore: 5,
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

describe('BlastRadiusLeadersCard', () => {
  beforeEach(() => onSelectDistrict.mockClear());

  it('renders rows for signals with blastRadius > 0', () => {
    const signals = Array.from({ length: 8 }, (_, i) =>
      makeSignal({ districtId: `d${i}`, name: `district-${i}`, blastRadius: 5 + i }),
    );
    render(<BlastRadiusLeadersCard signals={signals} onSelectDistrict={onSelectDistrict} />);
    expect(screen.getByText('Blast Radius Leaders')).toBeInTheDocument();
  });

  it('hides when blastRadius is 0 for all', () => {
    const signals = Array.from({ length: 10 }, (_, i) =>
      makeSignal({ districtId: `d${i}`, blastRadius: 0 }),
    );
    const { container } = render(
      <BlastRadiusLeadersCard signals={signals} onSelectDistrict={onSelectDistrict} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('hides when fewer than 5 have blastRadius > 0', () => {
    const signals = Array.from({ length: 3 }, (_, i) =>
      makeSignal({ districtId: `d${i}`, blastRadius: 5 }),
    );
    const { container } = render(
      <BlastRadiusLeadersCard signals={signals} onSelectDistrict={onSelectDistrict} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('sorts by blastRadius desc, then inboundWeight desc', () => {
    const signals = [
      ...Array.from({ length: 5 }, (_, i) =>
        makeSignal({ districtId: `low-${i}`, blastRadius: 1 }),
      ),
      makeSignal({ districtId: 'top', name: 'top', blastRadius: 99, inboundWeight: 50 }),
      makeSignal({ districtId: 'second', name: 'second', blastRadius: 99, inboundWeight: 10 }),
    ];
    render(<BlastRadiusLeadersCard signals={signals} onSelectDistrict={onSelectDistrict} />);

    const buttons = screen.getAllByRole('button').filter((b) => !b.hasAttribute('aria-label'));
    expect(buttons[0]!.textContent).toContain('top');
    expect(buttons[1]!.textContent).toContain('second');
  });

  it('caps at 15', () => {
    const signals = Array.from({ length: 25 }, (_, i) =>
      makeSignal({ districtId: `d${i}`, blastRadius: 25 - i }),
    );
    render(<BlastRadiusLeadersCard signals={signals} onSelectDistrict={onSelectDistrict} />);
    const buttons = screen.getAllByRole('button').filter((b) => !b.hasAttribute('aria-label'));
    expect(buttons.length).toBeLessThanOrEqual(15);
  });

  it('click row calls onSelectDistrict', async () => {
    const user = userEvent.setup();
    const signals = Array.from({ length: 8 }, (_, i) =>
      makeSignal({ districtId: `d${i}`, blastRadius: 5 + i }),
    );
    render(<BlastRadiusLeadersCard signals={signals} onSelectDistrict={onSelectDistrict} />);
    const buttons = screen.getAllByRole('button').filter((b) => !b.hasAttribute('aria-label'));
    await user.click(buttons[0]!);
    expect(onSelectDistrict).toHaveBeenCalled();
  });
});
