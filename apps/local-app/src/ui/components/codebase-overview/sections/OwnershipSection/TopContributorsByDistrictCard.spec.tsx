import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CodebaseOverviewSnapshot } from '@devchain/codebase-overview';
import { TopContributorsByDistrictCard } from './TopContributorsByDistrictCard';

const onSelectDistrict = jest.fn();

function makeSnapshot(overrides: Partial<CodebaseOverviewSnapshot> = {}): CodebaseOverviewSnapshot {
  return {
    snapshotId: 'snap-1',
    projectKey: 'proj-1',
    name: 'Test Project',
    regions: [],
    districts: [
      {
        id: 'dist-1',
        regionId: 'r1',
        path: 'src/alpha',
        name: 'alpha',
        totalFiles: 10,
        totalLOC: 500,
        churn7d: 2,
        churn30d: 5,
        inboundWeight: 3,
        outboundWeight: 2,
        couplingScore: 1,
        testFileCount: 2,
        testFileRatio: 0.2,
        role: 'service',
        complexityAvg: 10,
        ownershipConcentration: 0.8,
        testCoverageRate: 0.5,
        blastRadius: 1,
        primaryAuthorName: 'Alice',
        primaryAuthorShare: 0.8,
        primaryAuthorRecentlyActive: true,
      },
      {
        id: 'dist-2',
        regionId: 'r1',
        path: 'src/bravo',
        name: 'bravo',
        totalFiles: 8,
        totalLOC: 300,
        churn7d: 1,
        churn30d: 3,
        inboundWeight: 1,
        outboundWeight: 1,
        couplingScore: 0,
        testFileCount: 1,
        testFileRatio: 0.1,
        role: 'utility',
        complexityAvg: 5,
        ownershipConcentration: 0.6,
        testCoverageRate: 0.3,
        blastRadius: 0,
        primaryAuthorName: 'Bob',
        primaryAuthorShare: 0.6,
        primaryAuthorRecentlyActive: true,
      },
    ],
    dependencies: [],
    hotspots: [],
    activity: [
      {
        targetId: 'dist-1',
        targetKind: 'district',
        modifiedCount1d: 1,
        modifiedCount7d: 3,
        buildFailures7d: null,
        testFailures7d: null,
        latestTimestamp: null,
        recentContributors7d: [],
        recentContributors30d: [
          { authorName: 'Alice', commitCount: 15 },
          { authorName: 'Bob', commitCount: 5 },
        ],
      },
      {
        targetId: 'dist-2',
        targetKind: 'district',
        modifiedCount1d: 0,
        modifiedCount7d: 1,
        buildFailures7d: null,
        testFailures7d: null,
        latestTimestamp: null,
        recentContributors7d: [],
        recentContributors30d: [
          { authorName: 'Bob', commitCount: 8 },
          { authorName: 'Alice', commitCount: 3 },
        ],
      },
    ],
    metrics: {
      totalRegions: 1,
      totalDistricts: 2,
      totalFiles: 18,
      gitHistoryDaysAvailable: 90,
      shallowHistoryDetected: false,
      dependencyCoverage: 1,
      warnings: [],
      excludedAuthorCount: 0,
      scopeConfigHash: 'test',
    },
    signals: [],
    globalContributors: [
      { authorName: 'Alice', commitCount7d: 5, commitCount30d: 18 },
      { authorName: 'Bob', commitCount7d: 3, commitCount30d: 13 },
    ],
    ...overrides,
  };
}

