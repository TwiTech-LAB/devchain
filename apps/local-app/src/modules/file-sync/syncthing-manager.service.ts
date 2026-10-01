import {
  BeforeApplicationShutdown,
  Inject,
  Injectable,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { z } from 'zod';
import { randomBytes } from 'crypto';
import { mkdir } from 'fs/promises';
import { createServer } from 'net';
import { join } from 'path';
import { getEnvConfig } from '../../common/config/env.config';
import { createLogger } from '../../common/logging/logger';
import { FILE_SYNC_PATHS, type FileSyncPaths } from './file-sync-paths';
import { SyncthingLauncher, type SyncthingProcess } from './syncthing-launcher';
import { SyncthingRestClient, SyncthingRestError } from './syncthing-rest.client';
import { SyncthingSettingsStore, type SyncthingSettings } from './syncthing-settings.store';

const logger = createLogger('SyncthingManager');

export interface SyncthingState {
  /** A supported binary was found. */
  available: boolean;
  version: string | null;
  running: boolean;
  deviceId: string | null;
  apiPort: number | null;
  /** Why the instance is unavailable or not running; install guidance when the binary is missing. */
  error: string | null;
}

export interface SyncthingConnection {
  client: SyncthingRestClient;
  deviceId: string;
  /** The address Syncthing listens on; its host may be a wildcard such as 0.0.0.0. */
  listenAddress: string;
}

export interface SyncthingManagerTimings {
  readyTimeoutMs: number;
  pollIntervalMs: number;
  monitorIntervalMs: number;
  restartBaseDelayMs: number;
  restartMaxDelayMs: number;
  /** A run at least this long resets the restart backoff. */
  stableAfterMs: number;
  shutdownTimeoutMs: number;
}

export const SYNCTHING_MANAGER_TIMINGS = Symbol('SYNCTHING_MANAGER_TIMINGS');

export const DEFAULT_SYNCTHING_MANAGER_TIMINGS: SyncthingManagerTimings = {
  readyTimeoutMs: 30_000,
  pollIntervalMs: 100,
  monitorIntervalMs: 2_000,
  restartBaseDelayMs: 1_000,
  restartMaxDelayMs: 60_000,
  stableAfterMs: 60_000,
  shutdownTimeoutMs: 5_000,
};

interface Instance {
  proc: SyncthingProcess;
  /** `serve` runs a monitor parent; this is the process that does the work. */
  childPid: number | null;
  client: SyncthingRestClient;
  listenAddress: string;
  deviceId: string | null;
  readyAt: number | null;
}

class StopRequested extends Error {
  constructor() {
    super('DevChain is shutting down');
  }
}

/**
 * Runs DevChain's own Syncthing instance: its own home directory, a loopback
 * API with a generated key, and no discovery, relays or NAT. It never reads
 * or changes a Syncthing the user runs. Boot starts it in the background; a
 * missing binary or a failed start is reported in `getState()`, never thrown.
 */
@Injectable()
export class SyncthingManager implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private state: SyncthingState = {
    available: false,
    version: null,
    running: false,
    deviceId: null,
    apiPort: null,
    error: null,
  };
  private instance: Instance | null = null;
  private starting: Promise<SyncthingState> | null = null;
  private stopping = false;
  private failures = 0;
  private transcriptFoldersRemoved = false;
  private restartTimer: NodeJS.Timeout | null = null;
  private monitorTimer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(FILE_SYNC_PATHS) private readonly paths: FileSyncPaths,
    private readonly launcher: SyncthingLauncher,
    private readonly settings: SyncthingSettingsStore,
    @Inject(SYNCTHING_MANAGER_TIMINGS) private readonly timings: SyncthingManagerTimings,
  ) {}

  onApplicationBootstrap(): void {
    void this.ensureRunning();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.stop();
  }

  getState(): SyncthingState {
    return { ...this.state };
  }

  /** The running instance, or null while it is unavailable, starting or restarting. */
  getConnection(): SyncthingConnection | null {
    const instance = this.instance;
    if (!this.state.running || !instance?.deviceId) return null;
    return {
      client: instance.client,
      deviceId: instance.deviceId,
      listenAddress: instance.listenAddress,
    };
  }

  /** Starts and configures the instance unless it runs; concurrent callers share one start. */
  ensureRunning(): Promise<SyncthingState> {
    if (this.stopping || this.state.running) return Promise.resolve(this.getState());
    this.starting ??= this.start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  /** Asks the instance to shut down, and kills it after `shutdownTimeoutMs`. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.clearRestartTimer();
    await this.starting;
    this.stopMonitor();
    const instance = this.instance;
    this.instance = null;
    this.state = { ...this.state, running: false };
    if (!instance) return;
    instance.childPid ??= await this.launcher.findChildPid(instance.proc.pid);
    try {
      await instance.client.shutdown();
    } catch {
      // Not answering; the kill below ends it.
    }
    if (!(await this.waitGone(instance, this.timings.shutdownTimeoutMs))) {
      logger.warn('Syncthing did not shut down in time; killing it');
      await this.kill(instance);
    }
  }

  private async start(): Promise<SyncthingState> {
    this.clearRestartTimer();
    const binary = await this.launcher.findBinary().catch((error: unknown) => ({
      found: false as const,
      version: null,
      error: `Looking for Syncthing failed: ${error instanceof Error ? error.message : String(error)}`,
    }));
    if (!binary.found) {
      this.state = {
        available: false,
        version: binary.version,
        running: false,
        deviceId: null,
        apiPort: null,
        error: binary.error,
      };
      logger.warn({ reason: binary.error }, 'Syncthing is unavailable; project file sync is off');
      return this.getState();
    }
    this.state = { ...this.state, available: true, version: binary.version };

    try {
      const { deviceId, apiPort } = await this.launch(binary.path);
      this.state = { ...this.state, running: true, deviceId, apiPort, error: null };
      logger.info({ version: binary.version, deviceId, apiPort }, 'Syncthing is running');
    } catch (error) {
      // The instance, if any, is left for stop() to shut down gracefully.
      if (this.stopping) return this.getState();
      const reason = error instanceof Error ? error.message : String(error);
      const instance = this.instance;
      this.instance = null;
      if (instance) await this.kill(instance);
      this.state = { ...this.state, running: false, error: reason };
      logger.warn({ reason }, 'Syncthing did not start');
      this.scheduleRestart();
    }
    return this.getState();
  }

  private async launch(binaryPath: string): Promise<{ deviceId: string; apiPort: number }> {
    const home = this.paths.syncthingHome();
    await mkdir(home, { recursive: true, mode: 0o700 });
    const settings = await this.resolveSettings();
    this.throwIfStopping();

    const proc = await this.launcher.spawn(
      binaryPath,
      [
        'serve',
        `--home=${home}`,
        `--gui-address=http://127.0.0.1:${settings.apiPort}`,
        '--no-browser',
        '--no-restart',
        '--no-upgrade',
        `--log-file=${join(home, 'syncthing.log')}`,
      ],
      {
        ...inheritedEnv(),
        // Keeps Syncthing from writing anywhere under the user's HOME.
        HOME: home,
        // The environment form of --gui-apikey; a flag would show the key in `ps`.
        STGUIAPIKEY: settings.apiKey,
        STNODEFAULTFOLDER: '1',
        STNOUPGRADE: '1',
      },
      join(home, 'syncthing.out.log'),
    );
    const instance: Instance = {
      proc,
      childPid: null,
      client: new SyncthingRestClient(`http://127.0.0.1:${settings.apiPort}`, settings.apiKey),
      listenAddress: `tcp://${listenHost()}:${settings.listenPort}`,
      deviceId: null,
      readyAt: null,
    };
    this.instance = instance;
    void proc.exited.then(() => {
      if (instance.readyAt !== null && !this.stopping) {
        void this.fail(instance, 'Syncthing exited unexpectedly');
      }
    });

    await this.waitForApi(instance, home);
    instance.childPid = (await this.launcher.findChildPid(proc.pid)) ?? proc.pid;
    this.throwIfStopping();
    await instance.client.patchOptions({
      listenAddresses: [instance.listenAddress],
      globalAnnounceEnabled: false,
      localAnnounceEnabled: false,
      relaysEnabled: false,
      natEnabled: false,
      urAccepted: -1,
      crashReportingEnabled: false,
      autoUpgradeIntervalH: 0,
    });
    if (await instance.client.restartRequired()) {
      throw new Error('Syncthing needs a restart to apply its options');
    }
    if (!this.transcriptFoldersRemoved) {
      const folders = z
        .array(z.object({ id: z.string() }))
        .parse(await instance.client.request('GET', '/rest/config/folders'));
      for (const folder of folders) {
        if (!folder.id.startsWith('tx:')) continue;
        try {
          await instance.client.request(
            'DELETE',
            `/rest/config/folders/${encodeURIComponent(folder.id)}`,
          );
        } catch (error) {
          if (!(error instanceof SyncthingRestError && error.status === 404)) throw error;
        }
      }
      this.transcriptFoldersRemoved = true;
    }
    instance.deviceId = await instance.client.deviceId();
    this.throwIfStopping();
    instance.readyAt = Date.now();
    this.startMonitor(instance);
    return { deviceId: instance.deviceId, apiPort: settings.apiPort };
  }

  /**
   * Reuses the stored key and ports. A port another program took is replaced;
   * an instance a crashed earlier run left on the stored API port is shut down
   * first, since it holds the home directory lock.
   */
  private async resolveSettings(): Promise<SyncthingSettings> {
    const stored = this.settings.read();
    if (stored) {
      await this.shutDownLeftover(
        new SyncthingRestClient(`http://127.0.0.1:${stored.apiPort}`, stored.apiKey),
      );
    }
    const apiKey = stored?.apiKey ?? randomBytes(24).toString('hex');
    const apiPort =
      stored && (await isPortFree(stored.apiPort)) ? stored.apiPort : await pickFreePort([]);
    const listenPort =
      stored && stored.listenPort !== apiPort && (await isPortFree(stored.listenPort))
        ? stored.listenPort
        : await pickFreePort([apiPort]);
    const next = { apiKey, apiPort, listenPort };
    if (
      !stored ||
      stored.apiKey !== apiKey ||
      stored.apiPort !== apiPort ||
      stored.listenPort !== listenPort
    ) {
      this.settings.write(next);
    }
    return next;
  }

  private async shutDownLeftover(client: SyncthingRestClient): Promise<void> {
    try {
      await client.ping();
    } catch {
      return;
    }
    logger.info('Stopping a Syncthing instance left running by an earlier DevChain run');
    await client.shutdown().catch(() => undefined);
    const deadline = Date.now() + this.timings.shutdownTimeoutMs;
    while (Date.now() < deadline) {
      try {
        await client.ping();
      } catch {
        return;
      }
      await sleep(this.timings.pollIntervalMs);
    }
    throw new Error('A Syncthing instance left by an earlier run did not shut down');
  }

  private async waitForApi(instance: Instance, home: string): Promise<void> {
    const deadline = Date.now() + this.timings.readyTimeoutMs;
    for (;;) {
      this.throwIfStopping();
      if (instance.proc.hasExited()) {
        throw new Error(`Syncthing exited during startup; see ${join(home, 'syncthing.log')}`);
      }
      try {
        await instance.client.ping();
        return;
      } catch {
        // Not up yet.
      }
      if (Date.now() >= deadline) {
        throw new Error(`Syncthing's API did not answer within ${this.timings.readyTimeoutMs} ms`);
      }
      await sleep(this.timings.pollIntervalMs);
    }
  }

  private startMonitor(instance: Instance): void {
    this.stopMonitor();
    this.monitorTimer = setInterval(() => {
      if (this.stopping || instance !== this.instance || instance.childPid === null) return;
      if (!this.launcher.isAlive(instance.childPid)) {
        void this.fail(instance, `Syncthing process ${instance.childPid} is gone`);
      }
    }, this.timings.monitorIntervalMs);
    this.monitorTimer.unref?.();
  }

  private stopMonitor(): void {
    if (this.monitorTimer) clearInterval(this.monitorTimer);
    this.monitorTimer = null;
  }

  private async fail(instance: Instance, reason: string): Promise<void> {
    if (instance !== this.instance || this.stopping) return;
    this.instance = null;
    this.stopMonitor();
    if (instance.readyAt !== null && Date.now() - instance.readyAt >= this.timings.stableAfterMs) {
      this.failures = 0;
    }
    this.state = { ...this.state, running: false, error: reason };
    logger.warn({ reason }, 'Syncthing stopped; restarting');
    await this.kill(instance);
    this.scheduleRestart();
  }

  private scheduleRestart(): void {
    if (this.stopping) return;
    this.clearRestartTimer();
    const delay = Math.min(
      this.timings.restartBaseDelayMs * 2 ** this.failures,
      this.timings.restartMaxDelayMs,
    );
    this.failures += 1;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.ensureRunning();
    }, delay);
    this.restartTimer.unref?.();
  }

  private clearRestartTimer(): void {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }

  /** Kills the monitor parent and the child; killing only the parent would orphan the child. */
  private async kill(instance: Instance): Promise<void> {
    const childPid = instance.childPid ?? (await this.launcher.findChildPid(instance.proc.pid));
    if (!instance.proc.hasExited()) this.launcher.kill(instance.proc.pid);
    if (childPid !== null && childPid !== instance.proc.pid) this.launcher.kill(childPid);
  }

  private async waitGone(instance: Instance, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const childGone = instance.childPid === null || !this.launcher.isAlive(instance.childPid);
      if (instance.proc.hasExited() && childGone) return true;
      if (Date.now() >= deadline) return false;
      await sleep(this.timings.pollIntervalMs);
    }
  }

  private throwIfStopping(): void {
    if (this.stopping) throw new StopRequested();
  }
}

/** The parent environment without Syncthing's own `ST*` variables, which could redirect the instance. */
function inheritedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !/^ST[A-Z]+$/.test(key)) env[key] = value;
  }
  return env;
}

/**
 * Syncthing listens where the DevChain API does: loopback by default, the LAN
 * when this instance serves as a remote, so a home can dial it. Peers are only
 * accepted by device id, never by address.
 */
function listenHost(): string {
  const host = getEnvConfig().HOST;
  return host.includes(':') ? `[${host}]` : host;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

async function pickFreePort(exclude: number[]): Promise<number> {
  for (;;) {
    const port = await new Promise<number>((resolve, reject) => {
      const server = createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        const picked = typeof address === 'object' && address ? address.port : 0;
        server.close(() => resolve(picked));
      });
    });
    if (port > 0 && !exclude.includes(port)) return port;
  }
}
