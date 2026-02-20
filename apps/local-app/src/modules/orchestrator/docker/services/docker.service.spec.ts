import Dockerode = require('dockerode');
import { execFileSync } from 'child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { Readable } from 'stream';
import { join } from 'path';
import { tmpdir } from 'os';
import { OrchestratorDockerService } from './docker.service';

jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  execFileSync: jest.fn(() => {
    throw new Error('no git config');
  }),
}));

const mockExecFileSync = execFileSync as jest.MockedFunction<typeof execFileSync>;

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

  const mockRunningContainer = (name: string, hostPort: string) => ({
    id: `container-${name}`,
    start: jest.fn().mockResolvedValue(undefined),
    inspect: jest.fn().mockResolvedValue({
      Name: `/${name}`,
      State: { Status: 'running' },
      NetworkSettings: {
        Ports: {
          '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: hostPort }],
        },
      },
    }),
  });

  it('creates container with required binds, env, labels, and capabilities', async () => {
    const worktreePath = join(tempHome, 'worktree');
    const dataPath = join(tempHome, 'data');
    await mkdir(worktreePath, { recursive: true });
    await mkdir(dataPath, { recursive: true });

    await mkdir(join(tempHome, '.claude'), { recursive: true });
    await writeFile(join(tempHome, '.claude', '.credentials.json'), '{"token":"x"}');
    await mkdir(join(tempHome, '.codex'), { recursive: true });
    await writeFile(join(tempHome, '.codex', 'auth.json'), '{"token":"y"}');
    await mkdir(join(tempHome, '.devchain', 'skills'), { recursive: true });

    const containerInspect = {
      Name: '/devchain-wt-feature-auth',
      State: { Status: 'running' },
      NetworkSettings: {
        Ports: {
          '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: '49155' }],
        },
      },
    };
    const containerMock = {
      id: 'container-123',
      start: jest.fn().mockResolvedValue(undefined),
      inspect: jest.fn().mockResolvedValue(containerInspect),
    };
    dockerMock.createContainer.mockResolvedValue(containerMock);

    const service = new OrchestratorDockerService(dockerMock as unknown as Dockerode);
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
      ]),
    );
    const enabledProviders = createInput.Env.find((entry: string) =>
      entry.startsWith('ENABLED_PROVIDERS='),
    );
    expect(enabledProviders).toBeDefined();
    expect(enabledProviders).toContain('claude');
    expect(enabledProviders).toContain('codex');

    expect(createInput.Labels).toEqual({
      'devchain.worktree': 'feature-auth',
    });

    expect(createInput.HostConfig.Binds).toEqual(
      expect.arrayContaining([
        `${worktreePath}:/project:rw`,
        `${dataPath}:/home/node/.devchain:rw`,
        `${join(tempHome, '.claude', '.credentials.json')}:/home/node/.claude/.credentials.json:ro`,
        `${join(tempHome, '.codex', 'auth.json')}:/home/node/.codex/auth.json:ro`,
        `${join(tempHome, '.devchain', 'skills')}:/seed-skills:ro`,
        '/var/run/docker.sock:/var/run/docker.sock:rw',
      ]),
    );
    expect(createInput.HostConfig.Binds).not.toContain(
      `${join(tempHome, '.claude')}:/home/node/.claude:ro`,
    );
    expect(createInput.HostConfig.Binds).not.toContain(
      `${join(tempHome, '.codex')}:/home/node/.codex:ro`,
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

    const service = new OrchestratorDockerService(dockerMock as unknown as Dockerode);

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

  it('supports partial provider auth discovery (gemini only)', async () => {
    const worktreePath = join(tempHome, 'worktree');
    const dataPath = join(tempHome, 'data');
    await mkdir(worktreePath, { recursive: true });
    await mkdir(dataPath, { recursive: true });

    await mkdir(join(tempHome, '.gemini'), { recursive: true });
    await writeFile(join(tempHome, '.gemini', 'oauth_creds.json'), '{"token":"z"}');

    const containerMock = {
      id: 'container-123',
      start: jest.fn().mockResolvedValue(undefined),
      inspect: jest.fn().mockResolvedValue({
        Name: '/devchain-wt-feature-gemini',
        State: { Status: 'running' },
        NetworkSettings: {
          Ports: {
            '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: '49156' }],
          },
        },
      }),
    };
    dockerMock.createContainer.mockResolvedValue(containerMock);

    const service = new OrchestratorDockerService(dockerMock as unknown as Dockerode);
    await service.createContainer({
      name: 'devchain-wt-feature-gemini',
      worktreePath,
      dataPath,
    });

    const createInput = dockerMock.createContainer.mock.calls[0][0];
    expect(createInput.Env).toContain('ENABLED_PROVIDERS=gemini');
    expect(createInput.Env).toContain('COMPOSE_PROJECT_NAME=feature-gemini');
    expect(createInput.HostConfig.Binds).toContain(
      `${join(tempHome, '.gemini', 'oauth_creds.json')}:/home/node/.gemini/oauth_creds.json:ro`,
    );
  });

  it('gracefully handles zero discovered providers', async () => {
    const worktreePath = join(tempHome, 'worktree');
    const dataPath = join(tempHome, 'data');
    await mkdir(worktreePath, { recursive: true });
    await mkdir(dataPath, { recursive: true });

    const containerMock = {
      id: 'container-123',
      start: jest.fn().mockResolvedValue(undefined),
      inspect: jest.fn().mockResolvedValue({
        Name: '/devchain-wt-no-providers',
        State: { Status: 'running' },
        NetworkSettings: {
          Ports: {
            '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: '49157' }],
          },
        },
      }),
    };
    dockerMock.createContainer.mockResolvedValue(containerMock);

    const service = new OrchestratorDockerService(dockerMock as unknown as Dockerode);
    await service.createContainer({
      name: 'devchain-wt-no-providers',
      worktreePath,
      dataPath,
    });

    const createInput = dockerMock.createContainer.mock.calls[0][0];
    expect(createInput.Env).toContain('ENABLED_PROVIDERS=');
    expect(createInput.HostConfig.Binds).toEqual(
      expect.arrayContaining([
        `${worktreePath}:/project:rw`,
        `${dataPath}:/home/node/.devchain:rw`,
        '/var/run/docker.sock:/var/run/docker.sock:rw',
      ]),
    );
    expect(createInput.HostConfig.Binds.length).toBeGreaterThanOrEqual(3);
  });

  it('includes git identity env vars when host has git config', async () => {
    mockExecFileSync.mockImplementation((_file, args) => {
      const key = (args as string[])?.[3];
      if (key === 'user.name') return 'Test User' as never;
      if (key === 'user.email') return 'test@example.com' as never;
      throw new Error('unknown key');
    });

    const worktreePath = join(tempHome, 'worktree');
    const dataPath = join(tempHome, 'data');
    await mkdir(worktreePath, { recursive: true });
    await mkdir(dataPath, { recursive: true });

    dockerMock.createContainer.mockResolvedValue(
      mockRunningContainer('devchain-wt-git-identity', '49170'),
    );

    const service = new OrchestratorDockerService(dockerMock as unknown as Dockerode);
    await service.createContainer({
      name: 'devchain-wt-git-identity',
      worktreePath,
      dataPath,
    });

    const createInput = dockerMock.createContainer.mock.calls[0][0];
    expect(createInput.Env).toEqual(
      expect.arrayContaining([
        'GIT_AUTHOR_NAME=Test User',
        'GIT_AUTHOR_EMAIL=test@example.com',
        'GIT_COMMITTER_NAME=Test User',
        'GIT_COMMITTER_EMAIL=test@example.com',
      ]),
    );
  });

  it('omits git identity env vars when host has no git config', async () => {
    const worktreePath = join(tempHome, 'worktree');
    const dataPath = join(tempHome, 'data');
    await mkdir(worktreePath, { recursive: true });
    await mkdir(dataPath, { recursive: true });

    dockerMock.createContainer.mockResolvedValue(
      mockRunningContainer('devchain-wt-no-git', '49171'),
    );

    const service = new OrchestratorDockerService(dockerMock as unknown as Dockerode);
    await service.createContainer({
      name: 'devchain-wt-no-git',
      worktreePath,
      dataPath,
    });

    const createInput = dockerMock.createContainer.mock.calls[0][0];
    const gitEnvVars = (createInput.Env as string[]).filter(
      (e: string) => e.startsWith('GIT_AUTHOR_') || e.startsWith('GIT_COMMITTER_'),
    );
    expect(gitEnvVars).toHaveLength(0);
  });

  it('preserves user-supplied git env vars over host config', async () => {
    mockExecFileSync.mockImplementation((_file, args) => {
      const key = (args as string[])?.[3];
      if (key === 'user.name') return 'Host User' as never;
      if (key === 'user.email') return 'host@example.com' as never;
      throw new Error('unknown key');
    });

    const worktreePath = join(tempHome, 'worktree');
    const dataPath = join(tempHome, 'data');
    await mkdir(worktreePath, { recursive: true });
    await mkdir(dataPath, { recursive: true });

    dockerMock.createContainer.mockResolvedValue(
      mockRunningContainer('devchain-wt-custom-git', '49172'),
    );

    const service = new OrchestratorDockerService(dockerMock as unknown as Dockerode);
    await service.createContainer({
      name: 'devchain-wt-custom-git',
      worktreePath,
      dataPath,
      env: { GIT_AUTHOR_NAME: 'Custom User', GIT_AUTHOR_EMAIL: 'custom@example.com' },
    });

    const createInput = dockerMock.createContainer.mock.calls[0][0];
    // User-supplied values are preserved
    expect(createInput.Env).toEqual(
      expect.arrayContaining([
        'GIT_AUTHOR_NAME=Custom User',
        'GIT_AUTHOR_EMAIL=custom@example.com',
      ]),
    );
    // Host values used for committer (not supplied by user)
    expect(createInput.Env).toEqual(
      expect.arrayContaining([
        'GIT_COMMITTER_NAME=Host User',
        'GIT_COMMITTER_EMAIL=host@example.com',
      ]),
    );
    // User-supplied values NOT overwritten
    expect(createInput.Env).not.toEqual(expect.arrayContaining(['GIT_AUTHOR_NAME=Host User']));
  });

  it('adds git common-dir mount when worktree .git file has valid gitdir path', async () => {
    const worktreePath = join(tempHome, 'worktree');
    const dataPath = join(tempHome, 'data');
    const repoGitCommonDir = join(tempHome, 'repo', '.git');
    const gitdirPath = join(repoGitCommonDir, 'worktrees', 'feature-auth');
    await mkdir(worktreePath, { recursive: true });
    await mkdir(dataPath, { recursive: true });
    await mkdir(gitdirPath, { recursive: true });
    await writeFile(join(worktreePath, '.git'), `gitdir: ${gitdirPath}\n`, 'utf8');

    dockerMock.createContainer.mockResolvedValue(
      mockRunningContainer('devchain-wt-feature-auth', '49159'),
    );

    const service = new OrchestratorDockerService(dockerMock as unknown as Dockerode);
    await service.createContainer({
      name: 'devchain-wt-feature-auth',
      worktreePath,
      dataPath,
    });

    const createInput = dockerMock.createContainer.mock.calls[0][0];
    expect(createInput.HostConfig.Binds).toContain(`${repoGitCommonDir}:${repoGitCommonDir}:rw`);
  });

  it('does not add git common-dir mount when worktree .git is a directory', async () => {
    const worktreePath = join(tempHome, 'worktree');
    const dataPath = join(tempHome, 'data');
    await mkdir(worktreePath, { recursive: true });
    await mkdir(dataPath, { recursive: true });
    await mkdir(join(worktreePath, '.git'), { recursive: true });

    dockerMock.createContainer.mockResolvedValue(
      mockRunningContainer('devchain-wt-dir-git', '49160'),
    );

    const service = new OrchestratorDockerService(dockerMock as unknown as Dockerode);
    await service.createContainer({
      name: 'devchain-wt-dir-git',
      worktreePath,
      dataPath,
    });

    const createInput = dockerMock.createContainer.mock.calls[0][0];
    expect(createInput.HostConfig.Binds).toEqual(
      expect.arrayContaining([
        `${worktreePath}:/project:rw`,
        `${dataPath}:/home/node/.devchain:rw`,
        '/var/run/docker.sock:/var/run/docker.sock:rw',
      ]),
    );
    expect(createInput.HostConfig.Binds.length).toBeGreaterThanOrEqual(3);
  });

  it('does not add git common-dir mount when worktree .git does not exist', async () => {
    const worktreePath = join(tempHome, 'worktree');
    const dataPath = join(tempHome, 'data');
    await mkdir(worktreePath, { recursive: true });
    await mkdir(dataPath, { recursive: true });

    dockerMock.createContainer.mockResolvedValue(
      mockRunningContainer('devchain-wt-missing-git', '49161'),
    );

    const service = new OrchestratorDockerService(dockerMock as unknown as Dockerode);
    await service.createContainer({
      name: 'devchain-wt-missing-git',
      worktreePath,
      dataPath,
    });

    const createInput = dockerMock.createContainer.mock.calls[0][0];
    expect(createInput.HostConfig.Binds).toEqual(
      expect.arrayContaining([
        `${worktreePath}:/project:rw`,
        `${dataPath}:/home/node/.devchain:rw`,
        '/var/run/docker.sock:/var/run/docker.sock:rw',
      ]),
    );
    expect(createInput.HostConfig.Binds.length).toBeGreaterThanOrEqual(3);
  });

  it('gracefully skips git common-dir mount when gitdir path does not exist', async () => {
    const worktreePath = join(tempHome, 'worktree');
    const dataPath = join(tempHome, 'data');
    const missingGitdirPath = join(tempHome, 'repo', '.git', 'worktrees', 'feature-missing');
    await mkdir(worktreePath, { recursive: true });
    await mkdir(dataPath, { recursive: true });
    await writeFile(join(worktreePath, '.git'), `gitdir: ${missingGitdirPath}\n`, 'utf8');

    dockerMock.createContainer.mockResolvedValue(
      mockRunningContainer('devchain-wt-missing-gitdir', '49162'),
    );

    const service = new OrchestratorDockerService(dockerMock as unknown as Dockerode);
    await service.createContainer({
      name: 'devchain-wt-missing-gitdir',
      worktreePath,
      dataPath,
    });

    const createInput = dockerMock.createContainer.mock.calls[0][0];
    expect(createInput.HostConfig.Binds).toEqual(
      expect.arrayContaining([
        `${worktreePath}:/project:rw`,
        `${dataPath}:/home/node/.devchain:rw`,
        '/var/run/docker.sock:/var/run/docker.sock:rw',
      ]),
    );
    expect(createInput.HostConfig.Binds.length).toBeGreaterThanOrEqual(3);
  });

  it('skips git common-dir mount for non-posix gitdir paths', async () => {
    const worktreePath = join(tempHome, 'worktree');
    const dataPath = join(tempHome, 'data');
    await mkdir(worktreePath, { recursive: true });
    await mkdir(dataPath, { recursive: true });
    await writeFile(
      join(worktreePath, '.git'),
      'gitdir: C:\\repo\\.git\\worktrees\\feature-auth\n',
      'utf8',
    );

    dockerMock.createContainer.mockResolvedValue(
      mockRunningContainer('devchain-wt-non-posix-gitdir', '49163'),
    );

    const service = new OrchestratorDockerService(dockerMock as unknown as Dockerode);
    await service.createContainer({
      name: 'devchain-wt-non-posix-gitdir',
      worktreePath,
      dataPath,
    });

    const createInput = dockerMock.createContainer.mock.calls[0][0];
    expect(createInput.HostConfig.Binds).toEqual(
      expect.arrayContaining([
        `${worktreePath}:/project:rw`,
        `${dataPath}:/home/node/.devchain:rw`,
        '/var/run/docker.sock:/var/run/docker.sock:rw',
      ]),
    );
    expect(createInput.HostConfig.Binds.length).toBeGreaterThanOrEqual(3);
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

    const containerMock = {
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
    };
    dockerMock.createContainer.mockResolvedValue(containerMock);

    const service = new OrchestratorDockerService(dockerMock as unknown as Dockerode);
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

    const service = new OrchestratorDockerService(dockerMock as unknown as Dockerode);
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

    const service = new OrchestratorDockerService(dockerMock as unknown as Dockerode);
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

    const service = new OrchestratorDockerService(dockerMock as unknown as Dockerode);
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

    const service = new OrchestratorDockerService(dockerMock as unknown as Dockerode);
    await service.removeWorktreeNetwork('feature-auth');
    await service.removeWorktreeNetwork('feature-auth');

    expect(remove).toHaveBeenCalledTimes(4);
  });

  it('pulls image when it is not present locally', async () => {
    dockerMock.getImage.mockReturnValue({
      inspect: jest.fn().mockRejectedValue(new Error('missing')),
    });
    dockerMock.pull.mockResolvedValue({});

    const containerMock = {
      id: 'container-123',
      start: jest.fn().mockResolvedValue(undefined),
      inspect: jest.fn().mockResolvedValue({
        Name: '/devchain-wt-test',
        State: { Status: 'running' },
        NetworkSettings: { Ports: { '3000/tcp': [{ HostPort: '49321' }] } },
      }),
    };
    dockerMock.createContainer.mockResolvedValue(containerMock);

    const worktreePath = join(tempHome, 'worktree');
    const dataPath = join(tempHome, 'data');
    await mkdir(worktreePath, { recursive: true });
    await mkdir(dataPath, { recursive: true });

    const service = new OrchestratorDockerService(dockerMock as unknown as Dockerode);
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

    const service = new OrchestratorDockerService(dockerMock as unknown as Dockerode);
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

    const service = new OrchestratorDockerService(dockerMock as unknown as Dockerode);
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

    const service = new OrchestratorDockerService(dockerMock as unknown as Dockerode);
    const ready = await service.waitForHealthy('container-123', 2000);

    expect(ready).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:49777/health/ready',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('uses docker ping for daemon readiness', async () => {
    dockerMock.ping = jest.fn().mockResolvedValue(undefined);
    const service = new OrchestratorDockerService(dockerMock as unknown as Dockerode);
    const ready = await service.ping();
    expect(ready).toBe(true);

    dockerMock.ping = jest.fn().mockRejectedValue(new Error('unreachable'));
    const unavailableService = new OrchestratorDockerService(dockerMock as unknown as Dockerode);
    const unavailable = await unavailableService.ping();
    expect(unavailable).toBe(false);
  });
});
