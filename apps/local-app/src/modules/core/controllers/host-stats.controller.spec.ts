import type * as os from 'node:os';
import { statfs } from 'node:fs/promises';
import { HostStatsController } from './host-stats.controller';

jest.mock('../../../common/logging/logger', () => ({
  createLogger: () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }),
}));

jest.mock('node:fs/promises', () => ({
  statfs: jest.fn(),
}));

jest.mock('../../storage/db/db.config', () => ({
  getDbConfig: () => ({ dbPath: '/tmp/host-stats-controller-spec/devchain.db', busyTimeout: 5000 }),
}));

jest.mock('node:os', () => ({
  cpus: jest.fn(),
  loadavg: jest.fn(),
  totalmem: jest.fn(),
  freemem: jest.fn(),
  uptime: jest.fn(),
}));

function cpuSnapshot(idle: number, other: number) {
  return [
    {
      model: 'test-cpu',
      speed: 0,
      times: { user: other, nice: 0, sys: 0, idle, irq: 0 },
    },
  ] as os.CpuInfo[];
}

describe('HostStatsController', () => {
  let controller: HostStatsController;
  const statfsMock = statfs as unknown as jest.Mock;
  const os = jest.requireMock('node:os') as {
    cpus: jest.Mock;
    loadavg: jest.Mock;
    totalmem: jest.Mock;
    freemem: jest.Mock;
    uptime: jest.Mock;
  };

  beforeEach(() => {
    jest.useFakeTimers();
    controller = new HostStatsController();
    statfsMock.mockResolvedValue({ bsize: 4096, blocks: 1000, bfree: 400, bavail: 400 });
    os.loadavg.mockReturnValue([0.5, 0.7, 0.9]);
    os.totalmem.mockReturnValue(8_000_000_000);
    os.freemem.mockReturnValue(2_000_000_000);
    os.uptime.mockReturnValue(123.9);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it('returns the documented shape', async () => {
    // Baseline check read, then the 100 ms sample: idle +100 per read, total +200 -> 50% CPU.
    os.cpus
      .mockReturnValueOnce(cpuSnapshot(1000, 1000))
      .mockReturnValueOnce(cpuSnapshot(1100, 1100))
      .mockReturnValueOnce(cpuSnapshot(1200, 1200));

    const resultPromise = controller.getStats();
    await jest.advanceTimersByTimeAsync(100);
    const result = await resultPromise;

    expect(os.cpus).toHaveBeenCalledTimes(3);
    expect(result).toEqual({
      cpuPercent: 50,
      load1: 0.5,
      load5: 0.7,
      memTotalBytes: 8_000_000_000,
      memUsedBytes: 6_000_000_000,
      diskTotalBytes: 1000 * 4096,
      diskUsedBytes: (1000 - 400) * 4096,
      diskAvailBytes: 400 * 4096,
      uptimeSec: 123,
      sampledAt: expect.any(String),
    });
    expect(() => new Date(result.sampledAt).toISOString()).not.toThrow();
  });

  it('falls back to zeroed disk stats when statfs fails', async () => {
    os.cpus.mockReturnValue(cpuSnapshot(1000, 1000));
    statfsMock.mockRejectedValue(new Error('EPERM'));

    const resultPromise = controller.getStats();
    await jest.advanceTimersByTimeAsync(100);
    const result = await resultPromise;

    expect(result.diskTotalBytes).toBe(0);
    expect(result.diskUsedBytes).toBe(0);
    expect(result.diskAvailBytes).toBe(0);
  });

  it('clamps cpuPercent to [0, 100] when the sample is degenerate', async () => {
    // No time elapsed between samples (idle == total delta) -> 0% used.
    os.cpus.mockReturnValue(cpuSnapshot(1000, 1000));

    const resultPromise = controller.getStats();
    await jest.advanceTimersByTimeAsync(100);
    const result = await resultPromise;

    expect(result.cpuPercent).toBe(0);
  });

  describe('cpu percent strategy', () => {
    function primeBaseline(): void {
      // First request: three reads — the baseline check (stored as the baseline:
      // idle 1000, total 2000), then the 100 ms sample start and end.
      // Sample: idle +100, total +200 -> 50%.
      os.cpus
        .mockReturnValueOnce(cpuSnapshot(1000, 1000))
        .mockReturnValueOnce(cpuSnapshot(1100, 1100))
        .mockReturnValueOnce(cpuSnapshot(1200, 1200));
    }

    async function collect<T>(promise: Promise<T>): Promise<T> {
      await jest.advanceTimersByTimeAsync(100);
      return promise;
    }

    it('averages over the delta since a previous reading 10 s old', async () => {
      primeBaseline();
      await collect(controller.getStats());

      await jest.advanceTimersByTimeAsync(10_000);
      // One read only: idle delta 300, total delta 1000 -> 70%.
      os.cpus.mockReturnValueOnce(cpuSnapshot(1300, 1700));
      const result = await controller.getStats();

      expect(os.cpus).toHaveBeenCalledTimes(4);
      expect(result.cpuPercent).toBe(70);
    });

    it('uses the 100 ms sample when the previous reading is under 1 s old', async () => {
      primeBaseline();
      await collect(controller.getStats());

      await jest.advanceTimersByTimeAsync(200);
      // The 200 ms-old baseline would average to a false 0%; the sample reads 33.33%.
      os.cpus
        .mockReturnValueOnce(cpuSnapshot(1100, 1000))
        .mockReturnValueOnce(cpuSnapshot(1150, 1100))
        .mockReturnValueOnce(cpuSnapshot(1250, 1150));
      const result = await collect(controller.getStats());

      expect(os.cpus).toHaveBeenCalledTimes(6);
      expect(result.cpuPercent).toBe(33.33);
    });

    it('uses the 100 ms sample when the previous reading is over 60 s old', async () => {
      primeBaseline();
      await collect(controller.getStats());

      await jest.advanceTimersByTimeAsync(61_000);
      // The stale baseline would average to 70%; the sample reads 66.67%.
      os.cpus
        .mockReturnValueOnce(cpuSnapshot(1300, 1700))
        .mockReturnValueOnce(cpuSnapshot(1350, 1750))
        .mockReturnValueOnce(cpuSnapshot(1450, 1950));
      const result = await collect(controller.getStats());

      expect(os.cpus).toHaveBeenCalledTimes(6);
      expect(result.cpuPercent).toBe(66.67);
    });

    it('samples instead of reporting a false 0 when the delta totals are zero', async () => {
      primeBaseline();
      await collect(controller.getStats());

      await jest.advanceTimersByTimeAsync(10_000);
      // Counters identical to the baseline: a zero total delta must not read as 0%.
      os.cpus
        .mockReturnValueOnce(cpuSnapshot(1000, 1000))
        .mockReturnValueOnce(cpuSnapshot(1100, 1100))
        .mockReturnValueOnce(cpuSnapshot(1200, 1200));
      const result = await collect(controller.getStats());

      expect(result.cpuPercent).toBe(50);
    });
  });
});
