import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
  CodebaseOverviewSnapshot,
  DependencyEdge,
  DistrictSignals,
} from '@devchain/codebase-overview';
import { CyclesCard } from './CyclesCard';

function makeSignal(id: string, name: string): DistrictSignals {
  return {
    districtId: id,
    name,
    path: name,
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
    couplingScore: 5,
    ownershipHHI: 0.6,
    ownershipMeasured: true,
    primaryAuthorName: 'Dev',
    primaryAuthorShare: 0.8,
    primaryAuthorRecentlyActive: true,
    fileTypeBreakdown: { kind: 'extension', counts: {} },
  };
}

function makeSnapshot(
  deps: DependencyEdge[],
  signals?: DistrictSignals[],
): CodebaseOverviewSnapshot {
  const sigs = signals ?? [makeSignal('d0', 'alpha'), makeSignal('d1', 'bravo')];
  return {
    snapshotId: 's1',
    projectKey: 'p1',
    name: 'Test',
    regions: [],
    districts: [],
    dependencies: deps,
    hotspots: [],
    activity: [],
    metrics: {
      totalRegions: 1,
      totalDistricts: 2,
      totalFiles: 10,
      gitHistoryDaysAvailable: 30,
      shallowHistoryDetected: false,
      dependencyCoverage: 1,
      warnings: [],
      excludedAuthorCount: 0,
      scopeConfigHash: 'test',
    },
    signals: sigs,
    globalContributors: [],
  };
}

const onSelectPair = jest.fn();

describe('CyclesCard', () => {
  beforeEach(() => onSelectPair.mockClear());

  it('renders cycle pairs sorted by combined weight', () => {
    const deps: DependencyEdge[] = [
      { fromDistrictId: 'd0', toDistrictId: 'd1', weight: 5, isCyclic: true },
      { fromDistrictId: 'd1', toDistrictId: 'd0', weight: 3, isCyclic: true },
    ];
    render(<CyclesCard snapshot={makeSnapshot(deps)} onSelectPair={onSelectPair} />);

    expect(screen.getByText('Dependency Cycles')).toBeInTheDocument();
    expect(screen.getByText(/alpha ↔ bravo/)).toBeInTheDocument();
    expect(screen.getByText('weight 8')).toBeInTheDocument();
  });

  it('hides when no cycles exist', () => {
    const deps: DependencyEdge[] = [
      { fromDistrictId: 'd0', toDistrictId: 'd1', weight: 5, isCyclic: false },
    ];
    const { container } = render(
      <CyclesCard snapshot={makeSnapshot(deps)} onSelectPair={onSelectPair} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('caps at 10 entries', () => {
    const signals: DistrictSignals[] = [];
    const deps: DependencyEdge[] = [];
    for (let i = 0; i < 15; i++) {
      const a = `a${i}`,
        b = `b${i}`;
      signals.push(makeSignal(a, `from-${i}`), makeSignal(b, `to-${i}`));
      deps.push({ fromDistrictId: a, toDistrictId: b, weight: 20 - i, isCyclic: true });
      deps.push({ fromDistrictId: b, toDistrictId: a, weight: 10, isCyclic: true });
    }
    render(<CyclesCard snapshot={makeSnapshot(deps, signals)} onSelectPair={onSelectPair} />);

    const buttons = screen.getAllByRole('button').filter((b) => b.textContent?.includes('↔'));
    expect(buttons.length).toBeLessThanOrEqual(10);
  });

  it('click pair calls onSelectPair', async () => {
    const user = userEvent.setup();
    const deps: DependencyEdge[] = [
      { fromDistrictId: 'd0', toDistrictId: 'd1', weight: 5, isCyclic: true },
      { fromDistrictId: 'd1', toDistrictId: 'd0', weight: 3, isCyclic: true },
    ];
    render(<CyclesCard snapshot={makeSnapshot(deps)} onSelectPair={onSelectPair} />);

    const btn = screen.getByText(/alpha ↔ bravo/).closest('button')!;
    await user.click(btn);
    expect(onSelectPair).toHaveBeenCalledWith('d0', 'd1');
  });
});
