import { RemoteApiKeyService } from '../auth/remote-api-key.service';
import { z } from 'zod';
import { ProviderCliRuntimeReportSchema } from '@devchain/shared';
import { ProviderCliVersionsService } from '../../providers/services/provider-cli-versions.service';
import { RemoteProviderCliSettingsService } from './remote-provider-cli-settings.service';
import {
  RemoteSkillSettingsService,
  type SkillSettingsPollCycle,
} from './remote-skill-settings.service';
import { DockerRuntimeSchema } from '../../core/controllers/docker-runtime';
import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createLogger } from '../../../common/logging/logger';
import { getAppVersion } from '../../../common/app-version';
import { getEnvConfig } from '../../../common/config/env.config';
import { STORAGE_SERVICE, type RemoteStorage } from '../../storage/interfaces/storage.interface';
import {
  REALTIME_BROADCASTER,
  type RealtimeBroadcaster,
} from '../../realtime/ports/realtime-broadcaster.port';
import { ProviderAuthWritebackService } from '../../provider-auth/provider-auth-writeback.service';
import type { HostStats } from '../../core/models/host-stats.model';
import type { Remote } from '../../storage/models/domain.models';
import { VmProvidersService } from '../../vm-providers/vm-providers.service';
import {
  HostEnvOverridesSchema,
  type HostEnvOverrideEntry,
} from '../host/host-env-override-report';
import type { RemoteHealthPort, RemoteHealthState } from '../ports/remote-health.port';
import { matchesHomePath } from '../home-identity';
import { isHostApiKeyRejection } from '../host-api-key';
import { remoteFetch, requireRemoteTls } from '../transport/remote-tls';
import { reportedVmUserMismatch, VmUidConflictSchema } from '../vm-user-identity';

const logger = createLogger('RemoteHealthService');

// Notes: never let a hung remote block the poll interval.
const REQUEST_TIMEOUT_MS = 3000;
const OFFLINE_AFTER_CONSECUTIVE_FAILURES = 2;
// In-memory only; ~10 minutes of trend at the default poll interval.
const STATS_HISTORY_LIMIT = 60;

const API_KEY_REJECTED_ERROR = 'API key rejected';

class HostApiKeyRejectedError extends Error {}

const OFFLINE_DEFAULT_STATE: RemoteHealthState = {
  online: false,
  apiKeyRejected: false,
  version: null,
  versionMatches: false,
  homePath: null,
  uid: null,
  gid: null,
  stats: null,
  lastSeenAt: null,
  error: null,
  powerState: 'unknown',
};

interface RuntimeResponse {
  cliVersions?: unknown;
  providerClis?: unknown;
  docker?: unknown;
  version?: unknown;
  homePath?: unknown;
  uid?: unknown;
  gid?: unknown;
  uidConflict?: unknown;
  providerEnvOverrides?: unknown;
}

