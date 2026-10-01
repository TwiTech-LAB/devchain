/**
 * RemoteOperationsService unit tests.
 * Test layer: pure unit. The contract is which open operation a detach may
 * take over, decided on the row as it is once no step runs; fakes for storage
 * and the runner show the order of those calls.
 */
import { ConflictError } from '../../../common/errors/error-types';
import { resetEnvConfig } from '../../../common/config/env.config';
import type {
  RemoteOperation,
  RemoteOperationStep,
  RemoteOperationStepState,
} from '../../storage/models/domain.models';
import { RemoteOperationsService } from './remote-operations.service';
import { utils } from 'ssh2';
import { ClaimRemoteSchema, InstallHostSchema, SshCredentialsSchema } from './remote-operation.dto';

jest.mock('node:os', () => {
  const actual = jest.requireActual('node:os');
  const identity = { username: 'devchain', home: '/home/devchain' };
  return {
    ...actual,
    userInfo: () => ({ username: identity.username }),
    homedir: () => identity.home,
    __setMockIdentity(username: string, home: string): void {
      identity.username = username;
      identity.home = home;
    },
  };
});

describe('SshCredentialsSchema', () => {
  it('accepts exactly one authentication source and permits key-name passphrases', () => {
    expect(
      SshCredentialsSchema.parse({ user: 'ubuntu', keyName: 'id_ed25519', passphrase: 'secret' }),
    ).toEqual({ user: 'ubuntu', keyName: 'id_ed25519', passphrase: 'secret' });
    expect(() =>
      SshCredentialsSchema.parse({ user: 'ubuntu', password: 'secret', keyName: 'id_rsa' }),
    ).toThrow('Give exactly one SSH password, private key or key name.');
    expect(() =>
      SshCredentialsSchema.parse({ user: 'ubuntu', password: 'secret', passphrase: 'unused' }),
    ).toThrow('An SSH passphrase applies only to a private key.');
  });
});

it('refuses to connect a provisioning remote without an address', async () => {
  const storage = {
    getRemote: jest.fn().mockResolvedValue({ id: 'remote-1', baseUrl: null }),
    getProject: jest.fn(),
  };
  const runner = { start: jest.fn() };
  const service = new RemoteOperationsService(
    storage as never,
    runner as never,
    {} as never,
    {} as never,
    {} as never,
  );
  await expect(service.attach('remote-1', 'project-1')).rejects.toMatchObject({
    details: expect.objectContaining({ code: 'REMOTE_PROVISIONING' }),
  });
  expect(storage.getProject).not.toHaveBeenCalled();
  expect(runner.start).not.toHaveBeenCalled();
});

const ATTACH_STEPS = [
  'preflight',
  'git_config',
  'stop_home_sessions',
  'wait_time_batches',
  'freeze_home',
  'build_replica',
  'push_replica',
  'file_sync_initial',
  'file_sync_flip',
  'bind_remote',
  'thaw_host',
  'start_live_sync',
];

function steps(ids: string[], doneUntil: string, failedAt: string | null): RemoteOperationStep[] {
  const doneIndex = ids.indexOf(doneUntil);
  return ids.map((id, index) => {
    let state: RemoteOperationStepState = index <= doneIndex ? 'done' : 'pending';
    if (id === failedAt) state = 'failed';
    return { id, label: id, state, startedAt: null, endedAt: null, error: null };
  });
}

function operation(overrides: Partial<RemoteOperation>): RemoteOperation {
  return {
    id: 'op-attach',
    kind: 'attach',
    remoteId: 'remote-1',
    projectId: 'project-1',
    state: 'failed',
    steps: steps(ATTACH_STEPS, 'bind_remote', 'thaw_host'),
    details: { importCursor: 'c' },
    createdAt: 't',
    updatedAt: 't',
    ...overrides,
  };
}

