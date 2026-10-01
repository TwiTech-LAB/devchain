/**
 * Wire contract for `GET /api/host/stats`, polled by `RemoteHealthService` on the home instance.
 * `diskAvailBytes` (blocks available to non-root, like `df`) is omitted by remotes running
 * older builds; consumers should then fall back to used / total for the disk percent.
 */
export interface HostStats {
  cpuPercent: number;
  load1: number;
  load5: number;
  memTotalBytes: number;
  memUsedBytes: number;
  diskTotalBytes: number;
  diskUsedBytes: number;
  diskAvailBytes?: number;
  uptimeSec: number;
  sampledAt: string;
}
