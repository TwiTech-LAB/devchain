import type { RemoteVmApi } from '@/ui/pages/cloud/lib/remote-vm-api';
import type {
  RemoteListItemDto,
  RemoteOperationDto,
  RemoteProjectBindingRow,
  RemoteReadinessDto,
  ProviderAuthEntryItem,
  ProviderAuthGenerationView,
  ProbeResultDto,
  LocalSshKey,
  ProjectFileSyncFailures,
  DockerPlan,
  ProjectFileSyncStatus,
  VmProviderConnectionView,
} from '@/ui/pages/cloud/lib/remote-vm-contracts';
import { FileListChangedError } from '@/ui/pages/cloud/lib/remote-vm-errors';
import { DEFAULT_FILE_SYNC_IGNORES } from '@/modules/file-sync/file-sync.dto';

const READY: RemoteReadinessDto = {
  syncthing: { ok: true, version: 'v2.1.5', message: null },
  identity: { ok: true, user: 'devchain', homePath: '/home/devchain', message: null },
  docker: { ok: true, message: null },
};

export interface TestRemote
  extends Partial<Pick<RemoteListItemDto, 'uid' | 'gid' | 'dockerUserMismatch'>> {
  id: string;
  name: string;
  baseUrl: string | null;
  kind: 'address' | 'proxmox';
  powerState?: 'running' | 'stopped' | 'unknown';
  createdAt: string;
  updatedAt: string;
  online: boolean;
  apiKeyRejected?: boolean;
  version: string | null;
  versionMatches: boolean;
  stats: Record<string, number | string> | null;
  lastSeenAt: string | null;
  vmProviderConnectionId?: string | null;
  vmIdentity?: string | null;
  vmSpec?: { cores: number; memory: number; disk: number } | null;
  providerEnvOverrides?: Array<{
    key: string;
    source: string;
    provider: string;
  }> | null;
  docker?: Record<string, unknown>;
  homePath?: string | null;
  homePathMatches?: boolean | null;
  lastOperation?: { id: string; kind: string; state: string; updatedAt: string } | null;
  userName?: string | null;
  logins?: Record<string, { choice: string; entryIds: string[] }> | null;
  providerClis?: Record<
    string,
    {
      desiredVersion: string;
      installedVersion: string | null;
      state: 'idle' | 'installing' | 'failed';
      error: string | null;
      checkedAt: string | null;
    }
  > | null;
  cliVersions?: Record<string, string> | null;
}

export const PROXMOX_CONNECTION: VmProviderConnectionView = {
  id: 'pc1',
  kind: 'proxmox',
  name: 'Proxmox lab',
  apiUrl: 'https://pve.test:8006',
  node: 'pve1',
  pool: 'devchain',
  storage: 'local-lvm',
  imageStorage: 'local',
  bridge: 'vmbr0',
  vmidMin: 100,
  vmidMax: 999999999,
  namePrefix: 'devchain-',
  tag: 'devchain',
  sslFingerprint: 'AB:'.repeat(31) + 'AB',
  caPem: null,
  tokenId: 'devchain@pve!agent',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  capabilities: { create: true, destroy: true, powerState: true },
};

export const REMOTE: TestRemote = {
  id: 'r1',
  name: 'lab-vm',
  baseUrl: 'https://10.0.0.5:4000',
  kind: 'address',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  online: false,
  version: null,
  versionMatches: false,
  stats: null,
  lastSeenAt: null,
  homePath: null,
  homePathMatches: null,
  lastOperation: null,
  logins: null,
};

export function makeOperation(): RemoteOperationDto {
  return {
    id: 'op1',
    kind: 'attach',
    remoteId: 'r1',
    projectId: 'p1',
    state: 'running',
    details: {},
    createdAt: '',
    updatedAt: '',
    steps: [
      { id: 'copy', label: 'Copy project', state: 'running', error: null },
      { id: 'handoff', label: 'Hand ownership to remote', state: 'pending', error: null },
    ],
  };
}

type OperationStep = RemoteOperationDto['steps'][number];

/** An operation step that has not failed; `pending` until a scenario moves it on. */
function step(id: string, label: string, state: OperationStep['state'] = 'pending'): OperationStep {
  return { id, label, state, error: null };
}

