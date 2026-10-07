import type { ProviderCliRuntimeReport } from '@devchain/shared';
import type { DockerRuntime } from '../../core/controllers/docker-runtime';
import type { HostStats } from '../../core/models/host-stats.model';
import type { HostEnvOverrideEntry } from '../host/host-env-override-report';
import type { VmPowerState } from '../../vm-providers/vm-provider.port';
import type { VmUidConflict } from '../vm-user-identity';

export const REMOTE_HEALTH_PORT = Symbol('RemoteHealthPort');

export interface RemoteHealthState {
  cliVersions?: Record<string, string> | null;
  providerClis?: ProviderCliRuntimeReport | null;
  docker?: DockerRuntime;
  online: boolean;
  apiKeyRejected?: boolean;
  version: string | null;
  versionMatches: boolean;
  /** The remote's home folder (`/api/runtime`), when it reports one. */
  homePath: string | null;
  /** The remote process's real account ids (`/api/runtime`), when reported. */
  uid: number | null;
  gid: number | null;
  uidConflict?: VmUidConflict | null;
  /**
   * Keys stored on the remote that shadow its applied `host.env` logins
   * (`/api/runtime`), names only; null when the remote reports none.
   */
  providerEnvOverrides?: HostEnvOverrideEntry[] | null;
  stats: HostStats | null;
  lastSeenAt: string | null;
  error: string | null;
  powerState?: VmPowerState;
}

export interface RemoteHealthPort {
  /**
   * Last known health state for a remote. Never polled (unknown id, or not yet
   * reached by a poll cycle) returns an all-offline default rather than undefined,
   * so callers such as the proxy (`/r/:remoteId/*`) can treat it uniformly as
   * "not currently usable".
   */
  getState(remoteId: string): RemoteHealthState;
  /**
   * Full stats samples kept in memory for this remote, oldest first and bounded
   * (not persisted; empty until a poll returns non-null stats).
   */
  getStatsHistory(remoteId: string): HostStats[];
  /** Polls the remote now instead of waiting for the next interval. */
  refresh(remoteId: string): Promise<RemoteHealthState>;
}
