import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import type {
  CodebaseOverviewSnapshot,
  DistrictSignals,
  ActivitySummary,
  AnalysisWarning,
  CodebaseOverviewMetrics,
} from '@devchain/codebase-overview';
import { Heatmap, formatTooltipDate } from './Heatmap';

// ---------------------------------------------------------------------------
// Date helpers — must match the component's getLast14Dates() logic
// ---------------------------------------------------------------------------

function computeTestDates(): string[] {
  const dates: string[] = [];
  const today = new Date();
  for (let i = 13; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const y = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    const dy = String(d.getDate()).padStart(2, '0');
    dates.push(`${y}-${mo}-${dy}`);
  }
  return dates;
}

const TEST_DATES = computeTestDates();
const TODAY = TEST_DATES[13];
const YESTERDAY = TEST_DATES[12];
const OLDEST = TEST_DATES[0];

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makeSignal(districtId: string, name: string, churn30d: number): DistrictSignals {
  return {
    districtId,
    name,
    path: name,
    regionId: 'r1',
    regionName: 'root',
    files: 10,
    sourceFileCount: 8,
    supportFileCount: 2,
    hasSourceFiles: true,
    loc: 1000,
    churn7d: Math.floor(churn30d / 4),
    churn30d,
    testCoverageRate: null,
    sourceCoverageMeasured: false,
    complexityAvg: null,
    inboundWeight: 1,
    outboundWeight: 1,
    blastRadius: 5,
    couplingScore: 0.5,
    ownershipHHI: null,
    ownershipMeasured: false,
    primaryAuthorName: null,
    primaryAuthorShare: null,
    primaryAuthorRecentlyActive: false,
    fileTypeBreakdown: { kind: 'extension', counts: {} },
  };
}

function makeActivity(targetId: string, dailyChurn: Record<string, number> = {}): ActivitySummary {
  return {
    targetId,
    targetKind: 'district',
    modifiedCount1d: 0,
    modifiedCount7d: 0,
    buildFailures7d: null,
    testFailures7d: null,
    latestTimestamp: null,
    dailyChurn,
    recentContributors7d: [],
    recentContributors30d: [],
  };
}

function makeMetrics(warnings: AnalysisWarning[] = []): CodebaseOverviewMetrics {
  return {
    totalRegions: 1,
    totalDistricts: 2,
    totalFiles: 20,
    gitHistoryDaysAvailable: 30,
    shallowHistoryDetected: false,
    dependencyCoverage: null,
    warnings,
  };
}

function makeSnapshot(
  signals: DistrictSignals[],
  activity: ActivitySummary[],
  warnings: AnalysisWarning[] = [],
): CodebaseOverviewSnapshot {
  return {
    snapshotId: 's1',
    projectKey: 'test',
    name: 'Test',
    regions: [],
    districts: [],
    dependencies: [],
    hotspots: [],
    activity,
    metrics: makeMetrics(warnings),
    signals,
    globalContributors: [],
  };
}

// ---------------------------------------------------------------------------
// Baseline snapshot (two qualifying districts)
// ---------------------------------------------------------------------------

const SIGNAL_ALPHA = makeSignal('d-alpha', 'apps/alpha', 10);
const SIGNAL_BETA = makeSignal('d-beta', 'apps/beta', 5);
const SIGNAL_ZERO = makeSignal('d-zero', 'apps/zero', 0);

const ACT_ALPHA = makeActivity('d-alpha', { [TODAY]: 3, [YESTERDAY]: 7 });
const ACT_BETA = makeActivity('d-beta', { [TODAY]: 1 });
const ACT_ZERO = makeActivity('d-zero', {});