type MethodArgs<K extends keyof RemoteVmApi> = Parameters<RemoteVmApi[K]>;
type MethodResult<K extends keyof RemoteVmApi> = Awaited<ReturnType<RemoteVmApi[K]>>;
type Override<K extends keyof RemoteVmApi> =
  | MethodResult<K>
  | Promise<MethodResult<K>>
  | Error
  | ((...args: MethodArgs<K>) => MethodResult<K> | Promise<MethodResult<K>>);
export type InMemoryRemoteVmApiOverrides = { [K in keyof RemoteVmApi]?: Override<K> };
export type InMemoryRemoteVmApiCalls = { [K in keyof RemoteVmApi]: MethodArgs<K>[] };

function copy<T>(value: T): T {
  if (Array.isArray(value)) return value.map(copy) as T;
  if (
    !value ||
    typeof value !== 'object' ||
    value instanceof AbortSignal ||
    value instanceof Promise ||
    value instanceof Error
  )
    return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copy(item)])) as T;
}

function remoteDto(remote: TestRemote): RemoteListItemDto {
  // Page seeds omit DTO fields their scenarios do not use.
  return copy(remote) as unknown as RemoteListItemDto;
}

export class InMemoryRemoteVmApi implements RemoteVmApi {
  remotesData: TestRemote[] = [{ ...REMOTE }];
  bindingsData: RemoteProjectBindingRow[] = [];
  operationsData: RemoteOperationDto[] = [];
  projectHistory: RemoteOperationDto[] = [];
  providerConnectionsData: VmProviderConnectionView[] = [];
  permissionMissing: string[] = [];
  fileSyncStatus: ProjectFileSyncStatus = { folders: null };
  availableSshKeys: LocalSshKey[] = [];
  dockerPlanData: unknown = null;
  readiness: RemoteReadinessDto = copy(READY);
  powerOnGate: Promise<void> | null = null;
  probeResult: ProbeResultDto = {
    kind: 'nothing',
    tried: ['https://10.0.0.5:3000'],
    sshReachable: true,
  };
  ignores: Record<string, string[]> = {};
  private ignoreRevisions: Record<string, number> = {};
  private autoFixEnabled: Record<string, boolean> = {};
  fileSyncFailures: Record<string, ProjectFileSyncFailures> = {};
  ignoreSaveError: string | null = null;
  ignoreSaveResult = { applied: true, message: 'Applied to the VM and this PC.' };
  loginEntries: ProviderAuthEntryItem[] = [];
  private generations: Record<string, ProviderAuthGenerationView> = {};
  readonly overrides: InMemoryRemoteVmApiOverrides = {};
  readonly calls: InMemoryRemoteVmApiCalls = {
    listRemotes: [],
    listBindings: [],
    createRemote: [],
    deleteRemote: [],
    renameRemote: [],
    readReadiness: [],
    readStatsHistory: [],
    powerOn: [],
    setApiKey: [],
    resetApiKey: [],
    listOperations: [],
    readNewestOperation: [],
    attachProject: [],
    detachProject: [],
    forceSync: [],
    updateHost: [],
    createVm: [],
    installHost: [],
    resetVm: [],
    destroyVm: [],
    updateLogins: [],
    claimHost: [],
    retryOperation: [],
    cancelOperation: [],
    probeAddress: [],
    readHomeIdentity: [],
    listLocalSshKeys: [],
    listSshPublicKeys: [],
    estimateProjectDisk: [],
    readHostInstallBlock: [],
    listVmProviders: [],
    checkVmProviderRights: [],
    deleteVmProvider: [],
    readProxmoxSetupBlock: [],
    previewProxmoxConnection: [],
    connectProxmox: [],
    countRunningAgents: [],
    listProviderAuthEntries: [],
    createStaticProviderAuth: [],
    importOpencodeLogins: [],
    deleteProviderAuthEntry: [],
    renameProviderAuthEntry: [],
    releaseProviderAuthEntry: [],
    listOpencodeLogins: [],
    readProviderAuthGeneration: [],
    startProviderAuthGeneration: [],
    cancelProviderAuthGeneration: [],
    readProjectFileSyncFailures: [],
    readFileSyncAutoFix: [],
    setFileSyncAutoFix: [],
    readProjectIgnores: [],
    saveProjectIgnores: [],
    readFileSyncSuggestions: [],
    previewFileSyncPattern: [],
    giveFileOwnership: [],
    readFileSyncStatus: [],
    readDockerPlan: [],
    readDockerPresence: [],
    readDockerSyncState: [],
    readConnectChoices: [],
  };

