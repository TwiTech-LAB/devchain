import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
  CodebaseOverviewSnapshot,
  DistrictSignals,
  DependencyEdge,
} from '@devchain/codebase-overview';
import { TestabilitySection } from './TestabilitySection';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
    testCoverageRate: 0.1,
    sourceCoverageMeasured: true,
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
    fileTypeBreakdown: { kind: 'extension', counts: { ts: 8, json: 2 } },
    ...overrides,
  };
}

function makeSnapshot(
  signals: DistrictSignals[],
  dependencies: DependencyEdge[] = [],
): CodebaseOverviewSnapshot {
  return {
    snapshotId: 'snap-1',
    projectKey: '/test',
    name: 'Test',
    regions: [{ id: 'r1', path: 'src', name: 'src', totalFiles: 100, totalLOC: 10000 }],
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
      testFileCount: 0,
      testFileRatio: 0,
      role: 'service' as const,
      complexityAvg: s.complexityAvg,
      ownershipConcentration: null,
      testCoverageRate: s.testCoverageRate,
      blastRadius: s.blastRadius,
      primaryAuthorName: null,
      primaryAuthorShare: null,
      primaryAuthorRecentlyActive: false,
    })),
    dependencies,
    hotspots: [],
    activity: [],
    signals,
    globalContributors: [],
    metrics: {
      totalRegions: 1,
      totalDistricts: signals.length,
      totalFiles: 100,
      gitHistoryDaysAvailable: 30,
      shallowHistoryDetected: false,
      dependencyCoverage: null,
      warnings: [],
      excludedAuthorCount: 0,
      scopeConfigHash: 'test',
    },
  };
}

function getRowButtons(card: HTMLElement): HTMLElement[] {
  return within(card)
    .getAllByRole('button')
    .filter((b) => !b.hasAttribute('aria-label'));
}

const onSelectDistrict = jest.fn();

