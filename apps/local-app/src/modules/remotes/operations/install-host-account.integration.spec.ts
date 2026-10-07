import { hostKey, startFakeSsh, type FakeSshServer } from '../../../common/test/fake-ssh.server';
import type { HostInstallService } from '../host-install/host-install.service';
import { SshRunner } from '../host-install/ssh-runner';
import type { RemoteOperation } from '../../storage/models/domain.models';
import { InstallHostOperation, type InstallHostDetails } from './install-host.operation';
import type { RemoteOperationStepRun } from './remote-operation.types';

// The real SshRunner scrubs credential values from captured output and from errors thrown
// inside a session; only the real transport shows that scrubbing cannot fake a collision
// or hide the account name when the password equals the user name. The name must not occur in
// the upload path (/tmp/devchain-host-install.*), which is scrubbed too.
describe('host install account check over SSH', () => {
  let server: FakeSshServer;
  let install: InstallHostOperation;
  let run: RemoteOperationStepRun;
  let account: { code: number; stdout: string };

  beforeEach(async () => {
    account = { code: 0, stdout: '' };
    server = await startFakeSsh(hostKey(), 0, '', undefined, (command, stream) => {
      if (!command.includes('getent passwd')) return false;
      stream.exit(account.code);
      stream.end(account.stdout);
      return true;
    });
    const ssh = new SshRunner();
    const connect = ssh.connect.bind(ssh);
    const withSession = ssh.withSession.bind(ssh);
    jest
      .spyOn(ssh, 'connect')
      .mockImplementation((options) => connect({ ...options, port: server.port }));
    jest
      .spyOn(ssh, 'withSession')
      .mockImplementation((options, use) => withSession({ ...options, port: server.port }, use));
    install = new InstallHostOperation(
      ssh,
      { render: async () => 'check block' } as unknown as HostInstallService,
      {} as never,
      { steps: [] } as never,
      {} as never,
    );
    const details: InstallHostDetails = {
      address: '127.0.0.1',
      sshUser: 'mira',
      sshAuthKind: 'password',
      minDiskGib: 12,
      userName: 'mira',
      homePath: '/home/mira',
      port: 3001,
      version: '1.0.0',
      bootstrapUrl: 'http://vm:3000',
      providerAuth: {},
    };
    run = {
      operation: { id: 'account-test' } as RemoteOperation,
      details: details as never,
      progress: jest.fn(async () => undefined),
    };
    install.seedCredentials('account-test', { user: 'mira', password: 'mira' });
    await step('ssh_connect').run(run);
  });

  afterEach(async () => {
    await server.close();
  });

  function step(id: string) {
    const found = install.steps.find((candidate) => candidate.id === id);
    if (!found) throw new Error(`Missing step ${id}`);
    return found;
  }

  it('names the account and this PC home in full and scrubs the VM home', async () => {
    account = { code: 10, stdout: '/srv/mira' };

    await expect(step('check').run(run)).rejects.toMatchObject({
      code: 'HOST_INSTALL_ACCOUNT_COLLISION',
      message:
        'The VM account mira already uses the home folder /srv/[REDACTED]. ' +
        "Correct that account's home folder to /home/mira, or use a new VM.",
    });
  });
});