  constructor(seed: Partial<InMemoryRemoteVmApiSeed> = {}) {
    Object.assign(this, copy(seed));
  }

  /** The change-logins body of the latest call, or null before any call. */
  get loginsBody(): { providerAuth: Record<string, string>; force: boolean } | null {
    return this.calls.updateLogins.at(-1)?.[1] ?? null;
  }

  /** Every ignore-list save request, in call order. */
  get ignorePuts(): Array<{ projectId: string; ignores: string[] | null }> {
    return this.calls.saveProjectIgnores.map(([projectId, ignores]) => ({ projectId, ignores }));
  }

  get probeBodies(): Array<{ address: string; checkSsh: boolean }> {
    return this.calls.probeAddress.map(([address, options]) => ({
      address,
      checkSsh: options.checkSsh,
    }));
  }

  readonly defaults: RemoteVmApi = {
    listRemotes: async () => this.remotesData.map(remoteDto),
    listBindings: async () => this.bindingsData,
    createRemote: async (input) => {
      const created: TestRemote = { ...REMOTE, id: 'r2', ...input };
      this.remotesData = [...this.remotesData, created];
      return remoteDto(created);
    },
    deleteRemote: async (remoteId) => {
      if (this.bindingsData.some((binding) => binding.remoteId === remoteId))
        throw new Error('Cannot delete a remote with a project binding.');
      this.remotesData = this.remotesData.filter((remote) => remote.id !== remoteId);
      this.operationsData = this.operationsData.filter(
        (operation) => operation.remoteId !== remoteId,
      );
    },
    renameRemote: async (remoteId, name) => {
      this.updateRemote(remoteId, { name });
      const renamed = this.remotesData.find((remote) => remote.id === remoteId);
      if (!renamed) throw new Error('VM not found');
      return remoteDto(renamed);
    },
    readReadiness: async () => this.readiness,
    readStatsHistory: async () => ({ intervalMs: 0, samples: [] }),
    powerOn: async (remoteId) => {
      await this.powerOnGate;
      this.updateRemote(remoteId, { powerState: 'running', online: false });
    },
    setApiKey: async () => undefined,
    resetApiKey: async () => undefined,
    listOperations: async (state) =>
      this.operationsData.filter((operation) => operation.state === state),
    readNewestOperation: async (projectId) =>
      [...this.operationsData, ...this.projectHistory].find(
        (operation) => operation.projectId === projectId,
      ) ?? null,
    attachProject: async (remoteId, input) => this.projectOperation('attach', remoteId, input),
    detachProject: async (remoteId, input) => this.projectOperation('detach', remoteId, input),
    forceSync: async (remoteId, input) => this.projectOperation('force-sync', remoteId, input),
    createVm: async (connectionId, input) => {
      const operation = this.startOperation({
        id: 'create-op',
        kind: 'create_vm',
        remoteId: 'r-created',
        details: {
          providerAuth: {
            codex: { choice: 'generate', generationId: 'generation-1', sessionId: 'session-1' },
          },
        },
        steps: [
          step('vm_preflight', 'Check VM settings and permissions', 'done'),
          step('ensure_image', 'Import the host image', 'running'),
          step('ensure_template', 'Prepare the image template'),
          step('clone', 'Clone the VM'),
          step('start', 'Start the VM'),
          step('wait_ip', 'Wait for the guest IP address'),
          step('claim_preflight', 'Check the VM'),
          step('claim_claim', 'Claim and register'),
        ],
      });
      this.remotesData = [
        ...this.remotesData,
        {
          ...REMOTE,
          id: 'r-created',
          name: String(input.name),
          baseUrl: null,
          kind: 'proxmox',
          vmProviderConnectionId: connectionId,
          vmIdentity: null,
          vmSpec: {
            cores: Number(input.cores),
            memory: Number(input.memory),
            disk: Number(input.disk),
          },
        },
      ];
      return operation;
    },
    updateLogins: async (remoteId) =>
      this.startOperation(
        {
          id: 'logins-op',
          kind: 'update_logins',
          remoteId,
          steps: [
            step('preflight', 'Check the VM and its logins', 'running'),
            step('pull_families', 'Save the logins from the VM'),
            step('release_replaced', 'Release replaced logins'),
            step('claim', 'Apply the logins on the VM'),
            step('verify_providers', 'Verify the logins'),
          ],
        },
        this.operationsData.filter((op) => op.id !== 'logins-op'),
      ),
    resetVm: async (remoteId) =>
      this.startOperation({
        id: 'reset-op',
        kind: 'reset_vm',
        remoteId,
        details: { force: true },
        steps: [
          step('preflight', 'Check the VM', 'done'),
          step('pull_families', 'Save the logins from the VM', 'running'),
          step('detach:p1:preflight', 'Disconnect p1: Check connection'),
          step('destroy', 'Destroy the old VM'),
          step('create_vm_preflight', 'Check VM settings and permissions'),
          step('create_vm_ensure_image', 'Import the host image'),
          step('create_vm_clone', 'Clone the VM'),
          step('create_vm_start', 'Start the VM'),
          step('create_vm_wait_ip', 'Wait for the guest IP address'),
          step('create_vm_claim_claim', 'Claim and register'),
          step('attach:p1:preflight', 'Reconnect p1: Check connection'),
        ],
      }),
    destroyVm: async (remoteId, input) =>
      this.startOperation({
        id: 'destroy-op',
        kind: 'destroy_vm',
        remoteId,
        details: {
          force: input.force,
          familyPull: {
            pulled: !input.force,
            families: [{ provider: 'codex', entryId: 'entry-1', lastWritebackAt: null }],
          },
        },
        createdAt: '2026-09-25T00:00:00.000Z',
        steps: [
          step('preflight', 'Check VM ownership and projects', 'running'),
          step('pull_families', 'Save the logins from the VM'),
          step('destroy', 'Destroy the VM'),
        ],
      }),
    claimHost: async (input) =>
      this.startOperation({
        kind: 'claim',
        details: { providerAuth: input.providerAuth },
        steps: [
          step('preflight', 'Check the VM', 'running'),
          step('claim', 'Set up the VM and start DevChain'),
        ],
      }),
    updateHost: async (remoteId, input) =>
      this.startOperation({
        kind: 'update_host',
        remoteId,
        steps: [
          input?.installDocker
            ? step('docker', 'Install Docker Engine and Compose', 'running')
            : step('update', 'Install the new version', 'running'),
        ],
      }),
    installHost: async (input) =>
      this.startOperation({
        kind: 'install_host',
        details: { address: input.address },
        steps: [step('ssh_connect', 'Connect to the VM over SSH', 'running')],
      }),
    retryOperation: async (operationId) => this.changeOperation(operationId, 'retry'),
    cancelOperation: async (operationId) => this.changeOperation(operationId, 'cancel'),
    probeAddress: async () => this.probeResult,
    readHomeIdentity: async () => ({ user: 'devchain', homePath: '/home/devchain' }),
    listLocalSshKeys: async () => this.availableSshKeys,
    listSshPublicKeys: async () => [],
    estimateProjectDisk: async (projectIds) => ({
      projects: projectIds.map((id) => ({ id, bytes: null, approximate: true })),
      requiredDiskGib: 8,
    }),
    readHostInstallBlock: async () => 'install DevChain',
    listVmProviders: async () => this.providerConnectionsData,
    checkVmProviderRights: async () => ({
      ok: this.permissionMissing.length === 0,
      missing: this.permissionMissing,
    }),
    deleteVmProvider: async (connectionId) => {
      const user = this.remotesData.find(
        (remote) => remote.vmProviderConnectionId === connectionId,
      );
      if (user) throw new Error(`${user.name} uses this connection.`);
      this.providerConnectionsData = this.providerConnectionsData.filter(
        (connection) => connection.id !== connectionId,
      );
    },
    readProxmoxSetupBlock: async () => 'pveum pool add devchain',
    previewProxmoxConnection: async () => ({
      confirmationRequired: true,
      fingerprint: PROXMOX_CONNECTION.sslFingerprint,
      placement: {
        apiUrl: PROXMOX_CONNECTION.apiUrl,
        node: PROXMOX_CONNECTION.node,
        pool: PROXMOX_CONNECTION.pool,
        storage: PROXMOX_CONNECTION.storage,
        imageStorage: PROXMOX_CONNECTION.imageStorage,
        bridge: PROXMOX_CONNECTION.bridge,
      },
    }),
    connectProxmox: async () => {
      this.providerConnectionsData = [...this.providerConnectionsData, PROXMOX_CONNECTION];
      return {
        confirmationRequired: false,
        connection: PROXMOX_CONNECTION,
        permissions: { ok: this.permissionMissing.length === 0, missing: this.permissionMissing },
      };
    },
    countRunningAgents: async () => 0,
    listProviderAuthEntries: async () => this.loginEntries,
    createStaticProviderAuth: async (input) => {
      const entry: ProviderAuthEntryItem = {
        id: `entry-${this.loginEntries.length + 1}`,
        provider: input.provider,
        kind: 'static',
        label: input.label,
        payloadKind: 'env',
        checkedOutRemoteId: null,
        createdAt: '',
        updatedAt: '',
        lastVerifiedAt: null,
        lastWritebackAt: null,
      };
      this.loginEntries = [...this.loginEntries, entry];
      return entry;
    },
    importOpencodeLogins: async (providerIds) => ({
      results: providerIds.map((providerId) => ({ providerId, outcome: 'missing' as const })),
    }),
    deleteProviderAuthEntry: async (entryId) => {
      this.loginEntries = this.loginEntries.filter((entry) => entry.id !== entryId);
    },
    renameProviderAuthEntry: async (entryId, label) => this.updateLoginEntry(entryId, { label }),
    releaseProviderAuthEntry: async (entryId) => ({
      entry: this.updateLoginEntry(entryId, { checkedOutRemoteId: null }),
      pullStatus: 'not-needed',
    }),
    listOpencodeLogins: async () => [],
    readProviderAuthGeneration: async (generationId) => {
      const generation = this.generations[generationId];
      if (!generation) throw new Error('Login generation not found');
      return generation;
    },
    startProviderAuthGeneration: async (input) => {
      const generation: ProviderAuthGenerationView = {
        id: `generation-${Object.keys(this.generations).length + 1}`,
        provider: input.provider,
        sessionId: 'session-1',
        state: 'waiting',
        startedAt: '',
        finishedAt: null,
        entries: [],
        error: null,
      };
      this.generations[generation.id] = generation;
      return generation;
    },
    cancelProviderAuthGeneration: async (generationId) => {
      const generation = this.generations[generationId];
      if (!generation) throw new Error('Login generation not found');
      this.generations[generationId] = { ...generation, state: 'cancelled' };
    },
    readProjectFileSyncFailures: async (projectId) =>
      this.fileSyncFailures[projectId] ?? {
        ownerSide: 'vm',
        installedPrefix: ['/.git'],
        home: { entries: [] },
        vm: { entries: [] },
        groups: [],
        overLimit: false,
        forceSync: { offered: false, reason: null, pending: { fromVm: null, fromHome: null } },
      },
    readFileSyncAutoFix: async (projectId) => ({
      enabled: this.autoFixEnabled[projectId] ?? true,
      actions: [],
    }),
    setFileSyncAutoFix: async (projectId, enabled) => {
      this.autoFixEnabled[projectId] = enabled;
      return { enabled, actions: [] };
    },
    readProjectIgnores: async (projectId) => ({
      ignores: this.ignores[projectId] ?? [...DEFAULT_FILE_SYNC_IGNORES],
      revision: this.ignoreRevisions[projectId] ?? 0,
    }),
    saveProjectIgnores: async (projectId, ignores, revision) => {
      if (revision !== (this.ignoreRevisions[projectId] ?? 0))
        throw new FileListChangedError('The file list changed. Review it again.');
      if (this.ignoreSaveError) throw new Error(this.ignoreSaveError);
      if (ignores === null) delete this.ignores[projectId];
      else this.ignores[projectId] = copy(ignores);
      this.ignoreRevisions[projectId] = revision + 1;
      return {
        ignores: this.ignores[projectId] ?? [...DEFAULT_FILE_SYNC_IGNORES],
        revision: revision + 1,
        ...this.ignoreSaveResult,
      };
    },
    readFileSyncSuggestions: async () => ({
      groups: [],
      overLimit: false,
      ownerSide: 'home',
      home: {
        rootPath: '',
        exists: false,
        repository: false,
        projectOwner: null,
        gitState: 'no-repo',
        candidates: [],
        requestedPaths: [],
        entries: [],
      },
      vm: 'unavailable',
    }),
    previewFileSyncPattern: async () => ({
      home: { state: 'no-repo', tracked: null, kept: null },
      vm: { state: 'unavailable', tracked: null, kept: null },
    }),
    giveFileOwnership: async (_projectId, paths) => ({
      user: null,
      items: paths.map((path) => ({ path, state: 'unsupported' as const, paths: [] })),
    }),
    readFileSyncStatus: async () => this.fileSyncStatus,
    readDockerPlan: async () => {
      if (!this.dockerPlanData) throw new Error('The server returned an invalid Docker plan.');
      return this.dockerPlanData as DockerPlan;
    },
    readDockerPresence: async () => ({ state: 'unknown' }),
    readDockerSyncState: async () => null,
    readConnectChoices: async () => ({ remoteId: undefined, includeDocker: false, git: 'present' }),
  };