describe('RemoteOperationsService.detach', () => {
  let rows: Map<string, RemoteOperation>;
  let calls: string[];
  let storage: {
    getRemote: jest.Mock;
    getProject: jest.Mock;
    listRemoteOperations: jest.Mock;
    getRemoteOperation: jest.Mock;
    updateRemoteOperation: jest.Mock;
  };
  let runner: { whenIdle: jest.Mock; supersede: jest.Mock; start: jest.Mock };
  let service: RemoteOperationsService;

  beforeEach(() => {
    rows = new Map();
    calls = [];
    storage = {
      getRemote: jest.fn().mockResolvedValue({ id: 'remote-1' }),
      getProject: jest.fn().mockResolvedValue({ id: 'project-1' }),
      listRemoteOperations: jest.fn(async () =>
        [...rows.values()].filter((row) => ['running', 'failed'].includes(row.state)),
      ),
      getRemoteOperation: jest.fn(async (id: string) => {
        calls.push(`read ${id}`);
        return structuredClone(rows.get(id));
      }),
      updateRemoteOperation: jest.fn(async (id: string, data: Partial<RemoteOperation>) => {
        const row = { ...rows.get(id)!, ...data };
        rows.set(id, row);
        return row;
      }),
    };
    runner = {
      whenIdle: jest.fn(async (id: string) => void calls.push(`idle ${id}`)),
      supersede: jest.fn(async (row: RemoteOperation, details: Record<string, unknown>) => {
        calls.push(`supersede ${row.id}`);
        const cancelled = {
          ...row,
          state: 'cancelled' as const,
          details: { ...row.details, ...details },
        };
        rows.set(row.id, cancelled);
        return cancelled;
      }),
      start: jest.fn(async (input: { kind: string; details: Record<string, unknown> }) => {
        const open = [...rows.values()].find((row) => ['running', 'failed'].includes(row.state));
        if (open) throw new ConflictError('open', { code: 'REMOTE_OPERATION_IN_PROGRESS' });
        calls.push(`start ${input.kind}`);
        const detach = operation({
          id: 'op-detach',
          kind: 'detach',
          state: 'running',
          details: input.details,
        });
        rows.set(detach.id, detach);
        return detach;
      }),
    };
    service = new RemoteOperationsService(storage as never, runner as never);
  });

  it('starts a detach directly when no operation is open', async () => {
    const detach = await service.detach('remote-1', 'project-1', false);

    expect(detach).toMatchObject({ id: 'op-detach', details: { force: false } });
    expect(runner.supersede).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'takes over a failed attach that already bound the project (force %s)',
    async (force) => {
      rows.set('op-attach', operation({}));

      const detach = await service.detach('remote-1', 'project-1', force);

      expect(calls).toEqual([
        'idle op-attach',
        'read op-attach',
        'supersede op-attach',
        'start detach',
      ]);
      expect(detach.details).toEqual({ force });
      expect(rows.get('op-attach')).toMatchObject({
        state: 'cancelled',
        steps: operation({}).steps,
        details: { importCursor: 'c', supersededAt: expect.any(String), supersededBy: 'op-detach' },
      });
    },
  );

  it('refuses when the attach is running again after the wait, and supersedes nothing', async () => {
    rows.set('op-attach', operation({}));
    runner.whenIdle.mockImplementationOnce(async (id: string) => {
      calls.push(`idle ${id}`);
      // A retry started while the detach waited.
      rows.set(id, { ...rows.get(id)!, state: 'running' });
    });

    await expect(service.detach('remote-1', 'project-1', true)).rejects.toMatchObject({
      details: { code: 'REMOTE_OPERATION_IN_PROGRESS', operationId: 'op-attach' },
    });
    expect(calls).toEqual(['idle op-attach', 'read op-attach']);
    expect(runner.supersede).not.toHaveBeenCalled();
    expect(runner.start).not.toHaveBeenCalled();
  });

  it('refuses a failed attach that never handed the project over: cancel it instead', async () => {
    rows.set(
      'op-attach',
      operation({ steps: steps(ATTACH_STEPS, 'freeze_home', 'build_replica') }),
    );

    await expect(service.detach('remote-1', 'project-1', true)).rejects.toMatchObject({
      message: expect.stringContaining('cancel it instead'),
      details: { code: 'REMOTE_OPERATION_IN_PROGRESS', operationId: 'op-attach' },
    });
    expect(runner.supersede).not.toHaveBeenCalled();
    expect(rows.get('op-attach')?.state).toBe('failed');
  });

  it('replaces a failed detach only when forced', async () => {
    rows.set('op-old', operation({ id: 'op-old', kind: 'detach', steps: [] }));

    await expect(service.detach('remote-1', 'project-1', false)).rejects.toMatchObject({
      details: { code: 'REMOTE_OPERATION_IN_PROGRESS', operationId: 'op-old' },
    });
    const detach = await service.detach('remote-1', 'project-1', true);

    expect(detach.id).toBe('op-detach');
    expect(rows.get('op-old')).toMatchObject({
      state: 'cancelled',
      details: { supersededBy: 'op-detach' },
    });
  });

  it('leaves a running operation to the storage guard without waiting on it', async () => {
    rows.set('op-attach', operation({ state: 'running' }));

    await expect(service.detach('remote-1', 'project-1', true)).rejects.toMatchObject({
      details: { code: 'REMOTE_OPERATION_IN_PROGRESS' },
    });
    expect(runner.whenIdle).not.toHaveBeenCalled();
    expect(runner.supersede).not.toHaveBeenCalled();
  });
});

describe('RemoteOperationsService.installHost credentials', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, PORT: '3001' };
    resetEnvConfig();
  });

  afterAll(() => {
    process.env = originalEnv;
    resetEnvConfig();
  });

  it('seeds credentials before launch and persists only the safe details allowlist', async () => {
    const calls: string[] = [];
    const storage = {
      listRemotes: jest.fn().mockResolvedValue({ items: [] }),
      listRemoteOperations: jest.fn().mockResolvedValue([]),
      createRemote: jest.fn().mockResolvedValue({
        id: 'remote-install',
        name: 'host',
        baseUrl: 'https://192.168.1.20:3001',
      }),
    };
    const installOperation = {
      seedCredentials: jest.fn(() => calls.push('seed')),
      forget: jest.fn(),
    };
    const runner = {
      start: jest.fn(async (input: Record<string, unknown>) => {
        calls.push('start');
        return {
          id: input.id,
          kind: input.kind,
          remoteId: input.remoteId,
          projectId: null,
          state: 'running',
          steps: [],
          details: input.details,
          createdAt: 'now',
          updatedAt: 'now',
        };
      }),
    };
    const service = new RemoteOperationsService(
      storage as never,
      runner as never,
      {} as never,
      {} as never,
      { isSupported: jest.fn(), getSupportedProviders: jest.fn() } as never,
      installOperation as never,
      { resolve: jest.fn(async (input: never) => ({ credentials: input })) } as never,
    );
    const ssh = {
      user: 'vm-admin',
      password: 'ssh-password-secret',
      sudoPassword: 'sudo-password-secret',
    };

    const key = utils.generateKeyPairSync('ed25519').public;
    const operation = await service.installHost(
      InstallHostSchema.parse({
        address: '192.168.1.20',
        ssh,
        name: 'host',
        providerAuth: {},
        minDiskGib: 12,
        sshPublicKeys: [key],
      }),
    );

    expect(calls).toEqual(['seed', 'start']);
    expect(installOperation.seedCredentials).toHaveBeenCalledWith(operation.id, ssh);
    expect(storage.createRemote).toHaveBeenCalledWith({
      name: 'host',
      baseUrl: 'https://192.168.1.20:3001',
      kind: 'address',
      tlsCertificate: null,
    });
    expect(operation.details).toMatchObject({
      address: '192.168.1.20',
      sshUser: 'vm-admin',
      sshAuthKind: 'password',
      minDiskGib: 12,
      bootstrapUrl: 'https://192.168.1.20:3000',
      sshPublicKeys: [key],
    });
    const persisted = JSON.stringify(operation);
    for (const secret of [ssh.password, ssh.sudoPassword]) {
      expect(persisted).not.toContain(secret);
    }
    expect(persisted).not.toContain('privateKey');
    expect(persisted).not.toContain('passphrase');
  });

  it('accepts replacement SSH credentials only for a failed install operation', async () => {
    const failed = {
      id: 'operation-1',
      kind: 'install_host',
      state: 'failed',
      details: {},
    };
    const storage = {
      getRemoteOperation: jest.fn().mockResolvedValue(failed),
      updateRemoteOperation: jest.fn().mockResolvedValue(failed),
    };
    const runner = { retry: jest.fn().mockResolvedValue(failed) };
    const installOperation = { seedCredentials: jest.fn() };
    const service = new RemoteOperationsService(
      storage as never,
      runner as never,
      {} as never,
      {} as never,
      {} as never,
      installOperation as never,
      {
        resolve: jest.fn().mockResolvedValue({
          keyName: 'id_rsa',
          credentials: { user: 'vm-admin', privateKey: 'private-key-secret' },
        }),
      } as never,
    );
    const ssh = { user: 'vm-admin', keyName: 'id_rsa' };

    await service.retry(failed.id, undefined, ssh);

    expect(installOperation.seedCredentials).toHaveBeenCalledWith(failed.id, {
      user: 'vm-admin',
      privateKey: 'private-key-secret',
    });
    expect(storage.updateRemoteOperation).toHaveBeenCalledWith(failed.id, {
      expectedState: 'failed',
      details: { sshUser: 'vm-admin', sshAuthKind: 'key', sshKeyName: 'id_rsa' },
    });
    expect(runner.retry).toHaveBeenCalledWith(failed.id);
  });
});

