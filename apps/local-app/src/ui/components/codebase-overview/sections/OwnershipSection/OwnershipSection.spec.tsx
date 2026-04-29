import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CodebaseOverviewSnapshot, DistrictSignals } from '@devchain/codebase-overview';
import { OwnershipSection } from './OwnershipSection';

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
  overrides: Partial<CodebaseOverviewSnapshot> = {},
): CodebaseOverviewSnapshot {
  return {
    snapshotId: 'snap-1',
    projectKey: 'proj-1',
    name: 'Test Project',
    regions: [],
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
    dependencies: [{ fromDistrictId: 'f1', toDistrictId: 't1', weight: 1, isCyclic: false }],
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
    globalContributors: [{ authorName: 'Alice', commitCount7d: 5, commitCount30d: 18 }],
    ...overrides,
  };
}

const onSelectDistrict = jest.fn();

describe('OwnershipSection', () => {
  beforeEach(() => {
    onSelectDistrict.mockClear();
  });

  it('renders section header', () => {
    const signals = [makeSignal({ districtId: 'd1', ownershipMeasured: true })];
    render(
      <OwnershipSection snapshot={makeSnapshot(signals)} onSelectDistrict={onSelectDistrict} />,
    );

    expect(screen.getByText('Ownership')).toBeInTheDocument();
    expect(screen.getByText('Who knows what?')).toBeInTheDocument();
  });

  it('shows empty state when no ownership data', () => {
    const signals = [makeSignal({ districtId: 'd1', ownershipMeasured: false })];
    render(
      <OwnershipSection
        snapshot={makeSnapshot(signals, { globalContributors: [] })}
        onSelectDistrict={onSelectDistrict}
      />,
    );

    expect(screen.getByText('No ownership data available')).toBeInTheDocument();
  });

  it('renders cards when data permits', () => {
    const signals = Array.from({ length: 10 }, (_, i) =>
      makeSignal({
        districtId: `d${i}`,
        ownershipMeasured: true,
        ownershipHHI: 0.85,
        inboundWeight: 15 + i,
        primaryAuthorName: `Author ${i}`,
        primaryAuthorShare: 0.95,
        primaryAuthorRecentlyActive: false,
      }),
    );
    render(
      <OwnershipSection snapshot={makeSnapshot(signals)} onSelectDistrict={onSelectDistrict} />,
    );

    expect(screen.getByText('Bus Factor Risk')).toBeInTheDocument();
    expect(screen.getByText('Lone-Author Districts')).toBeInTheDocument();
    expect(screen.getByText('Owner-Quiet Districts')).toBeInTheDocument();
    expect(screen.getByText('Top Contributors')).toBeInTheDocument();
  });

  it('click row calls onSelectDistrict', async () => {
    const user = userEvent.setup();
    const signals = Array.from({ length: 10 }, (_, i) =>
      makeSignal({
        districtId: `d${i}`,
        name: `district-${i}`,
        ownershipMeasured: true,
        ownershipHHI: 0.85,
        inboundWeight: 15 + i,
        primaryAuthorName: `Author ${i}`,
        primaryAuthorShare: 0.95,
        primaryAuthorRecentlyActive: false,
      }),
    );
    render(
      <OwnershipSection snapshot={makeSnapshot(signals)} onSelectDistrict={onSelectDistrict} />,
    );

    const buttons = screen
      .getAllByRole('button')
      .filter((b) => b.textContent?.includes('district-'));
    await user.click(buttons[0]!);
    expect(onSelectDistrict).toHaveBeenCalled();
  });

  it('hides individual cards that fail population guards', () => {
    const signals = [
      makeSignal({
        districtId: 'd1',
        ownershipMeasured: true,
        ownershipHHI: 0.5,
        primaryAuthorName: 'Alice',
        primaryAuthorShare: 0.7,
        primaryAuthorRecentlyActive: true,
      }),
    ];
    render(
      <OwnershipSection snapshot={makeSnapshot(signals)} onSelectDistrict={onSelectDistrict} />,
    );

    expect(screen.getByText('Ownership')).toBeInTheDocument();
    expect(screen.queryByText('Bus Factor Risk')).not.toBeInTheDocument();
    expect(screen.queryByText('Lone-Author Districts')).not.toBeInTheDocument();
    expect(screen.queryByText('Owner-Quiet Districts')).not.toBeInTheDocument();
    expect(screen.getByText('Top Contributors')).toBeInTheDocument();
  });
});
