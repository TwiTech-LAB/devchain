import Dockerode = require('dockerode');
import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { mkdtemp, mkdir, rm } from 'fs/promises';
import { Readable } from 'stream';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import { OrchestratorDockerService } from './docker.service';
import { WorktreeMountDiscoveryService, MountPlan } from './worktree-mount-discovery.service';

jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  execFileSync: jest.fn(() => {
    throw new Error('no git config');
  }),
}));

const mockExecFileSync = execFileSync as jest.MockedFunction<typeof execFileSync>;

// Mirror docker.service.ts's module-load socket resolution so bind snapshots
// use the same path the production code selected (the first existing candidate).
const DOCKER_SOCKET_PATH_IN_SPEC = (() => {
  const candidates = [
    '/var/run/docker.sock',
    join(homedir(), '.docker', 'run', 'docker.sock'),
    join(homedir(), '.colima', 'default', 'docker.sock'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return candidates[0];
})();

function encodeDockerFrame(payload: string, streamType = 1): Buffer {
  const payloadBuffer = Buffer.from(payload, 'utf8');
  const header = Buffer.alloc(8);
  header.writeUInt8(streamType, 0);
  header.writeUInt32BE(payloadBuffer.length, 4);
  return Buffer.concat([header, payloadBuffer]);
}

describe('OrchestratorDockerService', () => {
  const originalHome = process.env.HOME;
  const originalFetch = global.fetch;
  const originalOrchestratorContainerImage = process.env.ORCHESTRATOR_CONTAINER_IMAGE;
  const originalDevchainMode = process.env.DEVCHAIN_MODE;

  let tempHome: string;
  let dockerMock: {
    createContainer: jest.Mock;
    createNetwork: jest.Mock;
    getContainer: jest.Mock;
    getNetwork: jest.Mock;
    listContainers: jest.Mock;
    listNetworks: jest.Mock;
    getImage: jest.Mock;
    pull: jest.Mock;
    ping: jest.Mock;
    modem: { followProgress: jest.Mock };
  };

  beforeEach(async () => {
    mockExecFileSync.mockReset().mockImplementation(() => {
      throw new Error('no git config');
    });
    tempHome = await mkdtemp(join(tmpdir(), 'orchestrator-docker-home-'));
    process.env.HOME = tempHome;
    process.env.ORCHESTRATOR_CONTAINER_IMAGE = 'ghcr.io/twitech-lab/devchain:test';
    delete process.env.DEVCHAIN_MODE;

    dockerMock = {
      createContainer: jest.fn(),
      createNetwork: jest.fn().mockResolvedValue({ id: 'network-1' }),
      getContainer: jest.fn(),
      getNetwork: jest.fn(() => ({
        inspect: jest.fn().mockRejectedValue(new Error('missing')),
        remove: jest.fn().mockResolvedValue(undefined),
      })),
      listContainers: jest.fn().mockResolvedValue([]),
      listNetworks: jest.fn().mockResolvedValue([]),
      getImage: jest.fn().mockReturnValue({
        inspect: jest.fn().mockResolvedValue({}),
      }),
      pull: jest.fn(),
      ping: jest.fn().mockResolvedValue(undefined),
      modem: {
        followProgress: jest.fn((_stream: unknown, done: (error?: unknown) => void) => done()),
      },
    };
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    if (originalOrchestratorContainerImage === undefined) {
      delete process.env.ORCHESTRATOR_CONTAINER_IMAGE;
    } else {
      process.env.ORCHESTRATOR_CONTAINER_IMAGE = originalOrchestratorContainerImage;
    }
    if (originalDevchainMode === undefined) {
      delete process.env.DEVCHAIN_MODE;
    } else {
      process.env.DEVCHAIN_MODE = originalDevchainMode;
    }
    global.fetch = originalFetch;
    jest.restoreAllMocks();
    await rm(tempHome, { recursive: true, force: true });
  });

  // Discovery is extracted to WorktreeMountDiscoveryService (see its dedicated spec).
  // These tests mock the MountPlan and verify OrchestratorDockerService CONSUMES it
  // correctly — discovery behavior itself is characterized in
  // worktree-mount-discovery.service.spec.ts.
  const EMPTY_PLAN: MountPlan = { env: {}, credentialBinds: [], infrastructureBinds: [] };

  const makeService = (plan: MountPlan = EMPTY_PLAN) => {
    const mountDiscovery = {
      discoverMountPlan: jest.fn().mockResolvedValue(plan),
    } as unknown as WorktreeMountDiscoveryService;
    const service = new OrchestratorDockerService(
      mountDiscovery,
      dockerMock as unknown as Dockerode,
    );
    return { service, mountDiscovery };
  };

  it('creates container with required binds, env, labels, and capabilities', async () => {
    const worktreePath = join(tempHome, 'worktree');
    const dataPath = join(tempHome, 'data');
    await mkdir(worktreePath, { recursive: true });
    await mkdir(dataPath, { recursive: true });

    const claudeBind = `${join(tempHome, '.claude', '.credentials.json')}:/home/node/.claude/.credentials.json:ro`;
    const codexBind = `${join(tempHome, '.codex', 'auth.json')}:/home/node/.codex/auth.json:ro`;
    const skillsBind = `${join(tempHome, '.devchain', 'skills')}:/seed-skills:ro`;
    const plan: MountPlan = {
      env: { ENABLED_PROVIDERS: 'claude,codex' },
      credentialBinds: [claudeBind, codexBind],
      infrastructureBinds: [skillsBind],
    };

    dockerMock.createContainer.mockResolvedValue({
      id: 'container-123',
      start: jest.fn().mockResolvedValue(undefined),
      inspect: jest.fn().mockResolvedValue({
        Name: '/devchain-wt-feature-auth',
        State: { Status: 'running' },
        NetworkSettings: {
          Ports: {
            '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: '49155' }],
          },
        },
      }),
    });

    const { service, mountDiscovery } = makeService(plan);
    const info = await service.createContainer({
      name: 'devchain-wt-feature-auth',
      worktreePath,
      dataPath,
      env: { CUSTOM_ENV: '1' },
    });

    expect(info).toEqual({
      id: 'container-123',
      name: 'devchain-wt-feature-auth',
      image: 'ghcr.io/twitech-lab/devchain:test',
      hostPort: 49155,
      state: 'running',
    });
    expect(mountDiscovery.discoverMountPlan).toHaveBeenCalledWith({
      worktreePath,
      worktreeName: 'feature-auth',
    });
    expect(dockerMock.getImage).toHaveBeenCalledWith('ghcr.io/twitech-lab/devchain:test');
    expect(dockerMock.pull).not.toHaveBeenCalled();

    const createInput = dockerMock.createContainer.mock.calls[0][0];
    expect(createInput.HostConfig.CapAdd).toEqual(['SYS_PTRACE']);
    expect(createInput.HostConfig.NetworkMode).toBe('devchain-wt-feature-auth-net');
    expect(createInput.HostConfig.PortBindings['3000/tcp'][0]).toEqual({
      HostIp: '127.0.0.1',
      HostPort: '',
    });

    expect(createInput.Env).toEqual(
      expect.arrayContaining([
        'HOST=0.0.0.0',
        'NODE_ENV=production',
        'CUSTOM_ENV=1',
        'COMPOSE_PROJECT_NAME=feature-auth',
        'ENABLED_PROVIDERS=claude,codex',
      ]),
    );

    expect(createInput.Labels).toEqual({
      'devchain.worktree': 'feature-auth',
    });

    expect(createInput.HostConfig.Binds).toEqual(
      expect.arrayContaining([
        `${worktreePath}:/project:rw`,
        `${dataPath}:/home/node/.devchain:rw`,
        claudeBind,
        codexBind,
        skillsBind,
        `${DOCKER_SOCKET_PATH_IN_SPEC}:/var/run/docker.sock:rw`,
      ]),
    );

    expect(dockerMock.createNetwork).toHaveBeenCalledWith({
      Name: 'devchain-wt-feature-auth-net',
      CheckDuplicate: true,
      Labels: {
        'devchain.worktree': 'feature-auth',
        'devchain.managed': 'true',
      },
    });
  });

  it('throws a clear error when ORCHESTRATOR_CONTAINER_IMAGE is missing in container mode', async () => {
    delete process.env.ORCHESTRATOR_CONTAINER_IMAGE;
    process.env.DEVCHAIN_MODE = 'main';

    const { service } = makeService();

    await expect(
      service.createContainer({
        name: 'devchain-wt-feature-auth',
        worktreePath: '/tmp/worktree',
        dataPath: '/tmp/data',
      }),
    ).rejects.toThrow(
      'ORCHESTRATOR_CONTAINER_IMAGE is required in container mode. Set it to a versioned GHCR image reference.',
    );

    expect(dockerMock.createContainer).not.toHaveBeenCalled();
    expect(dockerMock.createNetwork).not.toHaveBeenCalled();
  });

  it('preserves explicit COMPOSE_PROJECT_NAME and reuses existing network', async () => {
    dockerMock.getNetwork.mockReturnValue({
      inspect: jest.fn().mockResolvedValue({ Name: 'devchain-wt-existing-net' }),
      remove: jest.fn().mockResolvedValue(undefined),
    });

    const worktreePath = join(tempHome, 'worktree');
    const dataPath = join(tempHome, 'data');
    await mkdir(worktreePath, { recursive: true });
    await mkdir(dataPath, { recursive: true });

    dockerMock.createContainer.mockResolvedValue({
      id: 'container-123',
      start: jest.fn().mockResolvedValue(undefined),
      inspect: jest.fn().mockResolvedValue({
        Name: '/devchain-wt-existing',
        State: { Status: 'running' },
        NetworkSettings: {
          Ports: {
            '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: '49158' }],
          },
        },
      }),
    });

    const { service } = makeService();
    await service.createContainer({
      name: 'devchain-wt-existing',
      worktreePath,
      dataPath,
      env: { COMPOSE_PROJECT_NAME: 'custom-project' },
    });

    const createInput = dockerMock.createContainer.mock.calls[0][0];
    expect(createInput.HostConfig.NetworkMode).toBe('devchain-wt-existing-net');
    expect(createInput.Env).toContain('COMPOSE_PROJECT_NAME=custom-project');
    expect(dockerMock.createNetwork).not.toHaveBeenCalled();
  });

  it('connects worktree container to compose default network when available', async () => {
    const connect = jest.fn().mockResolvedValue(undefined);
    dockerMock.getNetwork.mockImplementation((nameOrId: string) => {
      if (nameOrId === 'feature-auth_default') {
        return {
          inspect: jest.fn().mockResolvedValue({
            Name: 'feature-auth_default',
            Containers: {},
          }),
          connect,
          remove: jest.fn().mockResolvedValue(undefined),
        } as unknown as Dockerode.Network;
      }
      return {
        inspect: jest.fn().mockRejectedValue({ statusCode: 404, message: 'No such network' }),
        remove: jest.fn().mockResolvedValue(undefined),
      } as unknown as Dockerode.Network;
    });

    const { service } = makeService();
    await service.ensureWorktreeOnComposeNetwork('feature-auth', 'worktree-1');

    expect(connect).toHaveBeenCalledWith({ Container: 'worktree-1' });
  });

  it('cleans compose-labeled containers and networks during project cleanup', async () => {
    const worktreeExec = {
      start: jest.fn().mockRejectedValue(new Error('docker cli unavailable')),
      inspect: jest.fn(),
    };
    const worktreeContainer = {
      exec: jest.fn().mockResolvedValue(worktreeExec),
      stop: jest.fn().mockResolvedValue(undefined),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    const projectContainer = {
      stop: jest.fn().mockResolvedValue(undefined),
      remove: jest.fn().mockResolvedValue(undefined),
    };

    const composeNetworkRemove = jest.fn().mockResolvedValue(undefined);

    dockerMock.getContainer.mockImplementation((id: string) => {
      if (id === 'worktree-1') {
        return worktreeContainer as unknown as Dockerode.Container;
      }
      if (id === 'project-compose-1') {
        return projectContainer as unknown as Dockerode.Container;
      }
      return {
        stop: jest.fn().mockResolvedValue(undefined),
        remove: jest.fn().mockResolvedValue(undefined),
      } as unknown as Dockerode.Container;
    });

    dockerMock.listContainers.mockResolvedValue([
      {
        Id: 'project-compose-1',
        Names: ['/feature-auth-db-1'],
      },
    ] as unknown as Dockerode.ContainerInfo[]);
    dockerMock.listNetworks.mockResolvedValue([
      {
        Id: 'compose-network-1',
        Name: 'feature-auth_default',
      },
    ] as unknown as Dockerode.NetworkInspectInfo[]);

    dockerMock.getNetwork.mockImplementation((nameOrId: string) => {
      if (nameOrId === 'compose-network-1') {
        return {
          inspect: jest.fn(),
          remove: composeNetworkRemove,
        } as unknown as Dockerode.Network;
      }
      return {
        inspect: jest.fn().mockResolvedValue({
          Name: 'devchain-wt-feature-auth-net',
          Containers: {},
        }),
        remove: jest.fn().mockResolvedValue(undefined),
      } as unknown as Dockerode.Network;
    });

    const { service } = makeService();
    await service.cleanupWorktreeProjectContainers('feature-auth', 'worktree-1');

    expect(dockerMock.listContainers).toHaveBeenCalledWith({
      all: true,
      filters: {
        label: ['com.docker.compose.project=feature-auth'],
      },
    });
    expect(projectContainer.stop).toHaveBeenCalledTimes(1);
    expect(projectContainer.remove).toHaveBeenCalledWith({ force: true });
    expect(dockerMock.listNetworks).toHaveBeenCalledWith({
      filters: {
        label: ['com.docker.compose.project=feature-auth'],
      },
    });
    expect(composeNetworkRemove).toHaveBeenCalledTimes(1);
  });

  it('falls back to network-based cleanup when compose-down cannot execute', async () => {
    const worktreeExec = {
      start: jest.fn().mockRejectedValue(new Error('container not running')),
      inspect: jest.fn(),
    };
    const worktreeContainer = {
      exec: jest.fn().mockResolvedValue(worktreeExec),
      stop: jest.fn().mockResolvedValue(undefined),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    const projectContainer = {
      stop: jest.fn().mockResolvedValue(undefined),
      remove: jest.fn().mockResolvedValue(undefined),
    };

    dockerMock.getContainer.mockImplementation((id: string) => {
      if (id === 'worktree-1') {
        return worktreeContainer as unknown as Dockerode.Container;
      }
      if (id === 'project-1') {
        return projectContainer as unknown as Dockerode.Container;
      }
      return {
        stop: jest.fn().mockRejectedValue(new Error('missing')),
        remove: jest.fn().mockRejectedValue(new Error('missing')),
      } as unknown as Dockerode.Container;
    });

    dockerMock.getNetwork.mockReturnValue({
      inspect: jest.fn().mockResolvedValue({
        Name: 'devchain-wt-feature-auth-net',
        Containers: {
          'worktree-1': { Name: 'devchain-wt-feature-auth' },
          'project-1': { Name: 'feature-auth-db-1' },
        },
      }),
      remove: jest.fn().mockResolvedValue(undefined),
    });

    const { service } = makeService();
    await service.cleanupWorktreeProjectContainers('feature-auth', 'worktree-1');

    expect(worktreeContainer.exec).toHaveBeenCalledWith(
      expect.objectContaining({
        Cmd: ['docker', 'compose', '-p', 'feature-auth', 'down', '--remove-orphans'],
        WorkingDir: '/project',
      }),
    );
    expect(projectContainer.stop).toHaveBeenCalledTimes(1);
    expect(projectContainer.remove).toHaveBeenCalledWith({ force: true });
  });

  it('removes worktree docker network and ignores missing network errors', async () => {
    const remove = jest
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce({ statusCode: 404, message: 'No such network' })
      .mockRejectedValueOnce({ statusCode: 404, message: 'No such network' });
    dockerMock.getNetwork.mockReturnValue({
      inspect: jest.fn(),
      remove,
    });

    const { service } = makeService();
    await service.removeWorktreeNetwork('feature-auth');
    await service.removeWorktreeNetwork('feature-auth');

    expect(remove).toHaveBeenCalledTimes(4);
  });

  it('pulls image when it is not present locally', async () => {
    dockerMock.getImage.mockReturnValue({
      inspect: jest.fn().mockRejectedValue(new Error('missing')),
    });
    dockerMock.pull.mockResolvedValue({});

    dockerMock.createContainer.mockResolvedValue({
      id: 'container-123',
      start: jest.fn().mockResolvedValue(undefined),
      inspect: jest.fn().mockResolvedValue({
        Name: '/devchain-wt-test',
        State: { Status: 'running' },
        NetworkSettings: { Ports: { '3000/tcp': [{ HostPort: '49321' }] } },
      }),
    });

    const worktreePath = join(tempHome, 'worktree');
    const dataPath = join(tempHome, 'data');
    await mkdir(worktreePath, { recursive: true });
    await mkdir(dataPath, { recursive: true });

    const { service } = makeService();
    await service.createContainer({
      name: 'devchain-wt-test',
      image: 'custom:latest',
      worktreePath,
      dataPath,
    });

    expect(dockerMock.pull).toHaveBeenCalledWith('custom:latest');
    expect(dockerMock.modem.followProgress).toHaveBeenCalledTimes(1);
  });

  it('decodes multiplexed container logs', async () => {
    const logsBuffer = Buffer.concat([
      encodeDockerFrame('stdout-line\n'),
      encodeDockerFrame('stderr-line\n', 2),
    ]);
    dockerMock.getContainer.mockReturnValue({
      logs: jest.fn().mockResolvedValue(logsBuffer),
    });

    const { service } = makeService();
    const logs = await service.getContainerLogs('container-123');

    expect(logs).toBe('stdout-line\nstderr-line\n');
  });

  it('executes a command in the container and returns exit code + output', async () => {
    const stream = Readable.from([encodeDockerFrame('exec-output\n')]);
    const execMock = {
      start: jest.fn().mockResolvedValue(stream),
      inspect: jest.fn().mockResolvedValue({ ExitCode: 0 }),
    };
    dockerMock.getContainer.mockReturnValue({
      exec: jest.fn().mockResolvedValue(execMock),
    });

    const { service } = makeService();
    const result = await service.execInContainer('container-123', ['echo', 'ok']);

    expect(result).toEqual({ exitCode: 0, output: 'exec-output\n' });
  });

  it('polls /health/ready and returns true when container is ready', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ status: 200 });
    global.fetch = fetchMock as unknown as typeof fetch;

    dockerMock.getContainer.mockReturnValue({
      inspect: jest.fn().mockResolvedValue({
        NetworkSettings: { Ports: { '3000/tcp': [{ HostPort: '49777' }] } },
      }),
    });

    const { service } = makeService();
    const ready = await service.waitForHealthy('container-123', 2000);

    expect(ready).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:49777/health/ready',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('uses docker ping for daemon readiness', async () => {
    dockerMock.ping = jest.fn().mockResolvedValue(undefined);
    const { service } = makeService();
    const ready = await service.ping();
    expect(ready).toBe(true);

    dockerMock.ping = jest.fn().mockRejectedValue(new Error('unreachable'));
    const { service: unavailableService } = makeService();
    const unavailable = await unavailableService.ping();
    expect(unavailable).toBe(false);
  });

  // ============================================================================
  // MountPlan consumption snapshots — lock the EXACT env/bind assembly that
  // OrchestratorDockerService builds from a given MountPlan + config. The
  // discovery side (what plan a given home/env produces) is locked in
  // worktree-mount-discovery.service.spec.ts. Together they are byte-identical
  // to the pre-extraction createContainer output.
  // ============================================================================
  describe('createContainer MountPlan consumption snapshots', () => {
    const captureCreateInput = async (
      plan: MountPlan,
      configOverrides: Partial<Parameters<OrchestratorDockerService['createContainer']>[0]> = {},
    ) => {
      const worktreePath = configOverrides.worktreePath ?? join(tempHome, 'snap-wt');
      const dataPath = configOverrides.dataPath ?? join(tempHome, 'snap-data');
      await mkdir(worktreePath, { recursive: true });
      await mkdir(dataPath, { recursive: true });

      dockerMock.createContainer.mockResolvedValue({
        id: 'snap-container',
        start: jest.fn().mockResolvedValue(undefined),
        inspect: jest.fn().mockResolvedValue({
          Name: '/snap',
          State: { Status: 'running' },
          NetworkSettings: {
            Ports: { '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: '49999' }] },
          },
        }),
      });

      const { service } = makeService(plan);
      await service.createContainer({
        name: 'devchain-wt-snap',
        worktreePath,
        dataPath,
        ...configOverrides,
      });
      return dockerMock.createContainer.mock.calls[0][0] as {
        Env: string[];
        HostConfig: { Binds: string[] };
      };
    };

    // ----- env precedence -----

    it('env: bare plan yields base env + COMPOSE_PROJECT_NAME default + plan ENABLED_PROVIDERS', async () => {
      const input = await captureCreateInput({ ...EMPTY_PLAN, env: { ENABLED_PROVIDERS: '' } });

      expect(input.Env).toEqual([
        'HOST=0.0.0.0',
        'NODE_ENV=production',
        'COMPOSE_PROJECT_NAME=snap',
        'ENABLED_PROVIDERS=',
      ]);
    });

    it('env: user env spreads between base and COMPOSE_PROJECT_NAME default (insertion order preserved)', async () => {
      const input = await captureCreateInput(
        { ...EMPTY_PLAN, env: { ENABLED_PROVIDERS: '' } },
        { env: { CUSTOM_ENV: '1', ANOTHER: 'two' } },
      );

      expect(input.Env).toEqual([
        'HOST=0.0.0.0',
        'NODE_ENV=production',
        'CUSTOM_ENV=1',
        'ANOTHER=two',
        'COMPOSE_PROJECT_NAME=snap',
        'ENABLED_PROVIDERS=',
      ]);
    });

    it('env: explicit user COMPOSE_PROJECT_NAME is preserved (no default applied)', async () => {
      const input = await captureCreateInput(
        { ...EMPTY_PLAN, env: { ENABLED_PROVIDERS: '' } },
        { env: { COMPOSE_PROJECT_NAME: 'custom-project' } },
      );

      expect(input.Env).toEqual([
        'HOST=0.0.0.0',
        'NODE_ENV=production',
        'COMPOSE_PROJECT_NAME=custom-project',
        'ENABLED_PROVIDERS=',
      ]);
    });

    it('env: plan git identity merges after COMPOSE_PROJECT_NAME via ??=', async () => {
      const input = await captureCreateInput({
        env: {
          GIT_AUTHOR_NAME: 'Alice',
          GIT_COMMITTER_NAME: 'Alice',
          GIT_AUTHOR_EMAIL: 'alice@example.com',
          GIT_COMMITTER_EMAIL: 'alice@example.com',
          ENABLED_PROVIDERS: '',
        },
        credentialBinds: [],
        infrastructureBinds: [],
      });

      expect(input.Env).toEqual([
        'HOST=0.0.0.0',
        'NODE_ENV=production',
        'COMPOSE_PROJECT_NAME=snap',
        'GIT_AUTHOR_NAME=Alice',
        'GIT_COMMITTER_NAME=Alice',
        'GIT_AUTHOR_EMAIL=alice@example.com',
        'GIT_COMMITTER_EMAIL=alice@example.com',
        'ENABLED_PROVIDERS=',
      ]);
    });

    it('env: user-supplied GIT_AUTHOR_* wins; plan fills only the unset COMMITTER/EMAIL slots', async () => {
      const input = await captureCreateInput(
        {
          env: {
            GIT_AUTHOR_NAME: 'Host User',
            GIT_COMMITTER_NAME: 'Host User',
            GIT_AUTHOR_EMAIL: 'host@example.com',
            GIT_COMMITTER_EMAIL: 'host@example.com',
            ENABLED_PROVIDERS: '',
          },
          credentialBinds: [],
          infrastructureBinds: [],
        },
        { env: { GIT_AUTHOR_NAME: 'Custom User' } },
      );

      expect(input.Env).toEqual([
        'HOST=0.0.0.0',
        'NODE_ENV=production',
        'GIT_AUTHOR_NAME=Custom User',
        'COMPOSE_PROJECT_NAME=snap',
        'GIT_COMMITTER_NAME=Host User',
        'GIT_AUTHOR_EMAIL=host@example.com',
        'GIT_COMMITTER_EMAIL=host@example.com',
        'ENABLED_PROVIDERS=',
      ]);
    });

    it('env: plan copilot token is forwarded under its own name; COPILOT_HOME never set', async () => {
      const input = await captureCreateInput({
        env: { ENABLED_PROVIDERS: 'copilot', GH_TOKEN: 'ghu_snapshot' },
        credentialBinds: [],
        infrastructureBinds: [],
      });

      expect(input.Env).toEqual([
        'HOST=0.0.0.0',
        'NODE_ENV=production',
        'COMPOSE_PROJECT_NAME=snap',
        'ENABLED_PROVIDERS=copilot',
        'GH_TOKEN=ghu_snapshot',
      ]);
      expect(input.Env.some((e) => e.startsWith('COPILOT_HOME='))).toBe(false);
    });

    it('env: explicit user ENABLED_PROVIDERS wins over the plan (??= no-clobber)', async () => {
      const input = await captureCreateInput(
        { env: { ENABLED_PROVIDERS: 'copilot' }, credentialBinds: [], infrastructureBinds: [] },
        { env: { ENABLED_PROVIDERS: 'claude' } },
      );

      expect(input.Env).toEqual([
        'HOST=0.0.0.0',
        'NODE_ENV=production',
        'ENABLED_PROVIDERS=claude',
        'COMPOSE_PROJECT_NAME=snap',
      ]);
    });

    // ----- bind precedence -----

    it('binds: bare plan assembles worktree + data + docker.sock only', async () => {
      const input = await captureCreateInput(EMPTY_PLAN);

      expect(input.HostConfig.Binds).toEqual([
        `${join(tempHome, 'snap-wt')}:/project:rw`,
        `${join(tempHome, 'snap-data')}:/home/node/.devchain:rw`,
        `${DOCKER_SOCKET_PATH_IN_SPEC}:/var/run/docker.sock:rw`,
      ]);
    });

    it('binds: plan credentialBinds slot in before additionalBinds and docker.sock', async () => {
      const claudeBind = `${join(tempHome, '.claude', '.credentials.json')}:/home/node/.claude/.credentials.json:ro`;
      const codexBind = `${join(tempHome, '.codex', 'auth.json')}:/home/node/.codex/auth.json:ro`;
      const input = await captureCreateInput(
        { env: {}, credentialBinds: [claudeBind, codexBind], infrastructureBinds: [] },
        { additionalBinds: ['/host/extra:/container/extra:ro'] },
      );

      expect(input.HostConfig.Binds).toEqual([
        `${join(tempHome, 'snap-wt')}:/project:rw`,
        `${join(tempHome, 'snap-data')}:/home/node/.devchain:rw`,
        claudeBind,
        codexBind,
        '/host/extra:/container/extra:ro',
        `${DOCKER_SOCKET_PATH_IN_SPEC}:/var/run/docker.sock:rw`,
      ]);
    });

    it('binds: plan infrastructureBinds append after docker.sock in fixed order', async () => {
      const gitCommonBind = `${join(tempHome, 'repo', '.git')}:${join(tempHome, 'repo', '.git')}:rw`;
      const skillsBind = `${join(tempHome, '.devchain', 'skills')}:/seed-skills:ro`;
      const input = await captureCreateInput({
        env: {},
        credentialBinds: [],
        infrastructureBinds: [gitCommonBind, skillsBind],
      });

      expect(input.HostConfig.Binds).toEqual([
        `${join(tempHome, 'snap-wt')}:/project:rw`,
        `${join(tempHome, 'snap-data')}:/home/node/.devchain:rw`,
        `${DOCKER_SOCKET_PATH_IN_SPEC}:/var/run/docker.sock:rw`,
        gitCommonBind,
        skillsBind,
      ]);
    });
  });
});
