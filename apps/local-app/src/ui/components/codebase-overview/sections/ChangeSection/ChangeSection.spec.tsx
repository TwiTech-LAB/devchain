import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CodebaseOverviewSnapshot, DistrictSignals } from '@devchain/codebase-overview';
import { ChangeSection } from './ChangeSection';

const onSelectDistrict = jest.fn();

function makeSignal(districtId: string, churn7d: number, churn30d: number): DistrictSignals {
  return { districtId, name: districtId, loc: 100, churn7d, churn30d, ownerQuiet: false };
}

function makeSnapshot(overrides: Partial<CodebaseOverviewSnapshot> = {}): CodebaseOverviewSnapshot {
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
    globalContributors: [],
    ...overrides,
  };
}

describe('ChangeSection', () => {
  beforeEach(() => {
    onSelectDistrict.mockClear();
  });

  it('always renders section header', () => {
    const snapshot = makeSnapshot();
    render(<ChangeSection snapshot={snapshot} onSelectDistrict={onSelectDistrict} />);
    expect(screen.getByText('Change')).toBeInTheDocument();
    expect(screen.getByText("What's happening this week?")).toBeInTheDocument();
  });

  it('shows EmptyState when all data unavailable', () => {
    const snapshot = makeSnapshot({
      metrics: {
        totalRegions: 0,
        totalDistricts: 0,
        totalFiles: 0,
        gitHistoryDaysAvailable: 90,
        shallowHistoryDetected: false,
        dependencyCoverage: 1,
        warnings: [{ code: 'daily_churn_unavailable', message: 'no data' }],
      },
      signals: [],
      globalContributors: [],
    });
    render(<ChangeSection snapshot={snapshot} onSelectDistrict={onSelectDistrict} />);
    expect(screen.getByText('No change data available')).toBeInTheDocument();
  });

  it('shows content when accelerating districts exist (even with warning)', () => {
    const snapshot = makeSnapshot({
      metrics: {
        totalRegions: 0,
        totalDistricts: 1,
        totalFiles: 0,
        gitHistoryDaysAvailable: 90,
        shallowHistoryDetected: false,
        dependencyCoverage: 1,
        warnings: [{ code: 'daily_churn_unavailable', message: 'no data' }],
      },
      signals: [makeSignal('alpha', 5, 10)],
    });
    render(<ChangeSection snapshot={snapshot} onSelectDistrict={onSelectDistrict} />);
    expect(screen.getByText('Accelerating')).toBeInTheDocument();
    expect(screen.queryByText('No change data available')).not.toBeInTheDocument();
  });

  it('shows content when gone-quiet districts exist', () => {
    const snapshot = makeSnapshot({
      metrics: {
        totalRegions: 0,
        totalDistricts: 1,
        totalFiles: 0,
        gitHistoryDaysAvailable: 90,
        shallowHistoryDetected: false,
        dependencyCoverage: 1,
        warnings: [{ code: 'daily_churn_unavailable', message: 'no data' }],
      },
      signals: [makeSignal('quiet', 0, 10)],
    });
    render(<ChangeSection snapshot={snapshot} onSelectDistrict={onSelectDistrict} />);
    expect(screen.getByText('Gone Quiet')).toBeInTheDocument();
  });

  it('shows content when globalContributors exist', () => {
    const snapshot = makeSnapshot({
      metrics: {
        totalRegions: 0,
        totalDistricts: 0,
        totalFiles: 0,
        gitHistoryDaysAvailable: 90,
        shallowHistoryDetected: false,
        dependencyCoverage: 1,
        warnings: [{ code: 'daily_churn_unavailable', message: 'no data' }],
      },
      globalContributors: [{ authorName: 'Alice', commitCount7d: 3, commitCount30d: 10 }],
    });
    render(<ChangeSection snapshot={snapshot} onSelectDistrict={onSelectDistrict} />);
    expect(screen.getByText('Top Contributors')).toBeInTheDocument();
  });

  it('renders all children when data available', () => {
    const snapshot = makeSnapshot({
      signals: [makeSignal('active', 5, 10), makeSignal('quiet', 0, 10)],
      globalContributors: [{ authorName: 'Alice', commitCount7d: 3, commitCount30d: 10 }],
    });
    render(<ChangeSection snapshot={snapshot} onSelectDistrict={onSelectDistrict} />);
    expect(screen.getByText('Accelerating')).toBeInTheDocument();
    expect(screen.getByText('Gone Quiet')).toBeInTheDocument();
    expect(screen.getByText('Top Contributors')).toBeInTheDocument();
  });

  it('propagates onSelectDistrict from AcceleratingCallout row click', async () => {
    const user = userEvent.setup();
    const snapshot = makeSnapshot({ signals: [makeSignal('dist-accel', 8, 10)] });
    render(<ChangeSection snapshot={snapshot} onSelectDistrict={onSelectDistrict} />);
    const btn = screen.getByText('dist-accel').closest('button')!;
    await user.click(btn);
    expect(onSelectDistrict).toHaveBeenCalledWith('dist-accel');
  });

  it('propagates onSelectDistrict from GoneQuietCallout row click', async () => {
    const user = userEvent.setup();
    const snapshot = makeSnapshot({ signals: [makeSignal('dist-quiet', 0, 10)] });
    render(<ChangeSection snapshot={snapshot} onSelectDistrict={onSelectDistrict} />);
    const btn = screen.getByText('dist-quiet').closest('button')!;
    await user.click(btn);
    expect(onSelectDistrict).toHaveBeenCalledWith('dist-quiet');
  });
});