  readonly listRemotes = this.method('listRemotes');
  readonly listBindings = this.method('listBindings');
  readonly createRemote = this.method('createRemote');
  readonly deleteRemote = this.method('deleteRemote');
  readonly renameRemote = this.method('renameRemote');
  readonly readReadiness = this.method('readReadiness');
  readonly readStatsHistory = this.method('readStatsHistory');
  readonly powerOn = this.method('powerOn');
  readonly setApiKey = this.method('setApiKey');
  readonly resetApiKey = this.method('resetApiKey');
  readonly listOperations = this.method('listOperations');
  readonly readNewestOperation = this.method('readNewestOperation');
  readonly attachProject = this.method('attachProject');
  readonly detachProject = this.method('detachProject');
  readonly forceSync = this.method('forceSync');
  readonly updateHost = this.method('updateHost');
  readonly createVm = this.method('createVm');
  readonly installHost = this.method('installHost');
  readonly resetVm = this.method('resetVm');
  readonly destroyVm = this.method('destroyVm');
  readonly updateLogins = this.method('updateLogins');
  readonly claimHost = this.method('claimHost');
  readonly retryOperation = this.method('retryOperation');
  readonly cancelOperation = this.method('cancelOperation');
  readonly probeAddress = this.method('probeAddress');
  readonly readHomeIdentity = this.method('readHomeIdentity');
  readonly listLocalSshKeys = this.method('listLocalSshKeys');
  readonly listSshPublicKeys = this.method('listSshPublicKeys');
  readonly estimateProjectDisk = this.method('estimateProjectDisk');
  readonly readHostInstallBlock = this.method('readHostInstallBlock');
  readonly listVmProviders = this.method('listVmProviders');
  readonly checkVmProviderRights = this.method('checkVmProviderRights');
  readonly deleteVmProvider = this.method('deleteVmProvider');
  readonly readProxmoxSetupBlock = this.method('readProxmoxSetupBlock');
  readonly previewProxmoxConnection = this.method('previewProxmoxConnection');
  readonly connectProxmox = this.method('connectProxmox');
  readonly countRunningAgents = this.method('countRunningAgents');
  readonly listProviderAuthEntries = this.method('listProviderAuthEntries');
  readonly createStaticProviderAuth = this.method('createStaticProviderAuth');
  readonly importOpencodeLogins = this.method('importOpencodeLogins');
  readonly deleteProviderAuthEntry = this.method('deleteProviderAuthEntry');
  readonly renameProviderAuthEntry = this.method('renameProviderAuthEntry');
  readonly releaseProviderAuthEntry = this.method('releaseProviderAuthEntry');
  readonly listOpencodeLogins = this.method('listOpencodeLogins');
  readonly readProviderAuthGeneration = this.method('readProviderAuthGeneration');
  readonly startProviderAuthGeneration = this.method('startProviderAuthGeneration');
  readonly cancelProviderAuthGeneration = this.method('cancelProviderAuthGeneration');
  readonly readProjectFileSyncFailures = this.method('readProjectFileSyncFailures');
  readonly readFileSyncAutoFix = this.method('readFileSyncAutoFix');
  readonly setFileSyncAutoFix = this.method('setFileSyncAutoFix');
  readonly readProjectIgnores = this.method('readProjectIgnores');
  readonly saveProjectIgnores = this.method('saveProjectIgnores');
  readonly readFileSyncSuggestions = this.method('readFileSyncSuggestions');
  readonly previewFileSyncPattern = this.method('previewFileSyncPattern');
  readonly giveFileOwnership = this.method('giveFileOwnership');
  readonly readFileSyncStatus = this.method('readFileSyncStatus');
  readonly readDockerPlan = this.method('readDockerPlan');
  readonly readDockerPresence = this.method('readDockerPresence');
  readonly readDockerSyncState = this.method('readDockerSyncState');
  readonly readConnectChoices = this.method('readConnectChoices');

