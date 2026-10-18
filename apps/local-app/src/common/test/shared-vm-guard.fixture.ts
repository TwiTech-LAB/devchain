import fs from 'node:fs';
import { join, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ProjectReplicaV1 } from '@devchain/shared';
import { startTwoInstances, type TwoInstances } from './two-instance.fixture';
import { resetEnvConfig } from '../config/env.config';
import { VM_DESTROY_FENCE_PATH } from '../config/vm-destroy-fence';
import { HostHelperService } from '../../modules/remotes/host/host-helper.service';
import { VmProvidersService } from '../../modules/vm-providers/vm-providers.service';
import { ProviderAuthWritebackService } from '../../modules/provider-auth/provider-auth-writeback.service';
import { RemoteOperationRunner } from '../../modules/remotes/operations/remote-operation.runner';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { HostSharedVmStore } from '../../modules/remotes/host/host-shared-vm.store';
import { RemoteHealthService } from '../../modules/remotes/services/remote-health.service';

const KEY = `dck_${'s'.repeat(43)}`;

interface ImportResult {
  committed: boolean;
  code?: string;
  message?: string;
}

/** Four real app/storage graphs: two homes and two VM instances. The shared key
 * keeps authentication out of this ordering fixture (separate tests own keys).
 * Only Proxmox, the privileged fence filesystem and normal OS boundaries differ. */
export class SharedVmGuardFixture {
  alice!: TwoInstances;
  bob!: TwoInstances;
  aliceRemoteId!: string;
  bobRemoteId!: string;
  fenceFile!: string;
  onPull?: () => Promise<void>;
  onFence?: () => Promise<void>;
  readonly deletions: string[] = [];
  readonly countStatuses: number[] = [];
  readonly importPhases: Array<{ phase: string; elapsedMs: number }> = [];
  countDb!: Database.Database;
  private readonly workers: Worker[] = [];
  private activeGate?: Int32Array;

