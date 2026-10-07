import type { RemoteListItemDto } from '@/modules/remotes/dtos/remote.dto';
import { render, screen, waitFor, within, type RenderResult } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation, useNavigate, type NavigateFunction } from 'react-router-dom';
import { DEFAULT_FILE_SYNC_IGNORES } from '@/modules/file-sync/file-sync.dto';
import type { ProbeResultDto, RemoteReadinessDto } from '@/modules/remotes/dtos/remote-probe.dto';
import type { ProviderAuthEntryItem } from '@/ui/hooks/useProviderAuth';
import type { RemoteOperationDto } from '@/ui/hooks/useRemoteOperations';
import { useHomeSocket } from '@/ui/hooks/useHomeSocket';
import type {
  FileSyncFailedCounts,
  FileSyncProblem,
  ProjectFileSyncFailures,
} from '@/modules/remotes/sync/remote-file-sync.dto';
import { RemoteVmSection } from '../RemoteVmSection';

/**
 * The home server behind RemoteVmSection for page specs: a fetch mock over
 * mutable state and a socket hook that delivers envelopes to the page. Each
 * spec file still declares the `jest.mock` calls for useProjectSelection,
 * useHomeSocket and use-toast, and calls `resetRemoteVmFixture` before each test.
 */

export type MessageHandler = (envelope: unknown) => void;

/** Mutable server state behind the fetch mock; tests edit it directly. */
export const fx = {} as {
  messageHandler: MessageHandler | undefined;
  remotesData: TestRemote[];
  bindingsData: {
    projectId: string;
    remoteId: string;
    state: string;
    hostCursor?: string | null;
    syncError?: string;
    fileSyncWarning?: string;
    fileSyncProblem?: FileSyncProblem;
    fileSyncFailed?: FileSyncFailedCounts;
  }[];
  operationsData: RemoteOperationDto[];
  loginsBody: { providerAuth: Record<string, string>; force: boolean } | null;
  remoteSessions: Array<{ status: string; agentId: string | null }>;
  providerConnectionsData: (typeof PROXMOX_CONNECTION)[];
  permissionMissing: string[];
  fileSyncStatus: { folders: { id: string; needItems: number; needBytes: number }[] | null };
  availableSshKeys: Array<{ name: string; type: string | null; encrypted: boolean }>;
  dockerPlanData: unknown;
  mockFetch: jest.Mock;
  readiness: RemoteReadinessDto;
  /** Answer of `POST /api/remotes/:id/power-on`; held open while `powerOnGate` is set. */
  powerOnGate: Promise<void> | null;
  /** The page's current `?search`, from the router. */
  search: string;
  /** The page's current path, from the router. */
  pathname: string;
  /** The router's navigate, for a URL change while the page stays mounted. */
  navigate: NavigateFunction;
  /** Every project of every workspace, as `GET /api/projects?limit=1000` lists them. */
  allProjects: Array<{ id: string; name: string; rootPath: string; workspaceId: string }>;
  /** `total` of that answer; more than the items means the list was cut. */
  projectsTotal: number | null;
  workspaces: Array<{ id: string; name: string; isDefault: boolean }>;
  /** Finished operations that only the per-project query returns. */
  projectHistory: RemoteOperationDto[];
  /** Answer of `POST /api/remotes/probe`. */
  probeResult: ProbeResultDto;
  /** Each project's file-sync ignore list; a missing project answers the defaults. */
  ignores: Record<string, string[]>;
  ignoreRevisions: Record<string, number>;
  autoFixEnabled: Record<string, boolean>;
  fileSyncFailures: Record<string, ProjectFileSyncFailures>;
  /** Bodies of every `PUT .../ignores`, oldest first, with their project. */
  ignorePuts: Array<{ projectId: string; ignores: string[] | null }>;
  /** Makes `PUT .../ignores` refuse with this message. */
  ignoreSaveError: string | null;
  ignoreSaveResult: { applied: boolean; message: string };
  /** The vault's logins, as `GET /api/provider-auth` lists them. */
  loginEntries: ProviderAuthEntryItem[];
  /** Bodies of every address check, oldest first. */
  probeBodies: Array<{ address: string; checkSsh: boolean }>;
};

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

