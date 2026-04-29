import { render, screen } from '@testing-library/react';
import type { CodebaseOverviewSnapshot } from '@devchain/codebase-overview';
import { TopContributorsCard } from './TopContributorsCard';

function makeSnapshot(
  globalContributors: CodebaseOverviewSnapshot['globalContributors'],
): CodebaseOverviewSnapshot {
  return {
    snapshotId: 'snap-1',
    projectKey: 'proj-1',
    name: 'Test',
    regions: [],
    districts: [],
    dependencies: [],
    hotspots: [],
    activity: [],
    metrics: {
      totalRegions: 0,
      totalDistricts: 0,
      totalFiles: 0,
      gitHistoryDaysAvailable: 90,
      shallowHistoryDetected: false,
      dependencyCoverage: 1,
      warnings: [],
      excludedAuthorCount: 0,
      scopeConfigHash: 'test',
    },
    signals: [],
    globalContributors,
  };
}

describe('TopContributorsCard', () => {
  it('renders top contributors', () => {
    const snapshot = makeSnapshot([
      { authorName: 'Alice', commitCount7d: 5, commitCount30d: 20 },
      { authorName: 'Bob', commitCount7d: 3, commitCount30d: 12 },
    ]);
    render(<TopContributorsCard snapshot={snapshot} />);
    expect(screen.getByText('Top Contributors')).toBeInTheDocument();
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();
  });

  it('returns null when globalContributors is empty', () => {
    const snapshot = makeSnapshot([]);
    const { container } = render(<TopContributorsCard snapshot={snapshot} />);
    expect(container.firstChild).toBeNull();
  });

  it('sorts by commitCount30d descending', () => {
    const snapshot = makeSnapshot([
      { authorName: 'Low', commitCount7d: 1, commitCount30d: 5 },
      { authorName: 'High', commitCount7d: 2, commitCount30d: 30 },
      { authorName: 'Mid', commitCount7d: 1, commitCount30d: 15 },
    ]);
    render(<TopContributorsCard snapshot={snapshot} />);
    const rows = screen.getAllByText(/High|Mid|Low/);
    const names = rows.map((el) => el.textContent);
    expect(names.indexOf('High')).toBeLessThan(names.indexOf('Mid'));
    expect(names.indexOf('Mid')).toBeLessThan(names.indexOf('Low'));
  });

  it('tie-break by commitCount7d descending', () => {
    const snapshot = makeSnapshot([
      { authorName: 'A', commitCount7d: 1, commitCount30d: 10 },
      { authorName: 'B', commitCount7d: 5, commitCount30d: 10 },
    ]);
    render(<TopContributorsCard snapshot={snapshot} />);
    const rows = screen.getAllByText(/^A$|^B$/);
    expect(rows[0]!.textContent).toBe('B');
  });

  it('secondary tie-break by authorName ascending', () => {
    const snapshot = makeSnapshot([
      { authorName: 'Zara', commitCount7d: 2, commitCount30d: 10 },
      { authorName: 'Adam', commitCount7d: 2, commitCount30d: 10 },
    ]);
    render(<TopContributorsCard snapshot={snapshot} />);
    const rows = screen.getAllByText(/^Zara$|^Adam$/);
    expect(rows[0]!.textContent).toBe('Adam');
  });

  it('caps at 10 contributors', () => {
    const contributors = Array.from({ length: 15 }, (_, i) => ({
      authorName: `Author-${i}`,
      commitCount7d: 15 - i,
      commitCount30d: 30 - i,
    }));
    const snapshot = makeSnapshot(contributors);
    render(<TopContributorsCard snapshot={snapshot} />);
    const nameEls = screen.getAllByText(/^Author-/);
    expect(nameEls.length).toBe(10);
  });

  it('shows 7d count for each contributor', () => {
    const snapshot = makeSnapshot([{ authorName: 'Alice', commitCount7d: 7, commitCount30d: 20 }]);
    render(<TopContributorsCard snapshot={snapshot} />);
    // 7d column value
    expect(screen.getByText('7')).toBeInTheDocument();
  });

  it('shows 30d count for each contributor', () => {
    const snapshot = makeSnapshot([{ authorName: 'Alice', commitCount7d: 5, commitCount30d: 42 }]);
    render(<TopContributorsCard snapshot={snapshot} />);
    expect(screen.getByText('42')).toBeInTheDocument();
  });

  it('renders column headers', () => {
    const snapshot = makeSnapshot([{ authorName: 'Alice', commitCount7d: 5, commitCount30d: 10 }]);
    render(<TopContributorsCard snapshot={snapshot} />);
    expect(screen.getByText('7d')).toBeInTheDocument();
    expect(screen.getByText('30d')).toBeInTheDocument();
    expect(screen.getByText('Author')).toBeInTheDocument();
  });
});