  async start(): Promise<void> {
    const options = {
      claimedHost: { key: KEY },
      healthIntervalMs: 600_000,
      syncIntervalMs: 600_000,
    };
    this.alice = await startTwoInstances(options);
    this.bob = await startTwoInstances({
      ...options,
      configureModule: (builder, instance, dataDir) => {
        if (instance !== 'host') return builder;
        // A dedicated real connection lets the busy-bound test constrain only the
        // producer, while unrelated app background writes keep their normal bound.
        this.countDb = new Database(join(dataDir, 'devchain.db'));
        return builder
          .overrideProvider(HostSharedVmStore)
          .useValue(new HostSharedVmStore(drizzle(this.countDb)));
      },
    });
    // Both pairs share env, as documented by the base fixture. Only the owner
    // serves roster/Notify here; count/inbox use each VM instance's own SQLite.
    const root = join(this.alice.rootDir, 'claim-etc');
    const claimHome = join(this.alice.rootDir, 'claim-home');
    const claim = (userName: string, port: number) => ({
      userName,
      port,
      version: '0.25.0',
      homePath: claimHome,
    });
    fs.writeFileSync(
      join(root, 'claim.json'),
      JSON.stringify(claim('alice', Number(new URL(this.alice.host.url).port))),
    );
    fs.mkdirSync(join(root, 'instances', 'bob'), { recursive: true });
    fs.writeFileSync(
      join(root, 'instances', 'bob', 'claim.json'),
      JSON.stringify(claim('bob', Number(new URL(this.bob.host.url).port))),
    );
    process.env.DEVCHAIN_HOST_ETC_DIR = root;
    resetEnvConfig();
    for (const pair of [this.alice, this.bob]) pair.hostApiKey!.setSeenPeerAddress('127.0.0.1');
    this.fenceFile = join(root, 'fence.json');
    const read = fs.readFileSync;
    jest
      .spyOn(fs, 'readFileSync')
      .mockImplementation(((file: fs.PathOrFileDescriptor, ...args: unknown[]) =>
        Reflect.apply(read, fs, [
          file === VM_DESTROY_FENCE_PATH ? this.fenceFile : file,
          ...args,
        ])) as typeof fs.readFileSync);
    jest
      .spyOn(this.alice.host.app.get(HostHelperService), 'destroyFence')
      .mockImplementation(async (mode, operationId) => {
        if (mode === 'clear') {
          fs.rmSync(this.fenceFile, { force: true });
          return { fence: null };
        }
        const fence = {
          ownerUser: 'alice',
          operationId,
          expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
        };
        fs.writeFileSync(this.fenceFile, JSON.stringify(fence));
        await this.onFence?.();
        return { fence };
      });
    this.bob.host.app
      .getHttpServer()
      .prependListener('request', (request: IncomingMessage, response: ServerResponse) => {
        if (request.url === '/api/host/shared-vm/connected-count')
          response.once('finish', () => this.countStatuses.push(response.statusCode));
      });
    const releaseWriter = () => {
      if (!this.activeGate || Atomics.load(this.activeGate, 0) !== 0) return;
      if (!fs.existsSync(this.fenceFile))
        throw new Error('The roster reached an admitted import before the owner fence');
      Atomics.store(this.activeGate, 0, 1);
      Atomics.notify(this.activeGate, 0);
    };
    const exec = this.countDb.exec;
    jest.spyOn(this.countDb, 'exec').mockImplementation((sql) => {
      if (sql === 'BEGIN IMMEDIATE') releaseWriter();
      return Reflect.apply(exec, this.countDb, [sql]);
    });
    const prepare = this.countDb.prepare;
    jest.spyOn(this.countDb, 'prepare').mockImplementation(((sql: string) => {
      const statement = Reflect.apply(prepare, this.countDb, [sql]);
      if (sql === 'SELECT id FROM projects WHERE is_template = 0') {
        const all = statement.all;
        statement.all = (...args: unknown[]) => {
          const rows = Reflect.apply(all, statement, args);
          // A plain SELECT releases after capturing its WAL snapshot. The
          // immediate-lock path releases before acquiring the write lock.
          releaseWriter();
          return rows;
        };
      }
      return statement;
    }) as Database.Database['prepare']);
    this.aliceRemoteId = (await this.alice.registerRemote('owner VM')).id;
    this.bobRemoteId = (await this.bob.registerRemote('bob instance')).id;
    const connection = await this.alice.home.storage.createVmProviderConnection({
      kind: 'proxmox',
      name: 'fixture',
      apiUrl: 'https://pve.invalid',
      node: 'node',
      pool: 'devchain',
      storage: 'local',
      imageStorage: 'local',
      bridge: 'vmbr0',
      vmidMin: 100,
      vmidMax: 200,
      namePrefix: 'dc-',
      tag: 'devchain',
      sslFingerprint: 'a'.repeat(64),
      tokenId: 'fixture!token',
      tokenSecret: 'fixture-token',
    });
    this.alice.home.sqlite
      .prepare(
        "UPDATE remotes SET kind='proxmox',vm_provider_connection_id=?,vm_identity=?,vm_spec_json=? WHERE id=?",
      )
      .run(
        connection.id,
        '12345678-1234-1234-1234-123456789abc',
        JSON.stringify({ cores: 2, memory: 4096, disk: 16 }),
        this.aliceRemoteId,
      );
    for (const [pair, remoteId, user] of [
      [this.alice, this.aliceRemoteId, 'alice'],
      [this.bob, this.bobRemoteId, 'bob'],
    ] as const) {
      const identity = await pair.home.storage.createRemoteOperation({
        kind: 'claim',
        remoteId,
        projectId: null,
        details: { userName: user },
        steps: [],
      });
      // Drain registration-triggered polls before arming the import race. The
      // long timer interval keeps only the explicit final roster in that window.
      await this.alice.home.app.get(RemoteHealthService).refresh(this.aliceRemoteId);
      await this.bob.home.app.get(RemoteHealthService).refresh(this.bobRemoteId);
      await pair.home.storage.updateRemoteOperation(identity.id, { state: 'done' });
    }
    jest.spyOn(this.alice.home.app.get(VmProvidersService), 'forConnection').mockResolvedValue({
      getOwnedVm: async () => ({ name: 'dc-owner' }),
      assertOwnedVmIdentity: async () => 101,
      confirmsVmIdle: async () => true,
      destroyVm: async (identity: string) => {
        this.deletions.push(identity);
        throw new Error('Fixture Proxmox declined deletion');
      },
    } as never);
    jest
      .spyOn(this.alice.home.app.get(ProviderAuthWritebackService), 'pullFamiliesNow')
      .mockImplementation(async () => {
        await this.onPull?.();
        return { pulled: true, families: [] };
      });
  }

  async importOnBob(
    replica: ProjectReplicaV1,
    pause = false,
    commitDelayMs = 0,
  ): Promise<{ admitted: Promise<void>; done: Promise<ImportResult> }> {
    const gate = new Int32Array(new SharedArrayBuffer(8));
    const startedAt = Date.now();
    let admit!: () => void;
    const admitted = new Promise<void>((resolve) => {
      admit = resolve;
    });
    const worker = new Worker(join(__dirname, 'shared-vm-import.worker.cjs'), {
      workerData: {
        appRoot: resolve(__dirname, '../../..'),
        database: join(this.bob.host.dataDir, 'devchain.db'),
        fenceFile: this.fenceFile,
        replica,
        pause,
        gate: gate.buffer,
        commitDelayMs,
      },
    });
    this.workers.push(worker);
    const done = new Promise<ImportResult>((resolve, reject) => {
      worker.on('message', (message: ImportResult & { phase: string }) => {
        this.importPhases.push({ phase: message.phase, elapsedMs: Date.now() - startedAt });
        if (message.phase === 'admitted') {
          this.activeGate = gate;
          admit();
        }
        if (message.phase === 'done') {
          admit();
          resolve(message);
        }
      });
      worker.on('error', (error) => {
        admit();
        reject(error);
      });
    });
    return { admitted, done };
  }

  async settle(id: string): Promise<void> {
    await this.alice.home.app.get(RemoteOperationRunner).whenIdle(id);
  }

  async close(): Promise<void> {
    for (const worker of this.workers) await worker.terminate();
    jest.restoreAllMocks();
    await this.bob?.host.close();
    this.countDb?.close();
    await this.bob?.close();
    await this.alice?.close();
  }
}
