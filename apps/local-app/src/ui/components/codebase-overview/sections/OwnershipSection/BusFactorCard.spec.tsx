import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DistrictSignals, DependencyEdge } from '@devchain/codebase-overview';
import { BusFactorCard } from './BusFactorCard';

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

function makeDeps(count: number): DependencyEdge[] {
  return Array.from({ length: count }, (_, i) => ({
    fromDistrictId: `from-${i}`,
    toDistrictId: `to-${i}`,
    weight: 1,
    isCyclic: false,
  }));
}

function makeHighHHISignals(count: number, inboundBase: number): DistrictSignals[] {
  return Array.from({ length: count }, (_, i) =>
    makeSignal({
      districtId: `d${i}`,
      name: `district-${i}`,
      ownershipMeasured: true,
      ownershipHHI: 0.8 + (count - i) * 0.005,
      inboundWeight: inboundBase + (count - i),
      primaryAuthorName: `Author ${i}`,
      primaryAuthorShare: 0.85,
    }),
  );
}

describe('BusFactorCard', () => {
  beforeEach(() => {
    onSelectDistrict.mockClear();
  });

  it('renders rows for signals with high HHI and above-median inbound', () => {
    const signals = makeHighHHISignals(10, 10);
    render(
      <BusFactorCard
        signals={signals}
        dependencies={makeDeps(5)}
        onSelectDistrict={onSelectDistrict}
      />,
    );

    expect(screen.getByText('Bus Factor Risk')).toBeInTheDocument();
    expect(screen.getByText('district-0')).toBeInTheDocument();
  });

  it('hides when ownershipMeasured is false for all signals', () => {
    const signals = Array.from({ length: 10 }, (_, i) =>
      makeSignal({
        districtId: `d${i}`,
        ownershipMeasured: false,
        ownershipHHI: 0.9,
        inboundWeight: 20,
      }),
    );
    const { container } = render(
      <BusFactorCard
        signals={signals}
        dependencies={makeDeps(5)}
        onSelectDistrict={onSelectDistrict}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('hides when ownershipHHI <= 0.7 for all signals', () => {
    const signals = Array.from({ length: 10 }, (_, i) =>
      makeSignal({
        districtId: `d${i}`,
        ownershipMeasured: true,
        ownershipHHI: 0.5,
        inboundWeight: 20,
      }),
    );
    const { container } = render(
      <BusFactorCard
        signals={signals}
        dependencies={makeDeps(5)}
        onSelectDistrict={onSelectDistrict}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('hides when dependencies are empty', () => {
    const signals = makeHighHHISignals(10, 10);
    const { container } = render(
      <BusFactorCard signals={signals} dependencies={[]} onSelectDistrict={onSelectDistrict} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('hides when fewer than 5 signals pass filter', () => {
    const signals = Array.from({ length: 3 }, (_, i) =>
      makeSignal({
        districtId: `d${i}`,
        ownershipMeasured: true,
        ownershipHHI: 0.9,
        inboundWeight: 20,
      }),
    );
    const { container } = render(
      <BusFactorCard
        signals={signals}
        dependencies={makeDeps(5)}
        onSelectDistrict={onSelectDistrict}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('sorts by ownershipHHI desc, then inboundWeight desc', () => {
    const signals = [
      ...Array.from({ length: 5 }, (_, i) =>
        makeSignal({
          districtId: `low-${i}`,
          ownershipMeasured: true,
          ownershipHHI: 0.75,
          inboundWeight: 1 + i,
        }),
      ),
      ...Array.from({ length: 5 }, (_, i) =>
        makeSignal({
          districtId: `high-${i}`,
          ownershipMeasured: true,
          ownershipHHI: 0.8 + i * 0.01,
          inboundWeight: 20 + i,
        }),
      ),
      makeSignal({
        districtId: 'second',
        name: 'second',
        ownershipMeasured: true,
        ownershipHHI: 0.9,
        inboundWeight: 30,
      }),
      makeSignal({
        districtId: 'first',
        name: 'first',
        ownershipMeasured: true,
        ownershipHHI: 0.95,
        inboundWeight: 25,
      }),
    ];
    render(
      <BusFactorCard
        signals={signals}
        dependencies={makeDeps(5)}
        onSelectDistrict={onSelectDistrict}
      />,
    );

    const buttons = screen.getAllByRole('button').filter((b) => !b.hasAttribute('aria-label'));
    expect(buttons[0]!.textContent).toContain('first');
    expect(buttons[1]!.textContent).toContain('second');
  });

  it('caps at 15 entries', () => {
    const signals = makeHighHHISignals(25, 10);
    render(
      <BusFactorCard
        signals={signals}
        dependencies={makeDeps(5)}
        onSelectDistrict={onSelectDistrict}
      />,
    );

    const buttons = screen.getAllByRole('button').filter((b) => !b.hasAttribute('aria-label'));
    expect(buttons.length).toBeLessThanOrEqual(15);
  });

  it('click row calls onSelectDistrict', async () => {
    const user = userEvent.setup();
    const signals = makeHighHHISignals(10, 10);
    render(
      <BusFactorCard
        signals={signals}
        dependencies={makeDeps(5)}
        onSelectDistrict={onSelectDistrict}
      />,
    );

    const buttons = screen.getAllByRole('button').filter((b) => !b.hasAttribute('aria-label'));
    await user.click(buttons[0]!);
    expect(onSelectDistrict).toHaveBeenCalled();
  });

  it('row button has min-h-10 touch target', () => {
    const signals = makeHighHHISignals(10, 10);
    render(
      <BusFactorCard
        signals={signals}
        dependencies={makeDeps(5)}
        onSelectDistrict={onSelectDistrict}
      />,
    );
    const rowButtons = screen.getAllByRole('button').filter((b) => !b.hasAttribute('aria-label'));
    expect(rowButtons[0]).toHaveClass('min-h-10');
  });

  it('help icon button has h-10 w-10 touch target', () => {
    const signals = makeHighHHISignals(10, 10);
    render(
      <BusFactorCard
        signals={signals}
        dependencies={makeDeps(5)}
        onSelectDistrict={onSelectDistrict}
      />,
    );
    const helpBtn = screen.getByRole('button', { name: /about bus factor risk/i });
    expect(helpBtn).toHaveClass('h-10');
    expect(helpBtn).toHaveClass('w-10');
  });
});