export const PROXMOX_CONNECTION = {
  id: 'pc1',
  kind: 'proxmox' as const,
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
  capabilities: { create: true as const, destroy: true as const, powerState: true as const },
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

export const PROJECTS = [
  { id: 'p1', name: 'Project One', rootPath: '/tmp/p1' },
  { id: 'p2', name: 'Project Two', rootPath: '/tmp/p2' },
];

function setupFetch() {
  fx.mockFetch = jest.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const failed = /^\/api\/projects\/([^/]+)\/file-sync\/failed$/.exec(url);
    if (failed)
      return {
        ok: true,
        status: 200,
        json: async () =>
          fx.fileSyncFailures[failed[1]] ?? {
            ownerSide: 'vm',
            installedPrefix: ['/.git'],
            home: { entries: [] },
            vm: { entries: [] },
            groups: [],
            overLimit: false,
          },
      } as Response;
    const autoFix = /^\/api\/projects\/([^/]+)\/file-sync\/auto-fix$/.exec(url);
    if (autoFix) {
      const id = decodeURIComponent(autoFix[1]);
      if (method === 'PUT')
        fx.autoFixEnabled[id] = (JSON.parse(init?.body as string) as { enabled: boolean }).enabled;
      return {
        ok: true,
        status: 200,
        json: async () => ({ enabled: fx.autoFixEnabled[id] ?? true, actions: [] }),
      } as Response;
    }
    const ignores = (
      method === 'PUT'
        ? /^\/api\/projects\/([^/]+)\/file-sync\/ignores$/
        : /^\/api\/file-sync\/projects\/([^/]+)\/ignores$/
    ).exec(url);
    if (ignores) {
      const projectId = decodeURIComponent(ignores[1]);
      if (method === 'PUT') {
        const body = JSON.parse(init?.body as string) as {
          ignores: string[] | null;
          revision: number;
        };
        fx.ignorePuts.push({ projectId, ignores: body.ignores });
        if (body.revision !== (fx.ignoreRevisions[projectId] ?? 0))
          return {
            ok: false,
            status: 409,
            json: async () => ({ message: 'The file list changed. Review it again.' }),
          } as Response;
        if (fx.ignoreSaveError) {
          return {
            ok: false,
            status: 400,
            json: async () => ({ statusCode: 400, message: fx.ignoreSaveError }),
          } as Response;
        }
        if (body.ignores === null) delete fx.ignores[projectId];
        else fx.ignores[projectId] = body.ignores;
        fx.ignoreRevisions[projectId] = (fx.ignoreRevisions[projectId] ?? 0) + 1;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ignores: fx.ignores[projectId] ?? [...DEFAULT_FILE_SYNC_IGNORES],
          revision: fx.ignoreRevisions[projectId] ?? 0,
          ...(method === 'PUT' ? fx.ignoreSaveResult : {}),
        }),
      } as Response;
    }
    if (method === 'POST' && url === '/api/remotes/probe') {
      fx.probeBodies.push(JSON.parse(init?.body as string) as (typeof fx.probeBodies)[number]);
      return { ok: true, status: 200, json: async () => fx.probeResult } as Response;
    }
    if (method === 'POST' && url === '/api/projects/p1/docker/plan' && fx.dockerPlanData) {
      return { ok: true, status: 200, json: async () => fx.dockerPlanData } as Response;
    }
    // The Disconnect dialog's Docker check; unanswered, it offers no Docker copy.
    if (method === 'POST' && url.endsWith('/docker/sync-state')) {
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    }
    if (url === '/api/remotes/host-install/ssh-keys' && method === 'GET') {
      return {
        ok: true,
        status: 200,
        json: async () => ({ available: true, keys: fx.availableSshKeys }),
      } as Response;
    }
    const provider = /^\/api\/vm-providers\/([^/]+)(\/check)?$/.exec(url);
    if (provider && provider[2] && method === 'POST') {
      return {
        ok: true,
        status: 201,
        json: async () => ({
          ok: fx.permissionMissing.length === 0,
          missing: fx.permissionMissing,
        }),
      } as Response;
    }
    if (provider && !provider[2] && method === 'DELETE') {
      const user = fx.remotesData.find((remote) => remote.vmProviderConnectionId === provider[1]);
      if (user) {
        return {
          ok: false,
          status: 409,
          json: async () => ({ statusCode: 409, message: `${user.name} uses this connection.` }),
        } as Response;
      }
      fx.providerConnectionsData = fx.providerConnectionsData.filter(
        (connection) => connection.id !== provider[1],
      );
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    }
    if (url === '/api/vm-providers' && method === 'GET') {
      return {
        ok: true,
        status: 200,
        json: async () => ({ items: fx.providerConnectionsData }),
      } as Response;
    }
    if (url.startsWith('/api/vm-providers/proxmox/setup-block?') && method === 'GET') {
      return {
        ok: true,
        status: 200,
        json: async () => ({ block: 'pveum pool add devchain' }),
      } as Response;
    }
    if (url === '/api/vm-providers/proxmox/connect' && method === 'POST') {
      const body = JSON.parse(init?.body as string) as {
        connectionString: string;
        confirmFingerprint?: boolean;
      };
      if (!body.confirmFingerprint) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
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
        } as Response;
      }
      fx.providerConnectionsData = [...fx.providerConnectionsData, PROXMOX_CONNECTION];
      return {
        ok: true,
        status: 200,
        json: async () => ({
          confirmationRequired: false,
          connection: PROXMOX_CONNECTION,
          permissions: { ok: fx.permissionMissing.length === 0, missing: fx.permissionMissing },
        }),
      } as Response;
    }
    if (method === 'POST' && url === '/api/vm-providers/pc1/create-vm') {
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      const operation: RemoteOperationDto = {
        ...makeOperation(),
        id: 'create-op',
        kind: 'create_vm',
        remoteId: 'r-created',
        projectId: null,
        state: 'running',
        details: {
          providerAuth: {
            codex: { choice: 'generate', generationId: 'generation-1', sessionId: 'session-1' },
          },
        },
        steps: [
          {
            id: 'vm_preflight',
            label: 'Check VM settings and permissions',
            state: 'done',
            error: null,
          },
          { id: 'ensure_image', label: 'Import the host image', state: 'running', error: null },
          {
            id: 'ensure_template',
            label: 'Prepare the image template',
            state: 'pending',
            error: null,
          },
          { id: 'clone', label: 'Clone the VM', state: 'pending', error: null },
          { id: 'start', label: 'Start the VM', state: 'pending', error: null },
          { id: 'wait_ip', label: 'Wait for the guest IP address', state: 'pending', error: null },
          { id: 'claim_preflight', label: 'Check the VM', state: 'pending', error: null },
          { id: 'claim_claim', label: 'Claim and register', state: 'pending', error: null },
        ],
      };
      fx.remotesData = [
        ...fx.remotesData,
        {
          ...REMOTE,
          id: 'r-created',
          name: String(body.name),
          baseUrl: null,
          kind: 'proxmox',
          vmProviderConnectionId: 'pc1',
          vmIdentity: null,
          vmSpec: {
            cores: Number(body.cores),
            memory: Number(body.memory),
            disk: Number(body.disk),
          },
        },
      ];
      fx.operationsData = [operation];
      return { ok: true, status: 202, json: async () => operation } as Response;
    }
    if (method === 'POST' && url === '/api/remotes/r1/logins') {
      fx.loginsBody = JSON.parse(init?.body as string) as {
        providerAuth: Record<string, string>;
        force: boolean;
      };
      const operation: RemoteOperationDto = {
        ...makeOperation(),
        id: 'logins-op',
        kind: 'update_logins',
        projectId: null,
        state: 'running',
        details: {},
        steps: [
          { id: 'preflight', label: 'Check the VM and its logins', state: 'running', error: null },
          {
            id: 'pull_families',
            label: 'Save the logins from the VM',
            state: 'pending',
            error: null,
          },
          {
            id: 'release_replaced',
            label: 'Release replaced logins',
            state: 'pending',
            error: null,
          },
          { id: 'claim', label: 'Apply the logins on the VM', state: 'pending', error: null },
          { id: 'verify_providers', label: 'Verify the logins', state: 'pending', error: null },
        ],
      };
      fx.operationsData = [...fx.operationsData.filter((op) => op.id !== 'logins-op'), operation];
      return { ok: true, status: 202, json: async () => operation } as Response;
    }
    if (url === '/r/r1/api/sessions') {
      return { ok: true, json: async () => fx.remoteSessions } as Response;
    }
    if (method === 'POST' && url === '/api/remotes/r1/reset') {
      const operation: RemoteOperationDto = {
        ...makeOperation(),
        id: 'reset-op',
        kind: 'reset_vm',
        projectId: null,
        state: 'running',
        details: { force: true },
        steps: [
          { id: 'preflight', label: 'Check the VM', state: 'done', error: null },
          {
            id: 'pull_families',
            label: 'Save the logins from the VM',
            state: 'running',
            error: null,
          },
          {
            id: 'detach:p1:preflight',
            label: 'Disconnect p1: Check connection',
            state: 'pending',
            error: null,
          },
          { id: 'destroy', label: 'Destroy the old VM', state: 'pending', error: null },
          {
            id: 'create_vm_preflight',
            label: 'Check VM settings and permissions',
            state: 'pending',
            error: null,
          },
          {
            id: 'create_vm_ensure_image',
            label: 'Import the host image',
            state: 'pending',
            error: null,
          },
          { id: 'create_vm_clone', label: 'Clone the VM', state: 'pending', error: null },
          { id: 'create_vm_start', label: 'Start the VM', state: 'pending', error: null },
          {
            id: 'create_vm_wait_ip',
            label: 'Wait for the guest IP address',
            state: 'pending',
            error: null,
          },
          {
            id: 'create_vm_claim_claim',
            label: 'Claim and register',
            state: 'pending',
            error: null,
          },
          {
            id: 'attach:p1:preflight',
            label: 'Reconnect p1: Check connection',
            state: 'pending',
            error: null,
          },
        ],
      };
      fx.operationsData = [operation];
      return { ok: true, status: 202, json: async () => operation } as Response;
    }
    if (method === 'POST' && url === '/api/remotes/r1/destroy-vm') {
      const body = JSON.parse(init?.body as string) as { force: boolean };
      const operation: RemoteOperationDto = {
        ...makeOperation(),
        id: 'destroy-op',
        kind: 'destroy_vm',
        projectId: null,
        state: 'running',
        details: {
          force: body.force,
          familyPull: {
            pulled: !body.force,
            families: [{ provider: 'codex', entryId: 'entry-1', lastWritebackAt: null }],
          },
        },
        createdAt: '2026-09-25T00:00:00.000Z',
        steps: [
          {
            id: 'preflight',
            label: 'Check VM ownership and projects',
            state: 'running',
            error: null,
          },
          {
            id: 'pull_families',
            label: 'Save the logins from the VM',
            state: 'pending',
            error: null,
          },
          { id: 'destroy', label: 'Destroy the VM', state: 'pending', error: null },
        ],
      };
      fx.operationsData = [operation];
      return { ok: true, status: 202, json: async () => operation } as Response;
    }
    if (url === '/api/file-sync/projects/p1/status') {
      return { ok: true, status: 200, json: async () => fx.fileSyncStatus } as Response;
    }
    if (url.startsWith('/api/remotes/operations?')) {
      const params = new URL(url, 'http://localhost').searchParams;
      const projectId = params.get('projectId');
      if (projectId) {
        // Newest first, any state: open work plus finished records of the project.
        const items = [...fx.operationsData, ...fx.projectHistory]
          .filter((operation) => operation.projectId === projectId)
          .slice(0, Number(params.get('limit') ?? 100));
        return { ok: true, json: async () => ({ items }) } as Response;
      }
      const state = params.get('state');
      return {
        ok: true,
        json: async () => ({
          items: fx.operationsData.filter((operation) => operation.state === state),
        }),
      } as Response;
    }
    if (method === 'POST' && /\/(attach|detach|force-sync)$/.test(url)) {
      const action = url.split('/').pop() as 'attach' | 'detach' | 'force-sync';
      const body = init?.body ? JSON.parse(init.body as string) : {};
      const operation: RemoteOperationDto = {
        ...makeOperation(),
        id: `${action}-op`,
        kind: action === 'force-sync' ? 'force_sync' : action,
        remoteId: url.split('/')[3],
        projectId: body.projectId,
        state: 'running',
      };
      if (action === 'force-sync') {
        operation.details = { source: body.source, forceSync: { source: body.source } };
        operation.steps = [
          { id: 'preflight', label: 'Check the VM and the project', state: 'running', error: null },
          { id: 'force_copy', label: 'Copy files', state: 'pending', error: null },
        ];
      } else
        fx.bindingsData = [
          {
            projectId: body.projectId,
            remoteId: operation.remoteId,
            state: action === 'attach' ? 'attaching' : 'detaching',
          },
        ];
      fx.operationsData = [operation];
      return { ok: true, json: async () => operation } as Response;
    }
    if (method === 'POST' && /\/operations\/[^/]+\/(retry|cancel)$/.test(url)) {
      const [, , , , operationId, action] = url.split('/');
      const current =
        fx.operationsData.find((operation) => operation.id === operationId) ?? makeOperation();
      const operation: RemoteOperationDto =
        action === 'cancel'
          ? { ...current, state: 'cancelled' }
          : {
              ...current,
              state: 'running',
              steps: current.steps.map((step) => ({ ...step, state: 'running', error: null })),
            };
      if (action === 'cancel') {
        fx.bindingsData = [];
        // The VM list reports each VM's newest operation, as the server does.
        fx.remotesData = fx.remotesData.map((remote) =>
          remote.id === operation.remoteId
            ? {
                ...remote,
                lastOperation: {
                  id: operation.id,
                  kind: operation.kind,
                  state: operation.state,
                  updatedAt: operation.updatedAt,
                },
              }
            : remote,
        );
      }
      fx.operationsData = [
        operation,
        ...fx.operationsData.filter((candidate) => candidate.id !== operation.id),
      ];
      return { ok: true, json: async () => operation } as Response;
    }
    if (method === 'POST' && url === '/api/remotes/claim') {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      const operation: RemoteOperationDto = {
        ...makeOperation(),
        kind: 'claim',
        projectId: null,
        state: 'running',
        details: { providerAuth: body.providerAuth },
        steps: [
          { id: 'preflight', label: 'Check the VM', state: 'running', error: null },
          { id: 'claim', label: 'Set up the VM and start DevChain', state: 'pending', error: null },
        ],
      };
      fx.operationsData = [operation];
      return { ok: true, status: 202, json: async () => operation } as Response;
    }
    if (method === 'POST' && url === '/api/remotes/r1/update') {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      const operation: RemoteOperationDto = {
        ...makeOperation(),
        kind: 'update_host',
        projectId: null,
        state: 'running',
        steps: [
          {
            id: body.installDocker ? 'docker' : 'update',
            label: body.installDocker
              ? 'Install Docker Engine and Compose'
              : 'Install the new version',
            state: 'running',
            error: null,
          },
        ],
      };
      fx.operationsData = [operation];
      return { ok: true, status: 202, json: async () => operation } as Response;
    }
    if (url === '/api/provider-auth') {
      return { ok: true, status: 200, json: async () => ({ items: fx.loginEntries }) } as Response;
    }
    if (url === '/api/remotes/readiness' && method === 'GET') {
      return { ok: true, status: 200, json: async () => fx.readiness } as Response;
    }
    const powerOn = /^\/api\/remotes\/([^/]+)\/power-on$/.exec(url);
    if (powerOn && method === 'POST') {
      await fx.powerOnGate;
      fx.remotesData = fx.remotesData.map((remote) =>
        remote.id === powerOn[1] ? { ...remote, powerState: 'running', online: false } : remote,
      );
      return { ok: true, status: 200, json: async () => ({ powerState: 'running' }) } as Response;
    }
    const rename = /^\/api\/remotes\/([^/]+)$/.exec(url);
    if (rename && method === 'PATCH') {
      const { name } = JSON.parse(init?.body as string) as { name: string };
      fx.remotesData = fx.remotesData.map((remote) =>
        remote.id === rename[1] ? { ...remote, name } : remote,
      );
      const renamed = fx.remotesData.find((remote) => remote.id === rename[1]);
      return { ok: true, status: 200, json: async () => renamed } as Response;
    }
    if (url === '/api/runtime') {
      return { ok: true, status: 200, json: async () => ({ version: '0.23.4' }) } as Response;
    }
    if (url === '/api/remotes/host-install/identity') {
      return {
        ok: true,
        status: 200,
        json: async () => ({ user: 'devchain', homePath: '/home/devchain' }),
      } as Response;
    }
    if (url.startsWith('/api/projects?limit=') && method === 'GET') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          items: fx.allProjects,
          total: fx.projectsTotal ?? fx.allProjects.length,
        }),
      } as Response;
    }
    if (url === '/api/workspaces' && method === 'GET') {
      return { ok: true, status: 200, json: async () => fx.workspaces } as Response;
    }
    if (url === '/api/remotes' && method === 'GET') {
      return { ok: true, status: 200, json: async () => ({ items: fx.remotesData }) } as Response;
    }
    if (url === '/api/remotes/bindings') {
      return { ok: true, status: 200, json: async () => ({ items: fx.bindingsData }) } as Response;
    }
    if (url === '/api/remotes' && method === 'POST') {
      const body = JSON.parse(init!.body as string) as { name: string; baseUrl: string };
      const created: TestRemote = {
        ...REMOTE,
        id: 'r2',
        online: false,
        version: null,
        versionMatches: false,
        stats: null,
        lastSeenAt: null,
        ...body,
      };
      fx.remotesData = [...fx.remotesData, created];
      return { ok: true, status: 201, json: async () => created } as Response;
    }
    if (url.startsWith('/api/remotes/') && method === 'DELETE') {
      const remoteId = url.split('/').pop()!;
      if (!fx.bindingsData.some((binding) => binding.remoteId === remoteId)) {
        fx.remotesData = fx.remotesData.filter((remote) => remote.id !== remoteId);
        fx.operationsData = fx.operationsData.filter(
          (operation) => operation.remoteId !== remoteId,
        );
        return { ok: true, status: 200, json: async () => ({}) } as Response;
      }
      return {
        ok: false,
        status: 409,
        json: async () => ({
          statusCode: 409,
          code: 'conflict',
          message: 'Cannot delete a remote with a project binding.',
        }),
      } as Response;
    }
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  });
  global.fetch = fx.mockFetch as unknown as typeof fetch;
}

