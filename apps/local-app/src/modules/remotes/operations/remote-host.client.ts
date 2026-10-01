import { RemoteApiKeyService, remoteAuthorization } from '../auth/remote-api-key.service';
import {
  HostProviderCliSettingsStatusSchema,
  type HostProviderCliSettings,
  type HostProviderCliSettingsStatus,
} from '@devchain/shared';
import { Readable } from 'node:stream';
import {
  DockerEngineClient,
  DockerEngineError,
  DockerVersion,
} from '../../core/controllers/docker-engine.client';
import {
  DOCKER_API_VERSION_HEADER,
  DOCKER_ARCHIVE_SHA256_TRAILER,
  DockerArchiveWriteResultSchema,
  type DockerArchiveRequest,
  type DockerArchiveWriteResult,
  type DockerBindPrepare,
  type DockerCapacityResult,
  type DockerContainerCreate,
  type DockerHostOptions,
  type DockerNetworkCreate,
  type DockerScanResult,
  type DockerVolumeCreate,
  type DockerVolumeHolder,
} from '../host/host-docker.dto';
import type { ReadableStream } from 'node:stream/web';
import {
  TranscriptFilesService,
  assertTranscriptSize,
} from '../transcripts/transcript-files.service';
import {
  TranscriptListingSchema,
  TRANSCRIPT_TIMEOUT_MS,
  type TranscriptFile,
  type TranscriptRef,
  type TranscriptListing,
} from '../transcripts/transcript-transfer.dto';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import {
  HostSkillSettingsStatusSchema,
  type HostSkillSettings,
  type HostSkillSettingsStatus,
  PROJECT_REPLICA_CONTENT_TYPE,
  ProjectReplicaChangesSchema,
  ProjectReplicaImportResultSchema,
  ProjectReplicaV1Schema,
  type ProjectReplicaChanges,
  type ProjectReplicaOfScope,
  type ProjectReplicaV1,
} from '@devchain/shared';
import { getEnvConfig } from '../../../common/config/env.config';
import { AppError, ConflictError } from '../../../common/errors/error-types';
import {
  STORAGE_SERVICE,
  type FrozenProject,
  type RemoteStorage,
} from '../../storage/interfaces/storage.interface';
import {
  ProjectTimeSettlementSchema,
  type ProjectTimeSettlement,
} from '../time/project-time-settler.service';
import {
  FolderSyncStatusSchema,
  SyncDeviceSchema,
  SyncFolderSchema,
  type FolderSyncStatus,
  type SyncDevice,
  type SyncFolder,
  type SyncFolderPatch,
  type SyncFolderRequest,
} from '../../file-sync/file-sync.dto';
import { SCAN_TIMEOUT_MS } from '../../file-sync/file-sync.service';
import type { ProviderAuthClaimBundle } from '../../provider-auth/provider-auth-adapters';
import type { HostProviderApplyInput } from '../host/host-provider-auth.service';
import { DockerRuntimeSchema } from '../../core/controllers/docker-runtime';
import {
  HOST_HELPER_MIGRATION,
  HostDockerStatusSchema,
  HostUpdateStatusSchema,
} from '../host/host-helper.service';
import { requireRemoteAddress } from '../remote-address';
import {
  pinnedTlsOptions,
  remoteFetch,
  type RemoteFetchInit,
  requireRemoteCertificate,
  requireRemoteTls,
} from '../transport/remote-tls';
import { discoverRuntime } from '../transport/remote-discovery';

const CONTROL_TIMEOUT_MS = 15_000;
const REPLICA_TIMEOUT_MS = 120_000;
const RUNTIME_TIMEOUT_MS = 5_000;
/**
 * The bootstrap installs DevChain and the provider CLIs before it answers.
 * Node's fetch still drops the request after 300 s without response headers;
 * the claim step then watches the bootstrap's `/api/runtime` instead.
 */
const CLAIM_TIMEOUT_MS = 45 * 60_000;
/** The host allows each check 90 s. */
const VERIFY_TIMEOUT_MS = 100_000;

const HostRuntimeSchema = z
  .object({
    state: z.string().optional(),
    bootId: z.string().optional(),
    docker: DockerRuntimeSchema.optional(),
    version: z.string().nullable().optional(),
    /** The running process's home folder; absent on older builds and bootstraps. */
    homePath: z.string().nullable().optional(),
    /** The running process's real account ids; absent on older builds. */
    uid: z.number().nullable().optional(),
    gid: z.number().nullable().optional(),
    imageVersion: z.string().nullable().optional(),
    cliVersions: z.record(z.string()).nullable().optional(),
  })
  .passthrough();
