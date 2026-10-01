import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DockerRuntime } from '../../core/controllers/docker-runtime';
import { readDockerRuntime } from '../../core/controllers/docker-runtime';
import { FileSyncService } from '../../file-sync/file-sync.service';
import {
  DEFAULT_SYNCTHING_MANAGER_TIMINGS,
  SyncthingManager,
} from '../../file-sync/syncthing-manager.service';
import {
  findSyncthingBinary,
  SYNCTHING_INSTALL_GUIDANCE,
} from '../../file-sync/syncthing-launcher';
import { FakeSyncthingLauncher } from '../../file-sync/testing/fake-syncthing-launcher';
import type { FileSyncHandoff } from '../operations/file-sync-handoff';
import type { HostRuntime, RemoteHostClient } from '../operations/remote-host.client';
import { BASE_URL_MESSAGE } from '../dtos/remote.dto';
import { RemoteProbeService } from './remote-probe.service';

const mockIdentity = { user: 'alice', home: '/home/alice' };
jest.mock('node:os', () => {
  const actual = jest.requireActual('node:os');
  return {
    ...actual,
    userInfo: () => ({ username: mockIdentity.user }),
    homedir: () => mockIdentity.home,
  };
});

jest.mock('../../core/controllers/docker-runtime', () => ({
  ...jest.requireActual('../../core/controllers/docker-runtime'),
  readDockerRuntime: jest.fn(),
}));

jest.mock('../../../common/logging/logger', () => ({
  createLogger: () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }),
}));

const USABLE_DOCKER: DockerRuntime = {
  installed: true,
  engineVersion: '27.0.0',
  composeVersion: '2.29.0',
  userInGroup: true,
  dataRootFreeBytes: null,
};

function service(
  overrides: {
    fileSync?: Partial<FileSyncHandoff>;
    syncthing?: Partial<SyncthingManager>;
    hostClient?: Partial<RemoteHostClient>;
    installerPort?: number;
  } = {},
) {
  return new RemoteProbeService(
    { listRemotes: jest.fn().mockResolvedValue({ items: [] }) } as never,
    (overrides.hostClient ?? {}) as RemoteHostClient,
    (overrides.fileSync ?? {
      ensureAvailable: jest.fn().mockResolvedValue(undefined),
    }) as FileSyncHandoff,
    (overrides.syncthing ?? {
      getState: () => ({
        available: true,
        version: 'v2.1.5',
        running: true,
        deviceId: 'D',
        apiPort: 1,
        error: null,
      }),
    }) as SyncthingManager,
    { installerPort: overrides.installerPort ?? 3000, sshPort: 22, sshTimeoutMs: 2_000 },
  );
}

