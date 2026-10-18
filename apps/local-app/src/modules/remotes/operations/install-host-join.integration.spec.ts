import { Test } from '@nestjs/testing';
import { fixtureTls } from '../../../common/test/tls-fixture';
import { STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import type {
  CreateRemoteOperation,
  RemoteOperation,
  UpdateRemoteOperation,
} from '../../storage/models/domain.models';
import { ProcessExecutor } from '../../terminal/services/process-executor/process-executor.port';
import { ProviderAuthVaultService } from '../../provider-auth/provider-auth-vault.service';
import { ProviderAuthGeneratorService } from '../../provider-auth/provider-auth-generator.service';
import { RemoteApiKeyService } from '../auth/remote-api-key.service';
import { REMOTE_HEALTH_PORT } from '../ports/remote-health.port';
import { HostInstallService } from '../host-install/host-install.service';
import { SshRunner, type SshCommandResult, type SshSession } from '../host-install/ssh-runner';
import { ClaimOperation } from './claim.operation';
import {
  InstallHostOperation,
  INSTALL_HOST_TIMING,
  installJobPaths,
} from './install-host.operation';
import { RemoteHostClient, type HostClaimRequest } from './remote-host.client';
import { RemoteOperationRunner } from './remote-operation.runner';
import { RemoteOperationStepRefusedError } from './remote-operation.errors';
import {
  DEFAULT_REMOTE_OPERATION_TIMING,
  REMOTE_OPERATION_TIMING,
} from './remote-operation.timing';

jest.mock('node:os', () => ({
  ...jest.requireActual('node:os'),
  homedir: () => '/home/bob',
  userInfo: () => ({ username: 'bob' }),
}));

// Composing the real runner/install/claim providers catches port and nonce loss
// across persisted steps; the SSH/HTTP/OS boundaries remain fake.
describe('SSH join operation', () => {
  let row: RemoteOperation;
  let baseUrl: string;
  let runner: RemoteOperationRunner;
  let install: InstallHostOperation;
  let claim: ClaimOperation;
  let commands: string[];
  let uploads: Map<string, string>;
  let reservations: Map<
    string,
    {
      userName: string;
      homePath: string;
      requestId: string;
      port: number;
      nonce: string;
      expiresAt: string;
    }
  >;
  let started: boolean;
  let down: boolean;
  let holdBootstrap: boolean;
  let bootstrapSeen: () => void;
  let seen: Promise<void>;
  let cancelled: boolean;
  let requests: HostClaimRequest[];
  let broadcasts: string[];
  let claimFails: boolean;
  let checkError: { code: string; message: string } | null;
  let jobs: Set<string>;
  let ownClaim: Record<string, unknown> | null;

  const result = (stdout = '', code = 0, stderr = ''): SshCommandResult => ({
    stdout,
    code,
    stderr,
  });

  beforeEach(async () => {
    baseUrl = 'https://vm:3000';
    commands = [];
    uploads = new Map();
    reservations = new Map();
    requests = [];
    broadcasts = [];
    started = down = holdBootstrap = cancelled = claimFails = false;
    checkError = null;
    jobs = new Set();
    ownClaim = null;
    seen = new Promise((resolve) => {
      bootstrapSeen = resolve;
    });
    const session: SshSession = {
      fingerprint: 'SHA256:vm',
      uploadTemp: async (text) => {
        const file = `/tmp/devchain-host-install.${uploads.size + 1}`;
        uploads.set(file, text);
        return file;
      },
      exec: async (command) => {
        commands.push(command);
        if (command.includes('__DEVCHAIN_HOST_STATE__'))
          return result('__DEVCHAIN_HOST_STATE__claimed');
        if (command.includes(' --check'))
          return checkError
            ? result('', 1, JSON.stringify(checkError))
            : result('WARNING: available memory is low\n');
        if (command.includes('getent passwd')) return result('', 2);
        if (command.includes('cat ') && command.includes('/instances/bob/claim.json'))
          return result(ownClaim ? JSON.stringify(ownClaim) : '');
        if (command.includes('systemctl start') && command.includes('devchain-user-bob')) {
          started = true;
          down = false;
          return result();
        }
        if (command.includes('tls/cert.pem')) return result(fixtureTls.cert);
        if (command.includes('printf finished'))
          return result(
            jobs.has(command.match(/devchain-host-install-[A-Za-z0-9_-]+/)?.[0] ?? '')
              ? 'finished'
              : 'absent',
          );
        if (command.includes('systemd-run')) {
          jobs.add(command.match(/devchain-host-install-[A-Za-z0-9_-]+/)![0]);
          return result();
        }
        if (command.includes('__DEVCHAIN_EXIT__'))
          return result('helper installed\n__DEVCHAIN_EXIT__0');
        if (command.includes('--reserve-join')) {
          const input = uploads.get(command.match(/\/tmp\/devchain-host-install\.\d+/)![0])!;
          const request = JSON.parse(input) as {
            userName: string;
            homePath: string;
            requestId: string;
          };
          let reservation = reservations.get(request.requestId);
          if (!reservation) {
            reservation = {
              ...request,
              port: 3060 + reservations.size,
              nonce: (reservations.size ? 'b' : 'a').repeat(64),
              expiresAt: '2099-01-01T00:00:00.000Z',
            };
            reservations.set(request.requestId, reservation);
          }
          down = false;
          return result(JSON.stringify(reservation));
        }
        if (command.includes('--cancel-join')) {
          reservations.clear();
          cancelled = true;
          return result('{"cancelled":true}');
        }
        return result();
      },
    };
    const storage = {
      createRemoteOperation: async (data: CreateRemoteOperation) => {
        row = {
          ...data,
          id: data.id ?? 'join-bob',
          state: 'running',
          createdAt: 'now',
          updatedAt: 'now',
        };
        return structuredClone(row);
      },
      getRemoteOperation: async () => structuredClone(row),
      listRemoteOperations: async () => (row.state === 'running' ? [structuredClone(row)] : []),
      updateRemoteOperation: async (_id: string, data: UpdateRemoteOperation) => {
        row = { ...row, ...data };
        return structuredClone(row);
      },
      getRemote: async () => ({
        id: 'remote',
        name: 'VM (bob)',
        kind: 'address',
        baseUrl,
        tlsCertificate: fixtureTls.cert,
      }),
      updateRemoteBaseUrl: async (_id: string, value: string) => {
        baseUrl = value;
      },
      updateRemoteTlsCertificate: jest.fn(async () => undefined),
    };
    const host = {
      certificateOf: async () => fixtureTls.cert,
      runtimeAt: async () => {
        bootstrapSeen();
        return holdBootstrap || down
          ? null
          : started
            ? { state: 'claimed', version: '1.0.0' }
            : { state: 'unclaimed', imageVersion: '1.4.0' };
      },
      claim: async (_url: string, _certificate: string, body: HostClaimRequest) => {
        requests.push(body);
        if (claimFails) {
          claimFails = false;
          down = true;
          throw new RemoteOperationStepRefusedError(
            'HOST_START_TIMEOUT',
            'The join listener stopped.',
          );
        }
        started = true;
        return 'claimed';
      },
      applyProviderAuth: jest.fn(async () => undefined),
    };
    const module = await Test.createTestingModule({
      providers: [
        InstallHostOperation,
        ClaimOperation,
        { provide: STORAGE_SERVICE, useValue: storage },
        {
          provide: SshRunner,
          useValue: {
            connect: async () => 'SHA256:vm',
            withSession: async (
              _options: unknown,
              use: (session: SshSession) => Promise<unknown>,
            ) => use(session),
          },
        },
        {
          provide: HostInstallService,
          useValue: {
            render: jest.fn(() => {
              throw new Error('A claimed VM must not run machine preparation.');
            }),
            renderJoin: async ({ checkOnly }: { checkOnly: boolean }) =>
              checkOnly ? 'join check' : 'join helper install',
          },
        },
        { provide: RemoteHostClient, useValue: host },
        {
          provide: REMOTE_HEALTH_PORT,
          useValue: { refresh: async () => ({ online: true, versionMatches: true }) },
        },
        {
          provide: ProviderAuthVaultService,
          useValue: { buildClaimBundle: async () => ({ env: {}, files: [] }) },
        },
        { provide: ProviderAuthGeneratorService, useValue: {} },
        {
          provide: ProcessExecutor,
          useValue: { run: async () => ({ success: true, stdout: '', stderr: '' }) },
        },
        { provide: RemoteApiKeyService, useValue: { getOrCreate: async () => 'api-key' } },
        {
          provide: INSTALL_HOST_TIMING,
          useValue: { installTimeoutMs: 50, bootstrapTimeoutMs: 30_000, pollIntervalMs: 1 },
        },
        {
          provide: REMOTE_OPERATION_TIMING,
          useValue: {
            ...DEFAULT_REMOTE_OPERATION_TIMING,
            claimInstallTimeoutMs: 50,
            claimStartTimeoutMs: 50,
            pollIntervalMs: 1,
          },
        },
      ],
    }).compile();
    install = module.get(InstallHostOperation);
    claim = module.get(ClaimOperation);
    runner = new RemoteOperationRunner(
      storage as never,
      {
        broadcastEvent: (_topic: string, _event: string, value: unknown) =>
          broadcasts.push(JSON.stringify(value)),
      } as never,
      { kind: 'attach' } as never,
      { kind: 'detach' } as never,
      claim,
      { kind: 'update_host' } as never,
      undefined,
      undefined,
      undefined,
      install,
    );
    install.seedCredentials('join-bob', {
      user: 'admin',
      password: 'ssh-password',
      sudoPassword: 'sudo-password',
    });
  });

  afterEach(() => runner.onApplicationShutdown());

  async function start(): Promise<void> {
    await runner.start({
      id: 'join-bob',
      kind: 'install_host',
      remoteId: 'remote',
      projectId: null,
      details: {
        address: 'vm',
        sshUser: 'admin',
        sshAuthKind: 'password',
        minDiskGib: 8,
        userName: 'bob',
        homePath: '/home/bob',
        version: '1.0.0',
        port: 3000,
        bootstrapUrl: 'https://vm:3000',
        providerAuth: {},
      },
    });
  }

  it('routes a claimed VM to join and claims with the reserved port and nonce, persisting only safe details', async () => {
    await start();
    await runner.whenIdle('join-bob');
    expect(row.state).toBe('done');
    expect(row.details.mode).toBe('join');
    expect(row.details.port).toBe(3060);
    expect(baseUrl).toBe('https://vm:3060');
    expect(requests[0]).toMatchObject({ userName: 'bob', port: 3060, nonce: 'a'.repeat(64) });
    expect(row.details.checkWarnings).toEqual(['available memory is low']);
    expect(JSON.stringify(row)).not.toContain('a'.repeat(64));
    expect(broadcasts.join('\n')).not.toContain('a'.repeat(64));
    expect([...uploads.values()].join('\n')).not.toContain('a'.repeat(64));
    expect(JSON.stringify(row)).not.toMatch(/ssh-password|sudo-password/);
    expect(claim.hasJoinNonce('join-bob')).toBe(false);
  });

  it('returns to the SSH join step when P is down and the instance claim is absent, resuming the same request', async () => {
    claimFails = true;
    await start();
    await runner.whenIdle('join-bob');
    expect(row.state).toBe('failed');
    expect(await install.retryFrom(row)).toBe('install');
    await runner.retry('join-bob');
    await runner.whenIdle('join-bob');
    expect(row.state).toBe('done');
    expect(commands.filter((command) => command.includes('--reserve-join'))).toHaveLength(2);
    expect(requests.map((request) => request.port)).toEqual([3060, 3060]);
    expect(requests.map((request) => request.nonce)).toEqual(['a'.repeat(64), 'a'.repeat(64)]);
  });

  it('cancels before the claim through the own helper and drops the credentials and nonce', async () => {
    holdBootstrap = true;
    await start();
    await seen;
    const value = await runner.cancel('join-bob');
    expect(value.state).toBe('cancelled');
    expect(cancelled).toBe(true);
    expect(reservations.size).toBe(0);
    expect(commands.find((command) => command.includes('--cancel-join'))).toContain(
      '/opt/devchain-host/instances/bob/helper/bin/devchain-bootstrap',
    );
    expect(install.hasCredentials('join-bob')).toBe(false);
    expect(claim.hasJoinNonce('join-bob')).toBe(false);
    expect(requests).toHaveLength(0);
  });

  it('recovers an accepted claim through its own record and service without reserving again', async () => {
    claimFails = true;
    await start();
    await runner.whenIdle('join-bob');
    ownClaim = { userName: 'bob', homePath: '/home/bob', port: 3060, version: '1.0.0' };
    await runner.retry('join-bob');
    await runner.whenIdle('join-bob');
    expect(row.state).toBe('done');
    expect(row.details.claimed).toBe(true);
    expect(baseUrl).toBe('https://vm:3060');
    expect(requests).toHaveLength(1);
    expect(commands.filter((command) => command.includes('--reserve-join'))).toHaveLength(1);
    expect(commands.find((command) => command.includes('systemctl start'))).toContain(
      'devchain-user-bob.service',
    );
  });

  it('requests SSH credentials after a home restart and reacquires the same reservation', async () => {
    claimFails = true;
    await start();
    await runner.whenIdle('join-bob');
    install.forget('join-bob');
    row.state = 'running';
    await runner.onApplicationBootstrap();
    await runner.whenIdle('join-bob');
    expect(row.steps.find((step) => step.id === 'install')?.error?.code).toBe(
      'SSH_CREDENTIALS_REQUIRED',
    );
    install.seedCredentials('join-bob', { user: 'admin', password: 'ssh-password' });
    await runner.retry('join-bob');
    await runner.whenIdle('join-bob');
    expect(row.state).toBe('done');
    expect(requests.map((request) => request.port)).toEqual([3060, 3060]);
    expect(requests.map((request) => request.nonce)).toEqual(['a'.repeat(64), 'a'.repeat(64)]);
  });

  it('preserves the precise VM refusal and never runs claim steps after a failed join check', async () => {
    checkError = { code: 'HOST_JOIN_FENCED', message: 'This VM is being destroyed.' };
    await start();
    await runner.whenIdle('join-bob');
    expect(row.state).toBe('failed');
    expect(row.steps.find((step) => step.id === 'check')?.error).toEqual(checkError);
    expect(requests).toHaveLength(0);
    expect(reservations.size).toBe(0);
  });

  it('uses independent unit/log/exit names and ports for two home users joining concurrently', async () => {
    const values = ['bob', 'carol'].map((userName) => ({
      id: `join-${userName}`,
      kind: 'install_host' as const,
      remoteId: userName,
      projectId: null,
      state: 'running' as const,
      steps: [],
      createdAt: 'now',
      updatedAt: 'now',
      details: {
        address: 'vm',
        sshUser: 'admin',
        sshAuthKind: 'password',
        minDiskGib: 8,
        userName,
        homePath: `/home/${userName}`,
        version: '1.0.0',
        port: 3000,
        bootstrapUrl: 'https://vm:3000',
        providerAuth: {},
      },
    }));
    await Promise.all(
      values.map(async (operation) => {
        install.seedCredentials(operation.id, { user: 'admin', password: 'ssh-password' });
        const run = { operation, details: operation.details, progress: async () => {} };
        for (const id of ['ssh_connect', 'check', 'install'])
          await install.steps.find((step) => step.id === id)!.run(run);
      }),
    );
    expect(values.map((operation) => operation.details.port).sort()).toEqual([3060, 3061]);
    const first = installJobPaths('join-bob');
    const second = installJobPaths('join-carol');
    expect(first.unit).not.toBe(second.unit);
    expect(first.log).not.toBe(second.log);
    expect(first.exit).not.toBe(second.exit);
    for (const file of [first.log, first.exit, second.log, second.exit])
      expect(commands.join('\n')).toContain(file);
    expect(commands.filter((command) => command.includes('systemd-run'))).toEqual(
      expect.arrayContaining([
        expect.stringContaining(first.unit),
        expect.stringContaining(second.unit),
      ]),
    );
  });
});
