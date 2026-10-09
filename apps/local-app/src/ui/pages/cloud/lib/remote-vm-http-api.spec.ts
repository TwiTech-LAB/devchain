import { apiFetch, HOME_BACKEND } from '@/ui/lib/api-transport';
import type { RemoteVmApi } from './remote-vm-api';
import type {
  CreateRemoteInput,
  InstallHostRequestBody,
  RemoteOperationDto,
} from './remote-vm-contracts';
import { remoteVmHttpApi } from './remote-vm-http-api';
import { ProviderAuthApiError, FileListChangedError } from './remote-vm-errors';
import { FILE_SYNC_IGNORES_CHANGED } from '@/modules/file-sync/file-sync.dto';
import { ZodError } from 'zod';

jest.mock('@/ui/lib/api-transport', () => ({ apiFetch: jest.fn(), HOME_BACKEND: 'home' }));

const transport = jest.mocked(apiFetch);

function response(body: unknown, ok = true, status = ok ? 200 : 503): Response {
  return { ok, status, json: jest.fn(async () => body) } as unknown as Response;
}

function rejectedJson(ok: boolean): Response {
  return {
    ok,
    status: ok ? 200 : 503,
    json: jest.fn(async () => {
      throw new SyntaxError('invalid json');
    }),
  } as unknown as Response;
}

const remote = { id: 'vm', name: 'Lab VM' };
const binding = { projectId: 'project', remoteId: 'vm', state: 'remote' };
const operation: RemoteOperationDto = {
  id: 'operation',
  kind: 'attach',
  remoteId: 'vm',
  projectId: 'project',
  state: 'running',
  steps: [],
  details: {},
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};
const registration: CreateRemoteInput = {
  name: 'Lab VM',
  baseUrl: 'https://lab:3000',
  certificateFingerprint: 'SHA256:certificate',
  apiKey: 'candidate-key',
};
const install: InstallHostRequestBody = {
  address: 'lab',
  ssh: { user: 'alice', keyName: 'id_ed25519', passphrase: 'password', sudoPassword: 'sudo' },
  name: 'Lab VM',
  providerAuth: { claude: 'generate' },
  installDocker: true,
  sshPublicKeys: ['ssh-ed25519 public-key'],
  minDiskGib: 8,
};
const placement = {
  apiUrl: 'https://proxmox:8006',
  node: 'pve',
  pool: 'devchain',
  storage: 'local-lvm',
  imageStorage: 'local',
  bridge: 'vmbr0',
};
const preview = { confirmationRequired: true, fingerprint: 'AA:BB', placement };
const connected = {
  confirmationRequired: false,
  connection: { id: 'connection' },
  permissions: { ok: true, missing: [] },
};
const localKey = { name: 'id_ed25519', type: 'ssh-ed25519', encrypted: true };
const publicKey = {
  name: 'id_ed25519.pub',
  type: 'ssh-ed25519',
  fingerprint: 'SHA256:public-key',
  comment: 'alice',
  content: 'ssh-ed25519 public-key alice',
};

interface HttpCase {
  invoke: (api: RemoteVmApi, signal: AbortSignal) => Promise<unknown>;
  url: string;
  init: (signal: AbortSignal) => RequestInit;
  backend: string;
  response: unknown;
  result: unknown;
  fallback: string | null;
  serverMessage: boolean;
  failureResult?: unknown;
  providerAuthError?: boolean;
}

const post = (body?: unknown): RequestInit =>
  body === undefined
    ? { method: 'POST' }
    : {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      };
const get = (signal: AbortSignal): RequestInit => ({ signal });
const operationFailure = 'Remote operation request failed (503)';