export type HostRuntime = z.infer<typeof HostRuntimeSchema>;

const HostProviderVerifySchema = z.object({
  ok: z.boolean(),
  summary: z.string(),
  hint: z.string().nullable(),
});
export type HostProviderVerify = z.infer<typeof HostProviderVerifySchema>;

const HostUpdateStatusBodySchema = z.object({
  status: HostUpdateStatusSchema.omit({ at: true }).passthrough().nullable(),
});
export type HostUpdateProgress = NonNullable<z.infer<typeof HostUpdateStatusBodySchema>['status']>;

/** The bootstrap's claim contract (`apps/host-bootstrap/README.md`). */
export interface HostClaimRequest {
  userName: string;
  homePath: string;
  /** This PC's uid; the VM takes it when free, older bootstraps drop it. */
  uid?: number;
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

const FrozenProjectSchema = z.object({
  projectId: z.string(),
  frozenAt: z.string(),
});

const EpicIdSchema = z.object({ epicId: z.string().min(1) });
const CreatedEpicSchema = z.object({ id: z.string().min(1) });

/** Epic fields home sends when it creates an epic on the host. */
export interface HostEpicCreate {
  projectId: string;
  statusId: string;
  title: string;
  description: string | null;
  data: Record<string, unknown> | null;
}

/** A host request failed: unreachable, timed out, or answered with an unexpected status. */
export class RemoteHostRequestError extends AppError {
  constructor(
    message: string,
    details: { remoteId: string; path: string; status: number | null; hostCode: string | null },
  ) {
    super(message, 'REMOTE_HOST_REQUEST_FAILED', 502, details);
  }