// Service unit: readiness only aggregates three local checks, and the probe's
// parallelism is observable at the host-client boundary.
describe('RemoteProbeService.readiness', () => {
  beforeEach(() => {
    mockIdentity.user = 'alice';
    mockIdentity.home = '/home/alice';
    jest.mocked(readDockerRuntime).mockResolvedValue(USABLE_DOCKER);
  });

  it('reports a running Syncthing with its version, a claimable identity and usable Docker', async () => {
    const ensureAvailable = jest.fn().mockResolvedValue(undefined);
    await expect(service({ fileSync: { ensureAvailable } }).readiness()).resolves.toEqual({
      syncthing: { ok: true, version: 'v2.1.5', message: null },
      identity: { ok: true, user: 'alice', homePath: '/home/alice', message: null },
      docker: { ok: true, message: null },
    });
    // The same recovery Connect uses: an installed Syncthing that is not running starts.
    expect(ensureAvailable).toHaveBeenCalledTimes(1);
  });

  it('reports a missing Syncthing with the install guidance', async () => {
    const root = mkdtempSync(join(tmpdir(), 'devchain-readiness-'));
    try {
      const launcher = new FakeSyncthingLauncher();
      launcher.lookup = await findSyncthingBinary({
        explicitPath: undefined,
        pathEnv: '',
        homeDir: root,
        platform: 'linux',
        isExecutable: async () => false,
        readVersionOutput: async () => '',
      });
      const manager = new SyncthingManager(
        {} as never,
        launcher,
        {} as never,
        DEFAULT_SYNCTHING_MANAGER_TIMINGS,
      );
      const fileSync = new FileSyncService(manager, {} as never, {} as never, {} as never);
      const probe = service({
        fileSync: { ensureAvailable: () => fileSync.ensureAvailable() },
        syncthing: manager,
      });

      const { syncthing } = await probe.readiness();

      expect(syncthing.ok).toBe(false);
      expect(syncthing.version).toBeNull();
      expect(syncthing.message).toContain('Syncthing was not found on PATH or in ~/.devchain/bin.');
      expect(syncthing.message).toContain(SYNCTHING_INSTALL_GUIDANCE);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('names the broken claim rule for an identity the claim would refuse', async () => {
    mockIdentity.home = '/opt/alice';
    const { identity } = await service().readiness();
    expect(identity).toMatchObject({ ok: false, user: 'alice', homePath: '/opt/alice' });
    expect(identity.message).toMatch(
      /home folder "\/opt\/alice" cannot claim a VM: it must be under/,
    );
  });

  it.each([
    [
      { ...USABLE_DOCKER, installed: false, engineVersion: null },
      'Docker Engine is not installed on this PC.',
    ],
    [
      { ...USABLE_DOCKER, installed: false, composeVersion: null },
      'Docker Compose is not installed on this PC.',
    ],
    [{ ...USABLE_DOCKER, installed: false, userInGroup: false }, /docker group/],
    [{ ...USABLE_DOCKER, installed: false }, /Start the Docker service/],
  ])('says why Docker is not usable (%#)', async (docker, message) => {
    jest.mocked(readDockerRuntime).mockResolvedValue(docker);
    const result = await service().readiness();
    expect(result.docker.ok).toBe(false);
    expect(result.docker.message).toMatch(message);
  });
});

describe('RemoteProbeService.probe', () => {
  it('starts every HTTPS probe before any answers', async () => {
    const releases: Array<() => void> = [];
    const discoverRuntime = jest.fn(
      (_origin: string) =>
        new Promise<{ runtime: HostRuntime | null; certificate: string }>((_resolve, reject) => {
          releases.push(() => reject(new Error('refused')));
        }),
    );
    // An installer port other than this PC's port makes two probes.
    const probe = service({ hostClient: { discoverRuntime }, installerPort: 65_000 }).probe({
      address: '192.0.2.1',
      checkSsh: false,
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(discoverRuntime).toHaveBeenCalledTimes(2);
    expect(discoverRuntime.mock.calls.map(([url]) => url)).toContain('https://192.0.2.1:65000');
    releases.forEach((release) => release());
    await expect(probe).resolves.toMatchObject({ kind: 'nothing', sshReachable: null });
  });

  it('reads an installer from the discovered runtime', async () => {
    const discoverRuntime = jest.fn(async (origin: string) => ({
      runtime: origin.endsWith(':65000') ? { state: 'unclaimed', imageVersion: null } : null,
      certificate: 'certificate',
    }));
    await expect(
      service({ hostClient: { discoverRuntime }, installerPort: 65_000 }).probe({
        address: '192.0.2.1',
        checkSsh: false,
      }),
    ).resolves.toMatchObject({
      kind: 'installer',
      bootstrapUrl: 'https://192.0.2.1:65000',
      state: 'unclaimed',
    });
  });

  it('refuses a plain http address before probing', async () => {
    const discoverRuntime = jest.fn();
    await expect(
      service({ hostClient: { discoverRuntime } }).probe({
        address: 'http://192.0.2.1:3000',
        checkSsh: false,
      }),
    ).rejects.toMatchObject({ message: BASE_URL_MESSAGE });
    expect(discoverRuntime).not.toHaveBeenCalled();
  });
});
