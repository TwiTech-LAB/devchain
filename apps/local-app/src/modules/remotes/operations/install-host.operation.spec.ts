import { fixtureTls, otherTls } from '../../../common/test/tls-fixture';
import { normalizeCertificate } from '../../../common/tls/certificate';
import type { RemoteOperation } from '../../storage/models/domain.models';
import type { HostInstallService } from '../host-install/host-install.service';
import {
  SSH_COMMAND_TIMEOUT_MS,
  type SshCommandResult,
  type SshConnectionOptions,
  type SshExecOptions,
  type SshSession,
} from '../host-install/ssh-runner';
import {
  accountHomeCheckCommand,
  HOST_INSTALL_PREFLIGHT_TIMEOUT_MS,
  InstallHostOperation,
  type InstallHostDetails,
} from './install-host.operation';
import { RemoteOperationStepRefusedError } from './remote-operation.errors';
import type { RemoteOperationStepRun } from './remote-operation.types';

class FakeSession implements SshSession {
  readonly fingerprint = 'SHA256:first';
  uploads: string[] = [];
  commands: string[] = [];
  stdins: string[] = [];
  execOptions: SshExecOptions[] = [];
  uploadOptions: SshExecOptions[] = [];
  check: SshCommandResult = { code: 0, stdout: 'Pre-validation passed.\n', stderr: '' };
  sudoProbe: SshCommandResult = { code: 0, stdout: '', stderr: '' };
  account: SshCommandResult = { code: 2, stdout: '', stderr: '' };
  status: 'active' | 'finished' | 'absent' = 'absent';
  exitCodes: Array<number | null> = [0];
  certificate: SshCommandResult = { code: 0, stdout: fixtureTls.cert, stderr: '' };

  async uploadTemp(contents: string, options: SshExecOptions = {}): Promise<string> {
    this.uploads.push(contents);
    this.uploadOptions.push(options);
    return `/tmp/devchain-host-install.${this.uploads.length}`;
  }

  async exec(command: string, stdin = '', options: SshExecOptions = {}): Promise<SshCommandResult> {
    this.commands.push(command);
    this.stdins.push(stdin);
    this.execOptions.push(options);
    if (command.includes("sudo -S -p '' true")) return this.sudoProbe;
    if (command.includes(' --check')) return this.check;
    if (command.includes('getent passwd')) return this.account;
    if (command.includes('/etc/devchain-host/tls/cert.pem')) return this.certificate;
    if (command.includes('printf finished') && command.includes('systemctl is-active')) {
      return { code: 0, stdout: this.status, stderr: '' };
    }
    if (command.includes('__DEVCHAIN_EXIT__')) {
      const code = this.exitCodes.shift() ?? null;
      return {
        code: 0,
        stdout: `install log\n__DEVCHAIN_EXIT__${code === null ? '' : code}`,
        stderr: '',
      };
    }
    return { code: 0, stdout: '', stderr: '' };
  }
}

class FakeSshRunner {
  readonly session = new FakeSession();
  readonly connections: SshConnectionOptions[] = [];

  async connect(options: SshConnectionOptions): Promise<string> {
    this.connections.push(options);
    return this.session.fingerprint;
  }

  async withSession<T>(
    options: SshConnectionOptions,
    use: (session: SshSession) => Promise<T>,
  ): Promise<T> {
    this.connections.push(options);
    return use(this.session);
  }
}

function operation(details: InstallHostDetails): RemoteOperation {
  return {
    id: 'operation-1',
    kind: 'install_host',
    remoteId: 'remote-1',
    projectId: null,
    state: 'running',
    steps: [],
    details: details as unknown as Record<string, unknown>,
    createdAt: 'now',
    updatedAt: 'now',
  };
}

function installDetails(): InstallHostDetails {
  return {
    address: '192.168.1.20',
    sshUser: 'vm-admin',
    sshAuthKind: 'password',
    minDiskGib: 12,
    bootstrapUrl: 'https://192.168.1.20:3000',
    userName: 'devchain',
    homePath: '/home/devchain',
    version: '1.0.0',
    port: 3001,
    providerAuth: {},
  };
}

