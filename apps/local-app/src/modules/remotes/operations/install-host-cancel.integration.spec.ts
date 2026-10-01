import { Test } from '@nestjs/testing';
import { setTimeout as sleep } from 'node:timers/promises';
import { hostKey, startFakeSsh, type FakeSshServer } from '../../../common/test/fake-ssh.server';
import { fixtureTls } from '../../../common/test/tls-fixture';
import { STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import { HostInstallService } from '../host-install/host-install.service';
import { SshRunner } from '../host-install/ssh-runner';
import { ClaimOperation } from './claim.operation';
import { InstallHostOperation, INSTALL_HOST_TIMING } from './install-host.operation';
import { RemoteHostClient } from './remote-host.client';
import { RemoteOperationRunner } from './remote-operation.runner';
import type {
  CreateRemoteOperation,
  RemoteOperation,
  UpdateRemoteOperation,
} from '../../storage/models/domain.models';

jest.mock('node:os', () => {
  const actual = jest.requireActual('node:os');
  return {
    ...actual,
    userInfo: () => ({ username: 'devchain' }),
    homedir: () => '/home/devchain',
  };
});

// A real SSH transport is required to prove that abort closes a stalled channel
// while leaving the session usable to stop the detached unit.
describe('host install cancellation over SSH', () => {
  let server: FakeSshServer;
  let install: InstallHostOperation;
  let runner: RemoteOperationRunner;
  let row: RemoteOperation;
  let commands: string[];
  let inputs: string[];
  let holdCheck: boolean;
  let holdPoll: boolean;
  let finished: boolean;
  let stopFails: boolean;
  let stopped: boolean;
  let closedCheck: boolean;
  let closedPoll: boolean;
  let polled: boolean;
  const claim = {
    kind: 'claim',
    steps: [],
    interrupt: jest.fn(),
    rollback: jest.fn(),
    forget: jest.fn(),
  };

  beforeEach(async () => {
    commands = [];
    inputs = [];
    holdCheck = false;
    holdPoll = false;
    finished = false;
    stopFails = false;
    stopped = false;
    closedCheck = false;
    closedPoll = false;
    polled = false;
    jest.clearAllMocks();
    server = await startFakeSsh(hostKey(), 0, '', undefined, (command, stream) => {
      commands.push(command);
      stream.on('data', (data: Buffer) => inputs.push(data.toString()));
      if (command.startsWith('mktemp ')) return false;
      let output = '';
      let code = 0;
      if (command.includes(' --check') && holdCheck) {
        stream.on('close', () => {
          closedCheck = true;
        });
        return true;
      }
      if (command.includes('getent passwd')) code = 2;
      if (command.includes('/etc/devchain-host/tls/cert.pem')) output = fixtureTls.cert;
      if (command.includes('printf finished')) output = 'active';
      if (command.includes('__DEVCHAIN_EXIT__')) {
        polled = true;
        if (holdPoll) {
          stream.on('close', () => {
            closedPoll = true;
          });
          return true;
        }
        output = `installing\n__DEVCHAIN_EXIT__${finished ? '0' : ''}`;
      }
      if (command.includes('systemctl stop')) {
        code = stopFails ? 1 : 0;
        stopped = !stopFails;
      }
      stream.exit(code);
      stream.end(output);
      return true;
    });
    const module = await Test.createTestingModule({
      providers: [
        InstallHostOperation,
        SshRunner,
        { provide: HostInstallService, useValue: { render: async () => 'install block' } },
        {
          provide: RemoteHostClient,
          useValue: {
            certificateOf: async () => fixtureTls.cert,
            runtimeAt: async () => ({ state: 'unclaimed', imageVersion: '1.3.0' }),
          },
        },
        { provide: ClaimOperation, useValue: claim },
        {
          provide: STORAGE_SERVICE,
          useValue: { updateRemoteTlsCertificate: jest.fn(async () => undefined) },
        },
        {
          provide: INSTALL_HOST_TIMING,
          useValue: {
            installTimeoutMs: 60_000,
            bootstrapTimeoutMs: 60_000,
            pollIntervalMs: 30_000,
          },
        },
      ],
    }).compile();
    install = module.get(InstallHostOperation);
    const ssh = module.get(SshRunner);
    const withSession = ssh.withSession.bind(ssh);
    jest
      .spyOn(ssh, 'withSession')
      .mockImplementation((options, use) => withSession({ ...options, port: server.port }, use));
    const storage = {
      createRemoteOperation: async (data: CreateRemoteOperation) => {
        row = { ...data, id: 'cancel-test', state: 'running', createdAt: 'now', updatedAt: 'now' };
        return structuredClone(row);
      },
      getRemoteOperation: async () => structuredClone(row),
      updateRemoteOperation: async (_id: string, data: UpdateRemoteOperation) => {
        row = { ...row, ...data };
        return structuredClone(row);
      },
    };
    runner = new RemoteOperationRunner(
      storage as never,
      { broadcastEvent: jest.fn() } as never,
      { kind: 'attach' } as never,
      { kind: 'detach' } as never,
      claim as never,
      { kind: 'update_host' } as never,
      undefined,
      undefined,
      undefined,
      install,
    );
    install.seedCredentials('cancel-test', {
      user: 'admin',
      password: 'login-secret',
      sudoPassword: 'sudo-secret',
    });
  });

  afterEach(async () => {
    runner.onApplicationShutdown();
    await server.close();
  });

  async function start() {
    await runner.start({
      id: 'cancel-test',
      kind: 'install_host',
      remoteId: 'remote',
      projectId: null,
      details: {
        address: '127.0.0.1',
        sshUser: 'admin',
        sshAuthKind: 'password',
        minDiskGib: 12,
        userName: 'devchain',
        homePath: '/home/devchain',
        port: 3001,
        version: '1.0.0',
        bootstrapUrl: 'https://vm:3000',
        providerAuth: {},
      },
    });
  }

  async function until(predicate: () => boolean) {
    const deadline = Date.now() + 3_000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('Condition did not become true');
      await sleep(10);
    }
  }

  it('cancels a stalled check and closes its SSH channel without waiting for the preflight deadline', async () => {
    holdCheck = true;
    await start();
    await until(() => commands.some((command) => command.includes(' --check')));
    const before = Date.now();
    const cancelled = await runner.cancel('cancel-test');
    expect(Date.now() - before).toBeLessThan(2_000);
    expect(cancelled.state).toBe('cancelled');
    await until(() => closedCheck);
    expect(commands.some((command) => command.includes('systemd-run'))).toBe(false);
    expect(claim.interrupt).toHaveBeenCalledWith('cancel-test');
    expect(install.hasCredentials('cancel-test')).toBe(false);
  });

  it.each([false, true])(
    'stops the unit and cancels promptly with stalled poll=%s',
    async (stall) => {
      holdPoll = stall;
      await start();
      await until(() => polled);
      const before = Date.now();
      const cancelled = await runner.cancel('cancel-test');
      expect(Date.now() - before).toBeLessThan(2_000);
      expect(cancelled.state).toBe('cancelled');
      expect(stopped).toBe(true);
      expect(commands.filter((command) => command.includes('systemctl stop'))).toEqual([
        expect.stringContaining("sudo -S -p '' sh -c"),
      ]);
      expect(commands.find((command) => command.includes('systemctl stop'))).toContain(
        'systemctl kill --signal=SIGKILL',
      );
      // systemd 249 (Ubuntu 22.04) rejects --kill-whom; "all" is its default.
      expect(commands.find((command) => command.includes('systemctl stop'))).not.toContain(
        '--kill-whom',
      );
      expect(commands.find((command) => command.includes('systemctl stop'))).toContain('rm -f');
      expect(commands.join('\n')).not.toContain('sudo-secret');
      expect(inputs).toContain('sudo-secret\n');
      expect(cancelled.steps.find((step) => step.id === 'wait_bootstrap')?.state).toBe('pending');
      expect(cancelled.details.installStopRequired).toBeUndefined();
      if (stall) await until(() => closedPoll);
    },
  );

  it('does not report cancelled when stopping fails, and lets a later cancel retry cleanup', async () => {
    stopFails = true;
    await start();
    await until(() => polled);
    await expect(runner.cancel('cancel-test')).rejects.toMatchObject({ code: 'conflict' });
    expect(row.state).toBe('failed');
    expect(row.details.installStopRequired).toBe(true);
    expect(install.hasCredentials('cancel-test')).toBe(true);
    stopFails = false;
    expect((await runner.cancel('cancel-test')).state).toBe('cancelled');
    expect(stopped).toBe(true);
    expect(install.hasCredentials('cancel-test')).toBe(false);
  });

  it('finishes normally without sending a stop when no cancel is requested', async () => {
    finished = true;
    await start();
    await runner.whenIdle('cancel-test');
    expect(row.state).toBe('done');
    expect(commands.some((command) => command.includes('systemctl stop'))).toBe(false);
  });
});