const BASE_SNAPSHOT = makeSnapshot(
  [SIGNAL_ALPHA, SIGNAL_BETA, SIGNAL_ZERO],
  [ACT_ALPHA, ACT_BETA, ACT_ZERO],
);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Heatmap', () => {
  it('renders 14 date columns plus the district label column', () => {
    const { container } = render(<Heatmap snapshot={BASE_SNAPSHOT} onSelectDistrict={jest.fn()} />);
    const headers = container.querySelectorAll('thead th');
    expect(headers).toHaveLength(15); // 1 label + 14 dates
  });

  it('filters out districts with churn30d === 0', () => {
    render(<Heatmap snapshot={BASE_SNAPSHOT} onSelectDistrict={jest.fn()} />);
    expect(screen.queryByTitle('apps/zero')).not.toBeInTheDocument();
    expect(screen.getByTitle('apps/alpha')).toBeInTheDocument();
  });

  it('sorts rows by churn30d descending (highest first)', () => {
    const { container } = render(<Heatmap snapshot={BASE_SNAPSHOT} onSelectDistrict={jest.fn()} />);
    const rowLabels = container.querySelectorAll('tbody tr td:first-child button span');
    expect(rowLabels[0].textContent).toBe('apps/alpha'); // churn30d=10
    expect(rowLabels[1].textContent).toBe('apps/beta'); // churn30d=5
  });

  it('caps at 30 rows when more than 30 qualify', () => {
    const signals = Array.from({ length: 31 }, (_, i) =>
      makeSignal(`d${i}`, `district-${i}`, i + 1),
    );
    const activity = signals.map((s) => makeActivity(s.districtId, { [TODAY]: 1 }));
    const snapshot = makeSnapshot(signals, activity);
    const { container } = render(<Heatmap snapshot={snapshot} onSelectDistrict={jest.fn()} />);
    expect(container.querySelectorAll('tbody tr')).toHaveLength(30);
  });

  it('cell aria-label contains district name, count, and date', () => {
    const { container } = render(<Heatmap snapshot={BASE_SNAPSHOT} onSelectDistrict={jest.fn()} />);
    const todayFormatted = formatTooltipDate(TODAY);
    const cell = container.querySelector(
      `[aria-label*="apps/alpha"][aria-label*="${todayFormatted}"]`,
    );
    expect(cell).toBeInTheDocument();
    expect(cell!.getAttribute('aria-label')).toMatch(/changed file/);
  });

  it('calls onSelectDistrict with correct id when row label clicked', () => {
    const onSelect = jest.fn();
    render(<Heatmap snapshot={BASE_SNAPSHOT} onSelectDistrict={onSelect} />);
    fireEvent.click(screen.getByTitle('apps/alpha'));
    expect(onSelect).toHaveBeenCalledWith('d-alpha');
  });

  it('calls onSelectDistrict on Enter key press on row button', () => {
    const onSelect = jest.fn();
    render(<Heatmap snapshot={BASE_SNAPSHOT} onSelectDistrict={onSelect} />);
    fireEvent.keyDown(screen.getByTitle('apps/beta'), { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith('d-beta');
  });

  it('returns null when daily_churn_unavailable warning is present', () => {
    const snapshot = makeSnapshot(
      [SIGNAL_ALPHA],
      [ACT_ALPHA],
      [{ code: 'daily_churn_unavailable', message: 'unavailable' }],
    );
    const { container } = render(<Heatmap snapshot={snapshot} onSelectDistrict={jest.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it('shows EmptyState when no districts qualify (all churn30d === 0)', () => {
    const snapshot = makeSnapshot([SIGNAL_ZERO], [ACT_ZERO]);
    render(<Heatmap snapshot={snapshot} onSelectDistrict={jest.fn()} />);
    expect(screen.getByText('No recent activity')).toBeInTheDocument();
  });

  it('shows EmptyState when qualifying districts have all-zero dailyChurn in window', () => {
    const snapshot = makeSnapshot(
      [makeSignal('d1', 'apps/quiet', 5)],
      [makeActivity('d1', { '2020-01-01': 3 })], // data outside the 14-day window
    );
    render(<Heatmap snapshot={snapshot} onSelectDistrict={jest.fn()} />);
    expect(screen.getByText('No recent activity')).toBeInTheDocument();
  });

  it('header date columns have sticky top-0 class', () => {
    const { container } = render(<Heatmap snapshot={BASE_SNAPSHOT} onSelectDistrict={jest.fn()} />);
    const dateThs = Array.from(container.querySelectorAll('thead th')).slice(1);
    dateThs.forEach((th) => {
      expect(th.className).toMatch(/top-0/);
    });
  });

  it('district label column has sticky left-0 class', () => {
    const { container } = render(<Heatmap snapshot={BASE_SNAPSHOT} onSelectDistrict={jest.fn()} />);
    const bodyFirstCells = container.querySelectorAll('tbody td:first-child');
    bodyFirstCells.forEach((td) => {
      expect(td.className).toMatch(/left-0/);
    });
  });

  it('district name button has min-h-10 for 40px touch target', () => {
    render(<Heatmap snapshot={BASE_SNAPSHOT} onSelectDistrict={jest.fn()} />);
    const btn = screen.getByTitle('apps/alpha');
    expect(btn.className).toMatch(/min-h-10/);
  });

  it('uses global max for intensity scaling — cell at max value gets bg-primary class', () => {
    // YESTERDAY has value 7 = globalMax; TODAY has value 3
    const { container } = render(<Heatmap snapshot={BASE_SNAPSHOT} onSelectDistrict={jest.fn()} />);
    const yesterdayFormatted = formatTooltipDate(YESTERDAY);
    const maxCell = container.querySelector(
      `[aria-label="apps/alpha: 7 changed files on ${yesterdayFormatted}"] div`,
    );
    expect(maxCell).toBeInTheDocument();
    expect(maxCell!.className).toMatch(/bg-primary(?!\/)/);
  });

  it('date header shows weekday initial and day-of-month', () => {
    const { container } = render(<Heatmap snapshot={BASE_SNAPSHOT} onSelectDistrict={jest.fn()} />);
    const [, firstDateTh] = container.querySelectorAll('thead th');
    expect(firstDateTh.textContent).toBeTruthy();
    // weekday initial is a single letter (M T W T F S S)
    const weekdayDiv = firstDateTh.querySelector('div:first-child')!;
    expect(weekdayDiv.textContent!.trim()).toMatch(/^[MTWFSU]$/);
  });

  it('renders the correct district names in rows', () => {
    render(<Heatmap snapshot={BASE_SNAPSHOT} onSelectDistrict={jest.fn()} />);
    expect(screen.getByTitle('apps/alpha')).toBeInTheDocument();
    expect(screen.getByTitle('apps/beta')).toBeInTheDocument();
  });

  it('dates are in author-local format (YYYY-MM-DD parsed locally, not UTC)', () => {
    // Verify dates match the 14-day window anchored at today
    const { container } = render(<Heatmap snapshot={BASE_SNAPSHOT} onSelectDistrict={jest.fn()} />);
    const dateThs = Array.from(container.querySelectorAll('thead th[data-date]'));
    expect(dateThs).toHaveLength(14);
    expect(dateThs[13].getAttribute('data-date')).toBe(TODAY);
    expect(dateThs[0].getAttribute('data-date')).toBe(OLDEST);
  });

  // -----------------------------------------------------------------------
  // Roving tabindex grid
  // -----------------------------------------------------------------------

  describe('roving tabindex', () => {
    function makeFiveRowSnapshot() {
      const signals = Array.from({ length: 5 }, (_, i) =>
        makeSignal(`d${i}`, `district-${i}`, 10 - i),
      );
      const activity = signals.map((s) =>
        makeActivity(s.districtId, Object.fromEntries(TEST_DATES.map((d) => [d, 1]))),
      );
      return makeSnapshot(signals, activity);
    }

    function getCell(container: HTMLElement, row: number, col: number): HTMLElement | null {
      const td = container.querySelector(`[data-row="${row}"][data-col="${col}"]`);
      return td?.querySelector('[tabindex]') as HTMLElement | null;
    }

    function getAllTabbableCells(container: HTMLElement): HTMLElement[] {
      return Array.from(container.querySelectorAll('[data-row] [tabindex="0"]'));
    }

    it('only ONE cell has tabIndex=0; all others have -1', () => {
      const { container } = render(
        <Heatmap snapshot={makeFiveRowSnapshot()} onSelectDistrict={jest.fn()} />,
      );
      const tabbable = getAllTabbableCells(container);
      expect(tabbable).toHaveLength(1);
      expect(getCell(container, 0, 0)?.getAttribute('tabindex')).toBe('0');
      expect(getCell(container, 0, 1)?.getAttribute('tabindex')).toBe('-1');
      expect(getCell(container, 1, 0)?.getAttribute('tabindex')).toBe('-1');
    });

    it('ArrowRight moves focus across columns', () => {
      const { container } = render(
        <Heatmap snapshot={makeFiveRowSnapshot()} onSelectDistrict={jest.fn()} />,
      );
      const cell00 = getCell(container, 0, 0)!;
      cell00.focus();
      fireEvent.keyDown(container.querySelector('[data-testid="heatmap"]')!, { key: 'ArrowRight' });
      fireEvent.keyDown(container.querySelector('[data-testid="heatmap"]')!, { key: 'ArrowRight' });
      fireEvent.keyDown(container.querySelector('[data-testid="heatmap"]')!, { key: 'ArrowRight' });

      expect(getCell(container, 0, 3)?.getAttribute('tabindex')).toBe('0');
      expect(getCell(container, 0, 0)?.getAttribute('tabindex')).toBe('-1');
    });

    it('ArrowLeft from (0,0) stays at (0,0)', () => {
      const { container } = render(
        <Heatmap snapshot={makeFiveRowSnapshot()} onSelectDistrict={jest.fn()} />,
      );
      fireEvent.keyDown(container.querySelector('[data-testid="heatmap"]')!, { key: 'ArrowLeft' });
      expect(getCell(container, 0, 0)?.getAttribute('tabindex')).toBe('0');
    });

    it('ArrowDown moves to next row', () => {
      const { container } = render(
        <Heatmap snapshot={makeFiveRowSnapshot()} onSelectDistrict={jest.fn()} />,
      );
      fireEvent.keyDown(container.querySelector('[data-testid="heatmap"]')!, { key: 'ArrowDown' });
      expect(getCell(container, 1, 0)?.getAttribute('tabindex')).toBe('0');
      expect(getCell(container, 0, 0)?.getAttribute('tabindex')).toBe('-1');
    });

    it('ArrowUp from (0,0) stays at (0,0)', () => {
      const { container } = render(
        <Heatmap snapshot={makeFiveRowSnapshot()} onSelectDistrict={jest.fn()} />,
      );
      fireEvent.keyDown(container.querySelector('[data-testid="heatmap"]')!, { key: 'ArrowUp' });
      expect(getCell(container, 0, 0)?.getAttribute('tabindex')).toBe('0');
    });

    it('End jumps to last column in row', () => {
      const { container } = render(
        <Heatmap snapshot={makeFiveRowSnapshot()} onSelectDistrict={jest.fn()} />,
      );
      fireEvent.keyDown(container.querySelector('[data-testid="heatmap"]')!, { key: 'End' });
      expect(getCell(container, 0, 13)?.getAttribute('tabindex')).toBe('0');
    });

    it('Home jumps to first column in row', () => {
      const { container } = render(
        <Heatmap snapshot={makeFiveRowSnapshot()} onSelectDistrict={jest.fn()} />,
      );
      // First move to end
      fireEvent.keyDown(container.querySelector('[data-testid="heatmap"]')!, { key: 'End' });
      fireEvent.keyDown(container.querySelector('[data-testid="heatmap"]')!, { key: 'Home' });
      expect(getCell(container, 0, 0)?.getAttribute('tabindex')).toBe('0');
    });

    it('PageDown jumps to bottom-right', () => {
      const { container } = render(
        <Heatmap snapshot={makeFiveRowSnapshot()} onSelectDistrict={jest.fn()} />,
      );
      fireEvent.keyDown(container.querySelector('[data-testid="heatmap"]')!, { key: 'PageDown' });
      expect(getCell(container, 4, 13)?.getAttribute('tabindex')).toBe('0');
    });

    it('PageUp jumps to top-left', () => {
      const { container } = render(
        <Heatmap snapshot={makeFiveRowSnapshot()} onSelectDistrict={jest.fn()} />,
      );
      // Move to bottom-right first
      fireEvent.keyDown(container.querySelector('[data-testid="heatmap"]')!, { key: 'PageDown' });
      fireEvent.keyDown(container.querySelector('[data-testid="heatmap"]')!, { key: 'PageUp' });
      expect(getCell(container, 0, 0)?.getAttribute('tabindex')).toBe('0');
    });

    it('click cell updates focused coord', () => {
      const { container } = render(
        <Heatmap snapshot={makeFiveRowSnapshot()} onSelectDistrict={jest.fn()} />,
      );
      const td = container.querySelector('[data-row="2"][data-col="5"]')!;
      fireEvent.click(td);
      expect(getCell(container, 2, 5)?.getAttribute('tabindex')).toBe('0');
      expect(getCell(container, 0, 0)?.getAttribute('tabindex')).toBe('-1');
    });

    it('click cell then ArrowRight continues from that position', () => {
      const { container } = render(
        <Heatmap snapshot={makeFiveRowSnapshot()} onSelectDistrict={jest.fn()} />,
      );
      const td = container.querySelector('[data-row="2"][data-col="5"]')!;
      fireEvent.click(td);
      fireEvent.keyDown(container.querySelector('[data-testid="heatmap"]')!, { key: 'ArrowRight' });
      expect(getCell(container, 2, 6)?.getAttribute('tabindex')).toBe('0');
    });

    it('snapshot refresh reducing rows clamps focus', () => {
      const fiveRowSnap = makeFiveRowSnapshot();
      const { container, rerender } = render(
        <Heatmap snapshot={fiveRowSnap} onSelectDistrict={jest.fn()} />,
      );

      // Move to row 4, col 7
      fireEvent.keyDown(container.querySelector('[data-testid="heatmap"]')!, { key: 'PageDown' });
      // Now at (4, 13) — let's move to col 7
      fireEvent.keyDown(container.querySelector('[data-testid="heatmap"]')!, { key: 'Home' });
      for (let i = 0; i < 7; i++) {
        fireEvent.keyDown(container.querySelector('[data-testid="heatmap"]')!, {
          key: 'ArrowRight',
        });
      }
      expect(getCell(container, 4, 7)?.getAttribute('tabindex')).toBe('0');

      // Rerender with only 3 rows
      const threeRowSnap = makeSnapshot(
        Array.from({ length: 3 }, (_, i) => makeSignal(`d${i}`, `district-${i}`, 10 - i)),
        Array.from({ length: 3 }, (_, i) =>
          makeActivity(`d${i}`, Object.fromEntries(TEST_DATES.map((d) => [d, 1]))),
        ),
      );
      rerender(<Heatmap snapshot={threeRowSnap} onSelectDistrict={jest.fn()} />);

      // Focus should clamp to (2, 7)
      expect(getCell(container, 2, 7)?.getAttribute('tabindex')).toBe('0');
    });

    it('row label buttons remain independently focusable', () => {
      render(<Heatmap snapshot={makeFiveRowSnapshot()} onSelectDistrict={jest.fn()} />);
      const rowButtons = screen.getAllByTitle(/district-/);
      rowButtons.forEach((btn) => {
        expect(btn.tagName).toBe('BUTTON');
      });
    });

    it('cell [0,0] has 40×40 focusable wrapper (min-h-10 min-w-10)', () => {
      const { container } = render(
        <Heatmap snapshot={makeFiveRowSnapshot()} onSelectDistrict={jest.fn()} />,
      );
      const cell = container.querySelector(
        '[data-row="0"][data-col="0"] [tabindex]',
      ) as HTMLElement;
      expect(cell).not.toBeNull();
      expect(cell).toHaveClass('min-h-10');
      expect(cell).toHaveClass('min-w-10');
    });

    it('non-focused cells have tabindex=-1', () => {
      const { container } = render(
        <Heatmap snapshot={makeFiveRowSnapshot()} onSelectDistrict={jest.fn()} />,
      );
      const cell11 = container.querySelector(
        '[data-row="1"][data-col="1"] [tabindex]',
      ) as HTMLElement;
      expect(cell11?.getAttribute('tabindex')).toBe('-1');
    });
  });
});
