import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type {
  CodebaseOverviewSnapshot,
  DistrictSignals,
  DependencyEdge,
} from '@devchain/codebase-overview';
import { ArchitectureSection } from './ArchitectureSection';

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

function makeSnapshot(
  signals: DistrictSignals[],
  dependencies: DependencyEdge[] = [],
  overrides: Partial<CodebaseOverviewSnapshot> = {},
): CodebaseOverviewSnapshot {
  return {
    snapshotId: 'snap-1',
    projectKey: 'proj-1',
    name: 'Test Project',
    regions: [{ id: 'r1', path: 'src', name: 'src', totalFiles: 10, totalLOC: 1000 }],
    districts: signals.map((s) => ({
      id: s.districtId,
      regionId: s.regionId,
      path: s.path,
      name: s.name,
      totalFiles: s.files,
      totalLOC: s.loc,
      churn7d: s.churn7d,
      churn30d: s.churn30d,
      inboundWeight: s.inboundWeight,
      outboundWeight: s.outboundWeight,
      couplingScore: s.couplingScore,
      testFileCount: 2,
      testFileRatio: 0.2,
      role: 'service' as const,
      complexityAvg: s.complexityAvg,
      ownershipConcentration: s.ownershipHHI,
      testCoverageRate: s.testCoverageRate,
      blastRadius: s.blastRadius,
      primaryAuthorName: s.primaryAuthorName,
      primaryAuthorShare: s.primaryAuthorShare,
      primaryAuthorRecentlyActive: s.primaryAuthorRecentlyActive,
    })),
    dependencies,
    hotspots: [],
    activity: [],
    metrics: {
      totalRegions: 1,
      totalDistricts: signals.length,
      totalFiles: 10,
      gitHistoryDaysAvailable: 90,
      shallowHistoryDetected: false,
      dependencyCoverage: 1,
      warnings: [],
      excludedAuthorCount: 0,
      scopeConfigHash: 'test',
    },
    signals,
    globalContributors: [],
    ...overrides,
  };
}

const onSelectDistrict = jest.fn();

function renderSection(snapshot: CodebaseOverviewSnapshot) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ArchitectureSection
        snapshot={snapshot}
        projectId="p1"
        selectedDistrictId={null}
        onSelectDistrict={onSelectDistrict}
      />
    </QueryClientProvider>,
  );
}

describe('ArchitectureSection', () => {
  beforeEach(() => {
    onSelectDistrict.mockClear();
  });

  it('renders section header', () => {
    const signals = Array.from({ length: 10 }, (_, i) =>
      makeSignal({ districtId: `d${i}`, blastRadius: 5 + i }),
    );
    renderSection(
      makeSnapshot(signals, [
        { fromDistrictId: 'd0', toDistrictId: 'd1', weight: 3, isCyclic: false },
      ]),
    );

    expect(screen.getByText('Architecture')).toBeInTheDocument();
    expect(screen.getByText('Is the structure decaying?')).toBeInTheDocument();
  });

  it('shows empty state when no architecture data', () => {
    const signals = [makeSignal({ districtId: 'd1', blastRadius: 0, couplingScore: 0 })];
    renderSection(makeSnapshot(signals));

    expect(screen.getByText('No architecture data available')).toBeInTheDocument();
  });

  it('renders Dependency Matrix when dependencies exist', () => {
    const signals = [
      makeSignal({ districtId: 'd0', name: 'alpha' }),
      makeSignal({ districtId: 'd1', name: 'bravo' }),
    ];
    const deps: DependencyEdge[] = [
      { fromDistrictId: 'd0', toDistrictId: 'd1', weight: 5, isCyclic: false },
    ];
    renderSection(makeSnapshot(signals, deps));

    expect(screen.getByText('Dependency Matrix')).toBeInTheDocument();
  });

  it('renders BlastRadiusLeadersCard when sufficient signals have blast > 0', () => {
    const signals = Array.from({ length: 10 }, (_, i) =>
      makeSignal({ districtId: `d${i}`, name: `district-${i}`, blastRadius: 5 + i }),
    );
    renderSection(
      makeSnapshot(signals, [
        { fromDistrictId: 'd0', toDistrictId: 'd1', weight: 1, isCyclic: false },
      ]),
    );

    expect(screen.getByText('Blast Radius Leaders')).toBeInTheDocument();
  });

  it('renders CyclesCard when cyclic pairs exist', () => {
    const signals = [
      makeSignal({ districtId: 'd0', name: 'alpha' }),
      makeSignal({ districtId: 'd1', name: 'bravo' }),
    ];
    const deps: DependencyEdge[] = [
      { fromDistrictId: 'd0', toDistrictId: 'd1', weight: 5, isCyclic: true },
      { fromDistrictId: 'd1', toDistrictId: 'd0', weight: 3, isCyclic: true },
    ];
    renderSection(makeSnapshot(signals, deps));

    expect(screen.getByText('Dependency Cycles')).toBeInTheDocument();
    expect(screen.getByText(/alpha ↔ bravo/)).toBeInTheDocument();
  });

  it('renders TopDependencyPairsCard when dependencies exist', () => {
    const signals = [
      makeSignal({ districtId: 'd0', name: 'alpha' }),
      makeSignal({ districtId: 'd1', name: 'bravo' }),
    ];
    const deps: DependencyEdge[] = [
      { fromDistrictId: 'd0', toDistrictId: 'd1', weight: 5, isCyclic: false },
    ];
    renderSection(makeSnapshot(signals, deps));

    expect(screen.getByText('Top Dependency Pairs')).toBeInTheDocument();
  });

  it('click district row calls onSelectDistrict', async () => {
    const user = userEvent.setup();
    const signals = Array.from({ length: 10 }, (_, i) =>
      makeSignal({ districtId: `d${i}`, name: `district-${i}`, blastRadius: 5 + i }),
    );
    renderSection(
      makeSnapshot(signals, [
        { fromDistrictId: 'd0', toDistrictId: 'd1', weight: 1, isCyclic: false },
      ]),
    );

    const blastCard = screen.getByText('Blast Radius Leaders').closest('[class*="card"]')!;
    const cardButtons = Array.from(blastCard.querySelectorAll('button')).filter((b) =>
      b.textContent?.includes('district-'),
    );
    await user.click(cardButtons[0]!);
    expect(onSelectDistrict).toHaveBeenCalled();
  });
});
