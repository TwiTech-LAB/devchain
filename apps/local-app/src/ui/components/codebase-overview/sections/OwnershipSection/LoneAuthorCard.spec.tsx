import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DistrictSignals } from '@devchain/codebase-overview';
import { LoneAuthorCard } from './LoneAuthorCard';

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
    complexityAvg: 10.0,
    inboundWeight: 3,
    outboundWeight: 2,
    blastRadius: 1,
    couplingScore: 5,
    ownershipHHI: 0.6,
    ownershipMeasured: true,
    primaryAuthorName: 'Dev',
    primaryAuthorShare: 0.8,
    primaryAuthorRecentlyActive: true,
    fileTypeBreakdown: { kind: 'extension', counts: { ts: 8, json: 2 } },
    ...overrides,
  };
}

const onSelectDistrict = jest.fn();

describe('LoneAuthorCard', () => {
  beforeEach(() => {
    onSelectDistrict.mockClear();
  });

  it('renders rows for signals with primaryAuthorShare > 0.8', () => {
    const signals = [
      makeSignal({ districtId: 'solo', primaryAuthorName: 'Alice', primaryAuthorShare: 0.95 }),
    ];
    render(<LoneAuthorCard signals={signals} onSelectDistrict={onSelectDistrict} />);

    expect(screen.getByText('Lone-Author Districts')).toBeInTheDocument();
    expect(screen.getByText('solo')).toBeInTheDocument();
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('95%')).toBeInTheDocument();
  });

  it('hides when primaryAuthorName is null', () => {
    const signals = [
      makeSignal({ districtId: 'd1', primaryAuthorName: null, primaryAuthorShare: 0.95 }),
    ];
    const { container } = render(
      <LoneAuthorCard signals={signals} onSelectDistrict={onSelectDistrict} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('hides when primaryAuthorShare <= 0.8', () => {
    const signals = [
      makeSignal({ districtId: 'd1', primaryAuthorName: 'Bob', primaryAuthorShare: 0.8 }),
    ];
    const { container } = render(
      <LoneAuthorCard signals={signals} onSelectDistrict={onSelectDistrict} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('sorts by primaryAuthorShare desc, then loc desc', () => {
    const signals = [
      makeSignal({
        districtId: 'low-share',
        name: 'low-share',
        primaryAuthorName: 'A',
        primaryAuthorShare: 0.85,
        loc: 1000,
      }),
      makeSignal({
        districtId: 'high-share',
        name: 'high-share',
        primaryAuthorName: 'B',
        primaryAuthorShare: 0.99,
        loc: 200,
      }),
      makeSignal({
        districtId: 'same-share-big',
        name: 'same-share-big',
        primaryAuthorName: 'C',
        primaryAuthorShare: 0.85,
        loc: 2000,
      }),
    ];
    render(<LoneAuthorCard signals={signals} onSelectDistrict={onSelectDistrict} />);

    const buttons = screen.getAllByRole('button').filter((b) => !b.hasAttribute('aria-label'));
    expect(buttons[0]!.textContent).toContain('high-share');
    expect(buttons[1]!.textContent).toContain('same-share-big');
    expect(buttons[2]!.textContent).toContain('low-share');
  });

  it('caps at 15 entries', () => {
    const signals = Array.from({ length: 20 }, (_, i) =>
      makeSignal({
        districtId: `d${i}`,
        primaryAuthorName: `Author ${i}`,
        primaryAuthorShare: 0.9 + i * 0.001,
      }),
    );
    render(<LoneAuthorCard signals={signals} onSelectDistrict={onSelectDistrict} />);

    const buttons = screen.getAllByRole('button').filter((b) => !b.hasAttribute('aria-label'));
    expect(buttons.length).toBe(15);
  });

  it('click row calls onSelectDistrict', async () => {
    const user = userEvent.setup();
    const signals = [
      makeSignal({ districtId: 'target', primaryAuthorName: 'Alice', primaryAuthorShare: 0.95 }),
    ];
    render(<LoneAuthorCard signals={signals} onSelectDistrict={onSelectDistrict} />);

    const buttons = screen.getAllByRole('button').filter((b) => !b.hasAttribute('aria-label'));
    await user.click(buttons[0]!);
    expect(onSelectDistrict).toHaveBeenCalledWith('target');
  });

  it('row button has min-h-10 touch target', () => {
    const signals = [
      makeSignal({ districtId: 'solo', primaryAuthorName: 'Alice', primaryAuthorShare: 0.95 }),
    ];
    render(<LoneAuthorCard signals={signals} onSelectDistrict={onSelectDistrict} />);
    const rowButtons = screen.getAllByRole('button').filter((b) => !b.hasAttribute('aria-label'));
    expect(rowButtons[0]).toHaveClass('min-h-10');
  });

  it('help icon button has h-10 w-10 touch target', () => {
    const signals = [
      makeSignal({ districtId: 'solo', primaryAuthorName: 'Alice', primaryAuthorShare: 0.95 }),
    ];
    render(<LoneAuthorCard signals={signals} onSelectDistrict={onSelectDistrict} />);
    const helpBtn = screen.getByRole('button', { name: /about lone-author districts/i });
    expect(helpBtn).toHaveClass('h-10');
    expect(helpBtn).toHaveClass('w-10');
  });
});