  private method<K extends keyof RemoteVmApi>(name: K): RemoteVmApi[K] {
    return (async (...args: MethodArgs<K>): Promise<MethodResult<K>> => {
      // Hooks scrub credential objects immediately; calls retain independent request snapshots.
      const request = copy(args);
      this.calls[name].push(request);
      const values = copy(request);
      const override = this.overrides[name];
      if (override instanceof Error) throw override;
      const fallback = this.defaults[name] as (
        ...values: MethodArgs<K>
      ) => Promise<MethodResult<K>>;
      let result: unknown;
      if (override === undefined) {
        result = await fallback(...values);
      } else if (typeof override === 'function') {
        result = await (
          override as (...values: MethodArgs<K>) => MethodResult<K> | Promise<MethodResult<K>>
        )(...values);
      } else {
        result = await override;
      }
      return copy(result) as MethodResult<K>;
    }) as RemoteVmApi[K];
  }

  private projectOperation(
    action: 'attach' | 'detach' | 'force-sync',
    remoteId: string,
    input: { projectId: string; source?: string },
  ): RemoteOperationDto {
    const fields: Partial<RemoteOperationDto> = {
      id: `${action}-op`,
      kind: action === 'force-sync' ? 'force_sync' : action,
      remoteId,
      projectId: input.projectId,
    };
    if (action === 'force-sync') {
      fields.details = { source: input.source, forceSync: { source: input.source } };
      fields.steps = [
        step('preflight', 'Check the VM and the project', 'running'),
        step('force_copy', 'Copy files'),
      ];
    } else
      this.bindingsData = [
        {
          projectId: input.projectId,
          remoteId,
          state: action === 'attach' ? 'attaching' : 'detaching',
        },
      ];
    return this.startOperation(fields);
  }