  get status(): number | null {
    return (this.details?.status as number | null | undefined) ?? null;
  }
}

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
  ) {}

  private async dockerClient(
    remoteId: string,
    options: DockerHostOptions,
  ): Promise<DockerEngineClient> {
    const remote = await this.storage.getRemote(remoteId);
    const { baseUrl, certificate } = requireRemoteTls(remote);
    return DockerEngineClient.forHttp(baseUrl, pinnedTlsOptions(certificate), {
      ...(await this.apiKeys.headers(remoteId)),
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
      throw new RemoteHostRequestError('Docker host request failed', {
        remoteId,
        path: '/api/host/docker',
        status: error instanceof DockerEngineError ? (error.status ?? null) : null,
        hostCode: error instanceof DockerEngineError ? error.code : null,
      });
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
  ): Promise<DockerScanResult> {
    return this.dockerJson(
      remoteId,
      'POST',
      '/api/host/docker/scan',
      { paths, ...(volumes && { volumes }) },
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
    options: DockerHostOptions = {},
  ): Promise<void> {
    return this.dockerJson(
      remoteId,
      'DELETE',
      `/api/host/docker/${kind}/${enc(id)}?${new URLSearchParams({ projectId })}`,
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
    options: DockerHostOptions = {},
  ): Promise<void> {
    return this.dockerJson(
      remoteId,
      'POST',
      `/api/host/docker/containers/${enc(id)}/stop?${new URLSearchParams({ projectId })}`,
      undefined,
      options,
    );
  }
  async dockerLoadImage(
    remoteId: string,
    body: Readable,
    options: DockerHostOptions = {},
  ): Promise<void> {
    await this.dockerUpload(remoteId, '/api/host/docker/images/load', 'POST', body, options);
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
    const parsed = DockerArchiveWriteResultSchema.safeParse(
      (() => {
        try {
          return JSON.parse(answer);
        } catch {
          return null;
        }
      })(),
    );
    if (!parsed.success)
      throw new RemoteHostRequestError('Docker host request failed', {
        remoteId,
        path: '/api/host/docker/archive',
        status: null,
        hostCode: 'invalid-response',
      });
    return parsed.data;
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
    const response = await this.request(remoteId, '/api/host/transcripts/list', {
      method: 'POST',
      body: JSON.stringify({ refs }),
      expect: [200],
    });
    return parseBody(TranscriptListingSchema, response, remoteId, '/api/host/transcripts/list');
  }

  async uploadTranscript(
    remoteId: string,
    file: TranscriptFile,
    files: TranscriptFilesService,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.transferTranscript(remoteId, file, signal, async (send, transferSignal) => {
      const { stream, size } = await files.read(file);
      try {
        assertTranscriptSize(size);
        const init: RemoteFetchInit = {
          method: 'PUT',
          body: stream as unknown as BodyInit,
          duplex: 'half',
          signal: transferSignal,
          headers: {
            ...(await this.apiKeys.headers(remoteId)),
            'content-type': 'application/octet-stream',
            'content-length': String(size),
          },
        };
        const response = await send(init);
        try {
          if (response.status !== 204)
            throw new Error(`Transcript upload answered ${response.status}`);
        } finally {
          await discardBody(response);
        }
      } finally {
        stream.destroy();
      }
    });
  }

  async downloadTranscript(
    remoteId: string,
    file: TranscriptFile,
    files: TranscriptFilesService,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.transferTranscript(remoteId, file, signal, async (send, transferSignal) => {
      const response = await send({
        signal: transferSignal,
        headers: await this.apiKeys.headers(remoteId),
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
    });
  }

  private async transferTranscript(
    remoteId: string,
    file: TranscriptFile,
    signal: AbortSignal | undefined,
    transfer: (
      send: (init: RemoteFetchInit) => Promise<Response>,
      signal: AbortSignal,
    ) => Promise<void>,
  ): Promise<void> {
    const { baseUrl, certificate } = requireRemoteTls(await this.storage.getRemote(remoteId));
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
      await transfer((init) => remoteFetch(url, init, certificate), controller.signal);
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
    const response = await this.request(remoteId, `/api/projects/${enc(projectId)}`, {
      method: 'GET',
      expect: [200, 404],
    });
    await discardBody(response);
    return response.status === 200;
  }

  async importProject(remoteId: string, replica: ProjectReplicaV1): Promise<HostImportOutcome> {
    const response = await this.request(remoteId, '/api/host/projects/import', {
      method: 'POST',
      body: JSON.stringify(replica),
      contentType: PROJECT_REPLICA_CONTENT_TYPE,
      timeoutMs: REPLICA_TIMEOUT_MS,
      expect: [201, 409],
    });
    if (response.status === 409) {
      const code = await readErrorCode(response);
      if (code !== 'PROJECT_EXISTS') {
        throw new RemoteHostRequestError('Host refused the project import.', {
          remoteId,
          path: '/api/host/projects/import',
          status: 409,
          hostCode: code,
        });
      }
      return { imported: false, reason: 'PROJECT_EXISTS' };
    }
    const result = ProjectReplicaImportResultSchema.parse(await response.json());
    return { imported: true, cursor: result.cursor };
  }

  async exportReplica<S extends 'attach' | 'detach'>(
    remoteId: string,
    projectId: string,
    scope: S,
  ): Promise<ProjectReplicaOfScope<S>> {
    const path = `/api/host/projects/${enc(projectId)}/replica?scope=${scope}`;
    const response = await this.request(remoteId, path, {
      method: 'GET',
      timeoutMs: REPLICA_TIMEOUT_MS,
      expect: [200],
    });
    const replica = ProjectReplicaV1Schema.parse(await response.json());
    if (replica.scope !== scope) {
      throw new RemoteHostRequestError('Host returned a replica of the wrong scope.', {
        remoteId,
        path,
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
    const query = new URLSearchParams();
    if (options.since) query.set('since', options.since);
    if (options.full) query.set('full', 'true');
    const queryString = query.toString();
    const suffix = queryString ? `?${queryString}` : '';
    const response = await this.request(
      remoteId,
      `/api/host/projects/${enc(projectId)}/changes${suffix}`,
      { method: 'GET', timeoutMs: REPLICA_TIMEOUT_MS, expect: [200] },
    );
    return ProjectReplicaChangesSchema.parse(await response.json());
  }

  /** The host's frozen answer; its `frozenAt` is the host-issued import cursor. */
  async freeze(remoteId: string, projectId: string): Promise<FrozenProject> {
    const path = `/api/host/projects/${enc(projectId)}/freeze`;
    const response = await this.request(remoteId, path, {
      method: 'POST',
      expect: [200],
    });
    const body = await response.json().catch(() => null);
    const parsed = FrozenProjectSchema.safeParse(body);
    if (!parsed.success) {
      throw new RemoteHostRequestError('Host returned an invalid freeze answer.', {
        remoteId,
        path,
        status: response.status,
        hostCode: null,
      });
    }
    return parsed.data;
  }

  async thaw(remoteId: string, projectId: string): Promise<void> {
    const response = await this.request(remoteId, `/api/host/projects/${enc(projectId)}/thaw`, {
      method: 'POST',
      expect: [204],
    });
    await discardBody(response);
  }

  async stopSessions(remoteId: string, projectId: string): Promise<void> {
    const response = await this.request(
      remoteId,
      `/api/host/projects/${enc(projectId)}/stop-sessions`,
      { method: 'POST', expect: [204] },
    );
    await discardBody(response);
  }

  /** Returns once the host has no open segment or team batch left for the project. */
  async settleTime(remoteId: string, projectId: string): Promise<ProjectTimeSettlement> {
    const response = await this.request(
      remoteId,
      `/api/host/projects/${enc(projectId)}/settle-time`,
      {
        method: 'POST',
        // The host waits up to its own settle bound before forcing the rest.
        timeoutMs: getEnvConfig().REMOTES_TIME_SETTLE_TIMEOUT_MS + CONTROL_TIMEOUT_MS,
        expect: [200],
      },
    );
    return ProjectTimeSettlementSchema.parse(await response.json());
  }

  /** Deletes the host copy; a copy that is already gone counts as released. */
  async release(remoteId: string, projectId: string): Promise<void> {
    const response = await this.request(remoteId, `/api/host/projects/${enc(projectId)}/release`, {
      method: 'POST',
      expect: [204, 404],
    });
    await discardBody(response);
  }

  /** The host epic carrying `data.idempotencyKey = key`, or null when there is none. */
  async findEpicByIdempotencyKey(
    remoteId: string,
    projectId: string,
    key: string,
  ): Promise<string | null> {
    const path = `/api/host/projects/${enc(projectId)}/epics/by-idempotency-key/${enc(key)}`;
    const response = await this.request(remoteId, path, { method: 'GET', expect: [200, 404] });
    if (response.status === 404) {
      await discardBody(response);
      return null;
    }
    return (await parseBody(EpicIdSchema, response, remoteId, path)).epicId;
  }

  /**
   * Creates the epic through the host's ordinary epic route. A 423 (the host
   * project is frozen for a handoff) is a retryable `ConflictError`.
   */
  async createEpic(remoteId: string, epic: HostEpicCreate): Promise<{ id: string }> {
    const path = '/api/epics';
    const response = await this.request(remoteId, path, {
      method: 'POST',
      body: JSON.stringify(epic),
      expect: [201, 423],
    });
    if (response.status === 423) {
      const hostCode = await readErrorCode(response);
      throw new ConflictError('The remote project is locked for a handoff; try again shortly.', {
        code: 'REMOTE_PROJECT_LOCKED',
        retryable: true,
        remoteId,
        projectId: epic.projectId,
        hostCode,
      });
    }
    return { id: (await parseBody(CreatedEpicSchema, response, remoteId, path)).id };
  }

  /**
   * The host's Syncthing device, with its listen address pointed at the host
   * name home already reaches the host by: the host may listen on a wildcard.
   */
  async syncDevice(remoteId: string): Promise<SyncDevice> {
    const remote = await this.storage.getRemote(remoteId);
    const path = '/api/host/sync/device';
    const response = await this.request(remoteId, path, { method: 'GET', expect: [200] });
    const device = await parseBody(SyncDeviceSchema, response, remoteId, path);
    return {
      deviceId: device.deviceId,
      address: dialAddress(device.address, requireRemoteAddress(remote)),
    };
  }

  async syncPeer(remoteId: string, peer: SyncDevice): Promise<void> {
    const response = await this.request(remoteId, '/api/host/sync/peer', {
      method: 'POST',
      body: JSON.stringify(peer),
      expect: [204],
    });
    await discardBody(response);
  }

  async syncFolders(remoteId: string, folder: SyncFolderRequest): Promise<SyncFolder> {
    const path = '/api/host/sync/folders';
    const response = await this.request(remoteId, path, {
      method: 'POST',
      body: JSON.stringify(folder),
      expect: [200],
    });
    return parseBody(SyncFolderSchema, response, remoteId, path);
  }

  async syncFolderType(remoteId: string, folderId: string, patch: SyncFolderPatch): Promise<void> {
    const response = await this.request(remoteId, `/api/host/sync/folders/${enc(folderId)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
      expect: [204],
    });
    await discardBody(response);
  }

  /** Stops sharing the folder on the host; a folder the host no longer has counts as removed. */
  async syncRemoveFolder(remoteId: string, folderId: string): Promise<void> {
    const response = await this.request(remoteId, `/api/host/sync/folders/${enc(folderId)}`, {
      method: 'DELETE',
      expect: [204],
    });
    await discardBody(response);
  }

  async syncScan(remoteId: string, folderId: string): Promise<void> {
    // The host answers when its own Syncthing scan ends (SCAN_TIMEOUT_MS).
    const response = await this.request(remoteId, `/api/host/sync/folders/${enc(folderId)}/scan`, {
      method: 'POST',
      expect: [204],
      timeoutMs: SCAN_TIMEOUT_MS + CONTROL_TIMEOUT_MS,
    });
    await discardBody(response);
  }

  async syncRevert(remoteId: string, folderId: string): Promise<void> {
    const response = await this.request(
      remoteId,
      `/api/host/sync/folders/${enc(folderId)}/revert`,
      { method: 'POST', expect: [204] },
    );
    await discardBody(response);
  }

  /** With `deviceId`, includes the host's view of that device's copy. */
  async syncStatus(
    remoteId: string,
    folderId: string,
    deviceId?: string,
  ): Promise<FolderSyncStatus> {
    const query = new URLSearchParams({ folder: folderId });
    if (deviceId) query.set('device', deviceId);
    const path = `/api/host/sync/status?${query.toString()}`;
    const response = await this.request(remoteId, path, { method: 'GET', expect: [200] });
    return parseBody(FolderSyncStatusSchema, response, remoteId, path);
  }

  /** Sets the host's tunnel-attestation label; keeps the phone's instance name in sync. */
  async setInstanceLabel(remoteId: string, label: string): Promise<void> {
    const response = await this.request(remoteId, '/api/cloud/instance-label', {
      method: 'PUT',
      body: JSON.stringify({ label }),
      expect: [200],
    });
    await discardBody(response);
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
    const response = await this.fetchUrl(baseUrl, '/api/runtime', {
      method: 'GET',
      expect: [200],
      timeoutMs: RUNTIME_TIMEOUT_MS,
      label: baseUrl,
      certificate,
    });
    return parseBody(HostRuntimeSchema, response, baseUrl, '/api/runtime');
  }

  /**
   * Unpinned `/api/runtime` at an address nothing is known about yet. The
   * answer and the certificate only select the next setup step; neither is
   * trusted, and the call carries no key and no body.
   */
  async discoverRuntime(
    origin: string,
  ): Promise<{ runtime: HostRuntime | null; certificate: string }> {
    const answer = await discoverRuntime(origin, RUNTIME_TIMEOUT_MS);
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
    const response = await this.fetchUrl(bootstrapUrl, '/api/host/claim', {
      apiKey,
      certificate,
      method: 'POST',
      body: JSON.stringify(body),
      timeoutMs: CLAIM_TIMEOUT_MS,
      expect: [200, 409, 504],
      label: bootstrapUrl,
    });
    if (response.status === 200) {
      await discardBody(response);
      return 'claimed';
    }
    const code = await readErrorCode(response);
    if (response.status === 504) return 'starting';
    if (code === 'ALREADY_CLAIMED') return 'already_claimed';
    throw new RemoteHostRequestError(`The VM refused the claim${code ? ` (${code})` : ''}.`, {
      remoteId: bootstrapUrl,
      path: '/api/host/claim',
      status: response.status,
      hostCode: code,
    });
  }

  async verifyProviderAuth(
    remoteId: string,
    provider: string,
    opencodeProviderIds: string[],
  ): Promise<HostProviderVerify> {
    const path = '/api/host/provider-auth/verify';
    const response = await this.request(remoteId, path, {
      method: 'POST',
      body: JSON.stringify({ provider, opencodeProviderIds }),
      timeoutMs: VERIFY_TIMEOUT_MS,
      expect: [200],
    });
    return parseBody(HostProviderVerifySchema, response, remoteId, path);
  }

  /** Writes provider login material on a claimed host. The body carries credentials. */
  async applyProviderAuth(remoteId: string, bundle: HostProviderApplyInput): Promise<void> {
    const response = await this.request(remoteId, '/api/host/provider-auth', {
      method: 'POST',
      body: JSON.stringify(bundle),
      expect: [200],
    });
    await discardBody(response);
  }

  async applySshKeys(remoteId: string, keys: string[]): Promise<void> {
    const response = await this.request(remoteId, '/api/host/ssh-keys', {
      method: 'POST',
      body: JSON.stringify({ keys }),
      expect: [200],
    });
    await discardBody(response);
  }

  /** Starts the host's version install; answers once the install runs outside DevChain. */
  async requestHostUpdate(remoteId: string, version: string): Promise<'started' | 'in_progress'> {
    const response = await this.request(remoteId, '/api/host/update', {
      method: 'POST',
      body: JSON.stringify({ version }),
      expect: [202, 409],
    });
    if (response.status === 202) {
      await discardBody(response);
      return 'started';
    }
    const code = await readErrorCode(response);
    if (code === 'UPDATE_IN_PROGRESS') return 'in_progress';
    throw new RemoteHostRequestError(`The host refused the update${code ? ` (${code})` : ''}.`, {
      remoteId,
      path: '/api/host/update',
      status: 409,
      hostCode: code,
    });
  }

  async hostUpdateStatus(remoteId: string): Promise<HostUpdateProgress | null> {
    const path = '/api/host/update';
    const response = await this.request(remoteId, path, { method: 'GET', expect: [200] });
    return (await parseBody(HostUpdateStatusBodySchema, response, remoteId, path)).status;
  }

  async requestDocker(remoteId: string): Promise<{ jobId: string | null }> {
    const response = await this.request(remoteId, '/api/host/docker', {
      method: 'POST',
      body: '{}',
      expect: [202],
    });
    return parseBody(
      z.object({ jobId: z.string().nullable() }),
      response,
      remoteId,
      '/api/host/docker',
    );
  }

  async dockerStatus(remoteId: string) {
    const path = '/api/host/docker';
    const response = await this.request(remoteId, path, { method: 'GET', expect: [200] });
    return (
      await parseBody(
        z.object({ status: HostDockerStatusSchema.nullable() }),
        response,
        remoteId,
        path,
      )
    ).status;
  }

  getProviderCliSettingsStatus(remoteId: string): Promise<HostProviderCliSettingsStatus> {
    return this.hostSettingsRequest(
      remoteId,
      '/api/host/provider-clis/status',
      'GET',
      undefined,
      200,
      HostProviderCliSettingsStatusSchema,
      3000,
    );
  }

  async putProviderCliSettings(remoteId: string, body: HostProviderCliSettings): Promise<void> {
    await this.hostSettingsRequest(
      remoteId,
      '/api/host/provider-clis',
      'PUT',
      JSON.stringify(body),
      202,
      z.object({ revision: z.literal(body.revision) }),
      3000,
    );
  }

  async checkProviderClis(remoteId: string): Promise<void> {
    await this.hostSettingsRequest(
      remoteId,
      '/api/host/provider-clis/check',
      'POST',
      undefined,
      202,
      z.object({ accepted: z.literal(true) }),
      3000,
    );
  }

  getSkillSettingsStatus(remoteId: string): Promise<HostSkillSettingsStatus> {
    return this.hostSettingsRequest(
      remoteId,
      '/api/host/skill-settings/status',
      'GET',
      undefined,
      200,
      HostSkillSettingsStatusSchema,
      3000,
    );
  }

  async putSkillSettings(remoteId: string, body: HostSkillSettings): Promise<void> {
    await this.hostSettingsRequest(
      remoteId,
      '/api/host/skill-settings',
      'PUT',
      JSON.stringify(body),
      202,
      z.object({ revision: z.literal(body.revision) }),
      3000,
    );
  }

  async uploadSkillSourceContent(
    remoteId: string,
    name: string,
    contentHash: string,
    stream: Readable,
    signal?: AbortSignal,
  ): Promise<void> {
    const path = `/api/host/skill-settings/local-sources/${enc(name)}/content?${new URLSearchParams({ contentHash })}`;
    try {
      await this.hostSettingsRequest(
        remoteId,
        path,
        'PUT',
        stream,
        200,
        z.object({ name: z.literal(name), contentHash: z.literal(contentHash) }),
        60_000,
        signal,
      );
    } finally {
      stream.destroy();
    }
  }

  private async hostSettingsRequest<T>(
    remoteId: string,
    path: string,
    method: 'GET' | 'PUT' | 'POST',
    body: string | Readable | undefined,
    expectedStatus: number,
    schema: z.ZodType<T>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<T> {
    const { baseUrl, certificate } = requireRemoteTls(await this.storage.getRemote(remoteId));
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    const timeout = setTimeout(abort, timeoutMs);
    timeout.unref?.();
    let response: Response | undefined;
    try {
      const init: RemoteFetchInit = {
        method,
        signal: controller.signal,
        ...(body === undefined
          ? {}
          : {
              body: body as BodyInit,
              headers: {
                'content-type': typeof body === 'string' ? 'application/json' : 'application/x-tar',
              },
              ...(typeof body === 'string' ? {} : { duplex: 'half' as const }),
            }),
      };
      init.headers = { ...(await this.apiKeys.headers(remoteId)), ...init.headers };
      response = await remoteFetch(`${baseUrl.replace(/\/+$/, '')}${path}`, init, certificate);
      if (response.status !== expectedStatus)
        throw new RemoteHostRequestError('Host settings request failed', {
          remoteId,
          path,
          status: response.status,
          hostCode: null,
        });
      return await parseBody(schema, response, remoteId, path);
    } finally {
      if (response) await discardBody(response);
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    }
  }

  private async request(
    remoteId: string,
    path: string,
    options: {
      method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
      body?: string;
      contentType?: string;
      timeoutMs?: number;
      expect: number[];
    },
  ): Promise<Response> {
    const remote = await this.storage.getRemote(remoteId);
    const { baseUrl, certificate } = requireRemoteTls(remote);
    return this.fetchUrl(baseUrl, path, {
      ...options,
      apiKey: await this.apiKeys.get(remoteId),
      label: `Remote "${remote.name}"`,
      remoteId,
      certificate,
    });
  }

  private async fetchUrl(
    baseUrl: string,
    path: string,
    options: {
      method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
      body?: string;
      contentType?: string;
      timeoutMs?: number;
      expect: number[];
      label: string;
      remoteId?: string;
      apiKey?: string | null;
      certificate: string;
    },
  ): Promise<Response> {
    const remoteId = options.remoteId ?? baseUrl;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? CONTROL_TIMEOUT_MS);
    timeout.unref?.();
    let response: Response;
    try {
      response = await remoteFetch(
        `${baseUrl.replace(/\/+$/, '')}${path}`,
        {
          method: options.method,
          headers: {
            ...remoteAuthorization(options.apiKey),
            ...(options.body !== undefined
              ? { 'content-type': options.contentType ?? 'application/json' }
              : {}),
          },
          signal: controller.signal,
          ...(options.body !== undefined && {
            body: options.body,
          }),
        },
        options.certificate,
      );
    } catch (error) {
      throw new RemoteHostRequestError(
        `${options.label} is unreachable: ${error instanceof Error ? error.message : String(error)}`,
        { remoteId, path, status: null, hostCode: null },
      );
    } finally {
      clearTimeout(timeout);
    }
    if (!options.expect.includes(response.status)) {
      const hostCode = await readErrorCode(response);
      if (path === '/api/host/docker' && hostCode === 'HOST_HELPER_OUTDATED') {
        throw new RemoteHostRequestError(
          `The host helper needs one manual migration: ${HOST_HELPER_MIGRATION}`,
          { remoteId, path, status: response.status, hostCode: 'HOST_HELPER_OUTDATED' },
        );
      }
      throw new RemoteHostRequestError(
        `${options.label} answered ${response.status} to ${options.method} ${path.split('?')[0]}${hostCode ? ` (${hostCode})` : ''}.`,
        { remoteId, path, status: response.status, hostCode },
      );
    }
    return response;
  }
}

/** Releases the pooled connection; an unread body holds it until garbage collection. */
async function discardBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

async function parseBody<T>(
  schema: z.ZodType<T>,
  response: Response,
  remoteId: string,
  path: string,
): Promise<T> {
  const parsed = schema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) {
    throw new RemoteHostRequestError(`Host returned an invalid answer to ${path.split('?')[0]}.`, {
      remoteId,
      path,
      status: response.status,
      hostCode: null,
    });
  }
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

/** The AppError `code`, or a `details.code` conflict code, from an error body. */
async function readErrorCode(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { code?: unknown; details?: { code?: unknown } };
    const detailCode = body.details?.code;
    if (typeof detailCode === 'string') return detailCode;
    return typeof body.code === 'string' ? body.code : null;
  } catch {
    return null;
  }
}
