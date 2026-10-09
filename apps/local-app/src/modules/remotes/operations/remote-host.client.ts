import { Inject, Injectable, Optional } from '@nestjs/common';
import { Readable } from 'node:stream';
import type { ReadableStream } from 'node:stream/web';
import { z } from 'zod';
import type {
  HostProviderCliSettings,
  HostProviderCliSettingsStatus,
  HostSkillSettings,
  HostSkillSettingsStatus,
  ProjectReplicaChanges,
  ProjectReplicaOfScope,
  ProjectReplicaV1,
} from '@devchain/shared';
import { getEnvConfig } from '../../../common/config/env.config';
import { ConflictError } from '../../../common/errors/error-types';
import { STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import type { FrozenProject, RemoteStorage } from '../../storage/interfaces/storage.interface';
import { DockerEngineClient, DockerEngineError } from '../../core/controllers/docker-engine.client';
import type { DockerVersion } from '../../core/controllers/docker-engine.client';
import {
  DOCKER_API_VERSION_HEADER,
  DOCKER_ARCHIVE_SHA256_TRAILER,
  DockerArchiveWriteResultSchema,
  DockerImageLoadResultSchema,
  DockerImageMatchResultSchema,
} from '../host/host-docker.dto';
import type {
  DockerArchiveRequest,
  DockerArchiveWriteResult,
  DockerBindPrepare,
  DockerCapacityResult,
  DockerContainerCreate,
  DockerHostOptions,
  DockerOwnerOptions,
  DockerImageLoadResult,
  DockerImageMatchResult,
  DockerNetworkCreate,
  DockerScanResult,
  DockerVolumeCreate,
  DockerVolumeHolder,
} from '../host/host-docker.dto';
import {
  TranscriptFilesService,
  assertTranscriptSize,
} from '../transcripts/transcript-files.service';
import { TRANSCRIPT_TIMEOUT_MS } from '../transcripts/transcript-transfer.dto';
import type {
  TranscriptFile,
  TranscriptRef,
  TranscriptListing,
} from '../transcripts/transcript-transfer.dto';
import type { RemoteSession } from './git-owner.dto';
import type { ProjectTimeSettlement } from '../time/project-time-settler.dto';
import type {
  FolderSyncStatus,
  RemoteNeed,
  SyncDevice,
  SyncFolder,
  SyncFolderConfiguration,
  SyncFolderPatch,
  SyncFolderRequest,
  SyncStatusOptions,
  ForceCopyBackupRequest,
  ForceCopyBackup,
  ReceiveOnlyChanges,
} from '../../file-sync/file-sync.dto';
import { unsupportedChown } from '../../file-sync/sync-chown.dto';
import type { SyncChownRequest, SyncChownResult } from '../../file-sync/sync-chown.dto';
import type {
  SyncInspectRequest,
  SyncPathInspection,
} from '../../file-sync/sync-path-inspection.dto';
import type {
  GitGuardRemoveResult,
  GitIndexResult,
  VmGitGuardRequest,
} from '../../file-sync/git-guard.dto';
import type { ProviderAuthClaimBundle } from '../../provider-auth/provider-auth-adapters';
import type { HostProviderApplyInput } from '../host/host-provider-auth.dto';
import { RemoteApiKeyService, remoteAuthorization } from '../auth/remote-api-key.service';
import {
  pinnedTlsOptions,
  remoteFetch,
  requireRemoteCertificate,
  requireRemoteTls,
} from '../transport/remote-tls';
import type { RemoteFetchInit } from '../transport/remote-tls';
import { discoverRuntime } from '../transport/remote-discovery';
import {
  hostRoutes,
  HostRuntimeSchema,
  CONTROL_TIMEOUT_MS,
  REPLICA_TIMEOUT_MS,
  RUNTIME_TIMEOUT_MS,
} from '../contract/host-routes';
import type {
  HostProviderVerify,
  HostRoute,
  HostRouteBody,
  HostRouteParams,
  HostRouteResult,
  HostRuntime,
  HostUpdateProgress,
} from '../contract/host-routes';
import {
  send,
  discardBody,
  invalidHostAnswer,
  RemoteHostRequestError,
} from '../transport/host-transport';
import type { HostSendOptions, HostTarget } from '../transport/host-transport';

export type { HostRuntime, HostProviderVerify } from '../contract/host-routes';
export { RemoteHostRequestError } from '../transport/host-transport';

/** The bootstrap's claim contract (`apps/host-bootstrap/README.md`). */
export interface HostClaimRequest {
  userName: string;
  homePath: string;
  /** This PC's uid; the VM takes it when free, older bootstraps drop it. */
  uid?: number;
  gid?: number;
  version: string;
  port: number;
  providerAuth: ProviderAuthClaimBundle;
}

/**
 * `claimed`: DevChain runs. `starting`: the claim is recorded but DevChain did
 * not answer yet. `already_claimed`: the VM refuses claims (possibly an
 * earlier attempt of the same claim whose answer was lost).
 */
export type HostClaimOutcome = 'claimed' | 'starting' | 'already_claimed';

/** Epic fields home sends when it creates an epic on the host. */
export type HostEpicCreate = HostRouteBody<typeof hostRoutes.createEpic>;

export type HostImportOutcome =
  | { imported: true; cursor: string }
  | { imported: false; reason: 'PROJECT_EXISTS' };

/**
 * Home's client for the `/api/host/projects` routes of a remote. Bodies carry
 * provider secrets, so neither requests nor responses are ever logged.
 */
@Injectable()
export class RemoteHostClient {
  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: RemoteStorage,
    private readonly apiKeys: RemoteApiKeyService,
    @Optional()
    @Inject('REMOTE_HOST_RUNTIME_TIMEOUT_MS')
    private readonly runtimeTimeoutMs = RUNTIME_TIMEOUT_MS,
  ) {}

  private async target(remoteId: string): Promise<HostTarget> {
    const remote = await this.storage.getRemote(remoteId);
    return {
      ...requireRemoteTls(remote),
      apiKey: await this.apiKeys.get(remoteId),
      label: `Remote "${remote.name}"`,
      remoteId,
    };
  }

  /** One request to a registered remote's host over `route`. */
  private async call<R extends HostRoute>(
    remoteId: string,
    route: R,
    params: HostRouteParams<R>,
    options?: HostSendOptions<R>,
  ): Promise<HostRouteResult<R>> {
    return send(await this.target(remoteId), route, params, options);
  }

  private async dockerClient(
    remoteId: string,
    options: DockerHostOptions,
  ): Promise<DockerEngineClient> {
    const { baseUrl, certificate, apiKey } = await this.target(remoteId);
    return DockerEngineClient.forHttp(baseUrl, pinnedTlsOptions(certificate), {
      ...remoteAuthorization(apiKey),
      ...(options.apiVersion ? { [DOCKER_API_VERSION_HEADER]: options.apiVersion } : {}),
    });
  }

  private async dockerCall<T>(
    remoteId: string,
    options: DockerHostOptions,
    action: (client: DockerEngineClient) => Promise<T>,
  ): Promise<T> {
    try {
      return await action(await this.dockerClient(remoteId, options));
    } catch (error) {
      const status = error instanceof DockerEngineError ? (error.status ?? null) : null;
      // The VM's own reason, so a refusal on either machine can be diagnosed.
      const reason = error instanceof DockerEngineError ? error.reason : undefined;
      throw new RemoteHostRequestError(
        `Docker host request failed${status ? ` (HTTP ${status})` : ''}${reason ? `: ${reason}` : ''}`,
        {
          remoteId,
          path: '/api/host/docker',
          status,
          hostCode: error instanceof DockerEngineError ? error.code : null,
        },
      );
    }
  }

  private dockerJson<T>(
    remoteId: string,
    method: string,
    path: string,
    body: unknown,
    options: DockerHostOptions,
  ): Promise<T> {
    return this.dockerCall(remoteId, options, (client) =>
      client.json<T>(method, path, body, { signal: options.signal }),
    );
  }

  dockerScan(
    remoteId: string,
    paths: string[],
    options: DockerHostOptions = {},
    volumes?: string[],
    networks?: string[],
  ): Promise<DockerScanResult> {
    return this.dockerJson(
      remoteId,
      'POST',
      '/api/host/docker/scan',
      { paths, ...(volumes && { volumes }), ...(networks && { networks }) },
      options,
    );
  }

  dockerCapacity(
    remoteId: string,
    paths: string[],
    options: DockerHostOptions = {},
  ): Promise<DockerCapacityResult> {
    return this.dockerJson(remoteId, 'POST', '/api/host/docker/capacity', { paths }, options);
  }

  dockerImagesPresent(
    remoteId: string,
    ids: string[],
    options: DockerHostOptions = {},
  ): Promise<{ ids: string[] }> {
    return this.dockerJson(remoteId, 'POST', '/api/host/docker/images/present', { ids }, options);
  }
  async dockerMatchImages(
    remoteId: string,
    refs: string[],
    options: DockerHostOptions = {},
  ): Promise<DockerImageMatchResult> {
    const path = '/api/host/docker/images/match';
    const answer = await this.dockerJson<unknown>(remoteId, 'POST', path, { refs }, options);
    return checkDockerAnswer(DockerImageMatchResultSchema, answer, remoteId, path);
  }

  dockerCreateVolume(
    remoteId: string,
    input: DockerVolumeCreate,
    options: DockerHostOptions = {},
  ): Promise<{ Name: string; Labels?: Record<string, string> }> {
    return this.dockerJson(remoteId, 'POST', '/api/host/docker/volumes', input, options);
  }
  dockerCreateNetwork(
    remoteId: string,
    input: DockerNetworkCreate,
    options: DockerHostOptions = {},
  ): Promise<{ Id: string; created: boolean }> {
    return this.dockerJson(remoteId, 'POST', '/api/host/docker/networks', input, options);
  }
  dockerCreateContainer(
    remoteId: string,
    input: DockerContainerCreate,
    options: DockerHostOptions = {},
  ): Promise<{ Id: string }> {
    return this.dockerJson(remoteId, 'POST', '/api/host/docker/containers', input, options);
  }
  dockerVolumeHolders(
    remoteId: string,
    name: string,
    options: DockerHostOptions = {},
  ): Promise<{ holders: DockerVolumeHolder[] }> {
    return this.dockerJson(
      remoteId,
      'GET',
      `/api/host/docker/volumes/${enc(name)}/holders`,
      undefined,
      options,
    );
  }
  dockerDelete(
    remoteId: string,
    kind: 'volumes' | 'containers' | 'networks',
    id: string,
    projectId: string,
    options: DockerOwnerOptions = {},
  ): Promise<void> {
    return this.dockerJson(
      remoteId,
      'DELETE',
      `/api/host/docker/${kind}/${enc(id)}?${new URLSearchParams({ projectId, ...(options.projectRoot !== undefined ? { projectRoot: options.projectRoot } : {}) })}`,
      undefined,
      options,
    );
  }
  dockerSaveImage(
    remoteId: string,
    id: string,
    options: DockerHostOptions = {},
  ): Promise<Readable> {
    return this.dockerCall(remoteId, options, (client) =>
      client.stream('GET', `/api/host/docker/images/${enc(id)}/archive`, {
        signal: options.signal,
      }),
    );
  }
  /** `sha256()` is the VM's digest of the bytes it sent, known once `archive` ended; else null. */
  async dockerReadArchive(
    remoteId: string,
    input: DockerArchiveRequest,
    options: DockerHostOptions = {},
  ): Promise<{ archive: Readable; sha256: () => string | null }> {
    let sha256: string | null = null;
    const archive = await this.dockerCall(remoteId, options, (client) =>
      client.stream('GET', `/api/host/docker/archive?${new URLSearchParams(input)}`, {
        signal: options.signal,
        onTrailers: (trailers) => {
          const value = trailers[DOCKER_ARCHIVE_SHA256_TRAILER];
          sha256 = value && /^[0-9a-f]{64}$/.test(value) ? value : null;
        },
      }),
    );
    return { archive, sha256: () => sha256 };
  }
  dockerStopContainer(
    remoteId: string,
    id: string,
    projectId: string,
    options: DockerOwnerOptions = {},
  ): Promise<void> {
    return this.dockerJson(
      remoteId,
      'POST',
      `/api/host/docker/containers/${enc(id)}/stop?${new URLSearchParams({ projectId, ...(options.projectRoot !== undefined ? { projectRoot: options.projectRoot } : {}) })}`,
      undefined,
      options,
    );
  }
  /** Resolves with the ID and RootFS layers of each image the VM engine loaded. */
  async dockerLoadImage(
    remoteId: string,
    body: Readable,
    options: DockerHostOptions = {},
  ): Promise<DockerImageLoadResult> {
    const path = '/api/host/docker/images/load';
    const answer = await this.dockerUpload(remoteId, path, 'POST', body, options);
    return parseDockerAnswer(DockerImageLoadResultSchema, answer, remoteId, path);
  }
  /** Resolves with the digest of the bytes the VM received. */
  async dockerWriteArchive(
    remoteId: string,
    input: DockerArchiveRequest,
    body: Readable,
    options: DockerHostOptions = {},
  ): Promise<DockerArchiveWriteResult> {
    const answer = await this.dockerUpload(
      remoteId,
      `/api/host/docker/archive?${new URLSearchParams(input)}`,
      'PUT',
      body,
      options,
    );
    return parseDockerAnswer(
      DockerArchiveWriteResultSchema,
      answer,
      remoteId,
      '/api/host/docker/archive',
    );
  }
  async dockerPrepareBinds(
    remoteId: string,
    input: DockerBindPrepare,
    options: DockerHostOptions = {},
  ): Promise<void> {
    await this.dockerJson(remoteId, 'POST', '/api/host/docker/binds', input, options);
  }
  dockerStopProject(
    remoteId: string,
    projectId: string,
    options: DockerHostOptions = {},
  ): Promise<{ stopped: string[] }> {
    return this.dockerJson(
      remoteId,
      'POST',
      `/api/host/docker/projects/${enc(projectId)}/stop`,
      undefined,
      options,
    );
  }
  async dockerProbe(
    remoteId: string,
    body: Readable,
    options: DockerHostOptions = {},
  ): Promise<void> {
    await this.dockerUpload(remoteId, '/api/host/docker/probe', 'POST', body, options);
  }
  /** Resolves with the (small) response text. */
  private dockerUpload(
    remoteId: string,
    path: string,
    method: string,
    body: Readable,
    options: DockerHostOptions = {},
  ): Promise<string> {
    return this.dockerCall(remoteId, options, async (client) => {
      try {
        const response = await client.stream(method, path, {
          body,
          signal: options.signal,
          headers: { 'Content-Type': 'application/x-tar' },
        });
        let text = '';
        for await (const chunk of response) {
          if (text.length < 64 * 1024) text += chunk.toString('utf8');
        }
        return text;
      } finally {
        body.destroy();
      }
    });
  }

  dockerVersion(remoteId: string, options: DockerHostOptions = {}): Promise<DockerVersion> {
    return this.dockerJson(remoteId, 'GET', '/api/host/docker/version', undefined, options);
  }

  async listTranscripts(remoteId: string, refs: TranscriptRef[]): Promise<TranscriptListing> {
    return (await this.call(remoteId, hostRoutes.listTranscripts, {}, { body: { refs } })).body;
  }

  async uploadTranscript(
    remoteId: string,
    file: TranscriptFile,
    files: TranscriptFilesService,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.transferTranscript(
      remoteId,
      file,
      signal,
      async (fetchTranscript, transferSignal) => {
        const { stream, size } = await files.read(file);
        try {
          assertTranscriptSize(size);
          const init: RemoteFetchInit = {
            method: 'PUT',
            body: stream as unknown as BodyInit,
            duplex: 'half',
            signal: transferSignal,
            headers: {
              'content-type': 'application/octet-stream',
              'content-length': String(size),
            },
          };
          const response = await fetchTranscript(init);
          try {
            if (response.status !== 204)
              throw new Error(`Transcript upload answered ${response.status}`);
          } finally {
            await discardBody(response);
          }
        } finally {
          stream.destroy();
        }
      },
    );
  }

  async downloadTranscript(
    remoteId: string,
    file: TranscriptFile,
    files: TranscriptFilesService,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.transferTranscript(
      remoteId,
      file,
      signal,
      async (fetchTranscript, transferSignal) => {
        const response = await fetchTranscript({
          signal: transferSignal,
        });
        try {
          if (response.status !== 200)
            throw new Error(`Transcript download answered ${response.status}`);
          const length = response.headers.get('content-length');
          if (length === null || !/^\d+$/.test(length) || !response.body)
            throw new Error('Transcript response requires Content-Length and a body');
          const size = Number(length);
          assertTranscriptSize(size);
          const stream = Readable.fromWeb(response.body as ReadableStream<Uint8Array>);
          try {
            await files.write(file, stream, size, transferSignal);
          } finally {
            stream.destroy();
          }
        } finally {
          await discardBody(response);
        }
      },
    );
  }

  private async transferTranscript(
    remoteId: string,
    file: TranscriptFile,
    signal: AbortSignal | undefined,
    transfer: (
      fetchTranscript: (init: RemoteFetchInit) => Promise<Response>,
      signal: AbortSignal,
    ) => Promise<void>,
  ): Promise<void> {
    const { baseUrl, certificate, apiKey } = await this.target(remoteId);
    const path = `/api/host/transcripts?${new URLSearchParams(file).toString()}`;
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(abort, TRANSCRIPT_TIMEOUT_MS);
    timer.unref?.();
    try {
      controller.signal.throwIfAborted();
      const url = `${baseUrl.replace(/\/+$/, '')}${path}`;
      await transfer(
        (init) =>
          remoteFetch(
            url,
            {
              ...init,
              headers: {
                ...remoteAuthorization(apiKey),
                ...init.headers,
              },
            },
            certificate,
          ),
        controller.signal,
      );
    } catch (error) {
      throw new RemoteHostRequestError(
        `Transcript transfer failed: ${error instanceof Error ? error.message : String(error)}`,
        { remoteId, path, status: null, hostCode: null },
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }

  async projectExists(remoteId: string, projectId: string): Promise<boolean> {
    const response = await this.call(remoteId, hostRoutes.projectExists, { projectId });
    return response.status === 200;
  }

  async importProject(remoteId: string, replica: ProjectReplicaV1): Promise<HostImportOutcome> {
    const response = await this.call(remoteId, hostRoutes.importProject, {}, { body: replica });
    if (response.status === 409) {
      const code = response.body;
      if (code !== 'PROJECT_EXISTS') {
        throw new RemoteHostRequestError('Host refused the project import.', {
          remoteId,
          path: hostRoutes.importProject.path({}),
          status: 409,
          hostCode: code,
        });
      }
      return { imported: false, reason: 'PROJECT_EXISTS' };
    }
    return { imported: true, cursor: response.body.cursor };
  }

  async exportReplica<S extends 'attach' | 'detach'>(
    remoteId: string,
    projectId: string,
    scope: S,
  ): Promise<ProjectReplicaOfScope<S>> {
    const params = { projectId, scope };
    const response = await this.call(remoteId, hostRoutes.exportReplica, params);
    const replica = response.body;
    if (replica.scope !== scope) {
      throw new RemoteHostRequestError('Host returned a replica of the wrong scope.', {
        remoteId,
        path: hostRoutes.exportReplica.path(params),
        status: response.status,
        hostCode: null,
      });
    }
    return replica as ProjectReplicaOfScope<S>;
  }

  /** Rows changed after `since` (all rows without it); `full` adds the complete ID sets. */
  async changes(
    remoteId: string,
    projectId: string,
    options: { since: string | null; full: boolean },
  ): Promise<ProjectReplicaChanges> {
    return (await this.call(remoteId, hostRoutes.changes, { projectId, ...options })).body;
  }

  /** The host's frozen answer; its `frozenAt` is the host-issued import cursor. */
  async freeze(remoteId: string, projectId: string): Promise<FrozenProject> {
    return (await this.call(remoteId, hostRoutes.freeze, { projectId })).body;
  }

  async installGitGuard(
    remoteId: string,
    projectId: string,
    request: VmGitGuardRequest,
  ): Promise<{ warning: string | null }> {
    return (await this.call(remoteId, hostRoutes.installGitGuard, { projectId }, { body: request }))
      .body;
  }

  async removeGitGuard(
    remoteId: string,
    projectId: string,
    options: { refreshIndex?: boolean } = {},
  ): Promise<GitGuardRemoveResult> {
    return (
      await this.call(
        remoteId,
        hostRoutes.removeGitGuard,
        { projectId },
        {
          ...(options.refreshIndex !== undefined && {
            body: { refreshIndex: options.refreshIndex },
          }),
          ...(options.refreshIndex && { timeoutMs: REPLICA_TIMEOUT_MS }),
        },
      )
    ).body;
  }

  async refreshGitIndex(
    remoteId: string,
    projectId: string,
    since: string | null,
  ): Promise<GitIndexResult> {
    return (
      await this.call(remoteId, hostRoutes.refreshGitIndex, { projectId }, { body: { since } })
    ).body;
  }

  async thaw(remoteId: string, projectId: string): Promise<void> {
    await this.call(remoteId, hostRoutes.thaw, { projectId });
  }

  async listSessions(
    remoteId: string,
    projectId?: string,
    options: { timeoutMs?: number } = {},
  ): Promise<RemoteSession[]> {
    return (await this.call(remoteId, hostRoutes.listSessions, { projectId }, options)).body;
  }

  async stopSessions(remoteId: string, projectId: string): Promise<void> {
    await this.call(remoteId, hostRoutes.stopSessions, { projectId });
  }

  /** Returns once the host has no open segment or team batch left for the project. */
  async settleTime(remoteId: string, projectId: string): Promise<ProjectTimeSettlement> {
    return (
      await this.call(
        remoteId,
        hostRoutes.settleTime,
        { projectId },
        {
          // The host waits up to its own settle bound before forcing the rest.
          timeoutMs: getEnvConfig().REMOTES_TIME_SETTLE_TIMEOUT_MS + CONTROL_TIMEOUT_MS,
        },
      )
    ).body;
  }

  /** Deletes the host copy; a copy that is already gone counts as released. */
  async release(remoteId: string, projectId: string): Promise<void> {
    await this.call(remoteId, hostRoutes.release, { projectId });
  }

  /** The host epic carrying `data.idempotencyKey = key`, or null when there is none. */
  async findEpicByIdempotencyKey(
    remoteId: string,
    projectId: string,
    key: string,
  ): Promise<string | null> {
    const response = await this.call(remoteId, hostRoutes.findEpicByIdempotencyKey, {
      projectId,
      key,
    });
    return response.status === 404 ? null : response.body.epicId;
  }

  /**
   * Creates the epic through the host's ordinary epic route. A 423 (the host
   * project is frozen for a handoff) is a retryable `ConflictError`.
   */
  async createEpic(remoteId: string, epic: HostEpicCreate): Promise<{ id: string }> {
    const response = await this.call(remoteId, hostRoutes.createEpic, {}, { body: epic });
    if (response.status === 423) {
      throw new ConflictError('The remote project is locked for a handoff; try again shortly.', {
        code: 'REMOTE_PROJECT_LOCKED',
        retryable: true,
        remoteId,
        projectId: epic.projectId,
        hostCode: response.body,
      });
    }
    return { id: response.body.id };
  }

  /**
   * The host's Syncthing device, with its listen address pointed at the host
   * name home already reaches the host by: the host may listen on a wildcard.
   */
  async syncDevice(remoteId: string): Promise<SyncDevice> {
    const target = await this.target(remoteId);
    const device = (await send(target, hostRoutes.syncDevice, {})).body;
    return { deviceId: device.deviceId, address: dialAddress(device.address, target.baseUrl) };
  }

  async syncPeer(remoteId: string, peer: SyncDevice): Promise<void> {
    await this.call(remoteId, hostRoutes.syncPeer, {}, { body: peer });
  }

  async syncFolders(remoteId: string, folder: SyncFolderRequest): Promise<SyncFolder> {
    return (await this.call(remoteId, hostRoutes.syncFolders, {}, { body: folder })).body;
  }

  async syncForceCopyBackup(
    remoteId: string,
    request: ForceCopyBackupRequest,
  ): Promise<ForceCopyBackup> {
    return (await this.call(remoteId, hostRoutes.syncForceCopyBackup, {}, { body: request })).body;
  }

  async syncFolderType(remoteId: string, folderId: string, patch: SyncFolderPatch): Promise<void> {
    await this.call(remoteId, hostRoutes.syncFolderType, { folderId }, { body: patch });
  }

  async syncFolderConfiguration(
    remoteId: string,
    folderId: string,
  ): Promise<SyncFolderConfiguration> {
    return (await this.call(remoteId, hostRoutes.syncFolderConfiguration, { folderId })).body;
  }

  /** Stops sharing the folder on the host; a folder the host no longer has counts as removed. */
  async syncRemoveFolder(remoteId: string, folderId: string): Promise<void> {
    await this.call(remoteId, hostRoutes.syncRemoveFolder, { folderId });
  }

  async syncScan(remoteId: string, folderId: string): Promise<void> {
    await this.call(remoteId, hostRoutes.syncScan, { folderId });
  }

  async syncRevert(remoteId: string, folderId: string): Promise<void> {
    await this.call(remoteId, hostRoutes.syncRevert, { folderId });
  }

  async syncOverride(remoteId: string, folderId: string): Promise<void> {
    await this.call(remoteId, hostRoutes.syncOverride, { folderId });
  }

  async syncLocalChanges(remoteId: string, folderId: string): Promise<ReceiveOnlyChanges> {
    return (await this.call(remoteId, hostRoutes.syncLocalChanges, { folderId })).body;
  }

  /** With `deviceId`, includes the host's view of that device's copy. */
  async syncStatus(
    remoteId: string,
    folderId: string,
    deviceId?: string,
    options: SyncStatusOptions = {},
  ): Promise<FolderSyncStatus> {
    return (
      await this.call(remoteId, hostRoutes.syncStatus, {
        folderId,
        deviceId,
        allErrors: options.allErrors,
      })
    ).body;
  }

  async syncFolderExists(remoteId: string, folderId: string): Promise<boolean> {
    const response = await this.call(remoteId, hostRoutes.syncFolderExists, { folderId });
    return response.status === 200;
  }

  async syncRemoteNeed(remoteId: string, folderId: string, deviceId: string): Promise<RemoteNeed> {
    return (await this.call(remoteId, hostRoutes.syncRemoteNeed, { folderId, deviceId })).body;
  }

  async syncInspect(remoteId: string, input: SyncInspectRequest): Promise<SyncPathInspection> {
    return (await this.call(remoteId, hostRoutes.syncInspect, {}, { body: input })).body;
  }

  async syncChown(remoteId: string, input: SyncChownRequest): Promise<SyncChownResult> {
    const response = await this.call(remoteId, hostRoutes.syncChown, {}, { body: input });
    return response.status === 404 ? unsupportedChown(null, input.items) : response.body;
  }

  /** Sets the host's tunnel-attestation label; keeps the phone's instance name in sync. */
  async setInstanceLabel(remoteId: string, label: string): Promise<void> {
    await this.call(remoteId, hostRoutes.setInstanceLabel, {}, { body: { label } });
  }

  /** `/api/runtime` of a registered remote. */
  async remoteRuntime(remoteId: string): Promise<HostRuntime> {
    const { baseUrl, certificate } = requireRemoteTls(await this.storage.getRemote(remoteId));
    return this.runtimeAt(baseUrl, certificate);
  }

  /**
   * The certificate calls to this remote's VM are pinned to. The bootstrap
   * and DevChain on the VM serve the same one.
   */
  async certificateOf(remoteId: string): Promise<string> {
    return requireRemoteCertificate(await this.storage.getRemote(remoteId));
  }

  /**
   * `/api/runtime` at an address that may not be a registered remote's
   * address yet (an unclaimed VM's bootstrap), pinned to `certificate`.
   */
  async runtimeAt(baseUrl: string, certificate: string): Promise<HostRuntime> {
    return (
      await send(
        { baseUrl, certificate, apiKey: null, label: baseUrl },
        hostRoutes.runtimeAt,
        {},
        {
          timeoutMs: this.runtimeTimeoutMs,
        },
      )
    ).body;
  }

  /**
   * Unpinned `/api/runtime` at an address nothing is known about yet. The
   * answer and the certificate only select the next setup step; neither is
   * trusted, and the call carries no key and no body.
   */
  async discoverRuntime(
    origin: string,
  ): Promise<{ runtime: HostRuntime | null; certificate: string }> {
    const answer = await discoverRuntime(origin, this.runtimeTimeoutMs);
    const parsed = HostRuntimeSchema.safeParse(answer.body);
    return {
      runtime: answer.status === 200 && parsed.success ? parsed.data : null,
      certificate: answer.certificate,
    };
  }

  /**
   * Sends a claim to the bootstrap of an unclaimed VM. The bootstrap answers
   * once DevChain runs, which includes installing it, hence the long timeout.
   * The body carries provider credentials.
   */
  async claim(
    bootstrapUrl: string,
    certificate: string,
    body: HostClaimRequest,
    apiKey?: string,
  ): Promise<HostClaimOutcome> {
    const response = await send(
      { baseUrl: bootstrapUrl, certificate, apiKey: apiKey ?? null, label: bootstrapUrl },
      hostRoutes.claim,
      {},
      { body },
    );
    if (response.status === 200) return 'claimed';
    const code = response.body;
    if (response.status === 504) return 'starting';
    if (code === 'ALREADY_CLAIMED') return 'already_claimed';
    throw new RemoteHostRequestError(`The VM refused the claim${code ? ` (${code})` : ''}.`, {
      remoteId: bootstrapUrl,
      path: hostRoutes.claim.path({}),
      status: response.status,
      hostCode: code,
    });
  }

  async verifyProviderAuth(
    remoteId: string,
    provider: string,
    opencodeProviderIds: string[],
  ): Promise<HostProviderVerify> {
    return (
      await this.call(
        remoteId,
        hostRoutes.verifyProviderAuth,
        {},
        { body: { provider, opencodeProviderIds } },
      )
    ).body;
  }

  /** Writes provider login material on a claimed host. The body carries credentials. */
  async applyProviderAuth(remoteId: string, bundle: HostProviderApplyInput): Promise<void> {
    await this.call(remoteId, hostRoutes.applyProviderAuth, {}, { body: bundle });
  }

  async applySshKeys(remoteId: string, keys: string[]): Promise<void> {
    await this.call(remoteId, hostRoutes.applySshKeys, {}, { body: { keys } });
  }

  /** Starts the host's version install; answers once the install runs outside DevChain. */
  async requestHostUpdate(remoteId: string, version: string): Promise<'started' | 'in_progress'> {
    const response = await this.call(
      remoteId,
      hostRoutes.requestHostUpdate,
      {},
      { body: { version } },
    );
    if (response.status === 202) return 'started';
    const code = response.body;
    if (code === 'UPDATE_IN_PROGRESS') return 'in_progress';
    throw new RemoteHostRequestError(`The host refused the update${code ? ` (${code})` : ''}.`, {
      remoteId,
      path: hostRoutes.requestHostUpdate.path({}),
      status: 409,
      hostCode: code,
    });
  }

  async hostUpdateStatus(remoteId: string): Promise<HostUpdateProgress | null> {
    return (await this.call(remoteId, hostRoutes.hostUpdateStatus, {})).body.status;
  }

  async requestDocker(remoteId: string): Promise<{ jobId: string | null }> {
    return (await this.call(remoteId, hostRoutes.requestDocker, {}, { body: {} })).body;
  }

  async dockerStatus(remoteId: string) {
    return (await this.call(remoteId, hostRoutes.dockerStatus, {})).body.status;
  }

  async getProviderCliSettingsStatus(remoteId: string): Promise<HostProviderCliSettingsStatus> {
    return (await this.call(remoteId, hostRoutes.getProviderCliSettingsStatus, {})).body;
  }

  async putProviderCliSettings(remoteId: string, body: HostProviderCliSettings): Promise<void> {
    const route = hostRoutes.putProviderCliSettings;
    const response = await this.call(remoteId, route, {}, { body });
    checkSettingsRevision(remoteId, route.path({}), response, body.revision);
  }

  async checkProviderClis(remoteId: string): Promise<void> {
    await this.call(remoteId, hostRoutes.checkProviderClis, {});
  }

  async getSkillSettingsStatus(remoteId: string): Promise<HostSkillSettingsStatus> {
    return (await this.call(remoteId, hostRoutes.getSkillSettingsStatus, {})).body;
  }

  async putSkillSettings(remoteId: string, body: HostSkillSettings): Promise<void> {
    const route = hostRoutes.putSkillSettings;
    const response = await this.call(remoteId, route, {}, { body });
    checkSettingsRevision(remoteId, route.path({}), response, body.revision);
  }

  async uploadSkillSourceContent(
    remoteId: string,
    name: string,
    contentHash: string,
    stream: Readable,
    signal?: AbortSignal,
  ): Promise<void> {
    const params = { name, contentHash };
    try {
      const response = await this.call(remoteId, hostRoutes.uploadSkillSourceContent, params, {
        body: stream,
        signal,
      });
      if (response.body.name !== name || response.body.contentHash !== contentHash) {
        throw invalidHostAnswer(
          remoteId,
          hostRoutes.uploadSkillSourceContent.path(params),
          response.status,
        );
      }
    } finally {
      stream.destroy();
    }
  }
}

/** A settings route answers with the revision the host stored; any other revision is an invalid answer. */
function checkSettingsRevision(
  remoteId: string,
  path: string,
  response: { status: number; body: { revision: string } },
  expected: string,
): void {
  if (response.body.revision !== expected) {
    throw invalidHostAnswer(remoteId, path, response.status);
  }
}

/** A Docker upload's JSON answer, checked by `schema`; anything else is an invalid host response. */
function parseDockerAnswer<T>(
  schema: z.ZodType<T>,
  answer: string,
  remoteId: string,
  path: string,
): T {
  let value: unknown = null;
  try {
    value = JSON.parse(answer);
  } catch {
    // Not JSON: the schema refuses the null below.
  }
  return checkDockerAnswer(schema, value, remoteId, path);
}

/** A Docker answer, checked by `schema`; anything else is an invalid host response. */
function checkDockerAnswer<T>(
  schema: z.ZodType<T>,
  value: unknown,
  remoteId: string,
  path: string,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new RemoteHostRequestError('Docker host request failed', {
      remoteId,
      path,
      status: null,
      hostCode: 'invalid-response',
    });
  return parsed.data;
}

/** `address` with its host replaced by the host name in `baseUrl`; `dynamic` stays as is. */
export function dialAddress(address: string, baseUrl: string): string {
  const match = /^(tcp|quic):\/\/.*:(\d+)$/.exec(address);
  if (!match) return address;
  return `${match[1]}://${new URL(baseUrl).hostname}:${match[2]}`;
}

function enc(value: string): string {
  return encodeURIComponent(value);
}