  /**
   * A running operation that replaces the open ones, or follows `others`.
   * Host operations have no project and keep the seed remote unless one is given.
   */
  private startOperation(
    fields: Partial<RemoteOperationDto>,
    others: RemoteOperationDto[] = [],
  ): RemoteOperationDto {
    const operation: RemoteOperationDto = { ...makeOperation(), projectId: null, ...fields };
    this.operationsData = [...others, operation];
    return operation;
  }

  private updateRemote(remoteId: string, patch: Partial<TestRemote>): void {
    this.remotesData = this.remotesData.map((remote) =>
      remote.id === remoteId ? { ...remote, ...patch } : remote,
    );
  }

  private updateLoginEntry(
    entryId: string,
    patch: Partial<ProviderAuthEntryItem>,
  ): ProviderAuthEntryItem {
    const entry = this.loginEntries.find((item) => item.id === entryId);
    if (!entry) throw new Error('Login not found');
    const updated = { ...entry, ...patch };
    this.loginEntries = this.loginEntries.map((item) => (item.id === entryId ? updated : item));
    return updated;
  }

  private changeOperation(operationId: string, action: 'retry' | 'cancel'): RemoteOperationDto {
    const current =
      this.operationsData.find((operation) => operation.id === operationId) ?? makeOperation();
    const operation: RemoteOperationDto =
      action === 'cancel'
        ? { ...current, state: 'cancelled' }
        : {
            ...current,
            state: 'running',
            steps: current.steps.map((step) => ({ ...step, state: 'running', error: null })),
          };
    if (action === 'cancel') {
      this.bindingsData = [];
      this.updateRemote(operation.remoteId, {
        lastOperation: {
          id: operation.id,
          kind: operation.kind,
          state: operation.state,
          updatedAt: operation.updatedAt,
        },
      });
    }
    this.operationsData = [
      operation,
      ...this.operationsData.filter((candidate) => candidate.id !== operation.id),
    ];
    return operation;
  }
}

export type InMemoryRemoteVmApiSeed = Pick<
  InMemoryRemoteVmApi,
  | 'remotesData'
  | 'bindingsData'
  | 'operationsData'
  | 'projectHistory'
  | 'readiness'
  | 'providerConnectionsData'
  | 'permissionMissing'
  | 'fileSyncStatus'
  | 'availableSshKeys'
  | 'dockerPlanData'
  | 'powerOnGate'
  | 'probeResult'
  | 'ignores'
  | 'fileSyncFailures'
  | 'ignoreSaveError'
  | 'ignoreSaveResult'
  | 'loginEntries'
>;
