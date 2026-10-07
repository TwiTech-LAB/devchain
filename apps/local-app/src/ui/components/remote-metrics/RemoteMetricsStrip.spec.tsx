import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { RemoteStatsSample } from '@/ui/hooks/useRemoteStatsHistory';
import {
  RemoteMetricsStrip,
  diskPercent,
  diskTrendPercent,
  formatSampleTime,
  formatUptime,
  ramPercent,
} from './RemoteMetricsStrip';

const mockUseRemoteStatsHistory = jest.fn();
jest.mock('@/ui/hooks/useRemoteStatsHistory', () => ({
  useRemoteStatsHistory: (remoteId: string) => mockUseRemoteStatsHistory(remoteId),
}));

const GB = 1024 ** 3;

function makeSample(overrides: Partial<RemoteStatsSample> = {}): RemoteStatsSample {
  return {
    cpuPercent: 42.4,
    load1: 0.5,
    load5: 0.75,
    memTotalBytes: 16 * GB,
    memUsedBytes: 8 * GB,
    diskTotalBytes: 100 * GB,
    diskUsedBytes: 50 * GB,
    uptimeSec: 90_061,
    sampledAt: '2026-09-26T12:00:00Z',
    ...overrides,
  };
}

function renderStrip(samples: RemoteStatsSample[] = [makeSample()]) {
  mockUseRemoteStatsHistory.mockReturnValue({
    data: { intervalMs: 10_000, samples },
    isLoading: samples.length === 0,
  });
  return render(<RemoteMetricsStrip remoteId="remote-1" remoteName="build-vm" />);
}

beforeEach(() => {
  mockUseRemoteStatsHistory.mockClear();
});

describe('percent math', () => {
  it('computes RAM percent from used / total', () => {
    expect(ramPercent(makeSample({ memUsedBytes: 8 * GB, memTotalBytes: 16 * GB }))).toBe(50);
    expect(ramPercent(makeSample({ memUsedBytes: 12.8 * GB, memTotalBytes: 16 * GB }))).toBe(80);
  });

  it('returns null for RAM when the total is unknown', () => {
    expect(ramPercent(makeSample({ memTotalBytes: 0 }))).toBeNull();
  });

  it('computes disk percent as used / (used + avail) when avail is present', () => {
    const sample = makeSample({ diskUsedBytes: 50 * GB, diskAvailBytes: 25 * GB });
    expect(diskPercent(sample)).toBe(67); // 50 / 75 = 66.7%
  });

  it('falls back to used / total when avail is absent', () => {
    const sample = makeSample({ diskUsedBytes: 50 * GB, diskTotalBytes: 100 * GB });
    expect(diskPercent(sample)).toBe(50);
  });

  it('returns null for disk when no usable denominator exists', () => {
    expect(diskPercent(makeSample({ diskTotalBytes: 0 }))).toBeNull();
    expect(
      diskPercent(makeSample({ diskTotalBytes: 0, diskUsedBytes: 0, diskAvailBytes: 0 })),
    ).toBeNull();
  });
});

describe('disk trend formula', () => {
  it('diskTrendPercent keeps the df denominator and fractional precision', () => {
    expect(
      diskTrendPercent(makeSample({ diskUsedBytes: 50 * GB, diskAvailBytes: 25 * GB })),
    ).toBeCloseTo(66.6667, 3);
    expect(diskTrendPercent(makeSample({ diskUsedBytes: 50 * GB, diskTotalBytes: 100 * GB }))).toBe(
      50,
    );
    expect(diskTrendPercent(makeSample({ diskTotalBytes: 0 }))).toBeNull();
  });

  it('renders a changing Disk sparkline when only the available space changes', () => {
    // used/total stays constant across both samples, so a used/total trend would be
    // flat; the df trend rises because the available space shrinks.
    renderStrip([
      makeSample({ diskUsedBytes: 50 * GB, diskTotalBytes: 100 * GB, diskAvailBytes: 50 * GB }),
      makeSample({ diskUsedBytes: 50 * GB, diskTotalBytes: 100 * GB, diskAvailBytes: 30 * GB }),
    ]);

    const block = screen.getByTestId('remote-metric-disk');
    const polyline = block.querySelector('polyline');
    expect(polyline).not.toBeNull();
    expect(polyline).toHaveAttribute('points', '2,18 54,2');
  });
});

