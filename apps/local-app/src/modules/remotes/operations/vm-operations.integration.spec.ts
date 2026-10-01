import { X509Certificate } from 'node:crypto';
import { DockerImportInventoryStore } from './docker-import-inventory.store';
import Database from 'better-sqlite3';
import { ZodError } from 'zod';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { resetEnvConfig } from '../../../common/config/env.config';
import { fixtureTls, otherTls } from '../../../common/test/tls-fixture';
import { ConflictError, NotFoundError } from '../../../common/errors/error-types';
import type { ProviderAuthVaultService } from '../../provider-auth/provider-auth-vault.service';
import type { ProviderAuthWritebackService } from '../../provider-auth/provider-auth-writeback.service';
import type { ProviderAdapterFactory } from '../../providers/adapters/provider-adapter.factory';
import { IntegrationCredentialCipher } from '../../storage/local/integration-credential-cipher';
import { LocalStorageService } from '../../storage/local/local-storage.service';
import type { RemoteOperation } from '../../storage/models/domain.models';
import type { ProxmoxVmLifecycleService } from '../../vm-providers/proxmox-vm-lifecycle.service';
import type { VmProvidersService } from '../../vm-providers/vm-providers.service';
import { CreateVmOperation } from './create-vm.operation';
import { RemoteOperationRunner } from './remote-operation.runner';
import type { RemoteOperationDefinition } from './remote-operation.types';
import { RemoteOperationsService } from './remote-operations.service';
import { ResetVmOperation } from './reset-vm.operation';
import { DestroyVmOperation } from './destroy-vm.operation';
import { VmOperationsService } from './vm-operations.service';
import { VmOperationsController } from './vm-operations.controller';
import { RemotesService } from '../services/remotes.service';
import { ClaimOperation } from './claim.operation';
import { HostSshKeysService } from '../host/host-ssh-keys.service';
import { readFile } from 'node:fs/promises';
import { utils } from 'ssh2';

const MIGRATIONS_FOLDER = join(__dirname, '../../../../drizzle');
const SHA = 'a'.repeat(64);
const FAMILY_ID = '0f9982da-7b3c-4d23-a338-e304b128fd1b';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

jest.mock('node:os', () => {
  const actual = jest.requireActual('node:os');
  return {
    ...actual,
    userInfo: () => ({ username: 'alice' }),
    homedir: () => '/home/alice',
  };
});