describe('InstallHostOperation', () => {
  let ssh: FakeSshRunner;
  let hostInstall: { render: jest.Mock };
  let host: { certificateOf: jest.Mock; runtimeAt: jest.Mock };
  let storage: { updateRemoteTlsCertificate: jest.Mock };
  let claim: {
    steps: never[];
    assertCancellable: jest.Mock;
    interrupt: jest.Mock;
    forget: jest.Mock;
    retryFrom: jest.Mock;
    rollback: jest.Mock;
  };
  let install: InstallHostOperation;
  let details: InstallHostDetails;
  let run: RemoteOperationStepRun;
  let progress: jest.Mock;

  beforeEach(() => {
    ssh = new FakeSshRunner();
    hostInstall = {
      render: jest.fn(async ({ checkOnly }) => (checkOnly ? 'check block' : 'install block')),
    };
    host = {
      certificateOf: jest.fn().mockResolvedValue(fixtureTls.cert),
      runtimeAt: jest.fn().mockResolvedValue({ state: 'unclaimed', imageVersion: '1.3.0' }),
    };
    storage = { updateRemoteTlsCertificate: jest.fn(async () => undefined) };
    claim = {
      steps: [],
      assertCancellable: jest.fn(),
      interrupt: jest.fn(async () => undefined),
      forget: jest.fn(),
      retryFrom: jest.fn(() => null),
      rollback: jest.fn(async () => undefined),
    };
    install = new InstallHostOperation(
      ssh as never,
      hostInstall as unknown as HostInstallService,
      host as never,
      claim as never,
      storage as never,
      { installTimeoutMs: 50, bootstrapTimeoutMs: 50, pollIntervalMs: 1 },
    );
    details = installDetails();
    progress = jest.fn(async () => undefined);
    run = { operation: operation(details), details: details as never, progress };
    install.seedCredentials(run.operation.id, {
      user: 'vm-admin',
      password: 'ssh-secret',
      sudoPassword: 'sudo-secret',
    });
  });

  function step(id: string) {
    const found = install.steps.find((candidate) => candidate.id === id);
    if (!found) throw new Error(`Missing step ${id}`);
    return found;
  }

  async function connect(): Promise<void> {
    await step('ssh_connect').run(run);
    expect(details.hostKeyFingerprint).toBe('SHA256:first');
  }

  it('records the first SSH fingerprint and requires it on later connections', async () => {
    await connect();
    await step('check').run(run);

    expect(ssh.connections[0].expectedFingerprint).toBeUndefined();
    expect(ssh.connections[1].expectedFingerprint).toBe('SHA256:first');
    const checkIndex = ssh.session.commands.findIndex((command) => command.includes(' --check'));
    expect(ssh.session.execOptions[checkIndex]).toEqual({
      timeoutMs: HOST_INSTALL_PREFLIGHT_TIMEOUT_MS,
      signal: expect.any(AbortSignal),
    });
    expect(HOST_INSTALL_PREFLIGHT_TIMEOUT_MS).toBeGreaterThan(SSH_COMMAND_TIMEOUT_MS);
  });

  // The operation unit owns selecting warning lines and replacing persisted details on retry.
  it('retains check warnings from both streams and clears them on a clean retry', async () => {
    await connect();
    ssh.session.check = {
      code: 0,
      stdout: 'dry run output\nWARNING: stdout warning\r\nPre-validation passed.\n',
      stderr: 'WARNING: The VM has 1 vCPU.\nWARNING: ufw is active.\n',
    };
    await step('check').run(run);
    expect(run.details.checkWarnings).toEqual([
      'stdout warning',
      'The VM has 1 vCPU.',
      'ufw is active.',
    ]);
    ssh.session.check = { code: 0, stdout: 'Pre-validation passed.\n', stderr: '' };
    await step('check').run(run);
    expect(run.details.checkWarnings).toEqual([]);
  });

  it('surfaces the block refusal lines from check mode', async () => {
    await connect();
    ssh.session.check = {
      code: 1,
      stdout: '',
      stderr: 'ERROR: At least 12 GiB of free space is required.\n',
    };

    await expect(step('check').run(run)).rejects.toMatchObject({
      code: 'HOST_INSTALL_CHECK_FAILED',
      message: expect.stringContaining('12 GiB'),
    });
  });

  it('fails the check with a sudo-password request when the key login has no sudo password', async () => {
    install.seedCredentials(run.operation.id, { user: 'vm-admin', privateKey: 'key-material' });
    await connect();
    ssh.session.sudoProbe = { code: 1, stdout: '', stderr: 'sudo: a password is required\n' };

    await expect(step('check').run(run)).rejects.toMatchObject({
      code: 'SSH_SUDO_PASSWORD_REQUIRED',
      message: 'sudo on the VM needs a password for vm-admin. Enter the sudo password and retry.',
    });
    expect(ssh.session.uploads).toEqual([]);
  });

  it('reports a refused sudo password when one was given', async () => {
    await connect();
    ssh.session.sudoProbe = { code: 1, stdout: '', stderr: 'sudo: incorrect password\n' };

    await expect(step('check').run(run)).rejects.toMatchObject({
      code: 'SSH_SUDO_PASSWORD_REQUIRED',
      message: 'The VM refused the sudo password for vm-admin.',
    });
    expect(ssh.session.stdins[0]).toBe('sudo-secret\n');
    expect(ssh.session.commands[0]).toBe("env LC_ALL=C sudo -S -p '' true");
  });

  it("shows sudo's own refusal when the failure is not about a password", async () => {
    await connect();
    ssh.session.sudoProbe = {
      code: 1,
      stdout: '',
      stderr: 'vm-admin is not in the sudoers file.  This incident will be reported.\n',
    };

    await expect(step('check').run(run)).rejects.toMatchObject({
      code: 'HOST_INSTALL_CHECK_FAILED',
      message: 'vm-admin is not in the sudoers file.  This incident will be reported.',
    });
    expect(ssh.session.uploads).toEqual([]);
  });

  it('lets a retry run after a cancel that did not complete', async () => {
    await connect();
    await install.interrupt(run.operation.id);
    await expect(step('check').run(run)).rejects.toMatchObject({ name: 'AbortError' });

    install.retryFrom(run.operation);

    await step('check').run(run);
    expect(ssh.session.uploads).toHaveLength(1);
  });

  it('skips the sudo probe for the root SSH user', async () => {
    install.seedCredentials(run.operation.id, { user: 'root', password: 'root-secret' });
    details.sshUser = 'root';
    await connect();
    ssh.session.sudoProbe = { code: 1, stdout: '', stderr: '' };

    await step('check').run(run);

    expect(ssh.session.commands.some((command) => command.includes("sudo -S -p '' true"))).toBe(
      false,
    );
    expect(run.details.checkWarnings).toEqual([]);
  });

  // The operation unit owns mapping the account check's exit codes to step outcomes.
  it('runs the account home comparison on the VM without sudo', async () => {
    await connect();
    await step('check').run(run);

    const command = ssh.session.commands.find((candidate) => candidate.includes('getent passwd'));
    expect(command).toBe(accountHomeCheckCommand('devchain', '/home/devchain'));
    expect(command).not.toContain('sudo');
  });

  it.each([
    ['reuses an existing account with the same home', 0],
    ['continues when the account does not exist', 2],
  ])('%s', async (_name, code) => {
    await connect();
    ssh.session.account = { code, stdout: '', stderr: '' };

    await expect(step('check').run(run)).resolves.toBeUndefined();
  });

  it('refuses an existing account with a different home and names it in full', async () => {
    await connect();
    ssh.session.account = { code: 10, stdout: '/srv/devchain', stderr: '' };

    await expect(step('check').run(run)).rejects.toMatchObject({
      constructor: RemoteOperationStepRefusedError,
      code: 'HOST_INSTALL_ACCOUNT_COLLISION',
      message:
        'The VM account devchain already uses the home folder /srv/devchain. ' +
        "Correct that account's home folder to /home/devchain, or use a new VM.",
    });
  });

  it('refuses when the account check itself fails', async () => {
    await connect();
    ssh.session.account = { code: 1, stdout: '', stderr: 'getent: failure' };

    await expect(step('check').run(run)).rejects.toMatchObject({
      code: 'HOST_INSTALL_ACCOUNT_CHECK_FAILED',
    });
  });

  it('starts a detached install, streams progress, and accepts its zero exit code', async () => {
    await connect();
    ssh.session.exitCodes = [null, 0];

    await step('install').run(run);

    expect(ssh.session.uploads).toContain('install block');
    expect(ssh.session.commands.some((command) => command.includes('systemd-run'))).toBe(true);
    expect(progress).toHaveBeenCalledWith({ install: { tail: 'install log' } });
    const bounded = ssh.session.commands
      .map((command, index) => ({ command, options: ssh.session.execOptions[index] }))
      .filter(({ command }) =>
        ['systemctl is-active', 'systemd-run', '__DEVCHAIN_EXIT__'].some((part) =>
          command.includes(part),
        ),
      );
    expect(bounded).not.toHaveLength(0);
    expect(bounded.every(({ options }) => typeof options.deadlineAt === 'number')).toBe(true);
    expect(ssh.session.uploadOptions).toEqual([
      expect.objectContaining({ deadlineAt: expect.any(Number) }),
    ]);
  });

  it('attaches to an already finished install without uploading or starting it again', async () => {
    await connect();
    ssh.session.status = 'finished';

    await step('install').run(run);

    expect(ssh.session.uploads).toEqual([]);
    expect(ssh.session.commands.some((command) => command.includes('systemd-run'))).toBe(false);
  });

  it('clears an observed failure marker so a later retry can safely rerun the block', async () => {
    await connect();
    ssh.session.status = 'finished';
    ssh.session.exitCodes = [7];

    await expect(step('install').run(run)).rejects.toMatchObject({ code: 'HOST_INSTALL_FAILED' });
    expect(ssh.session.commands.some((command) => command.includes('rm -f'))).toBe(true);

    ssh.session.status = 'absent';
    ssh.session.exitCodes = [0];
    await step('install').run(run);
    expect(ssh.session.uploads).toContain('install block');
    expect(ssh.session.commands.some((command) => command.includes('systemd-run'))).toBe(true);
  });

  it('requires credentials after a home restart but keeps them for same-process retries', async () => {
    const restarted = new InstallHostOperation(
      ssh as never,
      hostInstall as unknown as HostInstallService,
      host as never,
      claim as never,
      storage as never,
      { installTimeoutMs: 50, bootstrapTimeoutMs: 50, pollIntervalMs: 1 },
    );
    const restartedStep = restarted.steps.find((candidate) => candidate.id === 'install')!;

    await expect(restartedStep.run(run)).rejects.toMatchObject({
      code: 'SSH_CREDENTIALS_REQUIRED',
    });
    await connect();
    await step('install').run(run);
    expect(install.hasCredentials(run.operation.id)).toBe(true);
  });

  it('reads the VM certificate over the install session after success and saves it before wait_bootstrap', async () => {
    await connect();
    ssh.session.exitCodes = [null, 0];

    await step('install').run(run);

    const readIndex = ssh.session.commands.findIndex((command) =>
      command.includes('/etc/devchain-host/tls/cert.pem'),
    );
    const lastPoll = ssh.session.commands
      .map((command) => command.includes('__DEVCHAIN_EXIT__'))
      .lastIndexOf(true);
    expect(readIndex).toBeGreaterThan(lastPoll);
    expect(ssh.session.commands[readIndex]).toBe(
      "sudo -S -p '' cat '/etc/devchain-host/tls/cert.pem'",
    );
    expect(ssh.session.stdins[readIndex]).toBe('sudo-secret\n');
    // The install step opens one session for the whole step; the read reuses it.
    expect(ssh.connections).toHaveLength(2);
    const pem = normalizeCertificate(fixtureTls.cert);
    expect(storage.updateRemoteTlsCertificate).toHaveBeenCalledWith('remote-1', pem);
    expect(details.tlsCertificate).toBe(pem);

    await step('wait_bootstrap').run(run);
    expect(host.certificateOf).not.toHaveBeenCalled();
    expect(host.runtimeAt).toHaveBeenCalledWith(details.bootstrapUrl, pem);
  });

  it('reads the certificate again when a retry attaches to an already finished install', async () => {
    await connect();
    ssh.session.status = 'finished';
    ssh.session.certificate = { code: 0, stdout: otherTls.cert, stderr: '' };
    details.tlsCertificate = normalizeCertificate(fixtureTls.cert);

    await step('install').run(run);

    expect(details.tlsCertificate).toBe(normalizeCertificate(otherTls.cert));
    expect(storage.updateRemoteTlsCertificate).toHaveBeenCalledWith(
      'remote-1',
      normalizeCertificate(otherTls.cert),
    );
  });

  it('never reads the certificate when the install fails', async () => {
    await connect();
    ssh.session.status = 'finished';
    ssh.session.exitCodes = [7];

    await expect(step('install').run(run)).rejects.toMatchObject({ code: 'HOST_INSTALL_FAILED' });
    expect(ssh.session.commands.some((command) => command.includes('tls/cert.pem'))).toBe(false);
    expect(storage.updateRemoteTlsCertificate).not.toHaveBeenCalled();
  });

  it('fails the install step with a clear error when the certificate cannot be read', async () => {
    await connect();
    ssh.session.status = 'finished';
    ssh.session.certificate = {
      code: 1,
      stdout: '',
      stderr: 'cat: /etc/devchain-host/tls/cert.pem: No such file or directory\n',
    };

    await expect(step('install').run(run)).rejects.toMatchObject({
      constructor: RemoteOperationStepRefusedError,
      code: 'HOST_TLS_CERTIFICATE_UNREADABLE',
      message:
        'Could not read the VM certificate /etc/devchain-host/tls/cert.pem over SSH: ' +
        'cat: /etc/devchain-host/tls/cert.pem: No such file or directory',
    });
    expect(storage.updateRemoteTlsCertificate).not.toHaveBeenCalled();
    expect(details.tlsCertificate).toBeUndefined();
  });

  it.each([
    ['empty output', ''],
    ['text that is not PEM', 'not a certificate'],
    [
      'a PEM block that does not parse',
      '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n',
    ],
    ['two certificates', `${fixtureTls.cert}${otherTls.cert}`],
    ['a private key', fixtureTls.key],
    ['a redacted certificate', fixtureTls.cert.replace(/[A-Za-z0-9]{8}\n/, '[REDACTED]\n')],
  ])('refuses %s as the VM certificate', async (_name, stdout) => {
    await connect();
    ssh.session.status = 'finished';
    ssh.session.certificate = { code: 0, stdout, stderr: '' };

    await expect(step('install').run(run)).rejects.toMatchObject({
      code: 'HOST_TLS_CERTIFICATE_INVALID',
    });
    expect(storage.updateRemoteTlsCertificate).not.toHaveBeenCalled();
    expect(details.tlsCertificate).toBeUndefined();
  });

  it('fails the install step when the certificate cannot be saved on the remote', async () => {
    await connect();
    ssh.session.status = 'finished';
    storage.updateRemoteTlsCertificate.mockRejectedValue(new Error('disk full'));

    await expect(step('install').run(run)).rejects.toThrow('disk full');
    expect(details.tlsCertificate).toBeUndefined();
  });

  it('waits for a supported unclaimed bootstrap and clears credentials on completion', async () => {
    await step('wait_bootstrap').run(run);
    expect(host.certificateOf).toHaveBeenCalledWith('remote-1');
    expect(host.runtimeAt).toHaveBeenCalledWith(details.bootstrapUrl, fixtureTls.cert);

    await install.completed(run.operation);
    expect(install.hasCredentials(run.operation.id)).toBe(false);
    expect(claim.forget).toHaveBeenCalledWith(run.operation.id);
  });

  it('never probes the bootstrap without the VM certificate', async () => {
    host.certificateOf.mockRejectedValue(
      Object.assign(new Error('no certificate'), { code: 'REMOTE_TLS_CERTIFICATE_MISSING' }),
    );

    await expect(step('wait_bootstrap').run(run)).rejects.toMatchObject({
      code: 'REMOTE_TLS_CERTIFICATE_MISSING',
    });
    expect(host.runtimeAt).not.toHaveBeenCalled();
  });

  it('stops waiting for the bootstrap when the operation is cancelled', async () => {
    host.runtimeAt.mockResolvedValue(null);
    await install.interrupt(run.operation.id);

    await expect(step('wait_bootstrap').run(run)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('delegates rollback to the claim so checked-out provider logins are released', async () => {
    await install.rollback(run.operation);

    expect(claim.rollback).toHaveBeenCalledWith(expect.objectContaining({ kind: 'install_host' }));
    expect(install.hasCredentials(run.operation.id)).toBe(false);
  });

  it('sends only the sudo password on stdin and never embeds credentials in commands', async () => {
    await connect();
    await step('check').run(run);
    await step('install').run(run);

    const serialized = JSON.stringify(ssh.session.commands);
    expect(serialized).not.toContain('ssh-secret');
    expect(serialized).not.toContain('sudo-secret');
    expect(ssh.session.stdins.filter(Boolean)).toEqual(expect.arrayContaining(['sudo-secret\n']));
    expect(ssh.session.stdins.every((stdin) => !stdin.includes('check block'))).toBe(true);
    expect(ssh.session.stdins.every((stdin) => !stdin.includes('install block'))).toBe(true);
  });

  it('does not invoke sudo for the root SSH user', async () => {
    install.seedCredentials(run.operation.id, { user: 'root', password: 'root-ssh-secret' });
    details.sshUser = 'root';
    await connect();
    await step('check').run(run);
    await step('install').run(run);

    expect(ssh.session.commands.every((command) => !command.startsWith('sudo '))).toBe(true);
    expect(ssh.session.stdins.every((stdin) => stdin === '')).toBe(true);
  });
});
