import { certificateFingerprint } from '../../../common/tls/certificate';
import { createHash } from 'node:crypto';
import { RemoteApiKeyService } from '../auth/remote-api-key.service';
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDatabase } from '../../../common/test/test-database.helper';
import { getAppVersion } from '../../../common/app-version';
import { resetEnvConfig } from '../../../common/config/env.config';
import { PROVIDER_AUTH_ADAPTERS } from '../../provider-auth/provider-auth-adapters';
import type {
  ProviderAuthGeneration,
  ProviderAuthGeneratorService,
} from '../../provider-auth/provider-auth-generator.service';
import { ProviderAuthVaultService } from '../../provider-auth/provider-auth-vault.service';
import { ProviderAuthWritebackService } from '../../provider-auth/provider-auth-writeback.service';
import { FakeProcessExecutor } from '../../terminal/services/process-executor/fake-process-executor';
import type { ProcessExecutorOptions } from '../../terminal/services/process-executor/process-executor.port';
import type { ProviderAdapterFactory } from '../../providers/adapters/provider-adapter.factory';
import type { RealtimeBroadcaster } from '../../realtime/ports/realtime-broadcaster.port';
import { IntegrationCredentialCipher } from '../../storage/local/integration-credential-cipher';
import { LocalStorageService } from '../../storage/local/local-storage.service';
import type { RemoteOperation } from '../../storage/models/domain.models';
import { RemotesController } from '../controllers/remotes.controller';
import { RemoteHealthService } from '../services/remote-health.service';
import type { RemoteBindingsService } from '../services/remote-bindings.service';
import { RemotesService } from '../services/remotes.service';
import { ClaimOperation, type ClaimDetails } from './claim.operation';
import { RemoteHostClient, RemoteHostRequestError } from './remote-host.client';
import { RemoteOperationRunner } from './remote-operation.runner';
import type { RemoteOperationTiming } from './remote-operation.timing';
import { RemoteOperationsService } from './remote-operations.service';
import { UpdateHostOperation } from './update-host.operation';
import { CreateVmOperation } from './create-vm.operation';
import { VmOperationsService } from './vm-operations.service';
import type { ProxmoxVmLifecycleService } from '../../vm-providers/proxmox-vm-lifecycle.service';
import type { VmProvidersService } from '../../vm-providers/vm-providers.service';
import { FakeBootstrapServer } from '../../../common/test/fake-bootstrap.server';
import { otherTls } from '../../../common/test/tls-fixture';
import { InstallHostOperation, type InstallHostDetails } from './install-host.operation';
import type { SshCommandResult, SshSession } from '../host-install/ssh-runner';

const mockClaimInfo = jest.fn();

jest.mock('node:os', () => {
  const actual = jest.requireActual('node:os');
  const identity = { username: 'alice', home: '/Users/alice' };
  return {
    ...actual,
    userInfo: () => ({ username: identity.username }),
    homedir: () => identity.home,
  };
});