describe('TopContributorsByDistrictCard', () => {
  beforeEach(() => {
    onSelectDistrict.mockClear();
  });

  it('renders top authors from globalContributors sorted by 30d count', () => {
    const snapshot = makeSnapshot();
    render(
      <TopContributorsByDistrictCard snapshot={snapshot} onSelectDistrict={onSelectDistrict} />,
    );

    expect(screen.getByText('Top Contributors')).toBeInTheDocument();
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();

    const buttons = screen
      .getAllByRole('button')
      .filter((b) => b.textContent?.includes('commits in 30d'));
    expect(buttons[0]!.textContent).toContain('Alice');
    expect(buttons[0]!.textContent).toContain('18 commits in 30d');
  });

  it('hides when globalContributors is empty', () => {
    const snapshot = makeSnapshot({ globalContributors: [] });
    const { container } = render(
      <TopContributorsByDistrictCard snapshot={snapshot} onSelectDistrict={onSelectDistrict} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('expanding an author shows district list', async () => {
    const user = userEvent.setup();
    const snapshot = makeSnapshot();
    render(
      <TopContributorsByDistrictCard snapshot={snapshot} onSelectDistrict={onSelectDistrict} />,
    );

    const aliceTrigger = screen.getByText('Alice').closest('button')!;
    await user.click(aliceTrigger);

    expect(screen.getByText('alpha')).toBeInTheDocument();
    expect(screen.getByText('bravo')).toBeInTheDocument();
  });

  it('district list sorted by per-district count desc', async () => {
    const user = userEvent.setup();
    const snapshot = makeSnapshot();
    render(
      <TopContributorsByDistrictCard snapshot={snapshot} onSelectDistrict={onSelectDistrict} />,
    );

    const aliceTrigger = screen.getByText('Alice').closest('button')!;
    await user.click(aliceTrigger);

    const districtButtons = screen
      .getAllByRole('button')
      .filter((b) => b.textContent?.includes(' commits') && !b.textContent?.includes('30d'));
    const aliceDistricts = districtButtons.filter(
      (b) => b.textContent?.includes('alpha') || b.textContent?.includes('bravo'),
    );
    expect(aliceDistricts[0]!.textContent).toContain('alpha');
    expect(aliceDistricts[0]!.textContent).toContain('15 commits');
  });

  it('click district name calls onSelectDistrict', async () => {
    const user = userEvent.setup();
    const snapshot = makeSnapshot();
    render(
      <TopContributorsByDistrictCard snapshot={snapshot} onSelectDistrict={onSelectDistrict} />,
    );

    const aliceTrigger = screen.getByText('Alice').closest('button')!;
    await user.click(aliceTrigger);

    const alphaBtn = screen.getByText('alpha').closest('button')!;
    await user.click(alphaBtn);
    expect(onSelectDistrict).toHaveBeenCalledWith('dist-1');
  });

  it('caps at 10 authors', () => {
    const snapshot = makeSnapshot({
      globalContributors: Array.from({ length: 15 }, (_, i) => ({
        authorName: `Author-${i}`,
        commitCount7d: 15 - i,
        commitCount30d: 30 - i,
      })),
    });
    render(
      <TopContributorsByDistrictCard snapshot={snapshot} onSelectDistrict={onSelectDistrict} />,
    );

    const triggers = screen
      .getAllByRole('button')
      .filter((b) => b.textContent?.includes('commits in 30d'));
    expect(triggers.length).toBe(10);
  });

  it('keyboard: Enter/Space toggles author expansion', async () => {
    const user = userEvent.setup();
    const snapshot = makeSnapshot();
    render(
      <TopContributorsByDistrictCard snapshot={snapshot} onSelectDistrict={onSelectDistrict} />,
    );

    const aliceTrigger = screen.getByText('Alice').closest('button')!;
    aliceTrigger.focus();
    await user.keyboard('{Enter}');

    expect(screen.getByText('alpha')).toBeInTheDocument();

    await user.keyboard('{Enter}');
    expect(screen.queryByText('15 commits')).not.toBeInTheDocument();
  });

  it('collapsible trigger has min-h-10 touch target', () => {
    const snapshot = makeSnapshot();
    render(
      <TopContributorsByDistrictCard snapshot={snapshot} onSelectDistrict={onSelectDistrict} />,
    );
    const trigger = screen.getByText('Alice').closest('button')!;
    expect(trigger).toHaveClass('min-h-10');
  });

  it('nested district button has min-h-10 touch target after expansion', async () => {
    const user = userEvent.setup();
    const snapshot = makeSnapshot();
    render(
      <TopContributorsByDistrictCard snapshot={snapshot} onSelectDistrict={onSelectDistrict} />,
    );
    await user.click(screen.getByText('Alice').closest('button')!);
    const districtBtn = screen.getByText('alpha').closest('button')!;
    expect(districtBtn).toHaveClass('min-h-10');
  });

  it('help icon button has h-10 w-10 touch target', () => {
    const snapshot = makeSnapshot();
    render(
      <TopContributorsByDistrictCard snapshot={snapshot} onSelectDistrict={onSelectDistrict} />,
    );
    const helpBtn = screen.getByRole('button', { name: /about top contributors/i });
    expect(helpBtn).toHaveClass('h-10');
    expect(helpBtn).toHaveClass('w-10');
  });
});