function renderSection(signals: DistrictSignals[], deps: DependencyEdge[] = []) {
  const snapshot = makeSnapshot(signals, deps);
  return render(<TestabilitySection snapshot={snapshot} onSelectDistrict={onSelectDistrict} />);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TestabilitySection', () => {
  beforeEach(() => {
    onSelectDistrict.mockClear();
  });

  // -----------------------------------------------------------------------
  // Base eligible filter
  // -----------------------------------------------------------------------

  describe('base eligible filter', () => {
    it('excludes districts without source files', () => {
      const signals = Array.from({ length: 6 }, (_, i) =>
        makeSignal({
          districtId: `d${i}`,
          hasSourceFiles: i !== 0,
          churn30d: 10,
        }),
      );
      renderSection(signals);

      expect(screen.queryByText('d0')).not.toBeInTheDocument();
      expect(screen.getByText('d1')).toBeInTheDocument();
    });

    it('excludes districts where source coverage is not measured', () => {
      const signals = Array.from({ length: 6 }, (_, i) =>
        makeSignal({
          districtId: `d${i}`,
          sourceCoverageMeasured: i !== 0,
          churn30d: 10,
        }),
      );
      renderSection(signals);

      expect(screen.queryByText('d0')).not.toBeInTheDocument();
    });

    it('excludes districts with testCoverageRate === null (unmeasured)', () => {
      const signals = Array.from({ length: 6 }, (_, i) =>
        makeSignal({
          districtId: `d${i}`,
          testCoverageRate: i === 0 ? null : 0.1,
          churn30d: 10,
        }),
      );
      renderSection(signals);

      expect(screen.queryByText('d0')).not.toBeInTheDocument();
    });

    it('excludes districts with testCoverageRate >= 0.3', () => {
      const signals = Array.from({ length: 6 }, (_, i) =>
        makeSignal({
          districtId: `d${i}`,
          testCoverageRate: i === 0 ? 0.5 : 0.1,
          churn30d: 10,
        }),
      );
      renderSection(signals);

      expect(screen.queryByText('d0')).not.toBeInTheDocument();
    });

    it('shows section-level empty state when no eligible districts', () => {
      const signals = [
        makeSignal({ districtId: 'd0', testCoverageRate: 0.8 }),
        makeSignal({ districtId: 'd1', testCoverageRate: 0.9 }),
      ];
      renderSection(signals);

      expect(screen.getByText('No untested source code')).toBeInTheDocument();
    });
  });

  // -----------------------------------------------------------------------
  // Untested Changed card
  // -----------------------------------------------------------------------

  describe('Untested Changed card', () => {
    it('renders districts with churn30d > 0', () => {
      const signals = Array.from({ length: 6 }, (_, i) =>
        makeSignal({ districtId: `d${i}`, churn30d: (6 - i) * 5 }),
      );
      renderSection(signals);

      expect(screen.getByText('Untested Changed')).toBeInTheDocument();
      expect(screen.getByText('d0')).toBeInTheDocument();
    });

    it('excludes districts with churn30d === 0', () => {
      const withChurn = Array.from({ length: 5 }, (_, i) =>
        makeSignal({ districtId: `active-${i}`, churn30d: 10 }),
      );
      const noChurn = makeSignal({ districtId: 'stale', churn30d: 0 });
      renderSection([...withChurn, noChurn]);

      expect(screen.queryByText('stale')).not.toBeInTheDocument();
    });

    it('sorts by churn30d desc, ties broken by loc desc', () => {
      const signals = [
        makeSignal({ districtId: 'a', churn30d: 20, loc: 100 }),
        makeSignal({ districtId: 'b', churn30d: 20, loc: 500 }),
        makeSignal({ districtId: 'c', churn30d: 30, loc: 100 }),
        makeSignal({ districtId: 'd4', churn30d: 1, loc: 100 }),
        makeSignal({ districtId: 'd5', churn30d: 1, loc: 100 }),
      ];
      renderSection(signals);

      const card = screen.getByText('Untested Changed').closest('[class*="rounded"]')!;
      const rows = getRowButtons(card as HTMLElement);
      const names = rows.map((b) => b.textContent);
      expect(names[0]).toContain('c');
      expect(names[1]).toContain('b');
      expect(names[2]).toContain('a');
    });

    it('caps at 15 entries', () => {
      const signals = Array.from({ length: 20 }, (_, i) =>
        makeSignal({ districtId: `d${i}`, churn30d: 20 - i }),
      );
      renderSection(signals);

      const card = screen.getByText('Untested Changed').closest('[class*="rounded"]')!;
      const rows = getRowButtons(card as HTMLElement);
      expect(rows.length).toBe(15);
    });

    it('hides card when fewer than 5 eligible after filter', () => {
      const signals = Array.from({ length: 4 }, (_, i) =>
        makeSignal({ districtId: `d${i}`, churn30d: 10 }),
      );
      renderSection(signals);

      expect(screen.queryByText('Untested Changed')).not.toBeInTheDocument();
    });

    it('displays metric text per row', () => {
      const signals = Array.from({ length: 5 }, (_, i) =>
        makeSignal({ districtId: `d${i}`, churn30d: 15 }),
      );
      renderSection(signals);

      expect(screen.getAllByText('15 file touches in 30d').length).toBeGreaterThan(0);
    });
  });

  // -----------------------------------------------------------------------
  // Untested Critical card
  // -----------------------------------------------------------------------

  describe('Untested Critical card', () => {
    const deps: DependencyEdge[] = [
      { fromDistrictId: 'd-a', toDistrictId: 'd-b', weight: 3, isCyclic: false },
    ];

    function makeCriticalSignals() {
      return [
        ...Array.from({ length: 6 }, (_, i) =>
          makeSignal({ districtId: `high-${i}`, inboundWeight: 20 + i }),
        ),
        ...Array.from({ length: 14 }, (_, i) =>
          makeSignal({ districtId: `low-${i}`, inboundWeight: 1 }),
        ),
      ];
    }

    it('renders when dependencies exist and inbound > P75', () => {
      renderSection(makeCriticalSignals(), deps);

      expect(screen.getByText('Untested Critical')).toBeInTheDocument();
    });

    it('hides card when no dependencies exist', () => {
      renderSection(makeCriticalSignals(), []);

      expect(screen.queryByText('Untested Critical')).not.toBeInTheDocument();
    });

    it('hides card when no inboundWeight > 0', () => {
      const signals = Array.from({ length: 8 }, (_, i) =>
        makeSignal({ districtId: `d${i}`, inboundWeight: 0 }),
      );
      renderSection(signals, deps);

      expect(screen.queryByText('Untested Critical')).not.toBeInTheDocument();
    });

    it('sorts by inboundWeight desc, ties broken by loc desc', () => {
      const signals = [
        makeSignal({ districtId: 'top', inboundWeight: 30, loc: 100 }),
        makeSignal({ districtId: 'tie-big', inboundWeight: 25, loc: 1000 }),
        makeSignal({ districtId: 'tie-small', inboundWeight: 25, loc: 100 }),
        makeSignal({ districtId: 'mid1', inboundWeight: 22, loc: 100 }),
        makeSignal({ districtId: 'mid2', inboundWeight: 21, loc: 100 }),
        makeSignal({ districtId: 'mid3', inboundWeight: 20, loc: 100 }),
        ...Array.from({ length: 14 }, (_, i) =>
          makeSignal({ districtId: `filler-${i}`, inboundWeight: 1 }),
        ),
      ];
      renderSection(signals, deps);

      const card = screen.getByText('Untested Critical').closest('[class*="rounded"]')!;
      const rows = getRowButtons(card as HTMLElement);
      expect(rows[0]!.textContent).toContain('top');
      expect(rows[1]!.textContent).toContain('tie-big');
      expect(rows[2]!.textContent).toContain('tie-small');
    });

    it('displays inbound weight metric', () => {
      renderSection(makeCriticalSignals(), deps);

      expect(screen.getAllByText(/Used by \d+ districts/).length).toBeGreaterThan(0);
    });
  });

  // -----------------------------------------------------------------------
  // Untested Complex card
  // -----------------------------------------------------------------------

  describe('Untested Complex card', () => {
    function makeComplexSignals() {
      return [
        ...Array.from({ length: 6 }, (_, i) =>
          makeSignal({ districtId: `complex-${i}`, complexityAvg: 20 + i * 2 }),
        ),
        ...Array.from({ length: 14 }, (_, i) =>
          makeSignal({ districtId: `simple-${i}`, complexityAvg: 3 }),
        ),
      ];
    }

    it('renders when complexity values exist and > P75', () => {
      renderSection(makeComplexSignals());

      expect(screen.getByText('Untested Complex')).toBeInTheDocument();
    });

    it('excludes districts with complexityAvg === null', () => {
      const signals = [
        makeSignal({ districtId: 'has-null', complexityAvg: null }),
        ...makeComplexSignals(),
      ];
      renderSection(signals);

      const card = screen.getByText('Untested Complex').closest('[class*="rounded"]');
      expect(within(card as HTMLElement).queryByText('has-null')).not.toBeInTheDocument();
    });

    it('hides card when all complexity values are null', () => {
      const signals = Array.from({ length: 8 }, (_, i) =>
        makeSignal({ districtId: `d${i}`, complexityAvg: null, churn30d: 10 }),
      );
      renderSection(signals);

      expect(screen.queryByText('Untested Complex')).not.toBeInTheDocument();
    });

    it('sorts by complexityAvg desc, ties broken by loc desc', () => {
      const signals = [
        makeSignal({ districtId: 'top', complexityAvg: 35, loc: 100 }),
        makeSignal({ districtId: 'tie-big', complexityAvg: 30, loc: 1000 }),
        makeSignal({ districtId: 'tie-small', complexityAvg: 30, loc: 100 }),
        makeSignal({ districtId: 'mid1', complexityAvg: 25, loc: 100 }),
        makeSignal({ districtId: 'mid2', complexityAvg: 22, loc: 100 }),
        makeSignal({ districtId: 'mid3', complexityAvg: 20, loc: 100 }),
        ...Array.from({ length: 14 }, (_, i) =>
          makeSignal({ districtId: `filler-${i}`, complexityAvg: 3 }),
        ),
      ];
      renderSection(signals);

      const card = screen.getByText('Untested Complex').closest('[class*="rounded"]')!;
      const rows = getRowButtons(card as HTMLElement);
      expect(rows[0]!.textContent).toContain('top');
      expect(rows[1]!.textContent).toContain('tie-big');
      expect(rows[2]!.textContent).toContain('tie-small');
    });

    it('formats complexity to 1 decimal', () => {
      const signals = [
        makeSignal({ districtId: 'precise', complexityAvg: 25.567 }),
        ...Array.from({ length: 5 }, (_, i) =>
          makeSignal({ districtId: `high-${i}`, complexityAvg: 20 + i }),
        ),
        ...Array.from({ length: 14 }, (_, i) =>
          makeSignal({ districtId: `low-${i}`, complexityAvg: 3 }),
        ),
      ];
      renderSection(signals);

      expect(screen.getByText('Complexity 25.6')).toBeInTheDocument();
    });
  });

  // -----------------------------------------------------------------------
  // Section-level behavior
  // -----------------------------------------------------------------------

  describe('section-level behavior', () => {
    it('does not show section-level empty when eligible exist but no card passes population guard', () => {
      const signals = Array.from({ length: 4 }, (_, i) =>
        makeSignal({
          districtId: `d${i}`,
          churn30d: 10,
          inboundWeight: 0,
          complexityAvg: null,
        }),
      );
      renderSection(signals);

      expect(screen.queryByText('No untested source code')).not.toBeInTheDocument();
    });

    it('shows section-level empty when eligible base is empty', () => {
      const signals = Array.from({ length: 5 }, (_, i) =>
        makeSignal({ districtId: `d${i}`, testCoverageRate: 0.8 }),
      );
      renderSection(signals);

      expect(screen.getByText('No untested source code')).toBeInTheDocument();
    });

    it('click row calls onSelectDistrict', async () => {
      const user = userEvent.setup();
      const signals = Array.from({ length: 6 }, (_, i) =>
        makeSignal({ districtId: `d${i}`, churn30d: 10 }),
      );
      renderSection(signals);

      await user.click(screen.getByText('d0'));
      expect(onSelectDistrict).toHaveBeenCalledWith('d0');
    });

    it('renders section header', () => {
      const signals = Array.from({ length: 6 }, (_, i) =>
        makeSignal({ districtId: `d${i}`, churn30d: 10 }),
      );
      renderSection(signals);

      expect(screen.getByText('Testability')).toBeInTheDocument();
      expect(
        screen.getByText('Where untested code intersects with risk signals'),
      ).toBeInTheDocument();
    });

    it('shows coverage percentage per row', () => {
      const signals = Array.from({ length: 6 }, (_, i) =>
        makeSignal({ districtId: `d${i}`, churn30d: 10, testCoverageRate: 0.15 }),
      );
      renderSection(signals);

      expect(screen.getAllByText('15%').length).toBeGreaterThan(0);
    });
  });
});