// The adapter is the cheapest layer that owns exact requests and response/error semantics.
const cases = {
  listRemotes: {
    invoke: (api, signal) => api.listRemotes(signal),
    url: '/api/remotes',
    init: get,
    backend: HOME_BACKEND,
    response: { items: [remote] },
    result: [remote],
    fallback: 'Failed to load remotes (503)',
    serverMessage: true,
  },
  listBindings: {
    invoke: (api, signal) => api.listBindings(signal),
    url: '/api/remotes/bindings',
    init: get,
    backend: HOME_BACKEND,
    response: { items: [binding] },
    result: [binding],
    fallback: 'Failed to load remote bindings (503)',
    serverMessage: true,
  },
  createRemote: {
    invoke: (api) => api.createRemote(registration),
    url: '/api/remotes',
    init: () => post(registration),
    backend: HOME_BACKEND,
    response: remote,
    result: remote,
    fallback: 'Failed to add the VM',
    serverMessage: true,
  },
  deleteRemote: {
    invoke: (api) => api.deleteRemote('vm'),
    url: '/api/remotes/vm',
    init: () => ({ method: 'DELETE' }),
    backend: HOME_BACKEND,
    response: null,
    result: undefined,
    fallback: 'Failed to delete remote',
    serverMessage: true,
  },
  renameRemote: {
    invoke: (api) => api.renameRemote('vm', 'New name'),
    url: '/api/remotes/vm',
    init: () => ({
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: '{"name":"New name"}',
    }),
    backend: HOME_BACKEND,
    response: remote,
    result: remote,
    fallback: 'Failed to rename the VM',
    serverMessage: true,
  },
  readReadiness: {
    invoke: (api, signal) => api.readReadiness(signal),
    url: '/api/remotes/readiness',
    init: get,
    backend: HOME_BACKEND,
    response: { syncthing: { ready: true }, identity: { user: 'alice' }, docker: { ready: true } },
    result: { syncthing: { ready: true }, identity: { user: 'alice' }, docker: { ready: true } },
    fallback: 'Could not check this PC (503)',
    serverMessage: false,
  },
  readStatsHistory: {
    invoke: (api, signal) => api.readStatsHistory('vm', signal),
    url: '/api/remotes/vm/stats/history',
    init: get,
    backend: HOME_BACKEND,
    response: { intervalMs: 1000, samples: [{ timestamp: 'sample' }] },
    result: { intervalMs: 1000, samples: [{ timestamp: 'sample' }] },
    fallback: 'Failed to load remote stats history (503)',
    serverMessage: false,
  },
  powerOn: {
    invoke: (api) => api.powerOn('vm'),
    url: '/api/remotes/vm/power-on',
    init: () => post(),
    backend: HOME_BACKEND,
    response: null,
    result: undefined,
    fallback: 'Power on failed (503)',
    serverMessage: true,
  },
  setApiKey: {
    invoke: (api) => api.setApiKey('vm', 'candidate-key'),
    url: '/api/remotes/vm/api-key',
    init: () => ({
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '{"apiKey":"candidate-key"}',
    }),
    backend: HOME_BACKEND,
    response: null,
    result: undefined,
    fallback: 'Could not change the VM API key.',
    serverMessage: true,
  },
  resetApiKey: {
    invoke: (api) => api.resetApiKey('vm'),
    url: '/api/remotes/vm/api-key/reset',
    init: () => post({}),
    backend: HOME_BACKEND,
    response: null,
    result: undefined,
    fallback: 'Could not change the VM API key.',
    serverMessage: true,
  },
  listOperations: {
    invoke: (api, signal) => api.listOperations('running', 200, signal),
    url: '/api/remotes/operations?state=running&limit=200',
    init: get,
    backend: HOME_BACKEND,
    response: { items: [operation] },
    result: [operation],
    fallback: operationFailure,
    serverMessage: true,
  },
  readNewestOperation: {
    invoke: (api, signal) => api.readNewestOperation('project /?#', signal),
    url: '/api/remotes/operations?projectId=project%20%2F%3F%23&limit=1',
    init: get,
    backend: HOME_BACKEND,
    response: { items: [operation, { id: 'older' }] },
    result: operation,
    fallback: "Could not load the project's last operation (503)",
    serverMessage: false,
  },
  attachProject: {
    invoke: (api) =>
      api.attachProject('vm', {
        projectId: 'project',
        docker: { items: [{ id: 'container', mode: 'without-data' }] },
      }),
    url: '/api/remotes/vm/attach',
    init: () =>
      post({
        projectId: 'project',
        docker: { items: [{ id: 'container', mode: 'without-data' }] },
      }),
    backend: HOME_BACKEND,
    response: operation,
    result: operation,
    fallback: operationFailure,
    serverMessage: true,
  },
  detachProject: {
    invoke: (api) =>
      api.detachProject('vm', {
        projectId: 'project',
        force: true,
        dockerCopyBack: { choices: { group: 'copy-home' } },
      }),
    url: '/api/remotes/vm/detach',
    init: () =>
      post({
        projectId: 'project',
        force: true,
        dockerCopyBack: { choices: { group: 'copy-home' } },
      }),
    backend: HOME_BACKEND,
    response: operation,
    result: operation,
    fallback: operationFailure,
    serverMessage: true,
  },
  forceSync: {
    invoke: (api) => api.forceSync('vm', { projectId: 'project', source: 'vm' }),
    url: '/api/remotes/vm/force-sync',
    init: () => post({ projectId: 'project', source: 'vm' }),
    backend: HOME_BACKEND,
    response: operation,
    result: operation,
    fallback: operationFailure,
    serverMessage: true,
  },
  updateHost: {
    invoke: (api) => api.updateHost('vm', { installDocker: true }),
    url: '/api/remotes/vm/update',
    init: () => post({ installDocker: true }),
    backend: HOME_BACKEND,
    response: operation,
    result: operation,
    fallback: operationFailure,
    serverMessage: true,
  },
  createVm: {
    invoke: (api) =>
      api.createVm('connection', {
        name: 'Lab VM',
        cores: 2,
        memory: 4096,
        disk: 16,
        providerAuth: { claude: 'generate' },
      }),
    url: '/api/vm-providers/connection/create-vm',
    init: () =>
      post({
        name: 'Lab VM',
        cores: 2,
        memory: 4096,
        disk: 16,
        providerAuth: { claude: 'generate' },
      }),
    backend: HOME_BACKEND,
    response: operation,
    result: operation,
    fallback: operationFailure,
    serverMessage: true,
  },
  installHost: {
    invoke: (api) => api.installHost(install),
    url: '/api/remotes/host-install',
    init: () => post(install),
    backend: HOME_BACKEND,
    response: operation,
    result: operation,
    fallback: operationFailure,
    serverMessage: true,
  },
  resetVm: {
    invoke: (api) =>
      api.resetVm('vm', {
        force: false,
        providerAuth: {},
        installDocker: false,
        sshPublicKeys: [],
      }),
    url: '/api/remotes/vm/reset',
    init: () => post({ force: false, providerAuth: {}, installDocker: false, sshPublicKeys: [] }),
    backend: HOME_BACKEND,
    response: operation,
    result: operation,
    fallback: operationFailure,
    serverMessage: true,
  },
  destroyVm: {
    invoke: (api) => api.destroyVm('vm', { force: false }),
    url: '/api/remotes/vm/destroy-vm',
    init: () => post({ force: false }),
    backend: HOME_BACKEND,
    response: operation,
    result: operation,
    fallback: operationFailure,
    serverMessage: true,
  },
  updateLogins: {
    invoke: (api) => api.updateLogins('vm', { providerAuth: { claude: 'skip' }, force: true }),
    url: '/api/remotes/vm/logins',
    init: () => post({ providerAuth: { claude: 'skip' }, force: true }),
    backend: HOME_BACKEND,
    response: operation,
    result: operation,
    fallback: operationFailure,
    serverMessage: true,
  },
  claimHost: {
    invoke: (api) =>
      api.claimHost({
        baseUrl: 'https://lab:3000',
        certificateFingerprint: 'SHA256:certificate',
        providerAuth: {},
        installDocker: true,
        sshPublicKeys: [],
      }),
    url: '/api/remotes/claim',
    init: () =>
      post({
        baseUrl: 'https://lab:3000',
        certificateFingerprint: 'SHA256:certificate',
        providerAuth: {},
        installDocker: true,
        sshPublicKeys: [],
      }),
    backend: HOME_BACKEND,
    response: operation,
    result: operation,
    fallback: operationFailure,
    serverMessage: true,
  },
  retryOperation: {
    invoke: (api) =>
      api.retryOperation('operation', {
        providerAuth: { claude: 'generate' },
        ssh: { user: 'alice', password: 'password' },
      }),
    url: '/api/remotes/operations/operation/retry',
    init: () =>
      post({ providerAuth: { claude: 'generate' }, ssh: { user: 'alice', password: 'password' } }),
    backend: HOME_BACKEND,
    response: operation,
    result: operation,
    fallback: operationFailure,
    serverMessage: true,
  },
  cancelOperation: {
    invoke: (api) => api.cancelOperation('operation'),
    url: '/api/remotes/operations/operation/cancel',
    init: () => post(),
    backend: HOME_BACKEND,
    response: operation,
    result: operation,
    fallback: operationFailure,
    serverMessage: true,
  },
  probeAddress: {
    invoke: (api, signal) => api.probeAddress('lab:3000', { checkSsh: true, signal }),
    url: '/api/remotes/probe',
    init: (signal) => ({ ...post({ address: 'lab:3000', checkSsh: true }), signal }),
    backend: HOME_BACKEND,
    response: { kind: 'nothing', tried: ['https://lab:3000'], sshReachable: true },
    result: { kind: 'nothing', tried: ['https://lab:3000'], sshReachable: true },
    fallback: 'The address check failed.',
    serverMessage: true,
  },
  readHomeIdentity: {
    invoke: (api, signal) => api.readHomeIdentity(signal),
    url: '/api/remotes/host-install/identity',
    init: get,
    backend: HOME_BACKEND,
    response: { user: 'alice', homePath: '/home/alice' },
    result: { user: 'alice', homePath: '/home/alice' },
    fallback: 'identity unavailable',
    serverMessage: false,
  },
  listLocalSshKeys: {
    invoke: (api) => api.listLocalSshKeys(),
    url: '/api/remotes/host-install/ssh-keys',
    init: () => ({}),
    backend: HOME_BACKEND,
    response: { available: true, keys: [localKey] },
    result: [localKey],
    fallback: null,
    serverMessage: false,
  },
  listSshPublicKeys: {
    invoke: (api, signal) => api.listSshPublicKeys(signal),
    url: '/api/remotes/host-install/ssh-public-keys',
    init: get,
    backend: HOME_BACKEND,
    response: { available: true, keys: [publicKey] },
    result: [publicKey],
    fallback: null,
    serverMessage: false,
  },
  estimateProjectDisk: {
    invoke: (api) => api.estimateProjectDisk(['project']),
    url: '/api/remotes/host-install/estimate',
    init: () => post({ projectIds: ['project'] }),
    backend: HOME_BACKEND,
    response: { projects: [{ id: 'project', bytes: 100, approximate: false }], requiredDiskGib: 9 },
    result: { projects: [{ id: 'project', bytes: 100, approximate: false }], requiredDiskGib: 9 },
    fallback: 'Could not measure project sizes.',
    serverMessage: true,
  },
  readHostInstallBlock: {
    invoke: (api, signal) => api.readHostInstallBlock(8, signal),
    url: '/api/remotes/host-install/block?minDiskGib=8',
    init: get,
    backend: HOME_BACKEND,
    response: { block: 'install block' },
    result: 'install block',
    fallback: 'Could not generate the install block.',
    serverMessage: true,
  },
  listVmProviders: {
    invoke: (api, signal) => api.listVmProviders(signal),
    url: '/api/vm-providers',
    init: get,
    backend: HOME_BACKEND,
    response: { items: [{ id: 'connection' }] },
    result: [{ id: 'connection' }],
    fallback: 'Failed to load VM providers (503)',
    serverMessage: true,
  },
  checkVmProviderRights: {
    invoke: (api) => api.checkVmProviderRights('connection /?#'),
    url: '/api/vm-providers/connection%20%2F%3F%23/check',
    init: () => post(),
    backend: HOME_BACKEND,
    response: { ok: false, missing: ['VM.Allocate'] },
    result: { ok: false, missing: ['VM.Allocate'] },
    fallback: 'The rights check failed.',
    serverMessage: true,
  },
  deleteVmProvider: {
    invoke: (api) => api.deleteVmProvider('connection /?#'),
    url: '/api/vm-providers/connection%20%2F%3F%23',
    init: () => ({ method: 'DELETE' }),
    backend: HOME_BACKEND,
    response: null,
    result: undefined,
    fallback: 'Could not remove the server.',
    serverMessage: true,
  },
  readProxmoxSetupBlock: {
    invoke: (api) =>
      api.readProxmoxSetupBlock({
        node: ' pve ',
        address: ' ',
        pool: '',
        storage: ' local lvm ',
        imageStorage: 'local',
        bridge: 'vmbr0',
      }),
    url: '/api/vm-providers/proxmox/setup-block?node=pve&storage=local+lvm&imageStorage=local&bridge=vmbr0',
    init: () => ({}),
    backend: HOME_BACKEND,
    response: { block: 'setup block' },
    result: 'setup block',
    fallback: 'Could not generate the setup block.',
    serverMessage: true,
  },
  previewProxmoxConnection: {
    invoke: (api) => api.previewProxmoxConnection(' connection string '),
    url: '/api/vm-providers/proxmox/connect',
    init: () => post({ connectionString: 'connection string' }),
    backend: HOME_BACKEND,
    response: preview,
    result: preview,
    fallback: 'Could not read the connection string.',
    serverMessage: true,
  },
  connectProxmox: {
    invoke: (api) => api.connectProxmox(' connection string '),
    url: '/api/vm-providers/proxmox/connect',
    init: () => post({ connectionString: 'connection string', confirmFingerprint: true }),
    backend: HOME_BACKEND,
    response: connected,
    result: connected,
    fallback: 'Could not connect Proxmox.',
    serverMessage: true,
  },
  countRunningAgents: {
    invoke: (api, signal) => api.countRunningAgents('vm', signal),
    url: '/api/sessions',
    init: get,
    backend: 'vm',
    response: [
      { status: 'running', agentId: 'agent' },
      { status: 'running', agentId: null },
      { status: 'stopped', agentId: 'agent' },
      { status: 'running', agentId: 'second' },
    ],
    result: 2,
    fallback: 'session list unavailable',
    serverMessage: false,
  },
  listProviderAuthEntries: {
    invoke: (api, signal) => api.listProviderAuthEntries(signal),
    url: '/api/provider-auth',
    init: get,
    backend: HOME_BACKEND,
    response: { items: [{ id: 'entry', provider: 'claude', label: 'Login' }] },
    result: [{ id: 'entry', provider: 'claude', label: 'Login' }],
    fallback: 'Provider auth request failed (503)',
    serverMessage: true,
    providerAuthError: true,
  },
  createStaticProviderAuth: {
    invoke: (api) =>
      api.createStaticProviderAuth({ provider: 'codex', label: 'Token', token: 'token-value' }),
    url: '/api/provider-auth/static',
    init: () => post({ provider: 'codex', label: 'Token', token: 'token-value' }),
    backend: HOME_BACKEND,
    response: { id: 'entry', label: 'Token' },
    result: { id: 'entry', label: 'Token' },
    fallback: 'Provider auth request failed (503)',
    serverMessage: true,
    providerAuthError: true,
  },
  importOpencodeLogins: {
    invoke: (api) => api.importOpencodeLogins(['claude', 'codex']),
    url: '/api/provider-auth/opencode-import',
    init: () => post({ providerIds: ['claude', 'codex'] }),
    backend: HOME_BACKEND,
    response: { results: [{ providerId: 'claude', outcome: 'imported', entryId: 'entry' }] },
    result: { results: [{ providerId: 'claude', outcome: 'imported', entryId: 'entry' }] },
    fallback: 'Provider auth request failed (503)',
    serverMessage: true,
    providerAuthError: true,
  },
  deleteProviderAuthEntry: {
    invoke: (api) => api.deleteProviderAuthEntry('entry'),
    url: '/api/provider-auth/entry',
    init: () => ({ method: 'DELETE' }),
    backend: HOME_BACKEND,
    response: null,
    result: undefined,
    fallback: 'Provider auth request failed (503)',
    serverMessage: true,
    providerAuthError: true,
  },
  renameProviderAuthEntry: {
    invoke: (api) => api.renameProviderAuthEntry('entry', 'New label'),
    url: '/api/provider-auth/entry',
    init: () => ({
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: '{"label":"New label"}',
    }),
    backend: HOME_BACKEND,
    response: { id: 'entry', label: 'New label' },
    result: { id: 'entry', label: 'New label' },
    fallback: 'Provider auth request failed (503)',
    serverMessage: true,
    providerAuthError: true,
  },
  releaseProviderAuthEntry: {
    invoke: (api) => api.releaseProviderAuthEntry('entry'),
    url: '/api/provider-auth/entry/release',
    init: () => post({}),
    backend: HOME_BACKEND,
    response: { entry: { id: 'entry' }, pullStatus: 'offline' },
    result: { entry: { id: 'entry' }, pullStatus: 'offline' },
    fallback: 'Provider auth request failed (503)',
    serverMessage: true,
    providerAuthError: true,
  },
  listOpencodeLogins: {
    invoke: (api, signal) => api.listOpencodeLogins(signal),
    url: '/api/provider-auth/opencode-logins',
    init: get,
    backend: HOME_BACKEND,
    response: { logins: [{ id: 'claude', type: 'oauth', imported: false }] },
    result: [{ id: 'claude', type: 'oauth', imported: false }],
    fallback: 'Provider auth request failed (503)',
    serverMessage: true,
    providerAuthError: true,
  },
  readProviderAuthGeneration: {
    invoke: (api, signal) => api.readProviderAuthGeneration('generation', signal),
    url: '/api/provider-auth/generate/generation',
    init: get,
    backend: HOME_BACKEND,
    response: { id: 'generation', state: 'stored', entries: [{ id: 'entry' }] },
    result: { id: 'generation', state: 'stored', entries: [{ id: 'entry' }] },
    fallback: 'Provider auth request failed (503)',
    serverMessage: true,
    providerAuthError: true,
  },
  startProviderAuthGeneration: {
    invoke: (api) => api.startProviderAuthGeneration({ provider: 'claude', label: 'Login' }),
    url: '/api/provider-auth/generate',
    init: () => post({ provider: 'claude', label: 'Login' }),
    backend: HOME_BACKEND,
    response: { id: 'generation', state: 'waiting' },
    result: { id: 'generation', state: 'waiting' },
    fallback: 'Provider auth request failed (503)',
    serverMessage: true,
    providerAuthError: true,
  },
  cancelProviderAuthGeneration: {
    invoke: (api) => api.cancelProviderAuthGeneration('generation'),
    url: '/api/provider-auth/generate/generation/cancel',
    init: () => post(),
    backend: HOME_BACKEND,
    response: { id: 'generation', state: 'cancelled' },
    result: undefined,
    fallback: 'Provider auth request failed (503)',
    serverMessage: true,
    providerAuthError: true,
  },
  readProjectFileSyncFailures: {
    invoke: (api, signal) => api.readProjectFileSyncFailures('project /?#', signal),
    url: '/api/projects/project%20%2F%3F%23/file-sync/failed',
    init: get,
    backend: HOME_BACKEND,
    response: {
      home: { entries: [{ path: 'file', error: 'permission denied' }] },
      vm: { entries: [] },
      installedPrefix: ['/.git'],
      groups: [],
    },
    result: {
      home: { entries: [{ path: 'file', error: 'permission denied' }] },
      vm: { entries: [] },
      installedPrefix: ['/.git'],
      groups: [],
    },
    fallback: 'Could not read file sync failures.',
    serverMessage: true,
  },
  readFileSyncAutoFix: {
    invoke: (api, signal) => api.readFileSyncAutoFix('project /?#', signal),
    url: '/api/projects/project%20%2F%3F%23/file-sync/auto-fix',
    init: get,
    backend: HOME_BACKEND,
    response: { enabled: true, actions: [], extra: 'not in schema' },
    result: { enabled: true, actions: [] },
    fallback: 'Could not read automatic file sync settings.',
    serverMessage: true,
  },
  setFileSyncAutoFix: {
    invoke: (api) => api.setFileSyncAutoFix('project /?#', false),
    url: '/api/projects/project%20%2F%3F%23/file-sync/auto-fix',
    init: () => ({
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '{"enabled":false}',
    }),
    backend: HOME_BACKEND,
    response: { enabled: false, actions: [], extra: 'not in schema' },
    result: { enabled: false, actions: [] },
    fallback: 'Could not save automatic file sync settings.',
    serverMessage: true,
  },
  readProjectIgnores: {
    invoke: (api, signal) => api.readProjectIgnores('project /?#', signal),
    url: '/api/file-sync/projects/project%20%2F%3F%23/ignores',
    init: get,
    backend: HOME_BACKEND,
    response: { ignores: ['node_modules'], revision: 3 },
    result: { ignores: ['node_modules'], revision: 3 },
    fallback: 'Could not read the file list.',
    serverMessage: true,
  },
  saveProjectIgnores: {
    invoke: (api) => api.saveProjectIgnores('project /?#', ['node_modules'], 3),
    url: '/api/projects/project%20%2F%3F%23/file-sync/ignores',
    init: () => ({
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '{"ignores":["node_modules"],"revision":3}',
    }),
    backend: HOME_BACKEND,
    response: { ignores: ['node_modules'], revision: 4, applied: true, message: 'Saved' },
    result: { ignores: ['node_modules'], revision: 4, applied: true, message: 'Saved' },
    fallback: 'Could not save the file list.',
    serverMessage: true,
  },
  readFileSyncSuggestions: {
    invoke: (api, signal) => api.readFileSyncSuggestions('project /?#', 'vm', signal),
    url: '/api/projects/project%20%2F%3F%23/file-sync/suggestions',
    init: (signal) => ({ ...post({ remoteId: 'vm' }), signal }),
    backend: HOME_BACKEND,
    response: { groups: [], warnings: ['Warning'] },
    result: { groups: [], warnings: ['Warning'] },
    fallback: 'Scan failed',
    serverMessage: false,
  },
  previewFileSyncPattern: {
    invoke: (api, signal) => api.previewFileSyncPattern('project /?#', ' node_modules/** ', signal),
    url: '/api/projects/project%20%2F%3F%23/file-sync/pattern-preview',
    init: (signal) => ({ ...post({ pattern: ' node_modules/** ' }), signal }),
    backend: HOME_BACKEND,
    response: {
      home: { state: 'no-repo', tracked: null, kept: null },
      vm: { state: 'unavailable', tracked: null, kept: null },
    },
    result: {
      home: { state: 'no-repo', tracked: null, kept: null },
      vm: { state: 'unavailable', tracked: null, kept: null },
    },
    fallback: 'Could not preview this pattern.',
    serverMessage: true,
  },
  giveFileOwnership: {
    invoke: (api) => api.giveFileOwnership('project /?#', ['build/out', 'tmp/cache']),
    url: '/api/projects/project%20%2F%3F%23/file-sync/give-ownership',
    init: () => post({ paths: ['build/out', 'tmp/cache'] }),
    backend: HOME_BACKEND,
    response: {
      user: null,
      items: [{ path: 'build/out', state: 'repaired', paths: ['build/out'] }],
      extra: 'not in schema',
    },
    result: { user: null, items: [{ path: 'build/out', state: 'repaired', paths: ['build/out'] }] },
    fallback: 'Could not change VM file owners.',
    serverMessage: true,
  },
  readFileSyncStatus: {
    invoke: (api, signal) => api.readFileSyncStatus('project /?#', signal),
    url: '/api/file-sync/projects/project%20%2F%3F%23/status',
    init: get,
    backend: HOME_BACKEND,
    response: { folders: [{ id: 'code:project', needItems: 2, needBytes: 100 }] },
    result: { folders: [{ id: 'code:project', needItems: 2, needBytes: 100 }] },
    fallback: null,
    serverMessage: false,
    failureResult: { folders: null },
  },
  readDockerPlan: {
    invoke: (api, signal) =>
      api.readDockerPlan(
        'project /?#',
        {
          remoteId: 'vm',
          items: [
            {
              id: 'container',
              mode: 'data-only',
              dataChoice: 'replace-home',
              acceptPrivileged: true,
            },
          ],
        },
        signal,
      ),
    url: '/api/projects/project%20%2F%3F%23/docker/plan',
    init: (signal) => ({
      ...post({
        remoteId: 'vm',
        items: [
          {
            id: 'container',
            mode: 'data-only',
            dataChoice: 'replace-home',
            acceptPrivileged: true,
          },
        ],
      }),
      signal,
    }),
    backend: HOME_BACKEND,
    response: { canConnect: true, fit: 'fits', items: [], availability: { available: true } },
    result: { canConnect: true, fit: 'fits', items: [], availability: { available: true } },
    fallback: 'The Docker plan failed (503)',
    serverMessage: true,
  },
  readDockerPresence: {
    invoke: (api, signal) => api.readDockerPresence('project /?#', signal),
    url: '/api/projects/project%20%2F%3F%23/docker/presence',
    init: get,
    backend: HOME_BACKEND,
    response: { state: 'unknown' },
    result: { state: 'unknown' },
    fallback: 'Could not read Docker presence.',
    serverMessage: true,
  },
  readDockerSyncState: {
    invoke: (api, signal) => api.readDockerSyncState('project /?#', 'vm', signal),
    url: '/api/projects/project%20%2F%3F%23/docker/sync-state',
    init: (signal) => ({ ...post({ remoteId: 'vm' }), signal }),
    backend: HOME_BACKEND,
    response: { availability: { available: true }, imported: true, groups: [] },
    result: { availability: { available: true }, imported: true, groups: [] },
    fallback: null,
    serverMessage: false,
    failureResult: null,
  },
  readConnectChoices: {
    invoke: (api, signal) => api.readConnectChoices('project /?#', signal),
    url: '/api/projects/project%20%2F%3F%23/connect-choices',
    init: get,
    backend: HOME_BACKEND,
    response: { remoteId: 'vm', includeDocker: true, git: 'missing', savedAt: 'time' },
    result: { remoteId: 'vm', includeDocker: true, git: 'missing' },
    fallback: 'Could not read the Connect choices.',
    serverMessage: true,
  },
} satisfies Record<keyof RemoteVmApi, HttpCase>;