describe('formatting helpers', () => {
  it('formats uptime as days, hours, then minutes', () => {
    expect(formatUptime(90_061)).toBe('1d 1h');
    expect(formatUptime(7_321)).toBe('2h 2m');
    expect(formatUptime(590)).toBe('9m');
    expect(formatUptime(-1)).toBe('unknown');
  });

  it('formats the sample time as a locale time string', () => {
    const formatted = formatSampleTime('2026-09-26T12:00:00Z');
    expect(formatted).not.toBe('unknown');
    expect(formatSampleTime('not-a-date')).toBe('unknown');
  });
});

describe('RemoteMetricsStrip rendering', () => {
  it('renders the three percents with accessible labels', () => {
    renderStrip();
    expect(screen.getByRole('button', { name: 'CPU 42%' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'RAM 50%' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Disk 50%' })).toBeInTheDocument();
  });

  it('shows an em dash when a percent cannot be computed', () => {
    renderStrip([makeSample({ memTotalBytes: 0, diskTotalBytes: 0, diskAvailBytes: undefined })]);
    expect(screen.getByRole('button', { name: 'RAM —' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Disk —' })).toBeInTheDocument();
  });

  it('shows "Waiting for stats" in muted text while there are no samples', () => {
    renderStrip([]);
    const strip = screen.getByTestId('remote-metrics-strip');
    expect(strip).toHaveTextContent('Waiting for stats');
    expect(strip).toHaveClass('text-muted-foreground');
  });

  describe('threshold colors', () => {
    function ramTone(percent: number): string {
      cleanup();
      const memUsed = (16 * GB * percent) / 100;
      renderStrip([makeSample({ memUsedBytes: memUsed, memTotalBytes: 16 * GB })]);
      const block = screen.getByTestId('remote-metric-ram');
      const value = within(block).getByText(`${percent}%`);
      const tone = ['text-status-warn', 'text-destructive'].find((cls) =>
        value.className.includes(cls),
      );
      return tone ?? 'none';
    }

    it('stays neutral at 79%, warns at 80% and turns destructive at 90%', () => {
      expect(ramTone(79)).toBe('none');
      expect(ramTone(80)).toBe('text-status-warn');
      expect(ramTone(90)).toBe('text-destructive');
    });
  });

  describe('tooltip', () => {
    // Radix opens the trigger on focus in jsdom; hover needs real pointer events.
    function focusBlock(name: string) {
      fireEvent.focus(screen.getByRole('button', { name }));
    }

    // Radix renders the content twice: the visible copy plus a visually-hidden
    // role="tooltip" copy, so tests read the first match.
    async function findTooltip(): Promise<HTMLElement> {
      const [tooltip] = await screen.findAllByTestId('remote-metrics-tooltip');
      return tooltip;
    }

    it('shows the remote name, RAM and Disk GB, loads, uptime and sample time', async () => {
      renderStrip();
      focusBlock('CPU 42%');
      const tooltip = await findTooltip();
      expect(within(tooltip).getByText('build-vm')).toBeInTheDocument();
      expect(within(tooltip).getByText('RAM 8.0 / 16.0 GB')).toBeInTheDocument();
      expect(within(tooltip).getByText('Disk 50.0 / 100.0 GB')).toBeInTheDocument();
      expect(within(tooltip).getByText('Load 0.5 / 0.8')).toBeInTheDocument();
      expect(within(tooltip).getByText('Up 1d 1h')).toBeInTheDocument();
      expect(
        within(tooltip).getByText(`Sampled ${formatSampleTime('2026-09-26T12:00:00Z')}`),
      ).toBeInTheDocument();
    });

    it('opens from every metric block', async () => {
      renderStrip();
      for (const name of ['CPU 42%', 'RAM 50%', 'Disk 50%']) {
        focusBlock(name);
        expect(await findTooltip()).toBeInTheDocument();
      }
    });
  });
});
