import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
  CodebaseOverviewSnapshot,
  DistrictSignals,
  RegionNode,
} from '@devchain/codebase-overview';
import { StructureSection } from './StructureSection';

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
    couplingScore: 5,
    ownershipHHI: 0.6,
    ownershipMeasured: true,
    primaryAuthorName: 'Dev',
    primaryAuthorShare: 0.8,
    primaryAuthorRecentlyActive: true,
    fileTypeBreakdown: { kind: 'extension', counts: { '.ts': 8, '.json': 2 } },
    ...overrides,
  };
}

function makeSnapshot(
  signals: DistrictSignals[],
  regions: RegionNode[] = [{ id: 'r1', path: 'src', name: 'src', totalFiles: 100, totalLOC: 5000 }],
): CodebaseOverviewSnapshot {
  return {
    snapshotId: 's1',
    projectKey: 'p1',
    name: 'Test',
    regions,
    districts: [],
    dependencies: [],
    hotspots: [],
    activity: [],
    metrics: {
      totalRegions: regions.length,
      totalDistricts: signals.length,
      totalFiles: 100,
      gitHistoryDaysAvailable: 30,
      shallowHistoryDetected: false,
      dependencyCoverage: null,
      warnings: [],
      excludedAuthorCount: 0,
      scopeConfigHash: 'test',
    },
    signals,
    globalContributors: [],
  };
}

const onSelectDistrict = jest.fn();

describe('StructureSection', () => {
  beforeEach(() => {
    onSelectDistrict.mockClear();
    localStorage.clear();
  });

  it('renders section header and summary stats', () => {
    const signals = [
      makeSignal({ districtId: 'd1', files: 50, loc: 2000 }),
      makeSignal({ districtId: 'd2', files: 30, loc: 1500 }),
    ];
    render(
      <StructureSection snapshot={makeSnapshot(signals)} onSelectDistrict={onSelectDistrict} />,
    );

    expect(screen.getByText('Structure')).toBeInTheDocument();
    expect(screen.getByText("What's in this repo?")).toBeInTheDocument();
    expect(screen.getByText(/1 region.*2 districts.*80 files.*3,500 LOC/)).toBeInTheDocument();
  });

  it('shows empty state when no signals', () => {
    render(<StructureSection snapshot={makeSnapshot([])} onSelectDistrict={onSelectDistrict} />);

    expect(screen.getByText('No districts analyzed')).toBeInTheDocument();
  });

  it('renders region groups with districts', () => {
    const signals = [
      makeSignal({ districtId: 'alpha', name: 'alpha' }),
      makeSignal({ districtId: 'bravo', name: 'bravo' }),
    ];
    render(
      <StructureSection snapshot={makeSnapshot(signals)} onSelectDistrict={onSelectDistrict} />,
    );

    expect(screen.getByText('src')).toBeInTheDocument();
    expect(screen.getByText('alpha')).toBeInTheDocument();
    expect(screen.getByText('bravo')).toBeInTheDocument();
  });

  it('groups districts by regionId', () => {
    const regions: RegionNode[] = [
      { id: 'r1', path: 'src', name: 'src', totalFiles: 50, totalLOC: 3000 },
      { id: 'r2', path: 'lib', name: 'lib', totalFiles: 30, totalLOC: 1000 },
    ];
    const signals = [
      makeSignal({ districtId: 'a', name: 'a', regionId: 'r1' }),
      makeSignal({ districtId: 'b', name: 'b', regionId: 'r2' }),
    ];
    render(
      <StructureSection
        snapshot={makeSnapshot(signals, regions)}
        onSelectDistrict={onSelectDistrict}
      />,
    );

    expect(screen.getByText('src')).toBeInTheDocument();
    expect(screen.getByText('lib')).toBeInTheDocument();
  });

  it('click district row calls onSelectDistrict', async () => {
    const user = userEvent.setup();
    const signals = [makeSignal({ districtId: 'target', name: 'target' })];
    render(
      <StructureSection snapshot={makeSnapshot(signals)} onSelectDistrict={onSelectDistrict} />,
    );

    const btn = screen.getByText('target').closest('button')!;
    await user.click(btn);
    expect(onSelectDistrict).toHaveBeenCalledWith('target');
  });

  it('renders "Configure scope" button when onNavigateToScope is provided', () => {
    const onNavigateToScope = jest.fn();
    const signals = [makeSignal({ districtId: 'd1' })];
    render(
      <StructureSection
        snapshot={makeSnapshot(signals)}
        onSelectDistrict={onSelectDistrict}
        onNavigateToScope={onNavigateToScope}
      />,
    );

    expect(screen.getByRole('button', { name: /configure scope/i })).toBeInTheDocument();
  });

  it('does not render "Configure scope" button when onNavigateToScope is not provided', () => {
    const signals = [makeSignal({ districtId: 'd1' })];
    render(
      <StructureSection snapshot={makeSnapshot(signals)} onSelectDistrict={onSelectDistrict} />,
    );

    expect(screen.queryByRole('button', { name: /configure scope/i })).not.toBeInTheDocument();
  });

  it('clicking "Configure scope" calls onNavigateToScope', async () => {
    const user = userEvent.setup();
    const onNavigateToScope = jest.fn();
    const signals = [makeSignal({ districtId: 'd1' })];
    render(
      <StructureSection
        snapshot={makeSnapshot(signals)}
        onSelectDistrict={onSelectDistrict}
        onNavigateToScope={onNavigateToScope}
      />,
    );

    await user.click(screen.getByRole('button', { name: /configure scope/i }));
    expect(onNavigateToScope).toHaveBeenCalledTimes(1);
  });

  it('renders "Configure scope" button in empty state too', () => {
    const onNavigateToScope = jest.fn();
    render(
      <StructureSection
        snapshot={makeSnapshot([])}
        onSelectDistrict={onSelectDistrict}
        onNavigateToScope={onNavigateToScope}
      />,
    );

    expect(screen.getByRole('button', { name: /configure scope/i })).toBeInTheDocument();
  });

  it('top region by file count is default expanded', () => {
    const regions: RegionNode[] = [
      { id: 'r1', path: 'src', name: 'src', totalFiles: 50, totalLOC: 3000 },
      { id: 'r2', path: 'lib', name: 'lib', totalFiles: 80, totalLOC: 1000 },
    ];
    const signals = [
      makeSignal({ districtId: 'a', name: 'a-src', regionId: 'r1' }),
      makeSignal({ districtId: 'b', name: 'b-lib', regionId: 'r2' }),
    ];
    render(
      <StructureSection
        snapshot={makeSnapshot(signals, regions)}
        onSelectDistrict={onSelectDistrict}
      />,
    );

    expect(screen.getByText('b-lib')).toBeInTheDocument();
    expect(screen.queryByText('a-src')).not.toBeInTheDocument();
  });
});
