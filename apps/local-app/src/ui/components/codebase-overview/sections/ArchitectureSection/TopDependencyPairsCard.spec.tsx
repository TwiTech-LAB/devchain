import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CodebaseOverviewSnapshot, DependencyEdge } from '@devchain/codebase-overview';
import { TopDependencyPairsCard } from './TopDependencyPairsCard';

function makeSnapshot(deps: DependencyEdge[]): CodebaseOverviewSnapshot {
  return {
    snapshotId: 's1',
    projectKey: 'p1',
    name: 'Test',
    regions: [],
    districts: [
      {
        id: 'd0',
        regionId: 'r1',
        path: 'alpha',
        name: 'alpha',
        totalFiles: 5,
        totalLOC: 500,
        churn7d: 1,
        churn30d: 5,
        inboundWeight: 0,
        outboundWeight: 0,
        couplingScore: 0,
        testFileCount: 1,
        testFileRatio: 0.2,
        role: 'service',
        complexityAvg: null,
        ownershipConcentration: null,
        testCoverageRate: null,
        blastRadius: 0,
        primaryAuthorName: null,
        primaryAuthorShare: null,
        primaryAuthorRecentlyActive: false,
      },
      {
        id: 'd1',
        regionId: 'r1',
        path: 'bravo',
        name: 'bravo',
        totalFiles: 5,
        totalLOC: 500,
        churn7d: 1,
        churn30d: 5,
        inboundWeight: 0,
        outboundWeight: 0,
        couplingScore: 0,
        testFileCount: 1,
        testFileRatio: 0.2,
        role: 'service',
        complexityAvg: null,
        ownershipConcentration: null,
        testCoverageRate: null,
        blastRadius: 0,
        primaryAuthorName: null,
        primaryAuthorShare: null,
        primaryAuthorRecentlyActive: false,
      },
    ],
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
    signals: [],
    globalContributors: [],
  };
}

const onSelectPair = jest.fn();

describe('TopDependencyPairsCard', () => {
  beforeEach(() => onSelectPair.mockClear());

  it('renders pairs sorted by weight desc', () => {
    const deps: DependencyEdge[] = [
      { fromDistrictId: 'd0', toDistrictId: 'd1', weight: 10, isCyclic: false },
      { fromDistrictId: 'd1', toDistrictId: 'd0', weight: 3, isCyclic: false },
    ];
    render(<TopDependencyPairsCard snapshot={makeSnapshot(deps)} onSelectPair={onSelectPair} />);

    expect(screen.getByText('Top Dependency Pairs')).toBeInTheDocument();
    const buttons = screen.getAllByRole('button').filter((b) => b.textContent?.includes('→'));
    expect(buttons[0]!.textContent).toContain('alpha → bravo');
    expect(buttons[0]!.textContent).toContain('weight 10');
  });

  it('hides when no dependencies', () => {
    const { container } = render(
      <TopDependencyPairsCard snapshot={makeSnapshot([])} onSelectPair={onSelectPair} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('shows cycle indicator on cyclic pairs', () => {
    const deps: DependencyEdge[] = [
      { fromDistrictId: 'd0', toDistrictId: 'd1', weight: 5, isCyclic: true },
    ];
    render(<TopDependencyPairsCard snapshot={makeSnapshot(deps)} onSelectPair={onSelectPair} />);
    expect(screen.getByLabelText('Cyclic')).toBeInTheDocument();
  });

  it('caps at 20 entries', () => {
    const deps: DependencyEdge[] = Array.from({ length: 25 }, (_, i) => ({
      fromDistrictId: 'd0',
      toDistrictId: 'd1',
      weight: 25 - i,
      isCyclic: false,
    }));
    render(<TopDependencyPairsCard snapshot={makeSnapshot(deps)} onSelectPair={onSelectPair} />);
    const buttons = screen.getAllByRole('button').filter((b) => b.textContent?.includes('→'));
    expect(buttons.length).toBeLessThanOrEqual(20);
  });

  it('click pair calls onSelectPair', async () => {
    const user = userEvent.setup();
    const deps: DependencyEdge[] = [
      { fromDistrictId: 'd0', toDistrictId: 'd1', weight: 5, isCyclic: false },
    ];
    render(<TopDependencyPairsCard snapshot={makeSnapshot(deps)} onSelectPair={onSelectPair} />);
    const btn = screen.getByText(/alpha → bravo/).closest('button')!;
    await user.click(btn);
    expect(onSelectPair).toHaveBeenCalledWith('d0', 'd1');
  });
});