function LocationProbe() {
  const location = useLocation();
  fx.search = location.search;
  fx.pathname = location.pathname;
  fx.navigate = useNavigate();
  return null;
}

/** Renders the page at `path`, e.g. `/?tab=proxmox`; `fx.search` follows the URL and `fx.navigate` changes it. */
export function renderSection(path = '/'): RenderResult {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[path]}>
      <QueryClientProvider client={queryClient}>
        <RemoteVmSection />
        <LocationProbe />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

/** Opens a tab when another tab shows. */
async function openTab(name: string | RegExp): Promise<void> {
  const tab = screen.getByRole('tab', { name });
  if (tab.getAttribute('aria-selected') !== 'true') await userEvent.click(tab);
}

/** The VM rows live on the VMs tab. */
const openVmsTab = () => openTab(/^VMs/);

/** The row of a VM in the VMs box. */
export async function vmRow(name: string): Promise<HTMLElement> {
  await openVmsTab();
  return within(await screen.findByRole('list', { name: 'VMs' })).findByRole('listitem', {
    name,
  });
}

/** A VM's name button in the Overview tab's VM summary; waits until the summary loads. */
export async function overviewVmButton(name: string): Promise<HTMLElement> {
  return within(await screen.findByRole('list', { name: 'VMs' })).findByRole('button', { name });
}

