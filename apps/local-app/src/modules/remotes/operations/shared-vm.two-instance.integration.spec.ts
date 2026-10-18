import {
  startTwoInstances,
  waitForValue,
  type TwoInstances,
  type TestInstance,
} from '../../../common/test/two-instance.fixture';
import { SharedVmFixture } from '../../../common/test/shared-vm.fixture';
import { HostInstallService } from '../host-install/host-install.service';
import { SshRunner } from '../host-install/ssh-runner';
import type { RemoteOperation } from '../../storage/models/domain.models';

jest.mock('node:os', () => {
  const actual = jest.requireActual('node:os');
  let identity: { user: string; home: string } | null = null;
  return {
    ...actual,
    setFixtureIdentity: (value: typeof identity) => {
      identity = value;
    },
    homedir: () => identity?.home ?? actual.homedir(),
    userInfo: () =>
      identity ? { ...actual.userInfo(), username: identity.user } : actual.userInfo(),
  };
});
jest.mock('../../../common/app-version', () => {
  let version = '0.25.0';
  return {
    getAppVersion: () => version,
    setFixtureVersion: (value: string) => {
      version = value;
    },
  };
});
const mockOs = jest.requireMock('node:os') as {
  setFixtureIdentity: (identity: { user: string; home: string } | null) => void;
};
const mockAppVersion = jest.requireMock('../../../common/app-version') as {
  setFixtureVersion: (version: string) => void;
};

// Full home apps and real VM registry/claim/update code cross HTTP, storage and
// helper boundaries; KVM separately proves the privileged OS commands.
describe('two homes joining a shared VM', () => {
  let homes: TwoInstances;
  let vm: SharedVmFixture;

  beforeAll(async () => {
    vm = new SharedVmFixture();
    await vm.start();
    homes = await startTwoInstances({
      configureModule: (builder) =>
        builder
          .overrideProvider(SshRunner)
          .useValue(vm.ssh)
          .overrideProvider(HostInstallService)
          .useValue({ renderJoin: vm.renderJoin }),
    });
  });
  afterAll(async () => {
    mockOs.setFixtureIdentity(null);
    await homes?.close();
    await vm?.close();
  });

  async function api<T>(
    home: TestInstance,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: T }> {
    const result = await home.app.inject({
      method: method as 'POST' | 'GET',
      url: path,
      ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}),
    });
    return { status: result.statusCode, body: result.json() as T };
  }
  async function settle(home: TestInstance, id: string): Promise<RemoteOperation> {
    return waitForValue(async () => {
      const result = await api<RemoteOperation>(home, 'GET', `/api/remotes/operations/${id}`);
      return result.body.state === 'running' ? null : result.body;
    }, 15_000);
  }
  async function joinVm(home: TestInstance, user: string, name = user): Promise<RemoteOperation> {
    mockOs.setFixtureIdentity({ user, home: vm.homePath(user) });
    const started = await api<RemoteOperation>(home, 'POST', '/api/remotes/host-install', {
      name,
      address: 'https://127.0.0.1',
      ssh: { user: 'admin', password: 'fixture-ssh' },
      providerAuth: {},
      minDiskGib: 8,
    });
    expect(started.status).toBe(202);
    return settle(home, started.body.id);
  }

  it('joins two users on separate ports, refuses a duplicate, and keeps a sibling unchanged in both update directions', async () => {
    const bob = await joinVm(homes.home, 'bob');
    expect(bob.state).toBe('done');
    const carol = await joinVm(homes.host, 'carol');
    expect(carol.state).toBe('done');
    const remoteBob = await homes.home.storage.getRemote(bob.remoteId);
    const remoteCarol = await homes.host.storage.getRemote(carol.remoteId);
    expect(remoteBob.kind).toBe('address');
    expect(remoteCarol.kind).toBe('address');
    expect(new URL(remoteBob.baseUrl!).port).toBe(String(bob.details.port));
    expect(new URL(remoteCarol.baseUrl!).port).toBe(String(carol.details.port));
    expect(bob.details.port).not.toBe(carol.details.port);
    expect(bob.details.port).not.toBe(3000);
    const duplicate = await joinVm(homes.home, 'bob', 'duplicate-bob');
    expect(duplicate.state).toBe('failed');
    expect(duplicate.steps.find((step) => step.id === 'check')?.error).toMatchObject({
      code: 'INSTANCE_EXISTS',
      message: expect.stringContaining('bob'),
    });

    // Both PCs have the next build; each VM still changes only when its owner updates it.
    mockAppVersion.setFixtureVersion('0.25.1');
    const bobInitial = vm.instanceSnapshot('bob');
    const carolBefore = vm.instanceSnapshot('carol');
    const updatingBob = await api<RemoteOperation>(
      homes.home,
      'POST',
      `/api/remotes/${bob.remoteId}/update`,
      {},
    );
    expect(updatingBob.status).toBe(202);
    expect((await settle(homes.home, updatingBob.body.id)).state).toBe('done');
    expect(vm.instanceSnapshot('bob').pid).not.toBe(bobInitial.pid);
    expect(vm.instanceSnapshot('bob').claim?.version).toBe('0.25.1');
    expect(vm.instanceSnapshot('carol')).toEqual(carolBefore);

    const bobBefore = vm.instanceSnapshot('bob');
    const updatingCarol = await api<RemoteOperation>(
      homes.host,
      'POST',
      `/api/remotes/${carol.remoteId}/update`,
      {},
    );
    expect(updatingCarol.status).toBe(202);
    expect((await settle(homes.host, updatingCarol.body.id)).state).toBe('done');
    expect(vm.instanceSnapshot('carol').pid).not.toBe(carolBefore.pid);
    expect(vm.instanceSnapshot('carol').claim?.version).toBe('0.25.1');
    expect(vm.instanceSnapshot('bob')).toEqual(bobBefore);
  });
});
