import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, fireEvent } from '@testing-library/react';
import type { CodebaseOverviewSnapshot, DistrictSignals } from '@devchain/codebase-overview';
import { Callouts } from './Callouts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return Wrapper;
}

function makeSignal(overrides: Partial<DistrictSignals> & { districtId: string }): DistrictSignals {
  return {
    name: overrides.districtId,
    path: `src/${overrides.districtId}`,
    regionId: 'r-1',
    regionName: 'src',
    files: 5,
    sourceFileCount: 4,
    supportFileCount: 1,
    hasSourceFiles: true,
    loc: 500,
    churn7d: 0,
    churn30d: 0,
    testCoverageRate: null,
    sourceCoverageMeasured: false,
    complexityAvg: null,
    inboundWeight: 0,
    outboundWeight: 0,
    blastRadius: 0,
    couplingScore: 0,
    ownershipHHI: null,
    ownershipMeasured: false,
    primaryAuthorName: null,
    primaryAuthorShare: null,
    primaryAuthorRecentlyActive: false,
    fileTypeBreakdown: { kind: 'extension', counts: {} },
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<CodebaseOverviewSnapshot> = {}): CodebaseOverviewSnapshot {
  return {
    snapshotId: 'snap-1',
    projectKey: '/projects/test',
    name: 'Test Project',
    regions: [{ id: 'r-1', path: 'src', name: 'src', totalFiles: 20, totalLOC: 5000 }],
    districts: [],
    dependencies: [],
    hotspots: [],
    activity: [],
    signals: [],
    globalContributors: [],
    metrics: {
      totalRegions: 1,
      totalDistricts: 0,
      totalFiles: 0,
      gitHistoryDaysAvailable: 30,
      shallowHistoryDetected: false,
      dependencyCoverage: null,
      warnings: [],
      excludedAuthorCount: 0,
      scopeConfigHash: 'test',
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

// 6 signals with blast radius for population guard (need ≥5 positives)
const blastSignals: DistrictSignals[] = [
  makeSignal({ districtId: 'a', blastRadius: 10 }),
  makeSignal({ districtId: 'b', blastRadius: 20 }),
  makeSignal({ districtId: 'c', blastRadius: 30 }),
  makeSignal({ districtId: 'd', blastRadius: 40 }),
  makeSignal({ districtId: 'e', blastRadius: 50 }),
  makeSignal({ districtId: 'f', blastRadius: 60 }),
];

// ---------------------------------------------------------------------------
// Callout 1: Changed + Untested
// ---------------------------------------------------------------------------

describe('Callouts — Changed + Untested', () => {
  it('always renders the card heading', () => {
    const snapshot = makeSnapshot({ signals: [] });
    render(<Callouts snapshot={snapshot} projectId="p1" onSelectDistrict={jest.fn()} />, {
      wrapper: createWrapper(),
    });
    expect(screen.getByText('Changed + Untested')).toBeInTheDocument();
  });

  it('shows EmptyState when no signals match the filter', () => {
    const snapshot = makeSnapshot({ signals: [] });
    render(<Callouts snapshot={snapshot} projectId="p1" onSelectDistrict={jest.fn()} />, {
      wrapper: createWrapper(),
    });
    expect(screen.getByText('Nothing flagged here')).toBeInTheDocument();
  });

  it('renders a row for a district with churn30d > 0 and low coverage', () => {
    const signal = makeSignal({
      districtId: 'ctrl',
      name: 'controllers',
      churn30d: 12,
      hasSourceFiles: true,
      sourceCoverageMeasured: true,
      testCoverageRate: 0.1,
    });
    const snapshot = makeSnapshot({ signals: [signal] });
    render(<Callouts snapshot={snapshot} projectId="p1" onSelectDistrict={jest.fn()} />, {
      wrapper: createWrapper(),
    });
    expect(screen.getByText('controllers')).toBeInTheDocument();
    expect(screen.getByText('12 touches')).toBeInTheDocument();
  });

  it('excludes districts without source files', () => {
    const signal = makeSignal({
      districtId: 'noSource',
      name: 'no-source',
      churn30d: 5,
      hasSourceFiles: false,
      sourceCoverageMeasured: true,
      testCoverageRate: 0.1,
    });
    const snapshot = makeSnapshot({ signals: [signal] });
    render(<Callouts snapshot={snapshot} projectId="p1" onSelectDistrict={jest.fn()} />, {
      wrapper: createWrapper(),
    });
    expect(screen.queryByText('no-source')).not.toBeInTheDocument();
  });

  it('excludes districts where coverage is not measured', () => {
    const signal = makeSignal({
      districtId: 'noMeasure',
      name: 'no-measure',
      churn30d: 5,
      hasSourceFiles: true,
      sourceCoverageMeasured: false,
      testCoverageRate: null,
    });
    const snapshot = makeSnapshot({ signals: [signal] });
    render(<Callouts snapshot={snapshot} projectId="p1" onSelectDistrict={jest.fn()} />, {
      wrapper: createWrapper(),
    });
    expect(screen.queryByText('no-measure')).not.toBeInTheDocument();
  });

  it('excludes districts with adequate coverage (≥ 30%)', () => {
    const signal = makeSignal({
      districtId: 'covered',
      name: 'well-covered',
      churn30d: 5,
      hasSourceFiles: true,
      sourceCoverageMeasured: true,
      testCoverageRate: 0.5,
    });
    const snapshot = makeSnapshot({ signals: [signal] });
    render(<Callouts snapshot={snapshot} projectId="p1" onSelectDistrict={jest.fn()} />, {
      wrapper: createWrapper(),
    });
    expect(screen.queryByText('well-covered')).not.toBeInTheDocument();
  });

  it('calls onSelectDistrict when a row is clicked', () => {
    const onSelectDistrict = jest.fn();
    const signal = makeSignal({
      districtId: 'd-ctrl',
      name: 'controllers',
      churn30d: 8,
      hasSourceFiles: true,
      sourceCoverageMeasured: true,
      testCoverageRate: 0.05,
    });
    const snapshot = makeSnapshot({ signals: [signal] });
    render(<Callouts snapshot={snapshot} projectId="p1" onSelectDistrict={onSelectDistrict} />, {
      wrapper: createWrapper(),
    });
    fireEvent.click(screen.getByText('controllers').closest('button')!);
    expect(onSelectDistrict).toHaveBeenCalledWith('d-ctrl');
  });

  it('caps rendered rows at MAX_ENTRIES (5) when many districts qualify', () => {
    // 20 qualifying signals — only 5 should render
    const signals = Array.from({ length: 20 }, (_, i) =>
      makeSignal({
        districtId: `d-${i}`,
        name: `district-${i}`,
        churn30d: 10 + i,
        hasSourceFiles: true,
        sourceCoverageMeasured: true,
        testCoverageRate: 0.1,
      }),
    );
    const snapshot = makeSnapshot({ signals });
    render(<Callouts snapshot={snapshot} projectId="p1" onSelectDistrict={jest.fn()} />, {
      wrapper: createWrapper(),
    });
    // Each qualifying row shows its churn30d metric as "N touches"
    const rows = screen.getAllByText(/touches$/);
    expect(rows.length).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Callout 2: High-Blast + Untested
// ---------------------------------------------------------------------------

describe('Callouts — High-Blast + Untested', () => {
  it('hides the card when fewer than 5 signals have positive blast radius', () => {
    // Only 3 signals with blast > 0 → guard fails
    const signals = [
      makeSignal({ districtId: 'x1', blastRadius: 10 }),
      makeSignal({ districtId: 'x2', blastRadius: 20 }),
      makeSignal({ districtId: 'x3', blastRadius: 30 }),
    ];
    const snapshot = makeSnapshot({ signals });
    render(<Callouts snapshot={snapshot} projectId="p1" onSelectDistrict={jest.fn()} />, {
      wrapper: createWrapper(),
    });
    expect(screen.queryByText('High-Blast + Untested')).not.toBeInTheDocument();
  });

  it('renders the card when ≥5 signals have positive blast radius', () => {
    const snapshot = makeSnapshot({ signals: blastSignals });
    render(<Callouts snapshot={snapshot} projectId="p1" onSelectDistrict={jest.fn()} />, {
      wrapper: createWrapper(),
    });
    expect(screen.getByText('High-Blast + Untested')).toBeInTheDocument();
  });

  it('shows EmptyState when no high-blast signal is also untested', () => {
    // All blast signals have no coverage measurement → excluded from filter
    const snapshot = makeSnapshot({ signals: blastSignals });
    render(<Callouts snapshot={snapshot} projectId="p1" onSelectDistrict={jest.fn()} />, {
      wrapper: createWrapper(),
    });
    // Card appears but with EmptyState inside
    expect(screen.getByText('High-Blast + Untested')).toBeInTheDocument();
    // "Nothing flagged here" appears at least once (could be in multiple cards)
    expect(screen.getAllByText('Nothing flagged here').length).toBeGreaterThan(0);
  });

  it('renders high-blast untested district rows', () => {
    // P75 of [10,20,30,40,50,60] → index=0.75*5=3.75 → 40+(50-40)*0.75=47.5
    // So blastRadius > 47.5 means signals e(50) and f(60)
    const testedHighBlast = makeSignal({
      districtId: 'e',
      blastRadius: 50,
      name: 'high-blast-svc',
      hasSourceFiles: true,
      sourceCoverageMeasured: true,
      testCoverageRate: 0.1,
    });
    const signals = [...blastSignals.filter((s) => s.districtId !== 'e'), testedHighBlast];
    const snapshot = makeSnapshot({ signals });
    render(<Callouts snapshot={snapshot} projectId="p1" onSelectDistrict={jest.fn()} />, {
      wrapper: createWrapper(),
    });
    expect(screen.getByText('high-blast-svc')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Callout 3: Lone-Author + High-Blast
// ---------------------------------------------------------------------------

describe('Callouts — Lone-Author + High-Blast', () => {
  it('hides the card when fewer than 5 signals have positive blast radius', () => {
    const signals = [
      makeSignal({ districtId: 'x1', blastRadius: 10, ownershipMeasured: true, ownershipHHI: 0.9 }),
      makeSignal({ districtId: 'x2', blastRadius: 20, ownershipMeasured: true, ownershipHHI: 0.9 }),
    ];
    const snapshot = makeSnapshot({ signals });
    render(<Callouts snapshot={snapshot} projectId="p1" onSelectDistrict={jest.fn()} />, {
      wrapper: createWrapper(),
    });
    expect(screen.queryByText('Lone-Author + High-Blast')).not.toBeInTheDocument();
  });

  it('hides the card when no signals have ownership measured', () => {
    // ≥5 blast signals but none with ownershipMeasured
    const snapshot = makeSnapshot({ signals: blastSignals });
    render(<Callouts snapshot={snapshot} projectId="p1" onSelectDistrict={jest.fn()} />, {
      wrapper: createWrapper(),
    });
    expect(screen.queryByText('Lone-Author + High-Blast')).not.toBeInTheDocument();
  });

  it('renders the card when guard passes', () => {
    const signals = [
      ...blastSignals,
      makeSignal({
        districtId: 'lone',
        blastRadius: 55,
        ownershipMeasured: true,
        ownershipHHI: 0.8,
        name: 'lone-svc',
      }),
    ];
    const snapshot = makeSnapshot({ signals });
    render(<Callouts snapshot={snapshot} projectId="p1" onSelectDistrict={jest.fn()} />, {
      wrapper: createWrapper(),
    });
    expect(screen.getByText('Lone-Author + High-Blast')).toBeInTheDocument();
  });

  it('renders lone-author district when HHI > 0.7 and blast > P75', () => {
    const loneSig = makeSignal({
      districtId: 'lone',
      blastRadius: 55,
      ownershipMeasured: true,
      ownershipHHI: 0.85,
      name: 'lone-owner',
    });
    const signals = [...blastSignals, loneSig];
    const snapshot = makeSnapshot({ signals });
    render(<Callouts snapshot={snapshot} projectId="p1" onSelectDistrict={jest.fn()} />, {
      wrapper: createWrapper(),
    });
    expect(screen.getByText('lone-owner')).toBeInTheDocument();
  });

  it('excludes district with HHI ≤ 0.7', () => {
    const sharedSig = makeSignal({
      districtId: 'shared',
      blastRadius: 55,
      ownershipMeasured: true,
      ownershipHHI: 0.5,
      name: 'shared-owner',
    });
    const signals = [...blastSignals, sharedSig];
    const snapshot = makeSnapshot({ signals });
    render(<Callouts snapshot={snapshot} projectId="p1" onSelectDistrict={jest.fn()} />, {
      wrapper: createWrapper(),
    });
    expect(screen.queryByText('shared-owner')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Callout 4: Active Cycles
// ---------------------------------------------------------------------------

describe('Callouts — Active Cycles', () => {
  it('hides the card when there are no bidirectional dependencies', () => {
    const snapshot = makeSnapshot({
      signals: blastSignals,
      dependencies: [{ fromDistrictId: 'a', toDistrictId: 'b', weight: 3, isCyclic: false }],
    });
    render(<Callouts snapshot={snapshot} projectId="p1" onSelectDistrict={jest.fn()} />, {
      wrapper: createWrapper(),
    });
    expect(screen.queryByText('Active Cycles')).not.toBeInTheDocument();
  });

  it('renders the card when bidirectional dependencies exist', () => {
    const snapshot = makeSnapshot({
      signals: [
        makeSignal({ districtId: 'a', name: 'alpha' }),
        makeSignal({ districtId: 'b', name: 'beta' }),
      ],
      dependencies: [
        { fromDistrictId: 'a', toDistrictId: 'b', weight: 2, isCyclic: true },
        { fromDistrictId: 'b', toDistrictId: 'a', weight: 1, isCyclic: true },
      ],
    });
    render(<Callouts snapshot={snapshot} projectId="p1" onSelectDistrict={jest.fn()} />, {
      wrapper: createWrapper(),
    });
    expect(screen.getByText('Active Cycles')).toBeInTheDocument();
  });

  it('displays cycle pair as "A ⇄ B"', () => {
    const snapshot = makeSnapshot({
      signals: [
        makeSignal({ districtId: 'a', name: 'alpha' }),
        makeSignal({ districtId: 'b', name: 'beta' }),
      ],
      dependencies: [
        { fromDistrictId: 'a', toDistrictId: 'b', weight: 2, isCyclic: true },
        { fromDistrictId: 'b', toDistrictId: 'a', weight: 1, isCyclic: true },
      ],
    });
    render(<Callouts snapshot={snapshot} projectId="p1" onSelectDistrict={jest.fn()} />, {
      wrapper: createWrapper(),
    });
    // alpha and beta are text nodes within a single span alongside ⇄
    expect(screen.getByText(/alpha/)).toBeInTheDocument();
    expect(screen.getByText(/beta/)).toBeInTheDocument();
    expect(screen.getByText('⇄')).toBeInTheDocument();
  });

  it('shows weight as combined edge count', () => {
    const snapshot = makeSnapshot({
      signals: [
        makeSignal({ districtId: 'a', name: 'alpha' }),
        makeSignal({ districtId: 'b', name: 'beta' }),
      ],
      dependencies: [
        { fromDistrictId: 'a', toDistrictId: 'b', weight: 5, isCyclic: true },
        { fromDistrictId: 'b', toDistrictId: 'a', weight: 3, isCyclic: true },
      ],
    });
    render(<Callouts snapshot={snapshot} projectId="p1" onSelectDistrict={jest.fn()} />, {
      wrapper: createWrapper(),
    });
    expect(screen.getByText('8 edges')).toBeInTheDocument();
  });

  it('does not render PairDetailPanel initially', () => {
    const snapshot = makeSnapshot({
      signals: [
        makeSignal({ districtId: 'a', name: 'alpha' }),
        makeSignal({ districtId: 'b', name: 'beta' }),
      ],
      dependencies: [
        { fromDistrictId: 'a', toDistrictId: 'b', weight: 2, isCyclic: true },
        { fromDistrictId: 'b', toDistrictId: 'a', weight: 1, isCyclic: true },
      ],
    });
    render(<Callouts snapshot={snapshot} projectId="p1" onSelectDistrict={jest.fn()} />, {
      wrapper: createWrapper(),
    });
    expect(screen.queryByRole('heading', { name: /→/ })).not.toBeInTheDocument();
  });

  it('shows at most 3 cycle pairs', () => {
    const signals = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((id) =>
      makeSignal({ districtId: id, name: id }),
    );
    const deps = [
      { fromDistrictId: 'a', toDistrictId: 'b', weight: 10, isCyclic: true },
      { fromDistrictId: 'b', toDistrictId: 'a', weight: 9, isCyclic: true },
      { fromDistrictId: 'c', toDistrictId: 'd', weight: 8, isCyclic: true },
      { fromDistrictId: 'd', toDistrictId: 'c', weight: 7, isCyclic: true },
      { fromDistrictId: 'e', toDistrictId: 'f', weight: 6, isCyclic: true },
      { fromDistrictId: 'f', toDistrictId: 'e', weight: 5, isCyclic: true },
      { fromDistrictId: 'g', toDistrictId: 'h', weight: 4, isCyclic: true },
      { fromDistrictId: 'h', toDistrictId: 'g', weight: 3, isCyclic: true },
    ];
    const snapshot = makeSnapshot({ signals, dependencies: deps });
    render(<Callouts snapshot={snapshot} projectId="p1" onSelectDistrict={jest.fn()} />, {
      wrapper: createWrapper(),
    });
    // Only top 3 pairs → 3 edge-weight labels visible
    const edgeLabels = screen.getAllByText(/edges$/);
    expect(edgeLabels.length).toBe(3);
  });

  it('correctly finds top-3 cycles in a 1000-edge graph (O(E) correctness)', () => {
    // Build 1000 one-directional edges (non-cyclic) + 50 cyclic pairs
    // Cyclic pairs: district i ↔ district i+500, weights 100+i and 50+i (combined 150+2i)
    // Top 3 by combined weight: pairs 49, 48, 47 → combined 248, 246, 244
    const signals = Array.from({ length: 100 }, (_, i) =>
      makeSignal({ districtId: `d${i}`, name: `district-${i}` }),
    );
    const deps = [
      // 950 one-directional edges (no reverse counterpart)
      ...Array.from({ length: 950 }, (_, i) => ({
        fromDistrictId: `src-${i}`,
        toDistrictId: `dst-${i}`,
        weight: 1,
        isCyclic: false,
      })),
      // 50 cyclic pairs with increasing weight
      ...Array.from({ length: 50 }, (_, i) => ({
        fromDistrictId: `d${i}`,
        toDistrictId: `d${i + 50}`,
        weight: 100 + i,
        isCyclic: true,
      })),
      ...Array.from({ length: 50 }, (_, i) => ({
        fromDistrictId: `d${i + 50}`,
        toDistrictId: `d${i}`,
        weight: 50 + i,
        isCyclic: true,
      })),
    ];
    const snapshot = makeSnapshot({ signals, dependencies: deps });
    render(<Callouts snapshot={snapshot} projectId="p1" onSelectDistrict={jest.fn()} />, {
      wrapper: createWrapper(),
    });

    // Top pair: i=49, combined = (100+49)+(50+49) = 248
    expect(screen.getByText('248 edges')).toBeInTheDocument();
    // 2nd: i=48, combined = 148+98 = 246
    expect(screen.getByText('246 edges')).toBeInTheDocument();
    // 3rd: i=47, combined = 147+97 = 244
    expect(screen.getByText('244 edges')).toBeInTheDocument();

    // Exactly 3 pairs shown
    expect(screen.getAllByText(/edges$/).length).toBe(3);
  });
});
