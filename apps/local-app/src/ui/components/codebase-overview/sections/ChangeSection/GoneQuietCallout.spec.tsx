import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DistrictSignals } from '@devchain/codebase-overview';
import { GoneQuietCallout } from './GoneQuietCallout';

const onSelectDistrict = jest.fn();

function makeSignal(
  districtId: string,
  churn7d: number,
  churn30d: number,
  overrides: Partial<DistrictSignals> = {},
): DistrictSignals {
  return {
    districtId,
    name: districtId,
    loc: 200,
    churn7d,
    churn30d,
    ownerQuiet: false,
    ...overrides,
  };
}

describe('GoneQuietCallout', () => {
  beforeEach(() => {
    onSelectDistrict.mockClear();
  });

  it('renders gone-quiet districts', () => {
    const signals = [makeSignal('alpha', 0, 10)];
    render(<GoneQuietCallout signals={signals} onSelectDistrict={onSelectDistrict} />);
    expect(screen.getByText('Gone Quiet')).toBeInTheDocument();
    expect(screen.getByText('alpha')).toBeInTheDocument();
  });

  it('returns null when no qualifying districts', () => {
    const { container } = render(
      <GoneQuietCallout signals={[]} onSelectDistrict={onSelectDistrict} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('filters: churn7d must be 0', () => {
    const signals = [makeSignal('active', 2, 10)];
    const { container } = render(
      <GoneQuietCallout signals={signals} onSelectDistrict={onSelectDistrict} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('filters: churn30d must be > 5', () => {
    // churn30d=5 is not > 5 → excluded
    const signals = [makeSignal('lowactivity', 0, 5)];
    const { container } = render(
      <GoneQuietCallout signals={signals} onSelectDistrict={onSelectDistrict} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('includes district with churn30d just over 5', () => {
    const signals = [makeSignal('borderline', 0, 6)];
    render(<GoneQuietCallout signals={signals} onSelectDistrict={onSelectDistrict} />);
    expect(screen.getByText('borderline')).toBeInTheDocument();
  });

  it('sorts by churn30d descending', () => {
    const signals = [makeSignal('low', 0, 8), makeSignal('high', 0, 20), makeSignal('mid', 0, 12)];
    render(<GoneQuietCallout signals={signals} onSelectDistrict={onSelectDistrict} />);
    const buttons = screen.getAllByRole('button').filter((b) => b.textContent?.includes('in 30d'));
    expect(buttons[0]!.textContent).toContain('high');
    expect(buttons[1]!.textContent).toContain('mid');
    expect(buttons[2]!.textContent).toContain('low');
  });

  it('tie-break by loc descending', () => {
    const signals = [
      makeSignal('smallLoc', 0, 15, { loc: 50 }),
      makeSignal('bigLoc', 0, 15, { loc: 500 }),
    ];
    render(<GoneQuietCallout signals={signals} onSelectDistrict={onSelectDistrict} />);
    const buttons = screen.getAllByRole('button').filter((b) => b.textContent?.includes('in 30d'));
    expect(buttons[0]!.textContent).toContain('bigLoc');
    expect(buttons[1]!.textContent).toContain('smallLoc');
  });

  it('caps at 5 rows', () => {
    const signals = Array.from({ length: 8 }, (_, i) => makeSignal(`d${i}`, 0, 10));
    render(<GoneQuietCallout signals={signals} onSelectDistrict={onSelectDistrict} />);
    const buttons = screen.getAllByRole('button').filter((b) => b.textContent?.includes('in 30d'));
    expect(buttons.length).toBe(5);
  });

  it('shows churn30d metric per row', () => {
    const signals = [makeSignal('quiet', 0, 14)];
    render(<GoneQuietCallout signals={signals} onSelectDistrict={onSelectDistrict} />);
    expect(screen.getByText('14 in 30d, 0 in 7d')).toBeInTheDocument();
  });

  it('click row calls onSelectDistrict with districtId', async () => {
    const user = userEvent.setup();
    const signals = [makeSignal('dist-77', 0, 10)];
    render(<GoneQuietCallout signals={signals} onSelectDistrict={onSelectDistrict} />);
    const btn = screen.getByText('dist-77').closest('button')!;
    await user.click(btn);
    expect(onSelectDistrict).toHaveBeenCalledWith('dist-77');
  });

  it('shows badge with count', () => {
    const signals = [makeSignal('a', 0, 10), makeSignal('b', 0, 12)];
    render(<GoneQuietCallout signals={signals} onSelectDistrict={onSelectDistrict} />);
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('row button has min-h-10 touch target', () => {
    const signals = [makeSignal('quiet', 0, 10)];
    render(<GoneQuietCallout signals={signals} onSelectDistrict={onSelectDistrict} />);
    const btn = screen.getByText('quiet').closest('button')!;
    expect(btn).toHaveClass('min-h-10');
  });
});
