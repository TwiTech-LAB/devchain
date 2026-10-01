import { Inject, Injectable, Optional } from '@nestjs/common';
import { connect } from 'node:net';
import { getAppVersion } from '../../../common/app-version';
import { getEnvConfig } from '../../../common/config/env.config';
import { ValidationError } from '../../../common/errors/error-types';
import { readDockerRuntime, type DockerRuntime } from '../../core/controllers/docker-runtime';
import { FileSyncUnavailableError } from '../../file-sync/file-sync.service';
import { SyncthingManager } from '../../file-sync/syncthing-manager.service';
import { STORAGE_SERVICE, type RemoteStorage } from '../../storage/interfaces/storage.interface';
import { BASE_URL_MESSAGE, normalizeRemoteBaseUrl } from '../dtos/remote.dto';
import type {
  ProbeAddressData,
  ProbeResultDto,
  RemoteReadinessDto,
} from '../dtos/remote-probe.dto';
import { assertClaimableIdentity, homeIdentity, matchesHomePath } from '../home-identity';
import { isSupportedHostImage } from '../host-image';
import { HOST_INSTALL_BOOTSTRAP_PORT } from '../host-install/host-install-block';
import { FileSyncHandoff } from '../operations/file-sync-handoff';
import { RemoteHostClient, type HostRuntime } from '../operations/remote-host.client';

/** Ports and timing of the probe; tests move them off the well-known ports. */
export interface RemoteProbeOptions {
  /** The installer's port, pinned by its systemd unit. */
  installerPort: number;
  sshPort: number;
  sshTimeoutMs: number;
}

export const REMOTE_PROBE_OPTIONS = Symbol('RemoteProbeOptions');

const DEFAULT_OPTIONS: RemoteProbeOptions = {
  installerPort: HOST_INSTALL_BOOTSTRAP_PORT,
  sshPort: 22,
  sshTimeoutMs: 2_000,
};

/** A port written in the address, including a scheme's default one. */
const EXPLICIT_PORT = /^[a-z][a-z0-9+.-]*:\/\/(?:\[[^\]]*\]|[^/?#:@]*):\d+(?:[/?#]|$)/i;

/** Whether `port` on `host` accepts a TCP connection within `timeoutMs`. */
function tcpReachable(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const finish = (reachable: boolean) => {
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

function dockerMessage(docker: DockerRuntime): string | null {
  if (docker.installed) return null;
  if (!docker.engineVersion) return 'Docker Engine is not installed on this PC.';
  if (!docker.composeVersion) return 'Docker Compose is not installed on this PC.';
  return docker.userInGroup
    ? 'Docker does not answer on this PC. Start the Docker service.'
    : "Docker does not answer. Add this PC's user to the docker group, then sign in again.";
}

/**
 * What runs at an address before anything is set up there, and whether this
 * PC can set up a VM at all. Both only read: no remote and no operation.
 */
@Injectable()
export class RemoteProbeService {
  private readonly options: RemoteProbeOptions;

  constructor(
    // Read-only: the probe looks up existing registrations and never writes.
    @Inject(STORAGE_SERVICE) private readonly storage: RemoteStorage,
    private readonly hostClient: RemoteHostClient,
    private readonly fileSync: FileSyncHandoff,
    private readonly syncthing: SyncthingManager,
    @Optional() @Inject(REMOTE_PROBE_OPTIONS) options?: Partial<RemoteProbeOptions>,
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Probes the port in the address, or else the installer's port and this
   * PC's port, all in parallel with the SSH check. The answer's body decides
   * the kind, never the port: a set-up VM runs DevChain where its installer was.
   */
  async probe(input: ProbeAddressData): Promise<ProbeResultDto> {
    const written = /^[a-z][a-z0-9+.-]*:\/\//i.test(input.address)
      ? input.address
      : `https://${input.address}`;
    const origin = normalizeRemoteBaseUrl(written);
    if (origin === null) {
      throw new ValidationError(BASE_URL_MESSAGE, { reason: 'base_url_invalid' });
    }
    const homePort = getEnvConfig().PORT;
    const candidates = EXPLICIT_PORT.test(written)
      ? [origin]
      : [...new Set([homePort, this.options.installerPort])].map((port) => {
          const url = new URL(origin);
          url.port = String(port);
          return url.origin;
        });
    const hostname = new URL(origin).hostname.replace(/^\[(.*)\]$/, '$1');

    const [answers, sshReachable, remotes] = await Promise.all([
      Promise.all(
        candidates.map((candidate) =>
          // Discovery: nothing is trusted at this point, so no key and no body go out.
          this.hostClient.discoverRuntime(candidate).then(
            (answer): HostRuntime | null => answer.runtime,
            () => null,
          ),
        ),
      ),
      input.checkSsh
        ? tcpReachable(hostname, this.options.sshPort, this.options.sshTimeoutMs)
        : Promise.resolve(null),
      this.storage.listRemotes({ limit: 500 }),
    ]);
    const remoteAt = (baseUrl: string) =>
      remotes.items.find((remote) => remote.baseUrl === baseUrl)?.id ?? null;

    const devchain = answers.findIndex(
      (runtime) => typeof runtime?.state !== 'string' && typeof runtime?.version === 'string',
    );
    if (devchain >= 0) {
      const runtime = answers[devchain]!;
      const homePath = typeof runtime.homePath === 'string' ? runtime.homePath : null;
      return {
        kind: 'devchain',
        baseUrl: candidates[devchain],
        version: runtime.version ?? null,
        versionMatches: runtime.version === getAppVersion(),
        homePath,
        homePathMatches: matchesHomePath(homePath),
        remoteId: remoteAt(candidates[devchain]),
      };
    }

    const installer = answers.findIndex((runtime) => typeof runtime?.state === 'string');
    if (installer >= 0) {
      const runtime = answers[installer]!;
      const imageVersion = typeof runtime.imageVersion === 'string' ? runtime.imageVersion : null;
      // The claim registers DevChain at the installer's host with this PC's port.
      const future = new URL(candidates[installer]);
      future.port = String(homePort);
      return {
        kind: 'installer',
        bootstrapUrl: candidates[installer],
        state: runtime.state!,
        imageVersion,
        supported: isSupportedHostImage(imageVersion),
        remoteId: remoteAt(future.origin),
      };
    }

    return { kind: 'nothing', tried: candidates, sshReachable };
  }

  /**
   * Whether this PC can set up a VM: Syncthing runs (an installed but stopped
   * one is started, as Connect does), the identity passes the claim rules, and
   * Docker is usable.
   */
  async readiness(): Promise<RemoteReadinessDto> {
    const [syncthing, docker] = await Promise.all([this.syncthingReadiness(), readDockerRuntime()]);
    return {
      syncthing,
      identity: this.identityReadiness(),
      docker: { ok: docker.installed, message: dockerMessage(docker) },
    };
  }

  private async syncthingReadiness(): Promise<RemoteReadinessDto['syncthing']> {
    let message: string | null = null;
    try {
      await this.fileSync.ensureAvailable();
    } catch (error) {
      if (!(error instanceof FileSyncUnavailableError)) throw error;
      message = error.message;
    }
    return { ok: message === null, version: this.syncthing.getState().version, message };
  }

  private identityReadiness(): RemoteReadinessDto['identity'] {
    const { user, homePath } = homeIdentity();
    try {
      assertClaimableIdentity();
      return { ok: true, user, homePath, message: null };
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      return { ok: false, user, homePath, message: error.message };
    }
  }
}