jest.mock('../../../common/logging/logger', () => ({
  createLogger: () => ({
    info: (...args: unknown[]) => mockClaimInfo(...args),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

const CODEX_FILE = '{"auth_mode":"chatgpt","tokens":{"refresh_token":"codex-secret-refresh"}}';
const CLAUDE_TOKEN = 'sk-ant-oat01-claude-secret-token';
const TIMING: RemoteOperationTiming = {
  pollIntervalMs: 20,
  claimInstallTimeoutMs: 10_000,
  claimStartTimeoutMs: 100,
  hostUpdateTimeoutMs: 1_000,
};

/** Isolated logins finish at once with a stored entry, or never (`hold`). */
class FakeGenerator {
  hold = false;
  started: string[] = [];
  private readonly generations = new Map<string, ProviderAuthGeneration>();

  constructor(private readonly vault: ProviderAuthVaultService) {}

  async start(provider: string): Promise<ProviderAuthGeneration> {
    const id = `00000000-0000-4000-8000-${String(this.generations.size + 1).padStart(12, '0')}`;
    this.started.push(provider);
    const generation: ProviderAuthGeneration = {
      id,
      provider,
      sessionId: `session-${id}`,
      state: 'waiting',
      startedAt: 'now',
      finishedAt: null,
      entries: [],
      error: null,
    };
    this.generations.set(id, generation);
    if (!this.hold) {
      generation.entries = await this.vault.createGenerated(
        provider,
        `${provider} generated`,
        [{ kind: 'family', payload: { payloadKind: 'files', content: CODEX_FILE }, secrets: [] }],
        'now',
      );
      generation.state = 'stored';
      generation.finishedAt = 'now';
    }
    return { ...generation };
  }

  get(id: string): ProviderAuthGeneration {
    const generation = this.generations.get(id);
    if (!generation) throw new Error('not found');
    return { ...generation };
  }

  async cancel(id: string): Promise<ProviderAuthGeneration> {
    const generation = this.generations.get(id)!;
    generation.state = 'cancelled';
    generation.finishedAt = 'now';
    return { ...generation };
  }
}

class InstalledHostSshSession implements SshSession {
  readonly fingerprint = 'SHA256:integration-host';

  constructor(private readonly certificate: () => string) {}

  async uploadTemp(): Promise<string> {
    return '/tmp/devchain-host-install.integration';
  }

  async exec(command: string): Promise<SshCommandResult> {
    if (command.includes(' --check')) {
      return { code: 0, stdout: 'Pre-validation passed.\n', stderr: '' };
    }
    if (command.includes('getent passwd')) return { code: 2, stdout: '', stderr: '' };
    if (command.includes('printf finished') && command.includes('systemctl is-active')) {
      return { code: 0, stdout: 'finished', stderr: '' };
    }
    if (command.includes('__DEVCHAIN_EXIT__')) {
      return { code: 0, stdout: 'installed\n__DEVCHAIN_EXIT__0', stderr: '' };
    }
    if (command.includes('/etc/devchain-host/tls/cert.pem')) {
      return { code: 0, stdout: this.certificate(), stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  }
}

class InstalledHostSsh {
  private readonly session: InstalledHostSshSession;

  constructor(certificate: () => string) {
    this.session = new InstalledHostSshSession(certificate);
  }

  async connect(): Promise<string> {
    return this.session.fingerprint;
  }

  async withSession<T>(_options: unknown, use: (session: SshSession) => Promise<T>): Promise<T> {
    return use(this.session);
  }
}

// Layer: backend integration. Real storage (migrated SQLite, real cipher),
// vault, host client, health service and runner against a fake VM over HTTP;
// isolated logins are faked.
describe('claim and update_host operations', () => {
  let secretDir: string;
  let sqlite: Database.Database;
  let storage: LocalStorageService;
  let vault: ProviderAuthVaultService;
  let apiKeys: RemoteApiKeyService;
  let generator: FakeGenerator;
  let health: RemoteHealthService;
  let host: RemoteHostClient;
  let processExecutor: FakeProcessExecutor;
  let bindings: Array<{ projectId: string; remoteId: string; state: string }>;
  let runner: RemoteOperationRunner;
  let service: RemoteOperationsService;
  let vm: FakeBootstrapServer;
  let installDefinition: InstallHostOperation;

  const adapters = {
    isSupported: (provider: string) => provider.toLowerCase() in PROVIDER_AUTH_ADAPTERS,
    getSupportedProviders: () => Object.keys(PROVIDER_AUTH_ADAPTERS),
  } as unknown as ProviderAdapterFactory;
  const broadcaster: RealtimeBroadcaster = { broadcastEvent: jest.fn() } as never;

  function makeRunner(): RemoteOperationRunner {
    const claim = new ClaimOperation(
      storage,
      health,
      host,
      vault,
      generator as unknown as ProviderAuthGeneratorService,
      processExecutor,
      apiKeys,
      TIMING,
    );
    const updateHost = new UpdateHostOperation(
      health,
      { list: async () => bindings } as unknown as RemoteBindingsService,
      host,
      TIMING,
    );
    installDefinition = new InstallHostOperation(
      new InstalledHostSsh(() => vm.certificate) as never,
      { render: async () => 'host install block' } as never,
      host,
      claim,
      storage,
      { installTimeoutMs: 1_000, bootstrapTimeoutMs: 1_000, pollIntervalMs: 10 },
    );
    return new RemoteOperationRunner(
      storage,
      broadcaster,
      { kind: 'attach', steps: [] } as never,
      { kind: 'detach', steps: [] } as never,
      claim,
      updateHost,
      undefined,
      undefined,
      undefined,
      installDefinition,
    );
  }

  function makeService(): RemoteOperationsService {
    // Only approveCertificate is reached from the operations service.
    const remotes = new RemotesService(
      storage,
      {} as never,
      host,
      {} as never,
      runner,
      {} as never,
      apiKeys,
    );
    return new RemoteOperationsService(
      storage as never,
      runner,
      remotes,
      vault,
      adapters,
      installDefinition,
      { resolve: async (input: never) => ({ credentials: input }) } as never,
      health,
      { recordAttach: jest.fn() } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
  }

  async function settle(id: string): Promise<RemoteOperation> {
    await runner.whenIdle(id);
    return storage.getRemoteOperation(id);
  }

  const stepStates = (operation: RemoteOperation) =>
    Object.fromEntries(operation.steps.map((step) => [step.id, step.state]));

  beforeEach(async () => {
    mockClaimInfo.mockClear();
    secretDir = mkdtempSync(join(tmpdir(), 'devchain-claim-op-'));
    const database = createTestDatabase();
    sqlite = database.sqlite;
    const { db } = database;
    storage = new LocalStorageService(
      db,
      new IntegrationCredentialCipher({
        secretDirectory: secretDir,
        machineIdentity: 'claim-test:u',
      }),
    );
    apiKeys = new RemoteApiKeyService(storage);
    vault = new ProviderAuthVaultService(storage, adapters);
    generator = new FakeGenerator(vault);
    health = new RemoteHealthService(
      storage,
      broadcaster,
      new ProviderAuthWritebackService(storage, vault, apiKeys),
      {} as never,
      {
        createPollCycle: () => () => Promise.resolve(null),
        pushIfChanged: async () => undefined,
        prune: () => undefined,
      } as never,
      { pushIfChanged: async () => undefined } as never,
      { registerRemoteCheck: () => () => undefined } as never,
      apiKeys,
    );
    host = new RemoteHostClient(storage, apiKeys);
    processExecutor = new FakeProcessExecutor();
    processExecutor.setDefaultResponse({ type: 'failure', exitCode: 1 });
    bindings = [];
    runner = makeRunner();
    service = makeService();
    vm = new FakeBootstrapServer();
    await vm.listen();
  });

  afterEach(async () => {
    runner.onApplicationShutdown();
    await vm.close();
    sqlite.close();
    rmSync(secretDir, { recursive: true, force: true });
    delete process.env.HOST_IMAGE_URL;
    delete process.env.HOST_IMAGE_SHA256;
    resetEnvConfig();
  });

  const claimAt = (providerAuth: Record<string, string>) =>
    service.claim({
      baseUrl: vm.url,
      certificateFingerprint: certificateFingerprint(vm.certificate),
      name: 'vm-1',
      port: Number(new URL(vm.url).port),
      providerAuth,
    });

  async function installAt(
    providerAuth: Record<string, string>,
    installDocker = false,
  ): Promise<RemoteOperation> {
    const remote = await storage.createRemote({
      name: 'installed-vm',
      baseUrl: vm.url,
      kind: 'address',
    });
    const claim = await service.claimDetails({
      bootstrapUrl: vm.url,
      installDocker,
      port: Number(new URL(vm.url).port),
      providerAuth,
    });
    const id = randomUUID();
    const details: InstallHostDetails = {
      ...claim,
      address: '127.0.0.1',
      sshUser: 'alice',
      sshAuthKind: 'password',
      minDiskGib: 12,
    };
    installDefinition.seedCredentials(id, { user: 'alice', password: 'ssh-secret' });
    return runner.start({
      id,
      kind: 'install_host',
      remoteId: remote.id,
      projectId: null,
      details: details as unknown as Record<string, unknown>,
    });
  }

  async function seedLogins() {
    const claude = await vault.createStatic({
      provider: 'claude',
      label: 'Claude',
      token: CLAUDE_TOKEN,
    });
    const [codex] = await vault.createGenerated(
      'codex',
      'Codex A',
      [{ kind: 'family', payload: { payloadKind: 'files', content: CODEX_FILE }, secrets: [] }],
      'now',
    );
    return { claude, codex };
  }

  it('runs the shared Docker step once after Host Install when opted in', async () => {
    const done = await settle((await installAt({}, true)).id);
    expect(done.state).toBe('done');
    expect(vm.dockerRequests).toBe(1);
    expect(stepStates(done).claim_docker).toBe('done');
  });

  it('uses actual runtime ids when an old bootstrap ignores the requested uid', async () => {
    const requestedUid = process.getuid?.();
    const actualUid = (requestedUid ?? 1000) + 1000;
    vm.legacyAllocatedIds = { uid: actualUid, gid: actualUid + 1 };
    const started = await claimAt({});
    const done = await settle(started.id);
    expect(done.state).toBe('done');
    expect(vm.claims).toHaveLength(1);
    expect(vm.claims[0].uid).toBe(requestedUid);
    expect(vm.claims[0].gid).toBe(process.getgid?.());
    expect(vm.claims[0].uid).not.toBe(actualUid);
    expect(health.getState(done.remoteId)).toMatchObject({ uid: actualUid, gid: actualUid + 1 });
    const controller = new RemotesController(
      storage,
      health,
      {} as RemotesService,
      { warning: () => null } as never,
    );
    const response = await controller.listRemotes();
    expect(response.items.find((remote) => remote.id === done.remoteId)).toMatchObject({
      uid: actualUid,
      gid: actualUid + 1,
    });
  });

  it('composes an installed host with a generated login through the real claim steps', async () => {
    const started = await installAt({ codex: 'generate' });
    const done = await settle(started.id);

    expect(done.state).toBe('done');
    expect(stepStates(done)).toMatchObject({
      ssh_connect: 'done',
      check: 'done',
      install: 'done',
      wait_bootstrap: 'done',
      claim_provider_auth_resolve: 'done',
      claim_claim: 'done',
      claim_verify_providers: 'done',
      claim_register_remote: 'done',
    });
    expect(generator.started).toEqual(['codex']);
    expect(vm.claims).toHaveLength(1);
    expect(vm.verifies).toEqual(['codex']);
    expect(installDefinition.hasCredentials(started.id)).toBe(false);
    const remote = await storage.getRemote(done.remoteId);
    expect(remote.tlsFingerprint).toBe(certificateFingerprint(vm.certificate));
    expect((done.details as unknown as InstallHostDetails).tlsCertificate).toBe(
      remote.tlsCertificate,
    );
  });

  it('replaces a failed generated login choice and completes the installed-host claim', async () => {
    vm.verifyAnswers.codex = {
      ok: false,
      summary: 'Not logged in',
      hint: 'Codex is not logged in.',
    };
    const started = await installAt({ codex: 'generate' });
    const failed = await settle(started.id);
    expect(failed.state).toBe('failed');
    expect(failed.steps.find((step) => step.id === 'claim_verify_providers')?.error?.code).toBe(
      'PROVIDER_AUTH_VERIFY_FAILED',
    );

    delete vm.verifyAnswers.codex;
    await service.retry(started.id, { codex: 'generate' });
    const done = await settle(started.id);

    expect(done.state).toBe('done');
    expect(generator.started).toEqual(['codex', 'codex']);
    expect(vm.claims).toHaveLength(1);
    expect(vm.applied).toHaveLength(1);
  });

  it('cancels an installed-host claim and releases provider vault checkouts', async () => {
    const { codex } = await seedLogins();
    generator.hold = true;
    const started = await installAt({ codex: `reuse:${codex.id}`, agy: 'generate' });
    for (let index = 0; index < 100; index += 1) {
      if ((await vault.get(codex.id)).checkedOutRemoteId) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect((await vault.get(codex.id)).checkedOutRemoteId).not.toBeNull();

    const cancelled = await runner.cancel(started.id);

    expect(cancelled.state).toBe('cancelled');
    expect((await vault.get(codex.id)).checkedOutRemoteId).toBeNull();
    expect(installDefinition.hasCredentials(started.id)).toBe(false);
  });

  it('resumes after a home restart by requiring SSH credentials on retry', async () => {
    const remote = await storage.createRemote({
      name: 'restarted-install',
      baseUrl: vm.url,
      kind: 'address',
    });
    const claim = await service.claimDetails({
      bootstrapUrl: vm.url,
      port: Number(new URL(vm.url).port),
      providerAuth: {},
    });
    const details: InstallHostDetails = {
      ...claim,
      address: '127.0.0.1',
      sshUser: 'alice',
      sshAuthKind: 'password',
      hostKeyFingerprint: 'SHA256:integration-host',
      minDiskGib: 12,
    };
    const operationId = randomUUID();
    await storage.createRemoteOperation({
      id: operationId,
      kind: 'install_host',
      remoteId: remote.id,
      projectId: null,
      details: details as unknown as Record<string, unknown>,
      steps: installDefinition.steps.map((step, index) => ({
        id: step.id,
        label: step.label,
        state: index < 2 ? ('done' as const) : ('pending' as const),
        startedAt: index < 2 ? 'before-restart' : null,
        endedAt: index < 2 ? 'before-restart' : null,
        error: null,
      })),
    });

    runner.onApplicationShutdown();
    runner = makeRunner();
    service = makeService();
    await runner.onApplicationBootstrap();
    const missing = await settle(operationId);
    expect(missing.state).toBe('failed');
    expect(missing.steps.find((step) => step.id === 'install')?.error?.code).toBe(
      'SSH_CREDENTIALS_REQUIRED',
    );

    await service.retry(operationId, undefined, { user: 'alice', password: 'new-ssh-secret' });
    const done = await settle(operationId);

    expect(done.state).toBe('done');
    expect(vm.claims).toHaveLength(1);
    expect((await storage.getRemote(remote.id)).tlsFingerprint).toBe(
      certificateFingerprint(vm.certificate),
    );
  });

  it('resumes after the install with the saved certificate and without SSH credentials', async () => {
    const remote = await storage.createRemote({
      name: 'installed-before-restart',
      baseUrl: vm.url,
      kind: 'address',
      tlsCertificate: vm.certificate,
    });
    const claim = await service.claimDetails({
      bootstrapUrl: vm.url,
      port: Number(new URL(vm.url).port),
      providerAuth: {},
    });
    const details: InstallHostDetails = {
      ...claim,
      address: '127.0.0.1',
      sshUser: 'alice',
      sshAuthKind: 'password',
      hostKeyFingerprint: 'SHA256:integration-host',
      minDiskGib: 12,
      tlsCertificate: remote.tlsCertificate!,
    };
    const operationId = randomUUID();
    await storage.createRemoteOperation({
      id: operationId,
      kind: 'install_host',
      remoteId: remote.id,
      projectId: null,
      details: details as unknown as Record<string, unknown>,
      steps: installDefinition.steps.map((step, index) => ({
        id: step.id,
        label: step.label,
        state: index < 3 ? ('done' as const) : ('pending' as const),
        startedAt: index < 3 ? 'before-restart' : null,
        endedAt: index < 3 ? 'before-restart' : null,
        error: null,
      })),
    });

    runner.onApplicationShutdown();
    runner = makeRunner();
    service = makeService();
    await runner.onApplicationBootstrap();
    const done = await settle(operationId);

    expect(done.state).toBe('done');
    expect(installDefinition.hasCredentials(operationId)).toBe(false);
    expect(vm.claims).toHaveLength(1);
    expect((done.details as unknown as InstallHostDetails).tlsCertificate).toBe(
      remote.tlsCertificate,
    );
  });

  async function prepareCreate(): Promise<{
    vmOperations: VmOperationsService;
    connectionId: string;
  }> {
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
      sslFingerprint: 'a'.repeat(64),
      tokenId: 'root@pam!devchain',
      tokenSecret: 'private-token',
    });
    process.env.HOST_IMAGE_URL = 'https://images.example/devchain-host-1.4.0.qcow2';
    process.env.HOST_IMAGE_SHA256 = 'a'.repeat(64);
    resetEnvConfig();
    const lifecycle = {
      image: (url: string, sha256: string) => ({
        url,
        sha256,
        version: '1.4.0',
        filename: 'image.qcow2',
      }),
      assertReachable: async () => undefined,
      plan: async () => ({ templateVmid: 100, vmid: 101 }),
      ensureImage: async () => 'local:import/image.qcow2',
      ensureTemplate: async () => 100,
      clone: async () => '12345678-1234-1234-1234-123456789101',
      configure: async () => undefined,
      start: async () => undefined,
      waitIp: async () => ({ address: vm.url, bootstrapUrl: vm.url }),
      readCertificate: async () => vm.certificate,
    } as unknown as ProxmoxVmLifecycleService;
    const providers = {
      checkPermissions: async () => ({ ok: true, missing: [] }),
    } as unknown as VmProvidersService;
    const claim = new ClaimOperation(
      storage,
      health,
      host,
      vault,
      generator as unknown as ProviderAuthGeneratorService,
      processExecutor,
      apiKeys,
      TIMING,
    );
    const create = new CreateVmOperation(storage, lifecycle, providers, claim, host);
    runner.onApplicationShutdown();
    runner = new RemoteOperationRunner(
      storage,
      broadcaster,
      { kind: 'attach', steps: [] } as never,
      { kind: 'detach', steps: [] } as never,
      claim,
      { kind: 'update_host', steps: [] } as never,
      create,
    );
    service = makeService();
    return {
      vmOperations: new VmOperationsService(
        storage,
        runner,
        service,
        vault,
        providers,
        {} as never,
        {} as never,
      ),
      connectionId: connection.id,
    };
  }

  it('runs the shared Docker step once after Create VM when opted in', async () => {
    const { vmOperations, connectionId } = await prepareCreate();
    const done = await settle(
      (
        await vmOperations.create(connectionId, {
          name: 'docker',
          cores: 2,
          memory: 4096,
          disk: 30,
          port: Number(new URL(vm.url).port),
          providerAuth: {},
          installDocker: true,
        })
      ).id,
    );
    expect(done.state).toBe('done');
    expect(vm.dockerRequests).toBe(1);
    expect(stepStates(done).claim_docker).toBe('done');
  });

  it('composes VM creation with the real claim steps against a delayed fake bootstrap', async () => {
    const { vmOperations, connectionId } = await prepareCreate();
    const bootstrapPort = Number(new URL(vm.url).port);
    await vm.close();
    const delayedBootstrap = new Promise<void>((resolve, reject) => {
      setTimeout(() => {
        void vm.listen({ port: bootstrapPort }).then(resolve, reject);
      }, 250);
    });
    const started = await vmOperations.create(connectionId, {
      name: 'alpha',
      cores: 2,
      memory: 4096,
      disk: 30,
      port: bootstrapPort,
      providerAuth: {},
    });
    const done = await settle(started.id);
    await delayedBootstrap;
    expect(done.state).toBe('done');
    expect(done.steps.every((step) => step.state === 'done' || step.state === 'skipped')).toBe(
      true,
    );
    expect(vm.claims).toHaveLength(1);
    expect(await storage.getRemote(started.remoteId)).toMatchObject({
      baseUrl: vm.url,
      vmIdentity: '12345678-1234-1234-1234-123456789101',
    });
  });

  it('resumes create_vm claim after handover when its first host start timed out', async () => {
    const { vmOperations, connectionId } = await prepareCreate();
    const claimRequest = jest.spyOn(host, 'claim').mockResolvedValueOnce('starting');
    const started = await vmOperations.create(connectionId, {
      name: 'alpha',
      cores: 2,
      memory: 4096,
      disk: 30,
      port: Number(new URL(vm.url).port),
      providerAuth: {},
    });
    const failed = await settle(started.id);
    expect(failed.state).toBe('failed');
    expect(failed.steps.find((step) => step.id === 'claim_claim')?.error?.code).toBe(
      'HOST_START_TIMEOUT',
    );
    vm.version = getAppVersion();
    claimRequest.mockRejectedValueOnce(
      new RemoteHostRequestError('Bootstrap exited after handover.', {
        remoteId: vm.url,
        path: '/api/host/claim',
        status: null,
        hostCode: null,
      }),
    );
    await runner.retry(started.id);
    const completed = await settle(started.id);
    expect(completed.state).toBe('done');
    expect(completed.details.claimed).toBe(true);
    expect(claimRequest).toHaveBeenCalledTimes(2);
    expect(await storage.getRemote(started.remoteId)).toMatchObject({
      vmIdentity: '12345678-1234-1234-1234-123456789101',
    });
    claimRequest.mockRestore();
  });

  it('claims the VM with the bundle, checks every login, registers the remote, and persists every step', async () => {
    const { claude, codex } = await seedLogins();
    processExecutor.enqueueResponse({
      type: 'success',
      stdout: 'user.name\nAlice Example\0user.email\nalice@example.com\0',
    });
    const runSpy = jest.spyOn(processExecutor, 'run');

    const started = await claimAt({
      claude: `reuse:${claude.id}`,
      codex: `reuse:${codex.id}`,
      copilot: 'skip',
    });
    const done = await settle(started.id);

    expect(done.state).toBe('done');
    expect(stepStates(done)).toEqual({
      preflight: 'done',
      provider_auth_resolve: 'done',
      build_bundle: 'done',
      claim: 'done',
      verify_providers: 'done',
      ssh_keys: 'skipped',
      register_remote: 'done',
      docker: 'skipped',
    });
    expect(vm.claims).toHaveLength(1);
    const sent = vm.claims[0] as {
      providerAuth: {
        env: Record<string, string>;
        files: Array<{ path: string; contentBase64: string }>;
      };
    };
    expect(vm.claims[0]).toMatchObject({
      userName: 'alice',
      homePath: '/Users/alice',
      ...(process.platform === 'win32' ? {} : { uid: process.getuid?.() }),
      version: getAppVersion(),
    });
    expect(sent.providerAuth.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_TOKEN });
    expect(sent.providerAuth.files).toEqual([
      expect.objectContaining({ path: '/Users/alice/.codex/auth.json', mode: '0600' }),
      expect.objectContaining({ path: '/Users/alice/.gitconfig', mode: '0600' }),
      expect.objectContaining({ path: '/Users/alice/.devchain/host-api-key', mode: '0600' }),
    ]);
    expect(Buffer.from(sent.providerAuth.files[0].contentBase64, 'base64').toString()).toBe(
      CODEX_FILE,
    );
    expect(Buffer.from(sent.providerAuth.files[1].contentBase64, 'base64').toString()).toBe(
      '[user]\n\tname = "Alice Example"\n\temail = "alice@example.com"\n',
    );
    expect(sent.providerAuth.files.length).toBeLessThanOrEqual(32);
    expect(
      mockClaimInfo.mock.calls.filter(([message]) => message === 'git config: sent'),
    ).toHaveLength(1);
    expect(JSON.stringify(mockClaimInfo.mock.calls)).not.toContain('Alice Example');
    expect(JSON.stringify(mockClaimInfo.mock.calls)).not.toContain('alice@example.com');
    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(runSpy).toHaveBeenCalledWith({
      argv: ['git', 'config', '--global', '--includes', '--list', '-z'],
      mode: 'pipe',
      cwd: '/',
      timeout: 5_000,
    } satisfies ProcessExecutorOptions);
    expect(vm.verifies.sort()).toEqual(['claude', 'codex']);

    // The operation never stores the bundle.
    const stored = JSON.stringify(sqlite.prepare('SELECT details FROM remote_operations').all());
    const apiKey = await apiKeys.get(done.remoteId);
    const hash = createHash('sha256').update(apiKey!).digest('hex');
    expect(Buffer.from(sent.providerAuth.files[2].contentBase64, 'base64').toString()).toBe(
      `${hash}\n`,
    );
    expect(stored).not.toContain(apiKey);
    expect(stored).not.toContain(hash);
    expect(JSON.stringify(mockClaimInfo.mock.calls)).not.toContain(apiKey);
    expect(vm.claimHeaders[0]).toBe(`Bearer ${apiKey}`);
    expect(stored).not.toContain(CLAUDE_TOKEN);
    expect(stored).not.toContain('codex-secret-refresh');
    expect(stored).not.toContain('Alice Example');
    expect(stored).not.toContain('alice@example.com');
    expect((done.details as unknown as ClaimDetails).bundleSummary).toEqual({
      envKeys: ['CLAUDE_CODE_OAUTH_TOKEN'],
      files: ['/Users/alice/.codex/auth.json'],
    });

    expect(health.getState(done.remoteId)).toMatchObject({ online: true, versionMatches: true });
    expect((await storage.getRemote(done.remoteId)).baseUrl).toBe(vm.url);
    expect((await vault.get(codex.id)).checkedOutRemoteId).toBe(done.remoteId);
  });

  it('sends no git config when the global list cannot be read', async () => {
    // The executor's default response fails; git exits non-zero with no global config.
    const started = await claimAt({});
    const done = await settle(started.id);

    expect(done.state).toBe('done');
    expect(vm.claims).toHaveLength(1);
    expect((vm.claims[0] as { providerAuth: { files: unknown[] } }).providerAuth.files).toEqual([
      expect.objectContaining({ path: '/Users/alice/.devchain/host-api-key', mode: '0600' }),
    ]);
    expect((done.details as unknown as ClaimDetails).bundleSummary).toEqual({
      envKeys: [],
      files: [],
    });
    expect(
      mockClaimInfo.mock.calls.filter(
        ([message]) => message === 'git config: not set on this PC; the VM gets none',
      ),
    ).toHaveLength(1);
  });

  it.each(['unreachable', 'already_claimed'] as const)(
    'completes a plain claim retry when the bootstrap is %s after handover',
    async (outcome) => {
      const claimRequest = jest.spyOn(host, 'claim').mockResolvedValueOnce('starting');
      const started = await claimAt({});
      const failed = await settle(started.id);
      expect(failed.state).toBe('failed');
      expect(failed.steps.find((step) => step.id === 'claim')?.error?.code).toBe(
        'HOST_START_TIMEOUT',
      );
      vm.version = getAppVersion();
      if (outcome === 'unreachable') {
        claimRequest.mockRejectedValueOnce(
          new RemoteHostRequestError('Bootstrap is gone.', {
            remoteId: vm.url,
            path: '/api/host/claim',
            status: null,
            hostCode: null,
          }),
        );
      } else {
        claimRequest.mockResolvedValueOnce('already_claimed');
      }
      await service.retry(started.id);
      const completed = await settle(started.id);
      expect(completed.state).toBe('done');
      expect(completed.details.claimed).toBe(true);
      expect(claimRequest).toHaveBeenCalledTimes(2);
      expect(claimRequest.mock.calls[0][1]).toBe(vm.certificate);
      expect(claimRequest.mock.calls[0][3]).toBe(
        await storage.readRemoteApiKey(completed.remoteId),
      );
      expect(claimRequest.mock.calls[1][3]).toBe(claimRequest.mock.calls[0][3]);
      expect(JSON.stringify(completed.details)).not.toContain(claimRequest.mock.calls[0][3]);
      claimRequest.mockRestore();
    },
  );

  it('reloads the persisted claim key after home services restart', async () => {
    const firstClaim = jest.spyOn(host, 'claim').mockResolvedValueOnce('starting');
    const started = await claimAt({});
    const failed = await settle(started.id);
    expect(failed.state).toBe('failed');
    const key = firstClaim.mock.calls[0][3];
    firstClaim.mockRestore();
    runner.onApplicationShutdown();
    apiKeys = new RemoteApiKeyService(storage);
    host = new RemoteHostClient(storage, apiKeys);
    runner = makeRunner();
    service = makeService();
    await service.retry(started.id);
    const done = await settle(started.id);
    expect(done.state).toBe('done');
    expect(vm.claimHeaders).toEqual([`Bearer ${key}`]);
    expect(await storage.readRemoteApiKey(done.remoteId)).toBe(key);
    expect(JSON.stringify(done.details)).not.toContain(key);
  });

  it('keeps waiting while the bootstrap reports an install after the claim request dropped', async () => {
    // Node's fetch drops the claim request after 300 s; the bootstrap keeps installing.
    const claimRequest = jest.spyOn(host, 'claim').mockImplementationOnce(async () => {
      vm.claiming = true;
      throw new RemoteHostRequestError('Headers timeout.', {
        remoteId: vm.url,
        path: '/api/host/claim',
        status: null,
        hostCode: null,
      });
    });
    const started = await claimAt({});
    // Longer than claimStartTimeoutMs alone would allow.
    const installed = new Promise<void>((resolve) =>
      setTimeout(() => {
        vm.claiming = false;
        vm.version = getAppVersion();
        resolve();
      }, TIMING.claimStartTimeoutMs + 500),
    );
    const [completed] = await Promise.all([settle(started.id), installed]);
    expect(completed.state).toBe('done');
    expect(completed.details.claimed).toBe(true);
    expect(claimRequest).toHaveBeenCalledTimes(1);
    claimRequest.mockRestore();
  });

  it('fails at once when the bootstrap gives up the install after the claim request dropped', async () => {
    const claimRequest = jest.spyOn(host, 'claim').mockImplementationOnce(async () => {
      vm.claiming = true;
      throw new RemoteHostRequestError('Headers timeout.', {
        remoteId: vm.url,
        path: '/api/host/claim',
        status: null,
        hostCode: null,
      });
    });
    const started = await claimAt({});
    // The bootstrap's claim fails (a CLI download error) and it returns to `unclaimed`.
    const givenUp = new Promise<void>((resolve) =>
      setTimeout(() => {
        vm.claiming = false;
        resolve();
      }, 200),
    );
    const [failed] = await Promise.all([settle(started.id), givenUp]);
    expect(failed.state).toBe('failed');
    expect(failed.steps.find((step) => step.id === 'claim')?.error?.code).toBe(
      'CLAIM_INSTALL_FAILED',
    );

    await service.retry(started.id);
    const completed = await settle(started.id);
    expect(completed.state).toBe('done');
    expect(completed.details.claimed).toBe(true);
    expect(claimRequest).toHaveBeenCalledTimes(2);
    claimRequest.mockRestore();
  });

  it('a claim retry pins the certificate approved at the start, not the row', async () => {
    const realClaim = host.claim.bind(host);
    const claimRequest = jest.spyOn(host, 'claim').mockResolvedValueOnce('starting');
    const started = await claimAt({});
    expect((await settle(started.id)).state).toBe('failed');
    // The row holds another certificate while the retried claim runs; the claim
    // must still go to the one approved at the start.
    await storage.updateRemoteTlsCertificate(started.remoteId!, otherTls.cert);
    claimRequest.mockImplementationOnce(async (...args) => {
      await storage.updateRemoteTlsCertificate(started.remoteId!, vm.certificate);
      return realClaim(...args);
    });

    await service.retry(started.id);
    const completed = await settle(started.id);
    expect(completed.state).toBe('done');
    expect(claimRequest).toHaveBeenCalledTimes(2);
    expect(claimRequest.mock.calls.map(([, certificate]) => certificate)).toEqual([
      vm.certificate,
      vm.certificate,
    ]);
    expect((completed.details as unknown as ClaimDetails).tlsCertificate).toBe(vm.certificate);
    claimRequest.mockRestore();
  });

  it('refuses a claim retry when DevChain answers with another version', async () => {
    const claimRequest = jest.spyOn(host, 'claim').mockResolvedValueOnce('starting');
    const started = await claimAt({});
    expect((await settle(started.id)).state).toBe('failed');
    vm.version = '99.0.0';
    claimRequest.mockResolvedValueOnce('already_claimed');
    await service.retry(started.id);
    const refused = await settle(started.id);
    expect(refused.state).toBe('failed');
    expect(refused.steps.find((step) => step.id === 'claim')?.error?.code).toBe(
      'VM_ALREADY_CLAIMED',
    );
    claimRequest.mockRestore();
  });

  it('a failing Codex check fails only that step, and a retry prepares only Codex again', async () => {
    const { claude } = await seedLogins();
    vm.verifyAnswers.codex = {
      ok: false,
      summary: 'Not logged in',
      hint: 'Codex is not logged in.',
    };

    const started = await claimAt({ claude: `reuse:${claude.id}`, codex: 'generate' });
    const failed = await settle(started.id);

    expect(failed.state).toBe('failed');
    expect(stepStates(failed)).toMatchObject({
      claim: 'done',
      verify_providers: 'failed',
      register_remote: 'pending',
    });
    const step = failed.steps.find((s) => s.id === 'verify_providers')!;
    expect(step.error).toMatchObject({ code: 'PROVIDER_AUTH_VERIFY_FAILED' });
    expect(step.error!.message).toContain('codex: Codex is not logged in.');
    expect(step.error!.message).toContain('Re-authenticate');
    expect((failed.details as unknown as ClaimDetails).reauth).toEqual(['codex']);
    const firstEntry = (failed.details as unknown as ClaimDetails).providerAuth.codex.entryIds![0];

    delete vm.verifyAnswers.codex;
    vm.verifies = [];
    await runner.retry(started.id);
    const done = await settle(started.id);

    expect(done.state).toBe('done');
    expect(generator.started).toEqual(['codex', 'codex']);
    expect(vm.claims).toHaveLength(1);
    expect(vm.applied).toHaveLength(1);
    const applied = vm.applied[0] as {
      env: Record<string, string>;
      files: Array<{ path: string }>;
    };
    expect(applied.env).toEqual({});
    expect(applied.files.map((file) => file.path)).toEqual(['/Users/alice/.codex/auth.json']);
    expect(vm.verifies).toEqual(['codex']);
    // One git read serves the whole claim now: the single `--list -z` listing.
    expect(processExecutor.calls).toHaveLength(1);
    const codex = (done.details as unknown as ClaimDetails).providerAuth.codex;
    expect(codex.entryIds).toHaveLength(1);
    expect(codex.entryIds![0]).not.toBe(firstEntry);
    expect((await vault.get(firstEntry)).checkedOutRemoteId).toBeNull();
    expect((await vault.get(codex.entryIds![0])).checkedOutRemoteId).toBe(done.remoteId);
  });

  it('stops at provider_auth_resolve when a family is checked out by another remote, naming it', async () => {
    const { codex } = await seedLogins();
    const other = await storage.createRemote({
      name: 'vm-other',
      baseUrl: 'https://10.9.9.9:3000',
      kind: 'address',
    });
    await vault.checkout(codex.id, other.id);

    const failed = await settle((await claimAt({ codex: `reuse:${codex.id}` })).id);

    const step = failed.steps.find((s) => s.id === 'provider_auth_resolve')!;
    expect(step.state).toBe('failed');
    expect(step.error).toMatchObject({ code: 'PROVIDER_AUTH_ALREADY_CHECKED_OUT' });
    expect(step.error!.message).toContain('in use by remote "vm-other"');
    expect(vm.claims).toHaveLength(0);
    expect((await vault.get(codex.id)).checkedOutRemoteId).toBe(other.id);
  });

  it('refuses a VM that is already claimed or runs an unsupported image', async () => {
    vm.imageVersion = '0.0.9';
    const old = await settle((await claimAt({})).id);
    expect(old.steps[0].error).toMatchObject({ code: 'HOST_IMAGE_UNSUPPORTED' });
    await runner.cancel(old.id);

    vm.version = '9.9.9';
    const claimed = await settle((await claimAt({})).id);
    expect(claimed.steps[0].error).toMatchObject({ code: 'VM_NOT_UNCLAIMED' });
  });

  it('a cancel before the claim releases what the claim checked out', async () => {
    const { codex } = await seedLogins();
    generator.hold = true;
    const started = await claimAt({ codex: `reuse:${codex.id}`, agy: 'generate' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await vault.get(codex.id)).checkedOutRemoteId).not.toBeNull();

    // The resolve step waits on the agy login; the cancel ends that login.
    const cancelled = await runner.cancel(started.id);

    expect(cancelled.state).toBe('cancelled');
    expect(cancelled.steps.find((step) => step.id === 'provider_auth_resolve')?.state).toBe(
      'failed',
    );
    expect((await vault.get(codex.id)).checkedOutRemoteId).toBeNull();
    expect(vm.claims).toHaveLength(0);
  });

  it('resumes a claim after a home restart mid-claim', async () => {
    const { codex } = await seedLogins();
    let release!: () => void;
    vm.claimGate = new Promise((resolve) => (release = resolve));
    const started = await claimAt({ codex: `reuse:${codex.id}` });
    for (let i = 0; i < 100 && vm.claims.length === 0; i++)
      await new Promise((r) => setTimeout(r, 20));
    expect(vm.claims).toHaveLength(1);

    // Home stops while the claim request is open; the VM finishes it anyway.
    runner.onApplicationShutdown();
    release();
    await runner.whenIdle(started.id);
    expect((await storage.getRemoteOperation(started.id)).state).toBe('running');

    runner = makeRunner();
    await runner.onApplicationBootstrap();
    const done = await settle(started.id);

    expect(done.state).toBe('done');
    // The resumed step met an already claimed VM running this claim's version.
    expect(vm.claims).toHaveLength(1);
    expect(health.getState(done.remoteId).versionMatches).toBe(true);
  });

  it('a retry can replace the choice of a provider whose check failed, and only that one', async () => {
    const { claude, codex } = await seedLogins();
    vm.verifyAnswers.codex = { ok: false, summary: 'no', hint: 'Codex is not logged in.' };
    const started = await claimAt({ claude: `reuse:${claude.id}`, codex: `reuse:${codex.id}` });
    await settle(started.id);

    await expect(service.retry(started.id, { claude: 'generate' })).rejects.toMatchObject({
      details: { reason: 'retry_choices_not_applicable' },
    });

    delete vm.verifyAnswers.codex;
    await service.retry(started.id, { codex: 'generate' });
    const done = await settle(started.id);

    expect(done.state).toBe('done');
    expect(generator.started).toEqual(['codex']);
    expect((await vault.get(codex.id)).checkedOutRemoteId).toBeNull();
    const state = (done.details as unknown as ClaimDetails).providerAuth.codex;
    expect(state.choice).toBe('generate');
    expect((await vault.get(state.entryIds![0])).checkedOutRemoteId).toBe(done.remoteId);
  });

  it('refuses invalid choices before creating anything', async () => {
    const { claude } = await seedLogins();
    await expect(claimAt({ claude: 'generate' })).rejects.toMatchObject({
      details: { reason: 'provider_auth_paste_only' },
    });
    await expect(claimAt({ codex: `reuse:${claude.id}` })).rejects.toMatchObject({
      details: { reason: 'provider_auth_provider_mismatch' },
    });
    await expect(claimAt({ gemini: 'skip' })).rejects.toMatchObject({
      details: { reason: 'provider_not_supported' },
    });
    expect((await storage.listRemotes()).items).toEqual([]);

    const remote = await storage.createRemote({
      name: 'vm-port',
      baseUrl: 'https://127.0.0.1:4000',
      kind: 'address',
    });
    await expect(
      service.claim({ remoteId: remote.id, port: 3000, providerAuth: {} }),
    ).rejects.toMatchObject({ details: { reason: 'claim_port_mismatch' } });
  });

  it('claims with Docker opt-in through the real client without adding it to the bootstrap body', async () => {
    const done = await settle(
      (
        await service.claim({
          baseUrl: vm.url,
          certificateFingerprint: certificateFingerprint(vm.certificate),
          port: Number(new URL(vm.url).port),
          providerAuth: {},
          installDocker: true,
        })
      ).id,
    );
    expect(done.state).toBe('done');
    expect(stepStates(done).docker).toBe('done');
    expect(vm.dockerRequests).toBe(1);
    expect(vm.claims[0]).not.toHaveProperty('installDocker');
  });

  describe('update_host', () => {
    async function claimedRemote(version: string) {
      vm.version = version;
      const remote = await storage.createRemote({
        name: 'vm-1',
        baseUrl: vm.url,
        kind: 'address',
        tlsCertificate: vm.certificate,
      });
      bindings = [
        { projectId: 'p-1', remoteId: remote.id, state: 'remote' },
        { projectId: 'p-2', remoteId: remote.id, state: 'remote' },
        { projectId: 'p-3', remoteId: 'another-remote', state: 'remote' },
      ];
      return remote;
    }

    it('freezes and thaws every bound project and ends with versionMatches in the remote list', async () => {
      const remote = await claimedRemote('0.0.1');

      const done = await settle((await service.updateHost(remote.id)).id);

      expect(done.state).toBe('done');
      expect(stepStates(done)).toEqual({
        preflight: 'done',
        freeze_projects: 'done',
        update: 'done',
        wait_healthy: 'done',
        thaw_projects: 'done',
      });
      expect(vm.freezeLog).toEqual(['freeze:p-1', 'freeze:p-2', 'thaw:p-1', 'thaw:p-2']);
      expect(vm.frozen.size).toBe(0);
      expect(vm.version).toBe(getAppVersion());
      expect(health.getState(remote.id)).toMatchObject({ online: true, versionMatches: true });
    });

    it.each([getAppVersion(), '0.0.1'])(
      'installs Docker at version %s and keeps step ordering on resume',
      async (version) => {
        const remote = await claimedRemote(version);
        const started = await service.updateHost(remote.id, true);
        const done = await settle(started.id);
        expect(done.state).toBe('done');
        expect(vm.dockerRequests).toBe(1);
        expect(vm.docker).toMatchObject({ installed: true, userInGroup: true });
        expect(done.details.installDocker).toBe(true);
        expect(done.steps.map((step) => step.id)).toEqual(
          version === getAppVersion()
            ? ['preflight', 'freeze_projects', 'docker', 'thaw_projects']
            : ['preflight', 'freeze_projects', 'update', 'wait_healthy', 'docker', 'thaw_projects'],
        );
      },
    );

    it('accepts existing usable Docker without an install when enabling the saved option', async () => {
      const remote = await claimedRemote(getAppVersion());
      vm.docker = {
        installed: true,
        engineVersion: '29',
        composeVersion: '2',
        userInGroup: true,
        dataRootFreeBytes: 1000,
      };
      const done = await settle((await service.updateHost(remote.id, true)).id);
      expect(done.state).toBe('done');
      expect(vm.dockerRequests).toBe(0);
      const unchanged = await settle((await service.updateHost(remote.id, true)).id);
      expect(unchanged.steps[0].error?.code).toBe('REMOTE_VERSION_CURRENT');
    });

    it('refuses a host already on this version', async () => {
      const remote = await claimedRemote(getAppVersion());
      const failed = await settle((await service.updateHost(remote.id)).id);
      expect(failed.steps[0].error).toMatchObject({ code: 'REMOTE_VERSION_CURRENT' });
    });

    it('resumes after a home restart during the wait', async () => {
      const remote = await claimedRemote('0.0.1');
      const started = await service.updateHost(remote.id);
      for (let i = 0; i < 100 && !vm.update; i++) await new Promise((r) => setTimeout(r, 10));
      runner.onApplicationShutdown();
      await runner.whenIdle(started.id);

      runner = makeRunner();
      await runner.onApplicationBootstrap();
      const done = await settle(started.id);

      expect(done.state).toBe('done');
      expect(vm.frozen.size).toBe(0);
      expect(health.getState(remote.id).versionMatches).toBe(true);
    });

    it('allows one claim or update per remote at a time', async () => {
      const remote = await claimedRemote('0.0.1');
      vm.update = null;
      await service.updateHost(remote.id);
      await expect(service.updateHost(remote.id)).rejects.toMatchObject({
        statusCode: 409,
        details: { code: 'REMOTE_OPERATION_IN_PROGRESS' },
      });
    });
  });
});
