import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RegionNode, DistrictSignals } from '@devchain/codebase-overview';
import { RegionTreeNode } from './RegionTreeNode';

function makeRegion(overrides: Partial<RegionNode> = {}): RegionNode {
  return { id: 'r1', path: 'src', name: 'src', totalFiles: 100, totalLOC: 5000, ...overrides };
}

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

const onSelectDistrict = jest.fn();

describe('RegionTreeNode', () => {
  beforeEach(() => {
    onSelectDistrict.mockClear();
    localStorage.clear();
  });

  it('renders region header with summary', () => {
    const districts = [makeSignal({ districtId: 'd1' }), makeSignal({ districtId: 'd2' })];
    render(
      <RegionTreeNode
        region={makeRegion()}
        districts={districts}
        defaultExpanded
        onSelectDistrict={onSelectDistrict}
      />,
    );

    expect(screen.getByText('src')).toBeInTheDocument();
    expect(screen.getByText('2 districts · 100 files')).toBeInTheDocument();
  });

  it('shows districts when expanded', () => {
    const districts = [makeSignal({ districtId: 'alpha', name: 'alpha' })];
    render(
      <RegionTreeNode
        region={makeRegion()}
        districts={districts}
        defaultExpanded
        onSelectDistrict={onSelectDistrict}
      />,
    );

    expect(screen.getByText('alpha')).toBeInTheDocument();
  });

  it('hides districts when collapsed', () => {
    const districts = [makeSignal({ districtId: 'alpha', name: 'alpha' })];
    render(
      <RegionTreeNode
        region={makeRegion()}
        districts={districts}
        defaultExpanded={false}
        onSelectDistrict={onSelectDistrict}
      />,
    );

    expect(screen.queryByText('alpha')).not.toBeInTheDocument();
  });

  it('toggle expand/collapse persists to localStorage', async () => {
    const user = userEvent.setup();
    const districts = [makeSignal({ districtId: 'alpha', name: 'alpha' })];
    render(
      <RegionTreeNode
        region={makeRegion()}
        districts={districts}
        defaultExpanded
        onSelectDistrict={onSelectDistrict}
      />,
    );

    const trigger = screen.getByText('src').closest('button')!;
    await user.click(trigger);

    expect(localStorage.getItem('overview.structure.expanded.r1')).toBe('false');
  });

  it('reads persisted state from localStorage on mount', () => {
    localStorage.setItem('overview.structure.expanded.r1', 'true');
    const districts = [makeSignal({ districtId: 'alpha', name: 'alpha' })];
    render(
      <RegionTreeNode
        region={makeRegion()}
        districts={districts}
        defaultExpanded={false}
        onSelectDistrict={onSelectDistrict}
      />,
    );

    expect(screen.getByText('alpha')).toBeInTheDocument();
  });

  it('sorts districts by name ascending', () => {
    const districts = [
      makeSignal({ districtId: 'charlie', name: 'charlie' }),
      makeSignal({ districtId: 'alpha', name: 'alpha' }),
      makeSignal({ districtId: 'bravo', name: 'bravo' }),
    ];
    render(
      <RegionTreeNode
        region={makeRegion()}
        districts={districts}
        defaultExpanded
        onSelectDistrict={onSelectDistrict}
      />,
    );

    const buttons = screen
      .getAllByRole('button')
      .filter((b) => b !== screen.getByText('src').closest('button'));
    expect(buttons[0]!.textContent).toContain('alpha');
    expect(buttons[1]!.textContent).toContain('bravo');
    expect(buttons[2]!.textContent).toContain('charlie');
  });

  it('keyboard: Enter toggles expand/collapse', async () => {
    const user = userEvent.setup();
    const districts = [makeSignal({ districtId: 'alpha', name: 'alpha' })];
    render(
      <RegionTreeNode
        region={makeRegion()}
        districts={districts}
        defaultExpanded
        onSelectDistrict={onSelectDistrict}
      />,
    );

    const trigger = screen.getByText('src').closest('button')!;
    trigger.focus();
    await user.keyboard('{Enter}');

    expect(screen.queryByText('alpha')).not.toBeInTheDocument();
  });
});
