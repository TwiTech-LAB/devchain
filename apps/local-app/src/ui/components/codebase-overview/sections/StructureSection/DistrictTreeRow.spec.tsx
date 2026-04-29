import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DistrictSignals } from '@devchain/codebase-overview';
import { DistrictTreeRow } from './DistrictTreeRow';

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
    fileTypeBreakdown: { kind: 'extension', counts: { '.ts': 50, '.tsx': 30, '.json': 5 } },
    ...overrides,
  };
}

const onSelectDistrict = jest.fn();

describe('DistrictTreeRow', () => {
  beforeEach(() => onSelectDistrict.mockClear());

  it('renders name, file count, LOC, and top 3 extensions', () => {
    const signal = makeSignal({ districtId: 'alpha', name: 'src/alpha', files: 85, loc: 1234 });
    render(<DistrictTreeRow signal={signal} onSelectDistrict={onSelectDistrict} />);

    expect(screen.getByText('src/alpha')).toBeInTheDocument();
    expect(screen.getByText('85 files')).toBeInTheDocument();
    expect(screen.getByText('1,234 LOC')).toBeInTheDocument();
    expect(screen.getByText('.ts (50) · .tsx (30) · .json (5)')).toBeInTheDocument();
  });

  it('sorts extensions by count desc', () => {
    const signal = makeSignal({
      districtId: 'd1',
      fileTypeBreakdown: { kind: 'extension', counts: { '.json': 3, '.ts': 100, '.css': 20 } },
    });
    render(<DistrictTreeRow signal={signal} onSelectDistrict={onSelectDistrict} />);

    expect(screen.getByText('.ts (100) · .css (20) · .json (3)')).toBeInTheDocument();
  });

  it('shows fewer than 3 extensions when less are available', () => {
    const signal = makeSignal({
      districtId: 'd1',
      fileTypeBreakdown: { kind: 'extension', counts: { '.py': 10 } },
    });
    render(<DistrictTreeRow signal={signal} onSelectDistrict={onSelectDistrict} />);

    expect(screen.getByText('.py (10)')).toBeInTheDocument();
  });

  it('renders without extension line when counts is empty', () => {
    const signal = makeSignal({
      districtId: 'd1',
      fileTypeBreakdown: { kind: 'extension', counts: {} },
    });
    render(<DistrictTreeRow signal={signal} onSelectDistrict={onSelectDistrict} />);

    expect(screen.getByText('d1')).toBeInTheDocument();
    expect(screen.queryByText('·')).not.toBeInTheDocument();
  });

  it('click calls onSelectDistrict', async () => {
    const user = userEvent.setup();
    render(
      <DistrictTreeRow
        signal={makeSignal({ districtId: 'target' })}
        onSelectDistrict={onSelectDistrict}
      />,
    );

    await user.click(screen.getByRole('button'));
    expect(onSelectDistrict).toHaveBeenCalledWith('target');
  });

  it('does not double-prefix dot on real extname() keys', () => {
    const signal = makeSignal({
      districtId: 'd1',
      fileTypeBreakdown: { kind: 'extension', counts: { '.ts': 50, '.tsx': 30 } },
    });
    render(<DistrictTreeRow signal={signal} onSelectDistrict={onSelectDistrict} />);

    expect(screen.getByText('.ts (50) · .tsx (30)')).toBeInTheDocument();
    expect(screen.queryByText(/\.\./)).not.toBeInTheDocument();
  });

  it('handles (no ext) key without dot prefix', () => {
    const signal = makeSignal({
      districtId: 'd1',
      fileTypeBreakdown: { kind: 'extension', counts: { '(no ext)': 5, '.ts': 10 } },
    });
    render(<DistrictTreeRow signal={signal} onSelectDistrict={onSelectDistrict} />);

    expect(screen.getByText('.ts (10) · (no ext) (5)')).toBeInTheDocument();
  });

  it('has min-h-10 touch target', () => {
    render(
      <DistrictTreeRow
        signal={makeSignal({ districtId: 'd1' })}
        onSelectDistrict={onSelectDistrict}
      />,
    );
    expect(screen.getByRole('button').className).toContain('min-h-10');
  });
});