const methods: Array<[string, HttpCase]> = Object.entries(cases);

describe('RemoteVmHttpApi', () => {
  let signal: AbortSignal;

  beforeEach(() => {
    transport.mockReset();
    signal = new AbortController().signal;
  });

  it.each(methods)(
    '%s preserves its request and maps the success response',
    async (_name, test) => {
      transport.mockResolvedValue(response(test.response));
      await expect(test.invoke(remoteVmHttpApi, signal)).resolves.toEqual(test.result);
      expect(transport).toHaveBeenCalledTimes(1);
      expect(transport).toHaveBeenCalledWith(test.url, test.init(signal), {
        backend: test.backend,
      });
      if ('signal' in test.init(signal)) expect(transport.mock.calls[0][1]?.signal).toBe(signal);
    },
  );

  it.each(methods)(
    '%s preserves the fallback for an unreadable HTTP error',
    async (_name, test) => {
      transport.mockResolvedValue(rejectedJson(false));
      const result = test.invoke(remoteVmHttpApi, signal);
      if (test.fallback === null)
        await expect(result).resolves.toEqual('failureResult' in test ? test.failureResult : []);
      else {
        await expect(result).rejects.toThrow(new Error(test.fallback));
        if (test.providerAuthError)
          await expect(result).rejects.toMatchObject({
            name: 'ProviderAuthApiError',
            status: 503,
            details: null,
          });
      }
    },
  );

  it.each(methods)('%s preserves server error-message precedence', async (_name, test) => {
    transport.mockResolvedValue(response({ message: 'Server refused the request.' }, false));
    const result = test.invoke(remoteVmHttpApi, signal);
    if (test.fallback === null)
      await expect(result).resolves.toEqual('failureResult' in test ? test.failureResult : []);
    else
      await expect(result).rejects.toThrow(
        new Error(test.serverMessage ? 'Server refused the request.' : test.fallback),
      );
  });

  it.each([
    ['listRemotes', 42, 'Failed to load remotes (503)'],
    ['listRemotes', '', ''],
    ['probeAddress', ['refused'], 'The address check failed.'],
    ['estimateProjectDisk', false, 'Could not measure project sizes.'],
    ['readHostInstallBlock', null, 'Could not generate the install block.'],
    ['listVmProviders', 42, 'Failed to load VM providers (503)'],
    ['listOperations', null, 'Remote operation request failed (503)'],
    ['listOperations', '', ''],
    ['listOperations', ['one', 'two'], 'one,two'],
    ['readDockerPlan', '', ''],
    ['readDockerPlan', ['one', 'two'], 'one,two'],
    ['listProviderAuthEntries', null, 'Provider auth request failed (503)'],
    ['listProviderAuthEntries', '', ''],
  ] as const)('%s preserves message coercion for %j', async (name, message, expected) => {
    transport.mockResolvedValue(response({ message }, false));
    const result = cases[name].invoke(remoteVmHttpApi, signal);
    await expect(result).rejects.toBeInstanceOf(Error);
    await expect(result).rejects.toHaveProperty('message', expected);
  });

  it.each([
    ['listRemotes', {}, []],
    ['listBindings', {}, []],
    ['listOperations', {}, []],
    ['readNewestOperation', {}, null],
    ['listVmProviders', {}, []],
    ['readStatsHistory', { intervalMs: '1000', samples: {} }, { intervalMs: 0, samples: [] }],
    ['checkVmProviderRights', { ok: 'true', missing: null }, { ok: false, missing: [] }],
    ['listLocalSshKeys', { available: false, keys: [localKey] }, []],
    ['listLocalSshKeys', { available: true, keys: {} }, []],
    ['listSshPublicKeys', { available: false, keys: [publicKey] }, []],
    ['listSshPublicKeys', { available: true, keys: {} }, []],
  ] as const)(
    '%s retains its empty/default response semantics for %j',
    async (name, body, expected) => {
      transport.mockResolvedValue(response(body));
      await expect(cases[name].invoke(remoteVmHttpApi, signal)).resolves.toEqual(expected);
    },
  );

  it.each([
    ['readReadiness', {}, 'Could not check this PC: the answer was incomplete.'],
    ['readReadiness', null, 'Could not check this PC: the answer was incomplete.'],
    ['probeAddress', null, 'The address check returned an unknown answer.'],
    [
      'probeAddress',
      { kind: 'devchain', baseUrl: 'https://lab' },
      'The address check returned an unknown answer.',
    ],
    [
      'probeAddress',
      { kind: 'installer', bootstrapUrl: 'https://lab', state: 'ready' },
      'The address check returned an unknown answer.',
    ],
    ['estimateProjectDisk', null, 'The server returned an invalid project estimate.'],
    [
      'estimateProjectDisk',
      { projects: [], requiredDiskGib: '8' },
      'The server returned an invalid project estimate.',
    ],
    ['readHostInstallBlock', { block: '' }, 'The server returned an empty install block.'],
    ['readHostInstallBlock', null, 'The server returned an empty install block.'],
    ['readProxmoxSetupBlock', { block: '' }, 'The server returned an empty setup block.'],
    [
      'previewProxmoxConnection',
      { ...preview, confirmationRequired: false },
      'The server returned an unexpected fingerprint response.',
    ],
    [
      'previewProxmoxConnection',
      { ...preview, placement: { ...placement, node: 3 } },
      'The server returned an unexpected fingerprint response.',
    ],
    [
      'connectProxmox',
      { ...connected, confirmationRequired: true },
      'The server returned an unexpected connection response.',
    ],
    [
      'connectProxmox',
      { ...connected, connection: {} },
      'The server returned an unexpected connection response.',
    ],
    [
      'connectProxmox',
      { ...connected, permissions: null },
      'The server returned an unexpected connection response.',
    ],
  ] as const)('%s rejects malformed success %j', async (name, body, message) => {
    transport.mockResolvedValue(response(body));
    await expect(cases[name].invoke(remoteVmHttpApi, signal)).rejects.toThrow(new Error(message));
  });

  it.each([
    { kind: 'devchain', baseUrl: 'https://lab:3000', versionMatches: true },
    { kind: 'installer', bootstrapUrl: 'https://lab:3443', state: 'ready', supported: true },
  ])('accepts the %s probe answer', async (body) => {
    transport.mockResolvedValue(response(body));
    await expect(remoteVmHttpApi.probeAddress('lab', { checkSsh: false })).resolves.toEqual(body);
    expect(transport).toHaveBeenCalledWith(
      '/api/remotes/probe',
      { ...post({ address: 'lab', checkSsh: false }), signal: undefined },
      { backend: HOME_BACKEND },
    );
  });

  it.each([
    [
      'attachProject',
      (api: RemoteVmApi) => api.attachProject('vm', { projectId: 'project' }),
      '/api/remotes/vm/attach',
      post({ projectId: 'project' }),
    ],
    [
      'detachProject',
      (api: RemoteVmApi) => api.detachProject('vm', { projectId: 'project' }),
      '/api/remotes/vm/detach',
      post({ projectId: 'project', force: false }),
    ],
    ['updateHost', (api: RemoteVmApi) => api.updateHost('vm'), '/api/remotes/vm/update', post()],
    [
      'retryOperation',
      (api: RemoteVmApi) => api.retryOperation('operation'),
      '/api/remotes/operations/operation/retry',
      post(),
    ],
    [
      'retryOperation',
      (api: RemoteVmApi) => api.retryOperation('operation', {}),
      '/api/remotes/operations/operation/retry',
      post(),
    ],
  ] as const)('%s preserves omitted optional request fields', async (_name, invoke, url, init) => {
    transport.mockResolvedValue(response(operation));
    await expect(invoke(remoteVmHttpApi)).resolves.toEqual(operation);
    expect(transport).toHaveBeenCalledWith(url, init, { backend: HOME_BACKEND });
  });

  it.each(['listLocalSshKeys', 'listSshPublicKeys'] as const)(
    '%s treats transport failure as unavailable keys',
    async (name) => {
      transport.mockRejectedValue(new Error('network unavailable'));
      await expect(cases[name].invoke(remoteVmHttpApi, signal)).resolves.toEqual([]);
    },
  );

  it('propagates the probe abort error unchanged', async () => {
    const controller = new AbortController();
    controller.abort();
    const error = new DOMException('aborted', 'AbortError');
    transport.mockRejectedValue(error);
    await expect(
      remoteVmHttpApi.probeAddress('lab', { checkSsh: true, signal: controller.signal }),
    ).rejects.toBe(error);
    expect(transport.mock.calls[0][1]?.signal).toBe(controller.signal);
  });

  it.each(methods.filter(([, test]) => test.providerAuthError))(
    '%s retains the typed provider-auth error with status and details',
    async (_name, test) => {
      const details = {
        code: 'PROVIDER_AUTH_GENERATION_RUNNING',
        generationId: 'generation',
        provider: 'claude',
      };
      transport.mockResolvedValue(
        response({ message: 'Login already running', details }, false, 409),
      );
      const result = test.invoke(remoteVmHttpApi, signal);
      await expect(result).rejects.toBeInstanceOf(ProviderAuthApiError);
      await expect(result).rejects.toMatchObject({
        name: 'ProviderAuthApiError',
        message: 'Login already running',
        status: 409,
        details,
      });
    },
  );

  it.each([null, 'not an object', 42, ['code']])(
    'preserves provider-auth details normalization for %j',
    async (details) => {
      transport.mockResolvedValue(response({ message: 'Refused', details }, false));
      await expect(
        remoteVmHttpApi.startProviderAuthGeneration({ provider: 'claude' }),
      ).rejects.toMatchObject({ details: details && typeof details === 'object' ? details : null });
    },
  );

  it.each([
    {
      code: FILE_SYNC_IGNORES_CHANGED,
      message: 'The file list changed.',
      typed: true,
      expected: 'The file list changed.',
    },
    {
      code: FILE_SYNC_IGNORES_CHANGED,
      message: null,
      typed: true,
      expected: 'Could not save the file list.',
    },
    {
      code: 'FORCE_SYNC_RUNNING',
      message: 'Wait for Force sync.',
      typed: false,
      expected: 'Wait for Force sync.',
    },
  ])(
    'distinguishes ignore-save conflicts for $code with message $message',
    async ({ code, message, typed, expected }) => {
      transport.mockResolvedValue(response({ code, message }, false, 409));
      const result = remoteVmHttpApi.saveProjectIgnores('project', [], 3);
      await expect(result).rejects.toBeInstanceOf(Error);
      await expect(result).rejects.toHaveProperty('message', expected);
      if (typed) await expect(result).rejects.toBeInstanceOf(FileListChangedError);
      else await expect(result).rejects.not.toBeInstanceOf(FileListChangedError);
    },
  );

  it.each([
    ['readProjectFileSyncFailures', {}, 'The server returned no failed-file list.'],
    [
      'readProjectFileSyncFailures',
      { home: { entries: [] }, vm: { entries: [] }, installedPrefix: [] },
      'The server returned no failed-file list.',
    ],
    ['readProjectIgnores', { ignores: [], revision: -1 }, 'The server returned no file list.'],
    ['readProjectIgnores', { ignores: [], revision: 1.5 }, 'The server returned no file list.'],
    [
      'readProjectIgnores',
      { ignores: [], revision: Number.MAX_SAFE_INTEGER + 1 },
      'The server returned no file list.',
    ],
    ['readProjectIgnores', { ignores: null, revision: 1 }, 'The server returned no file list.'],
    ['readFileSyncSuggestions', {}, 'No suggestions'],
    ['previewFileSyncPattern', { home: {}, vm: null }, 'The server returned no pattern preview.'],
    ['readDockerPlan', null, 'The server returned an invalid Docker plan.'],
    [
      'readDockerPlan',
      { canConnect: true, fit: 'fits', items: [], availability: null },
      'The server returned an invalid Docker plan.',
    ],
  ] as const)('%s retains its malformed-success error for %j', async (name, body, expected) => {
    transport.mockResolvedValue(response(body));
    await expect(cases[name].invoke(remoteVmHttpApi, signal)).rejects.toThrow(new Error(expected));
  });

  it.each(['readFileSyncAutoFix', 'setFileSyncAutoFix', 'giveFileOwnership'] as const)(
    '%s retains its schema-validation error type',
    async (name) => {
      transport.mockResolvedValue(response({}));
      await expect(cases[name].invoke(remoteVmHttpApi, signal)).rejects.toBeInstanceOf(ZodError);
    },
  );

  it('does not parse the successful empty provider-auth DELETE response', async () => {
    transport.mockResolvedValue(rejectedJson(true));
    await expect(remoteVmHttpApi.deleteProviderAuthEntry('entry')).resolves.toBeUndefined();
  });

  it('still parses the provider-auth cancellation response before discarding it', async () => {
    transport.mockResolvedValue(rejectedJson(true));
    await expect(remoteVmHttpApi.cancelProviderAuthGeneration('generation')).rejects.toBeInstanceOf(
      SyntaxError,
    );
  });

  it('restores project ignores using the original null body', async () => {
    const saved = { ignores: ['default'], revision: 4, applied: true, message: 'Restored' };
    transport.mockResolvedValue(response(saved));
    await expect(remoteVmHttpApi.saveProjectIgnores('project', null, 3)).resolves.toEqual(saved);
    expect(transport).toHaveBeenCalledWith(
      '/api/projects/project/file-sync/ignores',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: '{"ignores":null,"revision":3}',
      },
      { backend: HOME_BACKEND },
    );
  });

  it('omits Docker items on the initial plan request', async () => {
    const plan = { canConnect: true, fit: 'fits', items: [], availability: { available: true } };
    transport.mockResolvedValue(response(plan));
    await expect(
      remoteVmHttpApi.readDockerPlan('project', { remoteId: 'vm' }, signal),
    ).resolves.toEqual(plan);
    expect(transport).toHaveBeenCalledWith(
      '/api/projects/project/docker/plan',
      { ...post({ remoteId: 'vm' }), signal },
      { backend: HOME_BACKEND },
    );
  });

  it('retains conservative defaults for absent or malformed Connect choices', async () => {
    transport.mockResolvedValue(response({ remoteId: 1, includeDocker: 'true', git: null }));
    await expect(remoteVmHttpApi.readConnectChoices('project', signal)).resolves.toEqual({
      remoteId: undefined,
      includeDocker: false,
      git: 'present',
    });
  });

  it.each([
    'readFileSyncStatus',
    'readDockerSyncState',
    'readFileSyncSuggestions',
    'previewFileSyncPattern',
    'readDockerPlan',
  ] as const)('%s propagates transport/abort errors unchanged', async (name) => {
    const error = new DOMException('aborted', 'AbortError');
    transport.mockRejectedValue(error);
    await expect(cases[name].invoke(remoteVmHttpApi, signal)).rejects.toBe(error);
    expect(transport.mock.calls[0][1]?.signal).toBe(signal);
  });

  it.each([
    [
      { node: '', address: '', pool: 'devchain', storage: '', imageStorage: '', bridge: '' },
      '/api/vm-providers/proxmox/setup-block?node=&pool=devchain&storage=&imageStorage=&bridge=',
    ],
    [
      { node: '', address: '', pool: '', storage: '', imageStorage: '', bridge: '' },
      '/api/vm-providers/proxmox/setup-block?node=&storage=&imageStorage=&bridge=',
    ],
    [
      {
        node: 'pve1',
        address: '192.168.1.128',
        pool: 'devchain',
        storage: '',
        imageStorage: '',
        bridge: '',
      },
      '/api/vm-providers/proxmox/setup-block?node=pve1&address=192.168.1.128&pool=devchain&storage=&imageStorage=&bridge=',
    ],
  ] as const)('keeps setup-block discovery query %s at the HTTP boundary', async (fields, url) => {
    transport.mockResolvedValue(response({ block: 'pveum pool add devchain' }));
    await expect(remoteVmHttpApi.readProxmoxSetupBlock(fields)).resolves.toBe(
      'pveum pool add devchain',
    );
    expect(transport).toHaveBeenCalledWith(url, {}, { backend: HOME_BACKEND });
  });
});
