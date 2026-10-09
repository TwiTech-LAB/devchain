import { FileSyncAutoFixSchema } from '@/modules/file-sync/file-sync-auto-fix.dto';
import { SyncChownResultSchema } from '@/modules/file-sync/sync-chown.dto';
import { FILE_SYNC_IGNORES_CHANGED } from '@/modules/file-sync/file-sync.dto';
import { ProviderAuthApiError, FileListChangedError } from './remote-vm-errors';
import { HOME_BACKEND, apiFetch } from '@/ui/lib/api-transport';
import type { RemoteVmApi } from './remote-vm-api';
import type {
  ProviderAuthEntryItem,
  ImportResult,
  ProviderAuthReleaseView,
  OpencodeLoginItem,
  ProviderAuthGenerationView,
  StartProviderAuthGenerationInput,
  ProjectFileSyncFailures,
  FileSyncAutoFix,
  ProjectIgnores,
  SaveProjectIgnoresResult,
  ProjectExclusionSuggestions,
  ProjectPatternPreview,
  SyncChownResult,
  ProjectFileSyncStatus,
  DockerPlanRequest,
  DockerPlan,
  DockerPresence,
  DockerSyncState,
  ConnectChoicesDto,
  AttachProjectRequest,
  AvailableSshPublicKey,
  ClaimRequestBody,
  CreateRemoteInput,
  CreateVmRequestBody,
  DetachProjectRequest,
  ForceSyncRequest,
  HomeIdentity,
  InstallHostRequestBody,
  LocalSshKey,
  ProbeResultDto,
  ProjectDiskEstimate,
  ProxmoxConnectedResult,
  ProxmoxFingerprintPreview,
  ProxmoxRightsCheck,
  ProxmoxSetupBlockFields,
  RemoteListItemDto,
  RemoteOperationDto,
  RemoteProjectBindingRow,
  RemoteReadinessDto,
  RemoteStatsHistoryDto,
  ResetVmRequestBody,
  RetryOperationRequest,
  UpdateLoginsRequestBody,
  VmProviderConnectionView,
} from './remote-vm-contracts';

/** The server's `message` from an error response, or `fallback`. */
async function readErrorMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { message?: unknown } | null;
  return typeof body?.message === 'string' ? body.message : fallback;
}

/** A call to the home backend, which serves every request except a remote's own session list. */
function home(path: string, init?: RequestInit): Promise<Response> {
  return apiFetch(path, init, { backend: HOME_BACKEND });
}

/** Throws the server's `message`, or `fallback`, when the response is not a success. */
async function okOrThrow(res: Response, fallback: string): Promise<void> {
  if (!res.ok) throw new Error(await readErrorMessage(res, fallback));
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await home(path, init);
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.message ?? `Remote operation request failed (${response.status})`);
  }
  return response.json();
}

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