@Injectable()
export class RemoteHealthService implements RemoteHealthPort, OnModuleInit, OnModuleDestroy {
  private readonly state = new Map<string, RemoteHealthState>();
  private readonly consecutiveFailures = new Map<string, number>();
  private readonly pollVersions = new Map<string, number>();
  private readonly statsHistory = new Map<string, HostStats[]>();
  /**
   * The refresh running for each remote. A newer poll would make its answer
   * stale, so the timer skips these remotes and refreshes run one at a time.
   */
  private readonly refreshing = new Map<string, Promise<void>>();
  private unregisterCliCheck?: () => void;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: RemoteStorage,
    @Inject(REALTIME_BROADCASTER) private readonly broadcaster: RealtimeBroadcaster,
    private readonly familyWriteback: ProviderAuthWritebackService,
    private readonly vmProviders: VmProvidersService,
    private readonly skillSettings: RemoteSkillSettingsService,
    private readonly cliSettings: RemoteProviderCliSettingsService,
    private readonly cliVersions: ProviderCliVersionsService,
    private readonly apiKeys: RemoteApiKeyService,
  ) {}

  onModuleInit(): void {
    this.unregisterCliCheck = this.cliVersions.registerRemoteCheck(async () => {
      const { items } = await this.storage.listRemotes({ limit: 500 });
      await Promise.all(
        items
          .filter((remote) => {
            const state = this.getState(remote.id);
            return state.online && state.versionMatches && !state.apiKeyRejected;
          })
          .map((remote) => this.cliSettings.checkNow(remote.id)),
      );
    });
    const intervalMs = getEnvConfig().REMOTES_HEALTH_INTERVAL_MS;
    this.timer = setInterval(() => {
      void this.pollAll();
    }, intervalMs);
    void this.pollAll();
  }

  onModuleDestroy(): void {
    this.unregisterCliCheck?.();
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getState(remoteId: string): RemoteHealthState {
    return this.state.get(remoteId) ?? OFFLINE_DEFAULT_STATE;
  }

  getStatsHistory(remoteId: string): HostStats[] {
    const samples = this.statsHistory.get(remoteId);
    return samples ? [...samples] : [];
  }

  rejectApiKey(remoteId: string): void {
    this.pollVersions.set(remoteId, (this.pollVersions.get(remoteId) ?? 0) + 1);
    this.consecutiveFailures.set(remoteId, 0);
    this.commit(remoteId, {
      ...this.getState(remoteId),
      apiKeyRejected: true,
      stats: null,
      error: API_KEY_REJECTED_ERROR,
    });
  }

  async refresh(remoteId: string): Promise<RemoteHealthState> {
    const previous = this.refreshing.get(remoteId);
    const run = (previous ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => this.refreshNow(remoteId));
    this.refreshing.set(remoteId, run);
    try {
      await run;
    } finally {
      if (this.refreshing.get(remoteId) === run) this.refreshing.delete(remoteId);
    }
    return this.getState(remoteId);
  }

  private async refreshNow(remoteId: string): Promise<void> {
    const remote = await this.storage.getRemote(remoteId);
    if (!remote.baseUrl) {
      this.commit(remote.id, OFFLINE_DEFAULT_STATE);
      return;
    }
    // One answer is enough to decide, in either direction.
    this.consecutiveFailures.set(remoteId, OFFLINE_AFTER_CONSECUTIVE_FAILURES - 1);
    await this.pollOne(remote, this.skillSettings.createPollCycle());
  }

  private async pollAll(): Promise<void> {
    let remotes: Remote[];
    try {
      const result = await this.storage.listRemotes({ limit: 500 });
      remotes = result.items;
    } catch (error) {
      logger.error({ error: String(error) }, 'Failed to list remotes for health poll');
      return;
    }

    this.pruneDeletedRemotes(new Set(remotes.map(({ id }) => id)));
    for (const remote of remotes) {
      if (!remote.baseUrl) this.commit(remote.id, OFFLINE_DEFAULT_STATE);
    }
    const skillCycle = this.skillSettings.createPollCycle();
    await Promise.all(
      remotes
        .filter((remote) => remote.baseUrl !== null && !this.refreshing.has(remote.id))
        .map((remote) => this.pollOne(remote, skillCycle)),
    );
  }

  /** Drops tracked state for remotes deleted since the last poll, so the maps stay bounded. */
  private pruneDeletedRemotes(currentIds: Set<string>): void {
    this.skillSettings.prune(currentIds);
    for (const trackedId of this.state.keys()) {
      if (!currentIds.has(trackedId)) {
        this.state.delete(trackedId);
        this.consecutiveFailures.delete(trackedId);
        this.statsHistory.delete(trackedId);
        this.pollVersions.delete(trackedId);
      }
    }
  }

  private async pollOne(remote: Remote, skillCycle: SkillSettingsPollCycle): Promise<void> {
    const { id: remoteId, baseUrl } = remote;
    if (!baseUrl) return;
    const pollVersion = (this.pollVersions.get(remoteId) ?? 0) + 1;
    this.pollVersions.set(remoteId, pollVersion);
    try {
      const { certificate } = requireRemoteTls(remote);
      const headers = await this.apiKeys.headers(remoteId);
      const [runtime, stats] = await Promise.all([
        this.fetchJson<RuntimeResponse>(`${baseUrl}/api/runtime`, headers, certificate),
        this.fetchJson<HostStats>(`${baseUrl}/api/host/stats`, headers, certificate).catch(
          (error: unknown) => {
            if (error instanceof HostApiKeyRejectedError) return null;
            throw error;
          },
        ),
      ]);
      if (this.pollVersions.get(remoteId) !== pollVersion) return;
      this.consecutiveFailures.set(remoteId, 0);

      const version = typeof runtime.version === 'string' ? runtime.version : null;
      const homePath = typeof runtime.homePath === 'string' ? runtime.homePath : null;
      const uid = typeof runtime.uid === 'number' ? runtime.uid : null;
      const gid = typeof runtime.gid === 'number' ? runtime.gid : null;
      const uidConflict = VmUidConflictSchema.safeParse(runtime.uidConflict).data ?? null;
      const overrides = HostEnvOverridesSchema.safeParse(runtime.providerEnvOverrides);
      const providerEnvOverrides: HostEnvOverrideEntry[] | null = overrides.success
        ? overrides.data
        : null;
      const versionMatches = version !== null && version === getAppVersion();
      // A null stats response means the host refused this PC's API key.
      const apiKeyRejected = stats === null;
      this.commit(remoteId, {
        online: true,
        apiKeyRejected,
        version,
        versionMatches,
        homePath,
        uid,
        gid,
        uidConflict,
        providerEnvOverrides,
        cliVersions: z.record(z.string()).safeParse(runtime.cliVersions).data ?? null,
        providerClis: ProviderCliRuntimeReportSchema.safeParse(runtime.providerClis).data ?? null,
        docker: DockerRuntimeSchema.safeParse(runtime.docker).data,
        stats,
        lastSeenAt: new Date().toISOString(),
        error: apiKeyRejected ? API_KEY_REJECTED_ERROR : null,
        powerState: 'running',
      });
      if (apiKeyRejected) return;
      this.appendStatsSample(remoteId, stats);

      // The families pull rides a successful poll only; its own failures are
      // tolerated inside and never change the online/version state above.
      await this.familyWriteback.pullIfChanged(remoteId, baseUrl, certificate);
      if (versionMatches) {
        void this.skillSettings.pushIfChanged(remoteId, skillCycle);
        void this.cliSettings.pushIfChanged(remoteId);
      }
    } catch (error) {
      if (this.pollVersions.get(remoteId) !== pollVersion) return;
      const failures = (this.consecutiveFailures.get(remoteId) ?? 0) + 1;
      this.consecutiveFailures.set(remoteId, failures);
      if (failures < OFFLINE_AFTER_CONSECUTIVE_FAILURES) {
        // Stay in the current state until the offline threshold is reached.
        return;
      }

      let powerState: RemoteHealthState['powerState'] = 'unknown';
      if (remote.kind === 'proxmox' && remote.vmIdentity) {
        try {
          powerState = await (
            await this.vmProviders.forRemote(remote)
          ).getPowerState(remote.vmIdentity);
        } catch {
          powerState = 'unknown';
        }
        // A refresh can bring the VM online while the power state loads.
        if (this.pollVersions.get(remoteId) !== pollVersion) return;
      }
      const previous = this.state.get(remoteId) ?? OFFLINE_DEFAULT_STATE;
      this.commit(remoteId, {
        ...previous,
        online: false,
        error: error instanceof Error ? error.message : String(error),
        powerState,
      });
    }
  }

  private appendStatsSample(remoteId: string, stats: HostStats): void {
    const samples = this.statsHistory.get(remoteId) ?? [];
    samples.push(stats);
    if (samples.length > STATS_HISTORY_LIMIT) {
      samples.splice(0, samples.length - STATS_HISTORY_LIMIT);
    }
    this.statsHistory.set(remoteId, samples);
  }

  private commit(remoteId: string, nextState: RemoteHealthState): void {
    const previous = this.state.get(remoteId);
    // lastSeenAt refreshes on every successful poll and would otherwise force an emit
    // even when nothing meaningful changed; it is stored but excluded from the gate.
    const changed = !previous || !this.isEquivalentIgnoringLastSeenAt(previous, nextState);
    this.state.set(remoteId, nextState);
    if (changed) {
      this.broadcaster.broadcastEvent('remotes', 'state', {
        remoteId,
        ...nextState,
        homePathMatches: matchesHomePath(nextState.homePath),
        dockerUserMismatch: reportedVmUserMismatch(nextState),
      });
    }
  }

  private isEquivalentIgnoringLastSeenAt(a: RemoteHealthState, b: RemoteHealthState): boolean {
    return (
      JSON.stringify(a.cliVersions ?? null) === JSON.stringify(b.cliVersions ?? null) &&
      JSON.stringify(a.providerClis ?? null) === JSON.stringify(b.providerClis ?? null) &&
      JSON.stringify(a.docker) === JSON.stringify(b.docker) &&
      a.online === b.online &&
      a.apiKeyRejected === b.apiKeyRejected &&
      a.version === b.version &&
      a.versionMatches === b.versionMatches &&
      a.homePath === b.homePath &&
      a.uid === b.uid &&
      a.gid === b.gid &&
      JSON.stringify(a.uidConflict ?? null) === JSON.stringify(b.uidConflict ?? null) &&
      a.error === b.error &&
      a.powerState === b.powerState &&
      JSON.stringify(a.providerEnvOverrides ?? null) ===
        JSON.stringify(b.providerEnvOverrides ?? null) &&
      JSON.stringify(a.stats) === JSON.stringify(b.stats)
    );
  }

  private async fetchJson<T>(
    url: string,
    headers: Record<string, string>,
    certificate: string,
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    timeout.unref?.();
    try {
      const response = await remoteFetch(url, { signal: controller.signal, headers }, certificate);
      if (await isHostApiKeyRejection(response)) {
        throw new HostApiKeyRejectedError(API_KEY_REJECTED_ERROR);
      }
      if (!response.ok) {
        throw new Error(`Unexpected status ${response.status} from ${url}`);
      }
      return (await response.json()) as T;
    } finally {
      clearTimeout(timeout);
    }
  }
}
