import React from 'react';
import { render, screen } from '@testing-library/react';
import type { CodebaseOverviewSnapshot } from '@devchain/codebase-overview';
import { DependencyMatrix } from './DependencyMatrix';

function makeSnapshot(overrides: Partial<CodebaseOverviewSnapshot> = {}): CodebaseOverviewSnapshot {
  return {
    snapshotId: 'snap-1',
    projectKey: 'proj-1',
    name: 'Test',
    regions: [{ id: 'r1', path: 'src', name: 'src', totalFiles: 5, totalLOC: 500 }],
    districts: [
      {
        id: 'd1',
        regionId: 'r1',
        path: 'src/alpha',
        name: 'alpha',
        totalFiles: 3,
        totalLOC: 300,
        churn7d: 1,
        churn30d: 5,
        inboundWeight: 2,
        outboundWeight: 3,
        couplingScore: 4,
        testFileCount: 1,
        testFileRatio: 0.33,
        role: 'service',
        complexityAvg: null,
        ownershipConcentration: null,
        testCoverageRate: null,
        blastRadius: 2,
        primaryAuthorName: null,
        primaryAuthorShare: null,
        primaryAuthorRecentlyActive: false,
      },
      {
        id: 'd2',
        regionId: 'r1',
        path: 'src/bravo',
        name: 'bravo',
        totalFiles: 2,
        totalLOC: 200,
        churn7d: 0,
        churn30d: 2,
        inboundWeight: 3,
        outboundWeight: 0,
        couplingScore: 2,
        testFileCount: 0,
        testFileRatio: null,
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
    dependencies: [{ fromDistrictId: 'd1', toDistrictId: 'd2', weight: 5, isCyclic: false }],
    hotspots: [],
    activity: [],
    metrics: {
      totalRegions: 1,
      totalDistricts: 2,
      totalFiles: 5,
      gitHistoryDaysAvailable: 90,
      shallowHistoryDetected: false,
      dependencyCoverage: 1,
      warnings: [],
      excludedAuthorCount: 0,
      scopeConfigHash: 'test',
    },
    signals: [],
    globalContributors: [],
    ...overrides,
  };
}

const onSelectTarget = jest.fn();
const onSelectPair = jest.fn();
const onModeChange = jest.fn();

function renderMatrix(snapshot = makeSnapshot(), selectedTargetId: string | null = null) {
  return render(
    <DependencyMatrix
      snapshot={snapshot}
      selectedTargetId={selectedTargetId}
      onSelectTarget={onSelectTarget}
      onSelectPair={onSelectPair}
      modeOverride={null}
      onModeChange={onModeChange}
    />,
  );
}

describe('DependencyMatrix accessibility', () => {
  beforeEach(() => {
    onSelectTarget.mockClear();
    onSelectPair.mockClear();
    onModeChange.mockClear();
  });

  it('mode buttons have h-10 (≥40px) — no h-7 regression', () => {
    renderMatrix();
    const modeBtns = ['Full', 'Regions', 'Focused'].map((label) =>
      screen.getByRole('button', { name: label }),
    );
    for (const btn of modeBtns) {
      expect(btn.className).toContain('h-10');
      expect(btn.className).not.toContain('h-7');
    }
  });

  it('column header buttons have focus-visible ring', () => {
    const { container } = renderMatrix();
    const colHeaderBtns = container.querySelectorAll('thead button');
    expect(colHeaderBtns.length).toBeGreaterThan(0);
    for (const btn of colHeaderBtns) {
      expect(btn.className).toContain('focus-visible:ring-2');
    }
  });

  it('row header buttons have focus-visible ring', () => {
    const { container } = renderMatrix();
    const rowHeaderBtns = container.querySelectorAll('tbody th button');
    expect(rowHeaderBtns.length).toBeGreaterThan(0);
    for (const btn of rowHeaderBtns) {
      expect(btn.className).toContain('focus-visible:ring-2');
    }
  });

  it('clickable matrix cell has w-10 h-10 and focus-visible ring', () => {
    const { container } = renderMatrix();
    const cell = container.querySelector('[role="button"][tabindex="0"]') as HTMLElement;
    expect(cell).not.toBeNull();
    expect(cell.className).toContain('w-10');
    expect(cell.className).toContain('h-10');
    expect(cell.className).toContain('focus-visible:ring-2');
  });

  it('cyclic cell retains ring-destructive and hover-ring alongside focus-visible ring', () => {
    const snapshot = makeSnapshot({
      dependencies: [{ fromDistrictId: 'd1', toDistrictId: 'd2', weight: 5, isCyclic: true }],
    });
    const { container } = renderMatrix(snapshot);
    const cell = container.querySelector('[role="button"][tabindex="0"]') as HTMLElement;
    expect(cell.className).toContain('ring-destructive');
    expect(cell.className).toContain('hover:ring-primary');
    expect(cell.className).toContain('focus-visible:ring-2');
  });

  it('non-interactive (zero-weight) cells have no role=button and no tabIndex', () => {
    const snapshot = makeSnapshot({
      dependencies: [{ fromDistrictId: 'd1', toDistrictId: 'd2', weight: 5, isCyclic: false }],
    });
    const { container } = renderMatrix(snapshot);
    const allCells = container.querySelectorAll('tbody td');
    const interactive = Array.from(allCells).filter((td) => td.getAttribute('role') === 'button');
    const nonInteractive = Array.from(allCells).filter(
      (td) => td.getAttribute('role') !== 'button',
    );
    expect(interactive.length).toBeGreaterThan(0);
    for (const td of nonInteractive) {
      expect(td.getAttribute('tabindex')).toBeNull();
    }
  });
});