describe('RemoteOperationsService.installHost account validation', () => {
  function setMockIdentity(username: string, home: string): void {
    (
      jest.requireMock('node:os') as { __setMockIdentity(username: string, home: string): void }
    ).__setMockIdentity(username, home);
  }

  function makeService() {
    const storage = {
      listRemotes: jest.fn().mockResolvedValue({ items: [] }),
      listRemoteOperations: jest.fn().mockResolvedValue([]),
      createRemote: jest.fn().mockResolvedValue({
        id: 'remote-install',
        name: 'host',
        baseUrl: 'https://192.168.1.20:3001',
      }),
    };
    const installOperation = { seedCredentials: jest.fn(), forget: jest.fn() };
    const runner = {
      start: jest.fn(async (input: Record<string, unknown>) => ({
        id: input.id,
        kind: input.kind,
        remoteId: input.remoteId,
        projectId: null,
        state: 'running',
        steps: [],
        details: input.details,
        createdAt: 'now',
        updatedAt: 'now',
      })),
    };
    const sshKeys = { resolve: jest.fn(async (ssh: unknown) => ({ credentials: ssh })) };
    const service = new RemoteOperationsService(
      storage as never,
      runner as never,
      {} as never,
      {} as never,
      { isSupported: jest.fn(() => true), getSupportedProviders: jest.fn(() => []) } as never,
      installOperation as never,
      sshKeys as never,
    );
    return { service, runner, storage, installOperation, sshKeys };
  }

  function installBody(overrides: Record<string, unknown> = {}) {
    return InstallHostSchema.parse({
      address: '192.168.1.20',
      ssh: { user: 'vm-admin', password: 'ssh-secret' },
      providerAuth: {},
      minDiskGib: 8,
      ...overrides,
    });
  }

  it('refuses this PC user name before any connection or row is created', async () => {
    setMockIdentity('first.last', '/home/first.last');
    const { service, runner, storage, sshKeys } = makeService();

    await expect(service.installHost(installBody())).rejects.toMatchObject({
      statusCode: 400,
      message:
        'This PC\'s user name "first.last" cannot claim a VM: it must start with a lowercase letter or underscore and use lowercase letters, digits, - or _, with at most 32 characters.',
      details: { reason: 'claim_user_name_invalid' },
    });
    expect(sshKeys.resolve).not.toHaveBeenCalled();
    expect(storage.createRemote).not.toHaveBeenCalled();
    expect(runner.start).not.toHaveBeenCalled();
  });

  it('refuses to retry a claim-capable operation persisted with another identity', async () => {
    setMockIdentity('devchain', '/home/devchain');
    const persisted = {
      id: 'operation-1',
      kind: 'claim',
      state: 'failed',
      details: { userName: 'alice', homePath: '/Users/alice' },
    };
    const storage = { getRemoteOperation: jest.fn().mockResolvedValue(persisted) };
    const runner = { retry: jest.fn() };
    const service = new RemoteOperationsService(
      storage as never,
      runner as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(service.retry('operation-1')).rejects.toMatchObject({
      statusCode: 400,
      details: { reason: 'claim_identity_mismatch' },
    });
    expect(runner.retry).not.toHaveBeenCalled();
  });

  it('starts the install with a valid default account', async () => {
    setMockIdentity('devchain', '/home/devchain');
    const { service, runner } = makeService();

    const operation = await service.installHost(installBody());

    expect(runner.start).toHaveBeenCalledTimes(1);
    expect(operation.details).toMatchObject({
      userName: 'devchain',
      homePath: '/home/devchain',
    });
  });
});

// Unit layer checks record selection/merging without reading unchanged credentials.
describe('RemoteOperationsService updateLogins', () => {
  it.each(['install_host', 'update_logins'] as const)(
    'prefills from %s and preserves all unchanged entry IDs',
    async (kind) => {
      const previous = operation({
        kind,
        state: 'done',
        details: {
          userName: 'devchain',
          homePath: '/home/devchain',
          port: 3000,
          providerAuth: {
            claude: { choice: 'reuse', entryId: 'old', checkedOut: ['stale'] },
            opencode: { choice: 'generate', entryIds: ['oc1', 'oc2'], checkedOut: ['stale'] },
          },
        },
      });
      const storage = {
        getRemote: jest.fn().mockResolvedValue({ id: 'remote-1', baseUrl: 'https://host:3000' }),
        listRemoteOperations: jest
          .fn()
          .mockImplementation(async (filter) => (filter.states.includes('done') ? [previous] : [])),
      };
      const vault = {
        get: jest.fn().mockResolvedValue({ provider: 'claude' }),
        familiesOfRemote: jest.fn().mockResolvedValue([{ provider: 'opencode', entryId: 'oc2' }]),
      };
      const runner = { start: jest.fn().mockImplementation(async (input) => input) };
      const service = new RemoteOperationsService(
        storage as never,
        runner as never,
        {} as never,
        vault as never,
        { isSupported: () => true } as never,
        {} as never,
        {} as never,
        {} as never,
      );
      const result = await service.updateLogins('remote-1', {
        providerAuth: { claude: 'reuse:new' },
        force: false,
      });
      expect(storage.listRemoteOperations).toHaveBeenCalledWith(
        expect.objectContaining({
          kinds: ['claim', 'create_vm', 'reset_vm', 'install_host', 'update_logins'],
          states: ['done'],
        }),
      );
      expect(result.details).toMatchObject({
        claimed: true,
        changedProviders: ['claude'],
        reauth: ['claude'],
        providerAuth: {
          claude: { choice: 'reuse', entryId: 'new', checkedOut: [] },
          opencode: { choice: 'generate', entryIds: ['oc1', 'oc2'], checkedOut: ['oc2'] },
        },
      });
      expect(vault.get).toHaveBeenCalledTimes(1);
      expect(vault.get).toHaveBeenCalledWith('new');
    },
  );
  it('marks replacement choices for an update-logins retry without clearing applyStarted', async () => {
    const current = operation({
      kind: 'update_logins',
      state: 'failed',
      details: {
        applyStarted: true,
        reauth: ['codex'],
        providerAuth: { codex: { choice: 'reuse', entryId: 'old', checkedOut: ['old'] } },
      },
    });
    const storage = {
      getRemoteOperation: jest.fn().mockResolvedValue(current),
      updateRemoteOperation: jest.fn(),
    };
    const runner = { retry: jest.fn() };
    const service = new RemoteOperationsService(
      storage as never,
      runner as never,
      {} as never,
      { get: jest.fn().mockResolvedValue({ provider: 'codex' }) } as never,
      { isSupported: () => true } as never,
      {} as never,
      {} as never,
      {} as never,
    );
    await service.retry(current.id, { codex: 'reuse:new' });
    expect(storage.updateRemoteOperation).toHaveBeenCalledWith(current.id, {
      expectedState: 'failed',
      details: expect.objectContaining({
        applyStarted: true,
        choicesReplaced: true,
        providerAuth: { codex: { choice: 'reuse', entryId: 'new', checkedOut: ['old'] } },
      }),
    });
    expect(runner.retry).toHaveBeenCalledWith(current.id);
  });
});

// Layer: unit. The service owns the input-to-persisted-details contract for own-VM claims.
it('persists public keys when claiming an own VM', async () => {
  const key = utils.generateKeyPairSync('ed25519').public;
  const remoteId = '2bad6067-3d63-4c92-b14a-5d1f04fa2bfd';
  const storage = {
    getRemote: jest.fn(async () => ({ id: remoteId, baseUrl: 'https://vm:3000' })),
    listRemoteOperations: jest.fn(async () => []),
  };
  const runner = { start: jest.fn(async (request) => request) };
  const service = new RemoteOperationsService(
    storage as never,
    runner as never,
    {} as never,
    {} as never,
    {} as never,
  );
  await service.claim(ClaimRemoteSchema.parse({ remoteId, port: 3000, sshPublicKeys: [key] }));
  expect(runner.start).toHaveBeenCalledWith(
    expect.objectContaining({ details: expect.objectContaining({ sshPublicKeys: [key] }) }),
  );
});

// Layer: unit. Claim by address trusts only the pasted fingerprint: the certificate is
// approved before any row, operation or claim exists, and the approved one travels on.
describe('RemoteOperationsService.claim by address', () => {
  const fingerprint = 'AB'.repeat(32);
  const approved = '-----BEGIN CERTIFICATE-----\napproved\n-----END CERTIFICATE-----\n';

  function makeService(existing: Record<string, unknown> | null = null) {
    const calls: string[] = [];
    const storage = {
      listRemotes: jest.fn(async () => ({ items: existing ? [existing] : [] })),
      listRemoteOperations: jest.fn(async () => []),
      createRemote: jest.fn(async (data: Record<string, unknown>) => {
        calls.push('create');
        return { id: 'remote-new', ...data };
      }),
      updateRemoteTlsCertificate: jest.fn(async (id: string, tlsCertificate: string) => {
        calls.push('update');
        return { ...existing, id, tlsCertificate };
      }),
    };
    const remotes = {
      approveCertificate: jest.fn(async () => {
        calls.push('approve');
        return approved;
      }),
    };
    const runner = {
      start: jest.fn(async (request: Record<string, unknown>) => {
        calls.push('start');
        return request;
      }),
    };
    const service = new RemoteOperationsService(
      storage as never,
      runner as never,
      remotes as never,
      {} as never,
      {} as never,
    );
    return { service, storage, remotes, runner, calls };
  }

  const body = (overrides: Record<string, unknown> = {}) =>
    ClaimRemoteSchema.parse({
      baseUrl: 'https://192.168.1.20:3000',
      certificateFingerprint: fingerprint.toLowerCase().match(/../g)!.join(':'),
      port: 3001,
      providerAuth: {},
      ...overrides,
    });

  it('approves the bootstrap certificate first, stores it on the new row and in the details', async () => {
    const { service, storage, remotes, runner, calls } = makeService();

    await service.claim(body());

    expect(calls).toEqual(['approve', 'create', 'start']);
    expect(remotes.approveCertificate).toHaveBeenCalledWith(
      'https://192.168.1.20:3000',
      fingerprint,
    );
    expect(storage.createRemote).toHaveBeenCalledWith({
      name: '192.168.1.20',
      baseUrl: 'https://192.168.1.20:3001',
      kind: 'address',
      tlsCertificate: approved,
    });
    expect(runner.start).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'claim',
        remoteId: 'remote-new',
        details: expect.objectContaining({
          bootstrapUrl: 'https://192.168.1.20:3000',
          tlsCertificate: approved,
        }),
      }),
    );
  });

  it('saves nothing and starts nothing when the fingerprint does not match', async () => {
    const { service, storage, remotes, runner } = makeService();
    remotes.approveCertificate.mockRejectedValue(
      new ConflictError('The fingerprint does not match the certificate that this address shows.'),
    );

    await expect(service.claim(body())).rejects.toThrow('The fingerprint does not match');
    expect(storage.createRemote).not.toHaveBeenCalled();
    expect(storage.updateRemoteTlsCertificate).not.toHaveBeenCalled();
    expect(runner.start).not.toHaveBeenCalled();
  });

  it('replaces the certificate of an existing row at the address with the approved one', async () => {
    const existing = {
      id: 'remote-old',
      name: 'vm',
      baseUrl: 'https://192.168.1.20:3001',
      tlsCertificate: 'stale',
    };
    const { service, storage, runner, calls } = makeService(existing);

    await service.claim(body());

    expect(calls).toEqual(['approve', 'update', 'start']);
    expect(storage.updateRemoteTlsCertificate).toHaveBeenCalledWith('remote-old', approved);
    expect(runner.start).toHaveBeenCalledWith(
      expect.objectContaining({
        remoteId: 'remote-old',
        details: expect.objectContaining({ tlsCertificate: approved }),
      }),
    );
  });

  it('keeps the certificate of an existing row while another setup of it is open', async () => {
    const existing = {
      id: 'remote-old',
      name: 'vm',
      baseUrl: 'https://192.168.1.20:3001',
      tlsCertificate: 'stale',
    };
    const { service, storage, runner } = makeService(existing);
    storage.listRemoteOperations.mockResolvedValue([
      { id: 'op-1', kind: 'claim', state: 'running', remoteId: 'remote-old', steps: [] },
    ] as never);

    await expect(service.claim(body())).rejects.toThrow('already open');
    expect(storage.updateRemoteTlsCertificate).not.toHaveBeenCalled();
    expect(runner.start).not.toHaveBeenCalled();
  });

  it('requires a fingerprint with an address, and refuses one with a registered remote', () => {
    expect(() => body({ certificateFingerprint: undefined })).toThrow(
      'Enter the SHA-256 fingerprint of the VM certificate',
    );
    expect(() => body({ certificateFingerprint: 'AB:CD' })).toThrow(
      'Enter the SHA-256 fingerprint of the VM certificate',
    );
    expect(() =>
      ClaimRemoteSchema.parse({
        remoteId: '2bad6067-3d63-4c92-b14a-5d1f04fa2bfd',
        certificateFingerprint: fingerprint,
        providerAuth: {},
      }),
    ).toThrow('give certificateFingerprint only with baseUrl');
  });
});