/** The row of a project in the Projects tab's list. */
export async function projectRow(name: string): Promise<HTMLElement> {
  await openTab(/^Projects/);
  return within(await screen.findByRole('list', { name: 'Projects' })).findByRole('listitem', {
    name,
  });
}

/** Opens a project's File sync settings from its row and returns the dialog. */
export async function openFileSyncSettings(name: string): Promise<HTMLElement> {
  await userEvent.click(
    within(await projectRow(name)).getByRole('button', { name: 'File sync settings' }),
  );
  return screen.findByRole('dialog', { name: `File sync settings · ${name}` });
}

/** Opens a VM's ⋯ menu and returns its item names. */
export async function openVmMenu(name: string): Promise<string[]> {
  await openVmsTab();
  await userEvent.click(await screen.findByRole('button', { name: `More actions for ${name}` }));
  return (await screen.findAllByRole('menuitem')).map((item) => item.textContent ?? '');
}

/** Opens a VM's ⋯ menu and picks one item. */
export async function pickVmMenu(name: string, item: string): Promise<void> {
  await openVmMenu(name);
  await userEvent.click(screen.getByRole('menuitem', { name: item }));
}

/** Opens the VMs tab's Add VM menu and picks one item. */
export async function pickAddVmMenu(item: string): Promise<void> {
  await openVmsTab();
  await userEvent.click(await screen.findByRole('button', { name: 'Add VM' }));
  await userEvent.click(await screen.findByRole('menuitem', { name: item }));
}

