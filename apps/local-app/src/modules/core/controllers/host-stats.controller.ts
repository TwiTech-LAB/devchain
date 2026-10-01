import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import * as os from 'node:os';
import { statfs } from 'node:fs/promises';
import { dirname } from 'node:path';
import { getDbConfig } from '../../storage/db/db.config';
import { createLogger } from '../../../common/logging/logger';
import type { HostStats } from '../models/host-stats.model';

const logger = createLogger('HostStatsController');

// A near-instant single-sample CPU read is meaningless (no prior baseline); this window is
// the minimum sane delta for a stable percentage without noticeably slowing the request.
const CPU_SAMPLE_WINDOW_MS = 100;
// The average-since-previous-request baseline is only trusted inside this age range: a
// younger reading overlaps this request (the poll timer and on-demand refreshes can fire
// close together), and an older one describes a machine state that no longer holds.
const CPU_BASELINE_MIN_AGE_MS = 1000;
const CPU_BASELINE_MAX_AGE_MS = 60000;

interface CpuTimeTotals {
  idle: number;
  total: number;
}

function readCpuTimeTotals(): CpuTimeTotals {
  return os.cpus().reduce<CpuTimeTotals>(
    (acc, cpu) => {
      acc.idle += cpu.times.idle;
      acc.total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
      return acc;
    },
    { idle: 0, total: 0 },
  );
}

/** Busy percent between two readings, or null when the counters did not advance. */
function busyPercentBetween(start: CpuTimeTotals, end: CpuTimeTotals): number | null {
  const idleDelta = end.idle - start.idle;
  const totalDelta = end.total - start.total;
  if (totalDelta <= 0) return null;
  return Math.max(0, Math.min(100, ((totalDelta - idleDelta) / totalDelta) * 100));
}

@ApiTags('host')
@Controller('api/host')
export class HostStatsController {
  private previousCpuTotals: { totals: CpuTimeTotals; at: number } | null = null;

  @Get('stats')
  @ApiOperation({ summary: 'Get this instance host resource stats' })
  @ApiResponse({ status: 200, description: 'Host resource stats' })
  async getStats(): Promise<HostStats> {
    const [cpuPercent, disk] = await Promise.all([this.readCpuPercent(), this.readDiskStats()]);
    const [load1, load5] = os.loadavg();
    const memTotalBytes = os.totalmem();
    const memUsedBytes = memTotalBytes - os.freemem();

    return {
      cpuPercent: Math.round(cpuPercent * 100) / 100,
      load1,
      load5,
      memTotalBytes,
      memUsedBytes,
      diskTotalBytes: disk.total,
      diskUsedBytes: disk.used,
      diskAvailBytes: disk.avail,
      uptimeSec: Math.floor(os.uptime()),
      sampledAt: new Date().toISOString(),
    };
  }

  private async readCpuPercent(): Promise<number> {
    const totals = readCpuTimeTotals();
    const now = Date.now();
    const previous = this.previousCpuTotals;
    this.previousCpuTotals = { totals, at: now };

    if (previous) {
      const ageMs = now - previous.at;
      if (ageMs >= CPU_BASELINE_MIN_AGE_MS && ageMs <= CPU_BASELINE_MAX_AGE_MS) {
        // Counters that did not advance would read as a false 0%; take a fresh sample instead.
        const average = busyPercentBetween(previous.totals, totals);
        if (average !== null) return average;
      }
    }
    return this.sampleCpuOverWindow();
  }

  private async sampleCpuOverWindow(): Promise<number> {
    const start = readCpuTimeTotals();
    await new Promise((resolve) => setTimeout(resolve, CPU_SAMPLE_WINDOW_MS));
    return busyPercentBetween(start, readCpuTimeTotals()) ?? 0;
  }

  private async readDiskStats(): Promise<{ total: number; used: number; avail: number }> {
    try {
      const dataDir = dirname(getDbConfig().dbPath);
      const stats = await statfs(dataDir);
      const total = stats.blocks * stats.bsize;
      const free = stats.bfree * stats.bsize;
      const avail = stats.bavail * stats.bsize;
      return { total, used: Math.max(0, total - free), avail };
    } catch (error) {
      logger.warn({ error: String(error) }, 'Failed to read disk stats for the data directory');
      return { total: 0, used: 0, avail: 0 };
    }
  }
}