describe('VM operation composition with fake Proxmox and bootstrap', () => {
  let sqlite: Database.Database;
  let inventory: DockerImportInventoryStore;
  let directory: string;
  let storage: LocalStorageService;
  let runner: RemoteOperationRunner;
  let operations: RemoteOperationsService;
  let vmOperations: VmOperationsService;
  let remotes: RemotesService;
  let connectionId: string;
  let nextVmid: number;
  let imageImported: boolean;
  let templateReady: boolean;
  let fakeVms: Map<number, { identity: string; name: string; operationId: string }>;
  let calls: string[];
  let cloneGate: ReturnType<typeof gate> | null;
  let cloneEntered: (() => void) | null;
  let updateGate: ReturnType<typeof gate> | null;
  let updateEntered: (() => void) | null;
  let pullGate: ReturnType<typeof gate> | null;
  let pullEntered: (() => void) | null;
  let hostOffline: boolean;
  let loseDestroyResponse: boolean;
  let vmidCollision: boolean;
  let rejectOwnership: boolean;
  let destroyGate: ReturnType<typeof gate> | null;
  let destroyEntered: (() => void) | null;
  let failClaim: boolean;
  let failNextImageHead: boolean;
  let loseCloneResponse: boolean;
  let appliedSshKeys: string[][];
  let claims: Array<{ remoteId: string; providerAuth: Record<string, unknown> }>;

  const family = {
    provider: 'codex',
    entryId: FAMILY_ID,
    lastWritebackAt: '2026-09-24T10:00:00.000Z',
  };

  /** Each VM has its own certificate, so a reset VM's certificate differs from the old one. */
  const vmCertificate = (vmid: number) => (vmid % 2 === 1 ? fixtureTls.cert : otherTls.cert);

  async function settle(started: RemoteOperation): Promise<RemoteOperation> {
    await runner.whenIdle(started.id);
    return storage.getRemoteOperation(started.id);
  }

  beforeEach(async () => {
    process.env.HOST_IMAGE_URL = 'https://images.example/devchain-host-1.3.0.qcow2';
    process.env.HOST_IMAGE_SHA256 = SHA;
    resetEnvConfig();
    directory = mkdtempSync(join(tmpdir(), 'devchain-vm-operations-'));
    sqlite = new Database(':memory:');
    const db = drizzle(sqlite);
    inventory = new DockerImportInventoryStore(db);
    migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    sqlite.pragma('foreign_keys = ON');
    storage = new LocalStorageService(
      db,
      new IntegrationCredentialCipher({
        secretDirectory: directory,
        machineIdentity: 'vm-operations-test:u',
      }),
    );
    const connection = await storage.createVmProviderConnection({
      kind: 'proxmox',
      name: 'Lab',
      apiUrl: 'https://proxmox.example',
      node: 'hw',
      pool: 'devchain',
      storage: 'local-lvm',
      imageStorage: 'local',
      bridge: 'vmbr0',
      vmidMin: 100,
      vmidMax: 200,
      namePrefix: 'dc-',
      tag: 'devchain',
      sslFingerprint: SHA,
      tokenId: 'root@pam!devchain',
      tokenSecret: 'private-token',
    });
    connectionId = connection.id;
    nextVmid = 100;
    imageImported = false;
    templateReady = false;
    fakeVms = new Map([
      [199, { identity: 'outside-vm', name: 'other-vm', operationId: 'outside' }],
    ]);
    calls = [];
    cloneGate = null;
    cloneEntered = null;
    updateGate = null;
    updateEntered = null;
    pullGate = null;
    pullEntered = null;
    hostOffline = false;
    loseDestroyResponse = false;
    vmidCollision = false;
    rejectOwnership = false;
    destroyGate = null;
    destroyEntered = null;
    failClaim = false;
    failNextImageHead = false;
    loseCloneResponse = false;
    claims = [];
    appliedSshKeys = [];

    const lifecycle = {
      image: (url: string, sha256: string) => ({
        url,
        sha256,
        version: '1.3.0',
        filename: `devchain-host-1.3.0-${sha256}.qcow2`,
      }),
      assertReachable: async () => {
        calls.push('image-head');
        if (failNextImageHead) {
          failNextImageHead = false;
          throw new Error('Image HEAD failed');
        }
      },
      plan: async () => {
        calls.push('nextid');
        return { templateVmid: 100, vmid: ++nextVmid };
      },
      ensureImage: async () => {
        if (!imageImported) {
          calls.push('download');
          imageImported = true;
        }
        return 'local:import/image.qcow2';
      },
      ensureTemplate: async () => {
        if (!templateReady) {
          calls.push('template');
          templateReady = true;
        }
        return 100;
      },
      clone: async (
        _connectionId: string,
        _template: number,
        vmid: number,
        name: string,
        operationId: string,
      ) => {
        if (vmidCollision) {
          vmidCollision = false;
          throw new ConflictError('The selected clone VMID belongs to another VM.', {
            code: 'VMID_TAKEN',
          });
        }
        calls.push(`clone:${vmid}`);
        fakeVms.set(vmid, { identity: `vm-${vmid}`, name, operationId });
        if (loseCloneResponse) {
          loseCloneResponse = false;
          throw new Error('Clone response was lost');
        }
        cloneEntered?.();
        await cloneGate?.promise;
        return `vm-${vmid}`;
      },
      configure: async () => {
        calls.push('configure');
      },
      start: async () => {
        calls.push('start');
      },
      waitIp: async (_connectionId: string, vmid: number, port: number) => {
        calls.push('wait-ip');
        return {
          address: `https://127.0.0.${vmid - 100}:${port}`,
          bootstrapUrl: `https://127.0.0.${vmid - 100}:3000`,
        };
      },
      readCertificate: async (_connectionId: string, vmid: number) => vmCertificate(vmid),
      isOperationClone: async (
        _connectionId: string,
        vmid: number,
        name: string,
        operationId: string,
      ) => {
        const vm = fakeVms.get(vmid);
        return vm?.name === name && vm.operationId === operationId;
      },
      destroyCreated: async (
        _connectionId: string,
        vmid: number,
        name: string,
        operationId: string,
      ) => {
        const vm = fakeVms.get(vmid);
        if (vm && vm.name === name && vm.operationId === operationId) fakeVms.delete(vmid);
        else if (vm) throw new ConflictError('Destroy guard refused the other VM.');
        calls.push(`cleanup:${vmid}`);
      },
    } as unknown as ProxmoxVmLifecycleService;
    const providers = {
      checkPermissions: async () => {
        calls.push('permissions');
        return { ok: true, missing: [] };
      },
      forConnection: async () => ({
        getOwnedVm: async (identity: string) => {
          const entry = [...fakeVms].find(([, vm]) => vm.identity === identity);
          if (!entry) throw new NotFoundError('VM', identity);
          if (entry[0] === 199 || rejectOwnership)
            throw new ConflictError('Destroy guard refused.');
          return { vmid: entry[0], name: entry[1].name };
        },
        assertOwnedVmIdentity: async (identity: string) => {
          const entry = [...fakeVms].find(([, vm]) => vm.identity === identity);
          if (!entry) throw new NotFoundError('VM', identity);
          if (entry[0] === 199 || rejectOwnership)
            throw new ConflictError('Destroy guard refused.');
          return entry[0];
        },
        assertOwnedVmid: async (vmid: number) => {
          if (!fakeVms.has(vmid)) throw new NotFoundError('VM', String(vmid));
          if (vmid === 199 || rejectOwnership) throw new ConflictError('Destroy guard refused.');
        },
        destroyVm: async (identity: string) => {
          const entry = [...fakeVms].find(([, vm]) => vm.identity === identity);
          if (!entry) throw new NotFoundError('VM', identity);
          if (entry[0] === 199) throw new ConflictError('Destroy guard refused.');
          destroyEntered?.();
          await destroyGate?.promise;
          fakeVms.delete(entry[0]);
          calls.push(`destroy:${identity}`);
          if (loseDestroyResponse) {
            loseDestroyResponse = false;
            throw new Error('Delete response was lost');
          }
        },
        destroyOwnedVmid: async (vmid: number) => {
          if (!fakeVms.has(vmid)) throw new NotFoundError('VM', String(vmid));
          if (vmid === 199 || rejectOwnership) throw new ConflictError('Destroy guard refused.');
          fakeVms.delete(vmid);
          calls.push(`destroy-vmid:${vmid}`);
        },
      }),
    } as unknown as VmProvidersService;
    const vault = {
      get: async (id: string) =>
        id === FAMILY_ID
          ? { id, provider: 'codex', kind: 'family', label: 'Codex' }
          : storage.getProviderAuthEntry(id),
      familiesOfRemote: async () => [family],
    } as unknown as ProviderAuthVaultService;
    const writeback = {
      pullFamiliesNow: async () => {
        calls.push('pull-families');
        pullEntered?.();
        await pullGate?.promise;
        return { pulled: !hostOffline, families: [family] };
      },
    } as unknown as ProviderAuthWritebackService;
    // The stub stands in for the VM's own claimed DevChain, so its claim check passes.
    const sshService = new HostSshKeysService(
      { assertClaimedHost: () => undefined } as never,
      directory,
    );
    const realClaim = new ClaimOperation(
      {} as never,
      {} as never,
      {
        applySshKeys: async (_remoteId: string, keys: string[]) => {
          appliedSshKeys.push([...keys]);
          await sshService.apply(keys);
        },
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const claim: RemoteOperationDefinition = {
      kind: 'claim',
      steps: [
        {
          id: 'preflight',
          label: 'Check bootstrap',
          run: async ({ details }) => {
            if (!details.bootstrapUrl) throw new Error('Bootstrap address missing');
            calls.push('bootstrap-preflight');
          },
        },
        {
          id: 'provider_auth_resolve',
          label: 'Reuse logins',
          run: async ({ details }) => {
            calls.push('provider-auth-resolve');
            const states = details.providerAuth as Record<
              string,
              { entryId?: string; entryIds?: string[] }
            >;
            for (const state of Object.values(states)) {
              if (!state.entryIds && state.entryId) state.entryIds = [state.entryId];
            }
            const state = states.codex;
            if (state) calls.push(`reuse:${state.entryIds?.join(',')}`);
          },
        },
        {
          id: 'build_bundle',
          label: 'Build bundle',
          run: async () => {
            calls.push('build-bundle');
          },
        },
        {
          id: 'claim',
          label: 'Claim',
          run: async ({ operation, details }) => {
            claims.push({
              remoteId: operation.remoteId,
              providerAuth: details.providerAuth as Record<string, unknown>,
            });
            calls.push('claim');
            if (failClaim) throw new Error('Claim timed out');
          },
        },
        {
          id: 'verify_providers',
          label: 'Verify',
          run: async ({ details }) => {
            calls.push('verify');
            for (const provider of Object.keys(details.providerAuth as Record<string, unknown>)) {
              calls.push(`verify:${provider}`);
            }
          },
        },
        realClaim.steps.find((step) => step.id === 'ssh_keys')!,
        {
          id: 'register_remote',
          label: 'Register',
          run: async () => {
            calls.push('register');
          },
        },
      ],
      assertCancellable: () => undefined,
      rollback: async () => {
        calls.push('claim-rollback');
      },
      retryFrom: () => null,
      interrupt: async () => undefined,
      forget: () => undefined,
    };
    const detach: RemoteOperationDefinition = {
      kind: 'detach',
      steps: [
        {
          id: 'preflight',
          label: 'Check binding',
          run: async ({ operation, details }) => {
            calls.push(`detach:${operation.projectId}`);
            if (details.force)
              details.forcedLoss = {
                hostCursor: null,
                mirrorAgeMs: null,
                fileSync: {},
                teamLanes: 'unfinalized',
              };
          },
        },
        {
          id: 'unbind',
          label: 'Unbind',
          run: async ({ operation }) => {
            await storage.deleteRemoteProjectBinding(operation.projectId!);
          },
        },
      ],
      stepsFor() {
        return this.steps;
      },
      assertCancellable: () => undefined,
      rollback: async () => undefined,
    };
    const attach: RemoteOperationDefinition = {
      kind: 'attach',
      steps: [
        {
          id: 'preflight',
          label: 'Check project',
          run: async ({ operation }) => {
            calls.push(`attach:${operation.projectId}`);
          },
        },
        {
          id: 'bind_remote',
          label: 'Bind',
          run: async ({ operation }) => {
            await storage.createRemoteProjectBinding({
              projectId: operation.projectId!,
              remoteId: operation.remoteId,
            });
            await storage.updateRemoteProjectBinding(operation.projectId!, { state: 'remote' });
          },
        },
      ],
      assertCancellable: () => undefined,
      rollback: async () => undefined,
      forget: () => undefined,
    };
    const create = new CreateVmOperation(
      storage,
      lifecycle,
      providers,
      claim as never,
      {
        certificateOf: async () => fixtureTls.cert,
        runtimeAt: async () => ({ state: 'unclaimed', imageVersion: '1.3.0' }),
      } as never,
    );
    const reset = new ResetVmOperation(
      storage,
      providers,
      writeback,
      detach as never,
      create,
      attach as never,
      inventory,
    );
    const destroy = new DestroyVmOperation(storage, providers, writeback, lifecycle);
    runner = new RemoteOperationRunner(
      storage,
      { broadcastEvent: jest.fn() } as never,
      attach as never,
      detach as never,
      claim as never,
      {
        kind: 'update_host',
        steps: [
          {
            id: 'install',
            label: 'Install',
            run: async () => {
              updateEntered?.();
              await updateGate?.promise;
            },
          },
        ],
        assertCancellable: () => undefined,
        rollback: async () => undefined,
      } as never,
      create,
      reset,
      destroy,
      undefined,
      {
        kind: 'update_logins',
        steps: claim.steps.filter((step) =>
          ['provider_auth_resolve', 'build_bundle', 'claim', 'verify_providers'].includes(step.id),
        ),
        assertCancellable: () => undefined,
        rollback: async () => undefined,
      } as never,
    );
    operations = new RemoteOperationsService(
      storage,
      runner,
      { create: (data: never) => storage.createRemote(data) } as never,
      vault,
      {
        isSupported: () => true,
        getSupportedProviders: () => ['codex'],
      } as unknown as ProviderAdapterFactory,
      undefined as never,
      undefined as never,
      { refresh: async () => ({ version: null }) } as never,
    );
    vmOperations = new VmOperationsService(
      storage,
      runner,
      operations,
      vault,
      providers,
      {} as never,
      {} as never,
    );
    remotes = new RemotesService(
      storage,
      {} as never,
      {} as never,
      writeback,
      runner,
      {} as never,
      {} as never,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
    runner.onApplicationShutdown();
    sqlite.close();
    rmSync(directory, { recursive: true, force: true });
    delete process.env.HOST_IMAGE_URL;
    delete process.env.HOST_IMAGE_SHA256;
    resetEnvConfig();
  });

  const input = () => ({
    name: 'alpha',
    cores: 2,
    memory: 4096,
    disk: 30,
    port: 4000,
    providerAuth: {},
  });

  const staticClaude = (label: string) =>
    storage.createProviderAuthEntry({
      provider: 'claude',
      kind: 'static',
      label,
      payload: { payloadKind: 'env', envKey: 'CLAUDE_CODE_OAUTH_TOKEN', value: 'test-token' },
    });

  it('creates, claims and registers two VMs while reusing the image and template', async () => {
    const first = await settle(await vmOperations.create(connectionId, input()));
    const second = await settle(
      await vmOperations.create(connectionId, { ...input(), name: 'beta' }),
    );
    expect([first.state, second.state]).toEqual(['done', 'done']);
    expect(calls.filter((call) => call === 'download')).toHaveLength(1);
    expect(calls.filter((call) => call === 'template')).toHaveLength(1);
    expect(first.steps.every((step) => ['done', 'skipped'].includes(step.state))).toBe(true);
    expect(claims).toHaveLength(2);
    const remote = await storage.getRemote(first.remoteId);
    expect(remote).toMatchObject({
      kind: 'proxmox',
      vmIdentity: 'vm-101',
      baseUrl: 'https://127.0.0.1:4000',
      tlsCertificate: new X509Certificate(fixtureTls.cert).toString(),
    });
    expect(first.details.bootstrapUrl).toBe('https://127.0.0.1:3000');
    expect(first.details.tlsCertificate).toBe(remote.tlsCertificate);
  });

  // Layer: storage/runner integration. Real persisted details and the real SSH merge
  // expose omissions when Change logins becomes Reset's most recent setup record.
  it('preserves and reapplies the SSH key through create, Change logins, and Reset', async () => {
    const key = utils.generateKeyPairSync('ed25519').public;
    const created = await settle(
      await vmOperations.create(connectionId, { ...input(), sshPublicKeys: [key] }),
    );
    expect(created.state).toBe('done');
    expect(created.steps.find((step) => step.id === 'claim_ssh_keys')?.state).toBe('done');
    const changed = await settle(
      await operations.updateLogins(created.remoteId, {
        providerAuth: { codex: 'skip' },
        force: false,
      }),
    );
    expect(changed.state).toBe('done');
    expect(changed.details.sshPublicKeys).toEqual([key]);
    expect(changed.steps.some((step) => step.id === 'ssh_keys')).toBe(false);
    const reset = await settle(
      await vmOperations.reset(created.remoteId, { force: false, providerAuth: {} }),
    );
    expect(reset.state).toBe('done');
    expect(reset.details.sshPublicKeys).toEqual([key]);
    expect(appliedSshKeys).toEqual([[key], [key]]);
    expect(await readFile(join(directory, '.ssh', 'authorized_keys'), 'utf8')).toBe(`${key}\n`);
  });

  it.each(['dev_box', 'box-', 'box.'])(
    'rejects invalid Proxmox create name %s before making a provider call',
    async (name) => {
      const controller = new VmOperationsController(vmOperations);
      await expect(
        controller.create(connectionId, { name, cores: 2, memory: 4096, disk: 30 }),
      ).rejects.toBeInstanceOf(ZodError);
      expect(calls).toEqual([]);
      await expect(storage.listRemotes()).resolves.toMatchObject({ items: [] });
    },
  );

  it('resets two projects after pulling families, then reconnects both to the same remote', async () => {
    const created = await settle(await vmOperations.create(connectionId, input()));
    const old = await storage.getRemote(created.remoteId);
    await storage.saveRemoteApiKey(old.id, 'dck_kept_across_vm_reset');
    const prior = {
      items: [],
      importedAt: '2026-09-01T00:00:00.000Z',
      groups: [
        {
          volumes: ['data'],
          bindPaths: [],
          lastSyncedAt: '2026-09-01T00:00:00.000Z',
          lastSyncDirection: 'to-vm',
        },
      ],
    };
    inventory.set('disconnected-project', old.id, prior);
    inventory.set('other-project', 'other-remote', prior);
    for (const name of ['one', 'two']) {
      const project = await storage.createProject({
        name,
        description: null,
        rootPath: join(directory, name),
        isTemplate: false,
      });
      await storage.createRemoteProjectBinding({ projectId: project.id, remoteId: old.id });
      await storage.updateRemoteProjectBinding(project.id, { state: 'remote' });
    }
    const reset = await settle(
      await vmOperations.reset(old.id, {
        force: false,
        providerAuth: {},
        port: 4000,
      }),
    );
    expect(reset.state).toBe('done');
    expect(inventory.get('disconnected-project', old.id)).toBeNull();
    expect(inventory.get('other-project', 'other-remote')).toEqual(prior);
    expect(calls.indexOf('pull-families')).toBeLessThan(calls.indexOf('destroy:vm-101'));
    expect(calls.filter((call) => call.startsWith('detach:'))).toHaveLength(2);
    expect(calls.filter((call) => call.startsWith('attach:'))).toHaveLength(2);
    expect(calls).toContain(`reuse:${FAMILY_ID}`);
    expect(fakeVms.has(101)).toBe(false);
    const current = await storage.getRemote(old.id);
    expect(await storage.readRemoteApiKey(old.id)).toBe('dck_kept_across_vm_reset');
    expect(JSON.stringify(reset.details)).not.toContain('dck_kept_across_vm_reset');
    expect(current.id).toBe(old.id);
    expect(current.name).toBe(old.name);
    expect(current.baseUrl).toBe('https://127.0.0.2:4000');
    expect(old.tlsCertificate).toBe(new X509Certificate(fixtureTls.cert).toString());
    expect(current.tlsCertificate).toBe(new X509Certificate(otherTls.cert).toString());
    expect((reset.details as { tlsCertificate?: string }).tlsCertificate).toBe(
      current.tlsCertificate,
    );
    expect(
      (await storage.listRemoteProjectBindings()).filter(
        (binding) => binding.remoteId === old.id && binding.state === 'remote',
      ),
    ).toHaveLength(2);
  });

  it('reuses a static Claude login, the prior port, and the old Proxmox VM name', async () => {
    const claude = await staticClaude('Claude for VM');
    const created = await settle(
      await vmOperations.create(connectionId, {
        ...input(),
        providerAuth: { claude: `reuse:${claude.id}` },
      }),
    );
    expect(created.details.providerAuth).toMatchObject({
      claude: { entryIds: [claude.id] },
    });
    const oldName = fakeVms.get(101)?.name;
    await storage.updateRemoteName(created.remoteId, 'My VM');
    const resetCallStart = calls.length;
    const reset = await settle(
      await vmOperations.reset(created.remoteId, { force: false, providerAuth: {} }),
    );
    expect(reset.state).toBe('done');
    expect(reset.details).toMatchObject({
      userName: 'alice',
      homePath: '/home/alice',
      port: 4000,
      vmName: oldName,
      providerAuth: { claude: { entryIds: [claude.id] } },
    });
    expect(claims.at(-1)?.providerAuth).toMatchObject({ claude: { entryIds: [claude.id] } });
    expect(calls.slice(resetCallStart)).toContain('verify:claude');
    expect(fakeVms.get(102)?.name).toBe(oldName);
    expect((await storage.getRemote(created.remoteId)).name).toBe('My VM');
  });

  it.each(['install_host', 'update_logins'] as const)(
    'Reset reads the most recent %s login record',
    async (kind) => {
      const old = await staticClaude('Original');
      const replacement = await staticClaude('Replacement');
      const created = await settle(
        await vmOperations.create(connectionId, {
          ...input(),
          providerAuth: { claude: `reuse:${old.id}` },
        }),
      );
      const remembered = await storage.createRemoteOperation({
        kind,
        remoteId: created.remoteId,
        projectId: null,
        steps: [],
        details: {
          ...created.details,
          providerAuth: {
            claude: {
              choice: 'reuse',
              entryId: replacement.id,
              entryIds: [replacement.id],
              checkedOut: ['stale'],
            },
          },
        },
      });
      await storage.updateRemoteOperation(remembered.id, { state: 'done' });
      const reset = await settle(
        await vmOperations.reset(created.remoteId, { force: false, providerAuth: {} }),
      );
      expect(reset.state).toBe('done');
      expect(reset.details.providerAuth).toMatchObject({ claude: { entryIds: [replacement.id] } });
      expect(JSON.stringify(reset.details.providerAuth)).not.toContain('stale');
    },
  );

  it('preserves the saved Docker opt-in when reset rebuilds claim details', async () => {
    const created = await settle(
      await vmOperations.create(connectionId, { ...input(), installDocker: true }),
    );
    expect(created.details.installDocker).toBe(true);
    const reset = await settle(
      await vmOperations.reset(created.remoteId, { force: false, providerAuth: {} }),
    );
    expect(reset.state).toBe('done');
    expect(reset.details.installDocker).toBe(true);
    expect(reset.steps.some((step) => step.id.startsWith('create_claim_'))).toBe(true);
  });

  it("lets an explicit reset login and port override the remembered claim; the identity stays this PC's", async () => {
    const oldClaude = await staticClaude('Original Claude');
    const newClaude = await staticClaude('New Claude');
    const created = await settle(
      await vmOperations.create(connectionId, {
        ...input(),
        providerAuth: { claude: `reuse:${oldClaude.id}` },
      }),
    );
    const reset = await settle(
      await vmOperations.reset(created.remoteId, {
        force: false,
        providerAuth: { claude: `reuse:${newClaude.id}` },
        port: 5000,
      }),
    );
    expect(reset.state).toBe('done');
    expect(reset.details).toMatchObject({
      userName: 'alice',
      homePath: '/home/alice',
      port: 5000,
      providerAuth: { claude: { entryIds: [newClaude.id] } },
    });
    expect(claims.at(-1)?.providerAuth).toMatchObject({ claude: { entryIds: [newClaude.id] } });
    const again = await settle(
      await vmOperations.reset(created.remoteId, { force: false, providerAuth: {} }),
    );
    expect(again.state).toBe('done');
    expect(again.details).toMatchObject({
      userName: 'alice',
      homePath: '/home/alice',
      port: 5000,
      providerAuth: { claude: { entryIds: [newClaude.id] } },
    });
  });

  it('omits a deleted remembered login and still starts reset', async () => {
    const claude = await staticClaude('Temporary Claude');
    const created = await settle(
      await vmOperations.create(connectionId, {
        ...input(),
        providerAuth: { claude: `reuse:${claude.id}` },
      }),
    );
    await storage.deleteProviderAuthEntry(claude.id);
    const resetCallStart = calls.length;
    const reset = await settle(
      await vmOperations.reset(created.remoteId, { force: false, providerAuth: {} }),
    );
    expect(reset.state).toBe('done');
    expect((reset.details.providerAuth as Record<string, unknown>).claude).toBeUndefined();
    expect(claims.at(-1)?.providerAuth.claude).toBeUndefined();
    expect(calls.slice(resetCallStart)).not.toContain('verify:claude');
  });

  it('reuses every resolved entry of a provider with multiple logins', async () => {
    const first = await storage.createProviderAuthEntry({
      provider: 'opencode',
      kind: 'static',
      label: 'OpenCode A',
      payload: {
        payloadKind: 'opencode-entry',
        providerId: 'first',
        entry: { type: 'api', key: 'first-secret' },
      },
    });
    const second = await storage.createProviderAuthEntry({
      provider: 'opencode',
      kind: 'static',
      label: 'OpenCode B',
      payload: {
        payloadKind: 'opencode-entry',
        providerId: 'second',
        entry: { type: 'api', key: 'second-secret' },
      },
    });
    const created = await settle(
      await vmOperations.create(connectionId, {
        ...input(),
        providerAuth: { opencode: `reuse:${first.id}` },
      }),
    );
    await storage.updateRemoteOperation(created.id, {
      details: {
        ...created.details,
        providerAuth: {
          ...(created.details.providerAuth as Record<string, unknown>),
          opencode: { choice: 'reuse', entryId: first.id, entryIds: [first.id, second.id] },
        },
      },
    });
    const reset = await settle(
      await vmOperations.reset(created.remoteId, { force: false, providerAuth: {} }),
    );
    expect(reset.state).toBe('done');
    expect(reset.details.providerAuth).toMatchObject({
      opencode: { entryIds: [first.id, second.id] },
    });
    expect(JSON.stringify(reset.details)).not.toContain('first-secret');
    expect(JSON.stringify(reset.details)).not.toContain('second-secret');
  });

  it('uses checked-out families and local defaults when no prior claim exists', async () => {
    fakeVms.set(101, { identity: 'vm-101', name: 'dc-legacy', operationId: 'legacy' });
    const remote = await storage.createRemote({
      name: 'legacy',
      kind: 'proxmox',
      baseUrl: 'https://127.0.0.1:4000',
      vmProviderConnectionId: connectionId,
      vmIdentity: 'vm-101',
      vmSpec: { cores: 2, memory: 4096, disk: 30 },
    });
    const reset = await settle(
      await vmOperations.reset(remote.id, { force: false, providerAuth: {} }),
    );
    expect(reset.state).toBe('done');
    expect(reset.details).toMatchObject({
      vmName: 'dc-legacy',
      userName: userInfo().username,
      homePath: homedir(),
      providerAuth: { codex: { entryIds: [FAMILY_ID] } },
    });
    expect(claims.at(-1)?.providerAuth).toMatchObject({ codex: { entryIds: [FAMILY_ID] } });
  });

  it('cancels during clone and removes only its own VM', async () => {
    cloneGate = gate();
    const entered = new Promise<void>((resolve) => {
      cloneEntered = resolve;
    });
    const started = await vmOperations.create(connectionId, input());
    await entered;
    const cancelling = runner.cancel(started.id);
    cloneGate.release();
    const result = await cancelling;
    expect(result.state).toBe('cancelled');
    expect(fakeVms.has(101)).toBe(false);
    expect(fakeVms.has(199)).toBe(true);
    expect(calls).toContain('cleanup:101');
  });

  it('records each forced detach loss and the last family write-back', async () => {
    const created = await settle(await vmOperations.create(connectionId, input()));
    hostOffline = true;
    for (const name of ['one', 'two']) {
      const project = await storage.createProject({
        name,
        description: null,
        rootPath: join(directory, name),
        isTemplate: false,
      });
      await storage.createRemoteProjectBinding({
        projectId: project.id,
        remoteId: created.remoteId,
      });
      await storage.updateRemoteProjectBinding(project.id, { state: 'remote' });
    }
    const reset = await settle(
      await vmOperations.reset(created.remoteId, {
        force: true,
        providerAuth: {},
        port: 4000,
      }),
    );
    expect(reset.state).toBe('done');
    expect(reset.details.forcedLoss as unknown[]).toHaveLength(2);
    expect(reset.details.forcedLoss).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          families: [family],
          detach: expect.objectContaining({ teamLanes: 'unfinalized' }),
        }),
      ]),
    );
  });

  it('resumes reset after the old VM was deleted but its response was lost', async () => {
    const created = await settle(await vmOperations.create(connectionId, input()));
    loseDestroyResponse = true;
    const started = await vmOperations.reset(created.remoteId, {
      force: false,
      providerAuth: {},
      port: 4000,
    });
    const failed = await settle(started);
    expect(failed.state).toBe('failed');
    expect(failed.details.oldVmid).toBe(101);
    expect(fakeVms.has(101)).toBe(false);
    const resumed = await settle(await runner.retry(started.id));
    expect(resumed.state).toBe('done');
    expect((await storage.getRemote(created.remoteId)).vmIdentity).toBe('vm-102');
  });

  it('chooses a new VMID on retry when the planned clone ID was taken', async () => {
    vmidCollision = true;
    const started = await vmOperations.create(connectionId, input());
    const failed = await settle(started);
    expect(failed.state).toBe('failed');
    expect(failed.steps.find((step) => step.id === 'clone')?.error?.code).toBe('VMID_TAKEN');
    const resumed = await settle(await runner.retry(started.id));
    expect(resumed.state).toBe('done');
    expect((await storage.getRemote(started.remoteId)).vmIdentity).toBe('vm-102');
    expect(fakeVms.has(199)).toBe(true);
  });

  it('rejects memory below 4096 before creating a remote or operation', async () => {
    await expect(
      vmOperations.create(connectionId, { ...input(), memory: 2048 }),
    ).rejects.toBeInstanceOf(ZodError);
    await expect(storage.listRemotes()).resolves.toMatchObject({ items: [] });
    await expect(storage.listRemoteOperations()).resolves.toEqual([]);
    expect(calls).toEqual([]);
  });

  it('returns a conflict for a host update while create is open', async () => {
    cloneGate = gate();
    const entered = new Promise<void>((resolve) => {
      cloneEntered = resolve;
    });
    const started = await vmOperations.create(connectionId, input());
    await entered;
    await expect(operations.updateHost(started.remoteId)).rejects.toMatchObject({
      statusCode: 409,
    });
    await expect(
      operations.claim({
        remoteId: started.remoteId,
        port: 4000,
        providerAuth: {},
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(vmOperations.destroy(started.remoteId, { force: false })).rejects.toMatchObject({
      statusCode: 409,
    });
    await expect(remotes.delete(started.remoteId)).rejects.toMatchObject({ statusCode: 409 });
    const cancelling = runner.cancel(started.id);
    cloneGate.release();
    await cancelling;
  });

  it('returns a conflict for reset while a host update is open', async () => {
    const created = await settle(await vmOperations.create(connectionId, input()));
    updateGate = gate();
    const entered = new Promise<void>((resolve) => {
      updateEntered = resolve;
    });
    const update = await operations.updateHost(created.remoteId);
    await entered;
    await expect(
      vmOperations.reset(created.remoteId, {
        force: false,
        providerAuth: {},
        port: 4000,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(vmOperations.destroy(created.remoteId, { force: false })).rejects.toMatchObject({
      statusCode: 409,
    });
    updateGate.release();
    await settle(update);
  });

  it('returns a conflict for claim and update while reset is open', async () => {
    const created = await settle(await vmOperations.create(connectionId, input()));
    pullGate = gate();
    const entered = new Promise<void>((resolve) => {
      pullEntered = resolve;
    });
    const reset = await vmOperations.reset(created.remoteId, {
      force: false,
      providerAuth: {},
      port: 4000,
    });
    await entered;
    await expect(operations.updateHost(created.remoteId)).rejects.toMatchObject({
      statusCode: 409,
    });
    await expect(
      operations.claim({
        remoteId: created.remoteId,
        port: 4000,
        providerAuth: {},
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(operations.attach(created.remoteId, 'project-new')).rejects.toMatchObject({
      statusCode: 409,
    });
    await expect(operations.detach(created.remoteId, 'project-old', false)).rejects.toMatchObject({
      statusCode: 409,
    });
    await expect(vmOperations.destroy(created.remoteId, { force: false })).rejects.toMatchObject({
      statusCode: 409,
    });
    pullGate.release();
    expect((await settle(reset)).state).toBe('done');
  });

  it('destroys a guarded VM after pulling families and removes its remote and operation', async () => {
    const created = await settle(await vmOperations.create(connectionId, input()));
    const started = await vmOperations.destroy(created.remoteId, { force: false });
    await runner.whenIdle(started.id);
    expect(calls.indexOf('pull-families')).toBeLessThan(calls.indexOf('destroy:vm-101'));
    expect(fakeVms.has(101)).toBe(false);
    expect(fakeVms.has(199)).toBe(true);
    await expect(storage.getRemote(created.remoteId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(storage.getRemoteOperation(started.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('supersedes a failed create after claim and destroys its guarded clone', async () => {
    failClaim = true;
    const failed = await settle(await vmOperations.create(connectionId, input()));
    expect(failed.state).toBe('failed');
    expect(failed.steps.find((step) => step.id === 'claim_claim')?.state).toBe('failed');
    expect(fakeVms.has(101)).toBe(true);
    jest.spyOn(storage, 'deleteRemote').mockRejectedValueOnce(new Error('keep evidence'));
    const started = await vmOperations.destroy(failed.remoteId, { force: false });
    await runner.whenIdle(started.id);
    expect(fakeVms.has(101)).toBe(false);
    expect(fakeVms.has(199)).toBe(true);
    expect(await storage.getRemoteOperation(failed.id)).toMatchObject({
      state: 'cancelled',
      details: { supersededAt: expect.any(String) },
    });
    expect(await storage.getRemoteOperation(started.id)).toMatchObject({ state: 'done' });
    await remotes.delete(failed.remoteId);
  });

  it("leaves another operation's VM at the planned VMID when destroying a failed create", async () => {
    fakeVms.set(101, { identity: 'vm-other', name: 'dc-other', operationId: 'other-operation' });
    vmidCollision = true;
    const failed = await settle(await vmOperations.create(connectionId, input()));
    expect(failed.steps.find((step) => step.id === 'clone')?.error?.code).toBe('VMID_TAKEN');
    expect(failed.details.vmid).toBe(101);
    const started = await vmOperations.destroy(failed.remoteId, { force: false });
    await runner.whenIdle(started.id);
    expect(fakeVms.get(101)).toMatchObject({ identity: 'vm-other' });
    expect(calls.filter((call) => call.startsWith('destroy-vmid:'))).toEqual([]);
    await expect(storage.getRemote(failed.remoteId)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('keeps a VM that took over the planned VMID between preflight and destroy', async () => {
    loseCloneResponse = true;
    const failed = await settle(await vmOperations.create(connectionId, input()));
    expect((await storage.getRemote(failed.remoteId)).vmIdentity).toBeNull();
    expect(fakeVms.has(101)).toBe(true);
    pullGate = gate();
    const entered = new Promise<void>((resolve) => {
      pullEntered = resolve;
    });
    const started = await vmOperations.destroy(failed.remoteId, { force: false });
    await entered;
    fakeVms.set(101, { identity: 'vm-other', name: 'dc-other', operationId: 'other-operation' });
    pullGate.release();
    await runner.whenIdle(started.id);
    expect(fakeVms.get(101)).toMatchObject({ identity: 'vm-other' });
    expect(calls.filter((call) => call.startsWith('destroy-vmid:'))).toEqual([]);
  });

  it('allows registration-only deletion after failed create while leaving the VM in Proxmox', async () => {
    failClaim = true;
    const failed = await settle(await vmOperations.create(connectionId, input()));
    expect(fakeVms.has(101)).toBe(true);
    await remotes.delete(failed.remoteId);
    expect(fakeVms.has(101)).toBe(true);
    await expect(storage.getRemote(failed.remoteId)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('allows registration-only deletion after failed reset while leaving its new VM in Proxmox', async () => {
    const created = await settle(await vmOperations.create(connectionId, input()));
    loseCloneResponse = true;
    const failed = await settle(
      await vmOperations.reset(created.remoteId, { force: false, providerAuth: {} }),
    );
    expect(failed.state).toBe('failed');
    expect(fakeVms.has(102)).toBe(true);
    await remotes.delete(created.remoteId);
    expect(fakeVms.has(102)).toBe(true);
    await expect(storage.getRemote(created.remoteId)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('cleans up a failed reset after old deletion when no new clone was attempted', async () => {
    const created = await settle(await vmOperations.create(connectionId, input()));
    failNextImageHead = true;
    const failed = await settle(
      await vmOperations.reset(created.remoteId, { force: false, providerAuth: {} }),
    );
    expect(failed.state).toBe('failed');
    expect(failed.steps.find((step) => step.id === 'destroy')?.state).toBe('done');
    expect(failed.steps.find((step) => step.id === 'create_clone')?.state).toBe('pending');
    expect((await storage.getRemote(created.remoteId)).vmIdentity).toBeNull();
    expect(fakeVms.has(101)).toBe(false);
    const destroy = await vmOperations.destroy(created.remoteId, { force: true });
    await runner.whenIdle(destroy.id);
    expect(calls.filter((call) => call.startsWith('destroy-vmid:'))).toEqual([]);
    await expect(storage.getRemote(created.remoteId)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('uses the guarded VMID when reset clone succeeded but its response was lost', async () => {
    const created = await settle(await vmOperations.create(connectionId, input()));
    loseCloneResponse = true;
    const failed = await settle(
      await vmOperations.reset(created.remoteId, { force: false, providerAuth: {} }),
    );
    expect(failed.state).toBe('failed');
    expect(failed.steps.find((step) => step.id === 'create_clone')?.state).toBe('failed');
    expect((await storage.getRemote(created.remoteId)).vmIdentity).toBeNull();
    expect(fakeVms.has(102)).toBe(true);
    const destroy = await vmOperations.destroy(created.remoteId, { force: true });
    await runner.whenIdle(destroy.id);
    expect(calls).toContain('destroy-vmid:102');
    expect(fakeVms.has(102)).toBe(false);
    expect(fakeVms.has(199)).toBe(true);
    await expect(storage.getRemote(created.remoteId)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('keeps a clone from a failed reset when the VMID ownership guard refuses it', async () => {
    const created = await settle(await vmOperations.create(connectionId, input()));
    loseCloneResponse = true;
    const failed = await settle(
      await vmOperations.reset(created.remoteId, { force: false, providerAuth: {} }),
    );
    rejectOwnership = true;
    const started = await vmOperations.destroy(created.remoteId, { force: true });
    const refused = await settle(started);
    expect(refused.state).toBe('failed');
    expect(refused.steps[0].id).toBe('preflight');
    expect(fakeVms.has(102)).toBe(true);
    expect(await storage.getRemoteOperation(failed.id)).toMatchObject({ state: 'cancelled' });
    expect(await storage.getRemote(created.remoteId)).toMatchObject({ vmIdentity: null });
  });

  it('refuses a remote without a managed VM before creating an operation', async () => {
    const remote = await storage.createRemote({
      name: 'Address only',
      kind: 'address',
      baseUrl: 'https://127.0.0.1:4000',
    });
    await expect(vmOperations.destroy(remote.id, { force: false })).rejects.toMatchObject({
      statusCode: 409,
      details: { code: 'REMOTE_NOT_VM_MANAGED' },
    });
    expect(await storage.listRemoteOperations({ remoteId: remote.id })).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('rejects a bound project before creating an operation or contacting Proxmox', async () => {
    const created = await settle(await vmOperations.create(connectionId, input()));
    const project = await storage.createProject({
      name: 'Bound',
      description: null,
      rootPath: join(directory, 'bound'),
      isTemplate: false,
    });
    await storage.createRemoteProjectBinding({ projectId: project.id, remoteId: created.remoteId });
    const operationsBefore = await storage.listRemoteOperations({ remoteId: created.remoteId });
    const callsBefore = [...calls];
    await expect(vmOperations.destroy(created.remoteId, { force: false })).rejects.toMatchObject({
      statusCode: 409,
      details: { code: 'REMOTE_HAS_PROJECT_BINDINGS' },
    });
    expect(await storage.listRemoteOperations({ remoteId: created.remoteId })).toEqual(
      operationsBefore,
    );
    expect(calls).toEqual(callsBefore);
  });

  it('keeps the VM, remote, and failed operation when the ownership guard refuses', async () => {
    const created = await settle(await vmOperations.create(connectionId, input()));
    rejectOwnership = true;
    const failed = await settle(await vmOperations.destroy(created.remoteId, { force: false }));
    expect(failed.state).toBe('failed');
    expect(failed.steps[0].id).toBe('preflight');
    expect(failed.steps[0].state).toBe('failed');
    expect(fakeVms.has(101)).toBe(true);
    expect(await storage.getRemote(created.remoteId)).toMatchObject({ vmIdentity: 'vm-101' });
    expect(calls).not.toContain('destroy:vm-101');
  });

  it('keeps the registration and tells the user to delete only it when the VM is missing', async () => {
    const created = await settle(await vmOperations.create(connectionId, input()));
    fakeVms.delete(101);
    const failed = await settle(await vmOperations.destroy(created.remoteId, { force: false }));
    expect(failed.state).toBe('failed');
    expect(failed.steps[0].error).toMatchObject({
      code: 'VM_NOT_FOUND',
      message: expect.stringMatching(/delete the registration only/i),
    });
    expect(await storage.getRemote(created.remoteId)).toMatchObject({ vmIdentity: 'vm-101' });
  });

  it('refuses an offline family pull, then permits a forced destroy after cancellation', async () => {
    const created = await settle(await vmOperations.create(connectionId, input()));
    hostOffline = true;
    const failed = await settle(await vmOperations.destroy(created.remoteId, { force: false }));
    expect(failed.steps.find((step) => step.id === 'pull_families')).toMatchObject({
      state: 'failed',
      error: { code: 'REMOTE_OFFLINE' },
    });
    expect(fakeVms.has(101)).toBe(true);
    expect(calls).not.toContain('destroy:vm-101');
    await expect(operations.attach(created.remoteId, 'project-new')).rejects.toMatchObject({
      statusCode: 409,
    });
    await expect(operations.detach(created.remoteId, 'project-old', false)).rejects.toMatchObject({
      statusCode: 409,
    });
    await expect(remotes.delete(created.remoteId)).rejects.toMatchObject({ statusCode: 409 });
    expect((await runner.cancel(failed.id)).state).toBe('cancelled');
    const forced = await vmOperations.destroy(created.remoteId, { force: true });
    await runner.whenIdle(forced.id);
    expect(calls).toContain('destroy:vm-101');
    await expect(storage.getRemote(created.remoteId)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('resumes after a lost delete response only with a persisted VMID and attempt', async () => {
    const created = await settle(await vmOperations.create(connectionId, input()));
    loseDestroyResponse = true;
    const failed = await settle(await vmOperations.destroy(created.remoteId, { force: false }));
    expect(failed.state).toBe('failed');
    expect(failed.details).toMatchObject({ vmid: 101, destroyAttempted: true });
    expect(fakeVms.has(101)).toBe(false);
    const retried = await runner.retry(failed.id);
    await runner.whenIdle(retried.id);
    await expect(storage.getRemote(created.remoteId)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('refuses cancellation once the destroy step has started', async () => {
    const created = await settle(await vmOperations.create(connectionId, input()));
    destroyGate = gate();
    const entered = new Promise<void>((resolve) => {
      destroyEntered = resolve;
    });
    const started = await vmOperations.destroy(created.remoteId, { force: false });
    await entered;
    try {
      await expect(runner.cancel(started.id)).rejects.toMatchObject({
        statusCode: 409,
        details: { code: 'REMOTE_OPERATION_NOT_CANCELLABLE' },
      });
    } finally {
      destroyGate.release();
      await runner.whenIdle(started.id);
    }
  });

  it('keeps a done operation and addressless registration when completion cleanup fails', async () => {
    const created = await settle(await vmOperations.create(connectionId, input()));
    jest.spyOn(storage, 'deleteRemote').mockRejectedValueOnce(new Error('cleanup unavailable'));
    const started = await vmOperations.destroy(created.remoteId, { force: false });
    await runner.whenIdle(started.id);
    expect(await storage.getRemoteOperation(started.id)).toMatchObject({ state: 'done' });
    expect(await storage.getRemote(created.remoteId)).toMatchObject({
      baseUrl: null,
      vmIdentity: null,
    });
    await remotes.delete(created.remoteId);
    await expect(storage.getRemote(created.remoteId)).rejects.toBeInstanceOf(NotFoundError);
    jest.restoreAllMocks();
  });

  it('excludes host, VM, project and registration deletion while destroy is open', async () => {
    const created = await settle(await vmOperations.create(connectionId, input()));
    pullGate = gate();
    const entered = new Promise<void>((resolve) => {
      pullEntered = resolve;
    });
    const started = await vmOperations.destroy(created.remoteId, { force: false });
    await entered;
    try {
      await expect(operations.updateHost(created.remoteId)).rejects.toMatchObject({
        statusCode: 409,
      });
      await expect(
        operations.claim({
          remoteId: created.remoteId,
          port: 4000,
          providerAuth: {},
        }),
      ).rejects.toMatchObject({ statusCode: 409 });
      await expect(
        vmOperations.reset(created.remoteId, { force: false, providerAuth: {} }),
      ).rejects.toMatchObject({ statusCode: 409 });
      await expect(vmOperations.destroy(created.remoteId, { force: false })).rejects.toMatchObject({
        statusCode: 409,
      });
      await expect(operations.attach(created.remoteId, 'project-new')).rejects.toMatchObject({
        statusCode: 409,
      });
      await expect(operations.detach(created.remoteId, 'project-old', false)).rejects.toMatchObject(
        { statusCode: 409 },
      );
      await expect(remotes.delete(created.remoteId)).rejects.toMatchObject({ statusCode: 409 });
    } finally {
      pullGate.release();
      await runner.whenIdle(started.id);
    }
  });
});