/** Opens the Add your own VM flow from the VMs tab's Add VM menu. */
export const addOwnVm = () => pickAddVmMenu('Add your own VM');

/** Walks an open Connect flow to its end with the choices it holds, and presses Connect. */
export async function finishConnect(dialog: HTMLElement): Promise<void> {
  await userEvent.click(within(dialog).getByRole('button', { name: 'Next' }));
  const next = await within(dialog).findByRole('button', { name: 'Next' });
  await waitFor(() => expect(next).toBeEnabled());
  await userEvent.click(next);
  await userEvent.click(within(dialog).getByRole('button', { name: 'Connect' }));
}

/** Picks a provider's login in a dialog's login step. */
export async function chooseLogin(
  dialog: HTMLElement,
  provider: string,
  option: string,
): Promise<void> {
  await userEvent.click(within(dialog).getByRole('combobox', { name: `${provider} login choice` }));
  await userEvent.click(await screen.findByRole('option', { name: option }));
}

export function resetRemoteVmFixture(mocks: {
  useSelectedProject: jest.Mock;
  toast: jest.Mock;
}): void {
  fx.remotesData = [{ ...REMOTE }];
  fx.bindingsData = [];
  fx.operationsData = [];
  fx.loginsBody = null;
  fx.remoteSessions = [];
  fx.providerConnectionsData = [];
  fx.permissionMissing = [];
  fx.fileSyncStatus = { folders: null };
  fx.availableSshKeys = [];
  fx.dockerPlanData = null;
  fx.readiness = READY;
  fx.powerOnGate = null;
  fx.search = '';
  fx.allProjects = PROJECTS.map((project) => ({ ...project, workspaceId: 'w1' }));
  fx.projectsTotal = null;
  fx.workspaces = [{ id: 'w1', name: 'Main', isDefault: true }];
  fx.projectHistory = [];
  fx.probeResult = { kind: 'nothing', tried: ['https://10.0.0.5:3000'], sshReachable: true };
  fx.probeBodies = [];
  fx.loginEntries = [];
  fx.ignores = {};
  fx.fileSyncFailures = {};
  fx.ignoreSaveResult = { applied: true, message: 'Applied to the VM and this PC.' };
  fx.ignorePuts = [];
  fx.ignoreRevisions = {};
  fx.autoFixEnabled = {};
  fx.ignoreSaveError = null;
  fx.messageHandler = undefined;
  mocks.useSelectedProject
    .mockReset()
    .mockReturnValue({ projects: PROJECTS, projectsLoading: false, activateProject: jest.fn() });
  jest
    .mocked(useHomeSocket)
    .mockClear()
    .mockImplementation(() => {
      fx.messageHandler = (envelope) => {
        for (const [handlers] of jest.mocked(useHomeSocket).mock.calls.slice(-2)) {
          (handlers.message as MessageHandler)?.(envelope);
        }
      };
      return {} as ReturnType<typeof useHomeSocket>;
    });
  setupFetch();
  mocks.toast.mockClear();
}

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