function jsonBody(method: 'POST' | 'PUT' | 'PATCH', body?: unknown): RequestInit {
  if (body === undefined) return { method };
  return { method, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

const jsonPost = (body?: unknown) => jsonBody('POST', body);

const API_KEY_FAILURE = 'Could not change the VM API key.';

function isProbeResult(body: unknown): body is ProbeResultDto {
  if (typeof body !== 'object' || body === null) return false;
  const result = body as Record<string, unknown>;
  switch (result.kind) {
    case 'devchain':
      return typeof result.baseUrl === 'string' && typeof result.versionMatches === 'boolean';
    case 'installer':
      return (
        typeof result.bootstrapUrl === 'string' &&
        typeof result.state === 'string' &&
        typeof result.supported === 'boolean'
      );
    case 'nothing':
      return Array.isArray(result.tried);
    default:
      return false;
  }
}

const PLACEMENT_FIELDS = [
  'apiUrl',
  'node',
  'pool',
  'storage',
  'imageStorage',
  'bridge',
] as const satisfies readonly (keyof ProxmoxFingerprintPreview['placement'])[];

function isPlacementPreview(value: unknown): value is ProxmoxFingerprintPreview['placement'] {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return PLACEMENT_FIELDS.every((field) => typeof candidate[field] === 'string');
}

async function sendProviderAuth(path: string, init?: RequestInit): Promise<Response> {
  const response = await home(path, init);
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const details = body?.details;
    throw new ProviderAuthApiError(
      body?.message ?? `Provider auth request failed (${response.status})`,
      response.status,
      details && typeof details === 'object' ? details : null,
    );
  }
  return response;
}

async function providerAuthRequest<T>(path: string, init?: RequestInit): Promise<T> {
  return (await sendProviderAuth(path, init)).json();
}

/** The SSH keys this PC offers, or none when it offers none or the request fails. */
async function listAvailableKeys<T>(path: string, init: RequestInit): Promise<T[]> {
  try {
    const response = await home(path, init);
    if (!response.ok) return [];
    const result = (await response.json()) as { available?: boolean; keys?: T[] } | null;
    return result?.available === true && Array.isArray(result.keys) ? result.keys : [];
  } catch {
    return [];
  }
}

function isPlan(value: unknown): value is DockerPlan {
  const plan = value as Partial<DockerPlan> | null;
  return (
    typeof plan?.canConnect === 'boolean' &&
    typeof plan?.fit === 'string' &&
    Array.isArray(plan?.items) &&
    typeof plan?.availability === 'object' &&
    plan?.availability !== null
  );
}

export class RemoteVmHttpApi implements RemoteVmApi {
  async listRemotes(signal: AbortSignal): Promise<RemoteListItemDto[]> {
    const res = await home('/api/remotes', { signal });
    await okOrThrow(res, `Failed to load remotes (${res.status})`);
    const body = (await res.json()) as { items?: RemoteListItemDto[] };
    return body.items ?? [];
  }

  async listBindings(signal: AbortSignal): Promise<RemoteProjectBindingRow[]> {
    const res = await home('/api/remotes/bindings', { signal });
    await okOrThrow(res, `Failed to load remote bindings (${res.status})`);
    const body = (await res.json()) as { items?: RemoteProjectBindingRow[] };
    return body.items ?? [];
  }

  async createRemote(input: CreateRemoteInput): Promise<RemoteListItemDto> {
    const res = await home('/api/remotes', jsonPost(input));
    await okOrThrow(res, 'Failed to add the VM');
    return res.json();
  }

  async deleteRemote(remoteId: string): Promise<void> {
    const res = await home(`/api/remotes/${remoteId}`, { method: 'DELETE' });
    await okOrThrow(res, 'Failed to delete remote');
  }

  async renameRemote(remoteId: string, name: string): Promise<RemoteListItemDto> {
    const res = await home(`/api/remotes/${remoteId}`, jsonBody('PATCH', { name }));
    await okOrThrow(res, 'Failed to rename the VM');
    return res.json();
  }

  async readReadiness(signal: AbortSignal): Promise<RemoteReadinessDto> {
    const res = await home('/api/remotes/readiness', { signal });
    if (!res.ok) throw new Error(`Could not check this PC (${res.status})`);
    const body = (await res.json()) as Partial<RemoteReadinessDto> | null;
    if (!body?.syncthing || !body.identity || !body.docker) {
      throw new Error('Could not check this PC: the answer was incomplete.');
    }
    return body as RemoteReadinessDto;
  }

  async readStatsHistory(remoteId: string, signal: AbortSignal): Promise<RemoteStatsHistoryDto> {
    const res = await home(`/api/remotes/${remoteId}/stats/history`, { signal });
    if (!res.ok) {
      throw new Error(`Failed to load remote stats history (${res.status})`);
    }
    const body = (await res.json()) as Partial<RemoteStatsHistoryDto>;
    return {
      intervalMs: typeof body.intervalMs === 'number' ? body.intervalMs : 0,
      samples: Array.isArray(body.samples) ? body.samples : [],
    };
  }

  async powerOn(remoteId: string): Promise<void> {
    const res = await home(`/api/remotes/${remoteId}/power-on`, { method: 'POST' });
    await okOrThrow(res, `Power on failed (${res.status})`);
  }

  async setApiKey(remoteId: string, apiKey: string): Promise<void> {
    const response = await home(`/api/remotes/${remoteId}/api-key`, jsonBody('PUT', { apiKey }));
    await okOrThrow(response, API_KEY_FAILURE);
  }

  async resetApiKey(remoteId: string): Promise<void> {
    const response = await home(`/api/remotes/${remoteId}/api-key/reset`, jsonPost({}));
    await okOrThrow(response, API_KEY_FAILURE);
  }

  async listOperations(
    state: RemoteOperationDto['state'],
    limit: number,
    signal: AbortSignal,
  ): Promise<RemoteOperationDto[]> {
    const list = await request<{ items: RemoteOperationDto[] }>(
      `/api/remotes/operations?state=${state}&limit=${limit}`,
      { signal },
    );
    return list.items ?? [];
  }

  async readNewestOperation(
    projectId: string,
    signal: AbortSignal,
  ): Promise<RemoteOperationDto | null> {
    const res = await home(
      `/api/remotes/operations?projectId=${encodeURIComponent(projectId)}&limit=1`,
      { signal },
    );
    if (!res.ok) throw new Error(`Could not load the project's last operation (${res.status})`);
    const body = (await res.json()) as { items?: RemoteOperationDto[] };
    return body.items?.[0] ?? null;
  }

  attachProject(remoteId: string, input: AttachProjectRequest): Promise<RemoteOperationDto> {
    return request(
      `/api/remotes/${remoteId}/attach`,
      jsonPost({
        projectId: input.projectId,
        ...(input.docker && { docker: input.docker }),
      }),
    );
  }

  detachProject(remoteId: string, input: DetachProjectRequest): Promise<RemoteOperationDto> {
    return request(
      `/api/remotes/${remoteId}/detach`,
      jsonPost({
        projectId: input.projectId,
        force: input.force ?? false,
        ...(input.dockerCopyBack && { dockerCopyBack: input.dockerCopyBack }),
      }),
    );
  }

  forceSync(remoteId: string, input: ForceSyncRequest): Promise<RemoteOperationDto> {
    return request(
      `/api/remotes/${remoteId}/force-sync`,
      jsonPost({ projectId: input.projectId, source: input.source }),
    );
  }

  updateHost(remoteId: string, input?: { installDocker: true }): Promise<RemoteOperationDto> {
    return request(`/api/remotes/${remoteId}/update`, jsonPost(input));
  }

  createVm(connectionId: string, input: CreateVmRequestBody): Promise<RemoteOperationDto> {
    return request(`/api/vm-providers/${connectionId}/create-vm`, jsonPost(input));
  }

  installHost(input: InstallHostRequestBody): Promise<RemoteOperationDto> {
    return request('/api/remotes/host-install', jsonPost(input));
  }

  resetVm(remoteId: string, input: ResetVmRequestBody): Promise<RemoteOperationDto> {
    return request(`/api/remotes/${remoteId}/reset`, jsonPost(input));
  }

  destroyVm(remoteId: string, input: { force: boolean }): Promise<RemoteOperationDto> {
    return request(`/api/remotes/${remoteId}/destroy-vm`, jsonPost(input));
  }

  updateLogins(remoteId: string, input: UpdateLoginsRequestBody): Promise<RemoteOperationDto> {
    return request(`/api/remotes/${remoteId}/logins`, jsonPost(input));
  }

  claimHost(input: ClaimRequestBody): Promise<RemoteOperationDto> {
    return request('/api/remotes/claim', jsonPost(input));
  }

  retryOperation(operationId: string, input?: RetryOperationRequest): Promise<RemoteOperationDto> {
    const body = {
      ...(input?.providerAuth ? { providerAuth: input.providerAuth } : {}),
      ...(input?.ssh ? { ssh: input.ssh } : {}),
    };
    return request(
      `/api/remotes/operations/${operationId}/retry`,
      jsonPost(Object.keys(body).length > 0 ? body : undefined),
    );
  }

  cancelOperation(operationId: string): Promise<RemoteOperationDto> {
    return request(`/api/remotes/operations/${operationId}/cancel`, jsonPost());
  }

  async probeAddress(
    address: string,
    options: { checkSsh: boolean; signal?: AbortSignal },
  ): Promise<ProbeResultDto> {
    const response = await home('/api/remotes/probe', {
      ...jsonBody('POST', { address, checkSsh: options.checkSsh }),
      signal: options.signal,
    });
    const body = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) {
      const message = (body as { message?: unknown } | null)?.message;
      throw new Error(typeof message === 'string' ? message : 'The address check failed.');
    }
    if (!isProbeResult(body)) throw new Error('The address check returned an unknown answer.');
    return body;
  }

  async readHomeIdentity(signal: AbortSignal): Promise<HomeIdentity> {
    const response = await home('/api/remotes/host-install/identity', { signal });
    if (!response.ok) throw new Error('identity unavailable');
    return response.json();
  }

  listLocalSshKeys(): Promise<LocalSshKey[]> {
    return listAvailableKeys<LocalSshKey>('/api/remotes/host-install/ssh-keys', {});
  }

  listSshPublicKeys(signal: AbortSignal): Promise<AvailableSshPublicKey[]> {
    return listAvailableKeys<AvailableSshPublicKey>('/api/remotes/host-install/ssh-public-keys', {
      signal,
    });
  }

  async estimateProjectDisk(projectIds: string[]): Promise<ProjectDiskEstimate> {
    const response = await home('/api/remotes/host-install/estimate', jsonPost({ projectIds }));
    const body = (await response.json().catch(() => null)) as {
      message?: unknown;
      projects?: ProjectDiskEstimate['projects'];
      requiredDiskGib?: number;
    } | null;
    if (!response.ok) {
      throw new Error(
        typeof body?.message === 'string' ? body.message : 'Could not measure project sizes.',
      );
    }
    if (!Array.isArray(body?.projects) || typeof body.requiredDiskGib !== 'number') {
      throw new Error('The server returned an invalid project estimate.');
    }
    return { projects: body.projects, requiredDiskGib: body.requiredDiskGib };
  }

  async readHostInstallBlock(minDiskGib: number, signal: AbortSignal): Promise<string> {
    const query = new URLSearchParams({ minDiskGib: String(minDiskGib) });
    const response = await home(`/api/remotes/host-install/block?${query.toString()}`, { signal });
    const body = (await response.json().catch(() => null)) as {
      block?: unknown;
      message?: unknown;
    } | null;
    if (!response.ok) {
      throw new Error(
        typeof body?.message === 'string' ? body.message : 'Could not generate the install block.',
      );
    }
    if (typeof body?.block !== 'string' || body.block.length === 0) {
      throw new Error('The server returned an empty install block.');
    }
    return body.block;
  }

  async listVmProviders(signal: AbortSignal): Promise<VmProviderConnectionView[]> {
    const response = await home('/api/vm-providers', { signal });
    await okOrThrow(response, `Failed to load VM providers (${response.status})`);
    const body = (await response.json()) as { items?: VmProviderConnectionView[] };
    return body.items ?? [];
  }

  async checkVmProviderRights(connectionId: string): Promise<ProxmoxRightsCheck> {
    const response = await home(`/api/vm-providers/${encodeURIComponent(connectionId)}/check`, {
      method: 'POST',
    });
    await okOrThrow(response, 'The rights check failed.');
    const body = (await response.json()) as Partial<ProxmoxRightsCheck>;
    return { ok: body.ok === true, missing: Array.isArray(body.missing) ? body.missing : [] };
  }

  async deleteVmProvider(connectionId: string): Promise<void> {
    const response = await home(`/api/vm-providers/${encodeURIComponent(connectionId)}`, {
      method: 'DELETE',
    });
    await okOrThrow(response, 'Could not remove the server.');
  }

  async readProxmoxSetupBlock(fields: ProxmoxSetupBlockFields): Promise<string> {
    const query = new URLSearchParams(
      Object.entries(fields)
        // Empty address and pool fields leave the server's defaults in effect.
        .filter(([key, value]) => (key !== 'address' && key !== 'pool') || value.trim().length > 0)
        .map(([key, value]) => [key, value.trim()]),
    );
    const response = await home(`/api/vm-providers/proxmox/setup-block?${query.toString()}`, {});
    await okOrThrow(response, 'Could not generate the setup block.');
    const result = (await response.json()) as { block?: unknown };
    if (typeof result.block !== 'string' || result.block.length === 0) {
      throw new Error('The server returned an empty setup block.');
    }
    return result.block;
  }

  async previewProxmoxConnection(connectionString: string): Promise<ProxmoxFingerprintPreview> {
    const response = await home(
      '/api/vm-providers/proxmox/connect',
      jsonPost({ connectionString: connectionString.trim() }),
    );
    await okOrThrow(response, 'Could not read the connection string.');
    const result = (await response.json()) as ProxmoxFingerprintPreview;
    if (
      result.confirmationRequired !== true ||
      typeof result.fingerprint !== 'string' ||
      !isPlacementPreview(result.placement)
    ) {
      throw new Error('The server returned an unexpected fingerprint response.');
    }
    return result;
  }

  async connectProxmox(connectionString: string): Promise<ProxmoxConnectedResult> {
    const response = await home(
      '/api/vm-providers/proxmox/connect',
      jsonPost({ connectionString: connectionString.trim(), confirmFingerprint: true }),
    );
    await okOrThrow(response, 'Could not connect Proxmox.');
    const result = (await response.json()) as ProxmoxConnectedResult;
    if (result.confirmationRequired !== false || !result.connection?.id || !result.permissions) {
      throw new Error('The server returned an unexpected connection response.');
    }
    return result;
  }

  async countRunningAgents(remoteId: string, signal: AbortSignal): Promise<number> {
    const response = await apiFetch('/api/sessions', { signal }, { backend: remoteId });
    if (!response.ok) throw new Error('session list unavailable');
    const sessions = (await response.json()) as Array<{ status?: string; agentId?: string | null }>;
    return sessions.filter((session) => session.status === 'running' && session.agentId).length;
  }

  async listProviderAuthEntries(signal: AbortSignal): Promise<ProviderAuthEntryItem[]> {
    return (
      await providerAuthRequest<{ items: ProviderAuthEntryItem[] }>('/api/provider-auth', {
        signal,
      })
    ).items;
  }

  createStaticProviderAuth(input: Record<string, string>): Promise<ProviderAuthEntryItem> {
    return providerAuthRequest('/api/provider-auth/static', jsonPost(input));
  }

  importOpencodeLogins(providerIds: string[]): Promise<{ results: ImportResult[] }> {
    return providerAuthRequest('/api/provider-auth/opencode-import', jsonPost({ providerIds }));
  }

  async deleteProviderAuthEntry(entryId: string): Promise<void> {
    await sendProviderAuth(`/api/provider-auth/${entryId}`, { method: 'DELETE' });
  }

  renameProviderAuthEntry(entryId: string, label: string): Promise<ProviderAuthEntryItem> {
    return providerAuthRequest(`/api/provider-auth/${entryId}`, jsonBody('PATCH', { label }));
  }

  releaseProviderAuthEntry(entryId: string): Promise<ProviderAuthReleaseView> {
    return providerAuthRequest(`/api/provider-auth/${entryId}/release`, jsonPost({}));
  }

  async listOpencodeLogins(signal: AbortSignal): Promise<OpencodeLoginItem[]> {
    return (
      await providerAuthRequest<{ logins: OpencodeLoginItem[] }>(
        '/api/provider-auth/opencode-logins',
        { signal },
      )
    ).logins;
  }

  readProviderAuthGeneration(
    generationId: string,
    signal: AbortSignal,
  ): Promise<ProviderAuthGenerationView> {
    return providerAuthRequest(`/api/provider-auth/generate/${generationId}`, { signal });
  }

  startProviderAuthGeneration(
    input: StartProviderAuthGenerationInput,
  ): Promise<ProviderAuthGenerationView> {
    return providerAuthRequest('/api/provider-auth/generate', jsonPost(input));
  }

  async cancelProviderAuthGeneration(generationId: string): Promise<void> {
    await providerAuthRequest<ProviderAuthGenerationView>(
      `/api/provider-auth/generate/${generationId}/cancel`,
      jsonPost(),
    );
  }

  async readProjectFileSyncFailures(
    projectId: string,
    signal: AbortSignal,
  ): Promise<ProjectFileSyncFailures> {
    const response = await home(`/api/projects/${encodeURIComponent(projectId)}/file-sync/failed`, {
      signal,
    });
    await okOrThrow(response, 'Could not read file sync failures.');
    const body = (await response.json()) as ProjectFileSyncFailures;
    if (
      !Array.isArray(body.home?.entries) ||
      !Array.isArray(body.vm?.entries) ||
      !Array.isArray(body.installedPrefix) ||
      !Array.isArray(body.groups)
    ) {
      throw new Error('The server returned no failed-file list.');
    }
    return body;
  }

  async readFileSyncAutoFix(projectId: string, signal: AbortSignal): Promise<FileSyncAutoFix> {
    const response = await home(
      `/api/projects/${encodeURIComponent(projectId)}/file-sync/auto-fix`,
      { signal },
    );
    await okOrThrow(response, 'Could not read automatic file sync settings.');
    return FileSyncAutoFixSchema.parse(await response.json());
  }

  async setFileSyncAutoFix(projectId: string, enabled: boolean): Promise<FileSyncAutoFix> {
    const response = await home(
      `/api/projects/${encodeURIComponent(projectId)}/file-sync/auto-fix`,
      jsonBody('PUT', { enabled }),
    );
    await okOrThrow(response, 'Could not save automatic file sync settings.');
    return FileSyncAutoFixSchema.parse(await response.json());
  }

  async readProjectIgnores(projectId: string, signal: AbortSignal): Promise<ProjectIgnores> {
    const response = await home(
      `/api/file-sync/projects/${encodeURIComponent(projectId)}/ignores`,
      { signal },
    );
    await okOrThrow(response, 'Could not read the file list.');
    const body = (await response.json()) as ProjectIgnores;
    if (!Array.isArray(body.ignores) || !Number.isSafeInteger(body.revision) || body.revision < 0) {
      throw new Error('The server returned no file list.');
    }
    return body;
  }

  async saveProjectIgnores(
    projectId: string,
    ignores: string[] | null,
    revision: number,
  ): Promise<SaveProjectIgnoresResult> {
    const response = await home(
      `/api/projects/${encodeURIComponent(projectId)}/file-sync/ignores`,
      jsonBody('PUT', { ignores, revision }),
    );
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        message?: unknown;
        code?: unknown;
      } | null;
      const message =
        typeof body?.message === 'string' ? body.message : 'Could not save the file list.';
      // Only a changed list resets the draft; other conflicts keep the user's edits.
      throw body?.code === FILE_SYNC_IGNORES_CHANGED
        ? new FileListChangedError(message)
        : new Error(message);
    }
    return response.json();
  }

  async readFileSyncSuggestions(
    projectId: string,
    remoteId: string,
    signal: AbortSignal,
  ): Promise<ProjectExclusionSuggestions> {
    const response = await home(
      `/api/projects/${encodeURIComponent(projectId)}/file-sync/suggestions`,
      { ...jsonPost({ remoteId }), signal },
    );
    if (!response.ok) throw new Error('Scan failed');
    const body = (await response.json()) as ProjectExclusionSuggestions;
    if (!Array.isArray(body.groups)) throw new Error('No suggestions');
    return body;
  }

  async previewFileSyncPattern(
    projectId: string,
    pattern: string,
    signal: AbortSignal,
  ): Promise<ProjectPatternPreview> {
    const response = await home(
      `/api/projects/${encodeURIComponent(projectId)}/file-sync/pattern-preview`,
      { ...jsonPost({ pattern }), signal },
    );
    await okOrThrow(response, 'Could not preview this pattern.');
    const result = (await response.json()) as ProjectPatternPreview;
    if (!result.home || !result.vm) throw new Error('The server returned no pattern preview.');
    return result;
  }

  async giveFileOwnership(projectId: string, paths: string[]): Promise<SyncChownResult> {
    const response = await home(
      `/api/projects/${encodeURIComponent(projectId)}/file-sync/give-ownership`,
      jsonPost({ paths }),
    );
    await okOrThrow(response, 'Could not change VM file owners.');
    return SyncChownResultSchema.parse(await response.json());
  }

  async readFileSyncStatus(projectId: string, signal: AbortSignal): Promise<ProjectFileSyncStatus> {
    const response = await home(`/api/file-sync/projects/${encodeURIComponent(projectId)}/status`, {
      signal,
    });
    if (!response.ok) return { folders: null };
    return response.json();
  }

  async readDockerPlan(
    projectId: string,
    input: DockerPlanRequest,
    signal: AbortSignal,
  ): Promise<DockerPlan> {
    const response = await home(`/api/projects/${encodeURIComponent(projectId)}/docker/plan`, {
      ...jsonPost(input),
      signal,
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(
        (body as { message?: string } | null)?.message ??
          `The Docker plan failed (${response.status})`,
      );
    }
    if (!isPlan(body)) throw new Error('The server returned an invalid Docker plan.');
    return body;
  }

  async readDockerPresence(projectId: string, signal: AbortSignal): Promise<DockerPresence> {
    const response = await home(`/api/projects/${encodeURIComponent(projectId)}/docker/presence`, {
      signal,
    });
    await okOrThrow(response, 'Could not read Docker presence.');
    return response.json();
  }

  async readDockerSyncState(
    projectId: string,
    remoteId: string,
    signal: AbortSignal,
  ): Promise<DockerSyncState | null> {
    const response = await home(
      `/api/projects/${encodeURIComponent(projectId)}/docker/sync-state`,
      { ...jsonPost({ remoteId }), signal },
    );
    if (!response.ok) return null;
    return response.json();
  }

  async readConnectChoices(projectId: string, signal: AbortSignal): Promise<ConnectChoicesDto> {
    const response = await home(`/api/projects/${encodeURIComponent(projectId)}/connect-choices`, {
      signal,
    });
    await okOrThrow(response, 'Could not read the Connect choices.');
    const body = (await response.json()) as Partial<ConnectChoicesDto>;
    return {
      remoteId: typeof body.remoteId === 'string' ? body.remoteId : undefined,
      includeDocker: body.includeDocker === true,
      git: body.git === 'missing' ? 'missing' : 'present',
    };
  }
}

export const remoteVmHttpApi: RemoteVmApi = new RemoteVmHttpApi();
