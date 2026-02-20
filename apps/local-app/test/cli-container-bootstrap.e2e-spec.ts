import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

type ExecSyncMock = jest.Mock<string, [string, Record<string, unknown>?]>;

interface DockerMockState {
  dockerAvailable: boolean;
  gitTopLevel: string | null;
  containerStatus: 'running' | 'exited' | null;
  volumeExists: boolean;
  worktreeImageExists: boolean;
  worktreeImagePullFails: boolean;
  worktreeImageBuildFails: boolean;
  imageInspectCount: number;
  imagePullCount: number;
  imageBuildCount: number;
  lastInspectedImage: string | null;
  lastPulledImage: string | null;
  lastBuiltImage: string | null;
  mappedPort: number;
  readyFailuresRemaining: number;
  runCount: number;
  startCount: number;
  stopCount: number;
  rmCount: number;
  volumeRmCount: number;
}

function createDockerExecSyncMock(
  overrides: Partial<DockerMockState> = {},
): { execSyncMock: ExecSyncMock; state: DockerMockState } {
  const state: DockerMockState = {
    dockerAvailable: true,
    gitTopLevel: '/repo',
    containerStatus: null,
    volumeExists: true,
    worktreeImageExists: true,
    worktreeImagePullFails: false,
    worktreeImageBuildFails: false,
    imageInspectCount: 0,
    imagePullCount: 0,
    imageBuildCount: 0,
    lastInspectedImage: null,
    lastPulledImage: null,
    lastBuiltImage: null,
    mappedPort: 35432,
    readyFailuresRemaining: 0,
    runCount: 0,
    startCount: 0,
    stopCount: 0,
    rmCount: 0,
    volumeRmCount: 0,
    ...overrides,
  };

  const execSyncMock: ExecSyncMock = jest.fn((command: string) => {
    if (command.startsWith('docker info --format "{{.ID}}"')) {
      if (!state.dockerAvailable) {
        throw new Error('docker unavailable');
      }
      return 'docker-id\n';
    }

    if (command.startsWith('git rev-parse --show-toplevel')) {
      if (!state.gitTopLevel) {
        throw new Error('not a git repo');
      }
      return `${state.gitTopLevel}\n`;
    }

    if (command.startsWith('docker inspect -f "{{.State.Status}}" devchain-orchestrator-pg')) {
      if (!state.containerStatus) {
        throw new Error('container not found');
      }
      return `${state.containerStatus}\n`;
    }

    if (command.startsWith('docker run -d --name devchain-orchestrator-pg')) {
      state.containerStatus = 'running';
      state.runCount += 1;
      return 'container-id\n';
    }

    if (command.startsWith('docker image inspect ')) {
      state.imageInspectCount += 1;
      state.lastInspectedImage = command.replace('docker image inspect ', '').trim();
      if (!state.worktreeImageExists) {
        throw new Error('image not found');
      }
      return '{}\n';
    }

    if (command.startsWith('docker pull ')) {
      state.imagePullCount += 1;
      state.lastPulledImage = command.replace('docker pull ', '').trim();
      if (state.worktreeImagePullFails) {
        throw new Error('pull failed');
      }
      state.worktreeImageExists = true;
      return `Pulled ${state.lastPulledImage}\n`;
    }

    if (command.startsWith('docker build ')) {
      state.imageBuildCount += 1;
      const imageMatch = command.match(/-t\s+([^\s]+)/);
      state.lastBuiltImage = imageMatch ? imageMatch[1] : null;
      if (state.worktreeImageBuildFails) {
        throw new Error('build failed');
      }
      state.worktreeImageExists = true;
      return `Built ${state.lastBuiltImage ?? 'image'}\n`;
    }

    if (command.startsWith('docker start devchain-orchestrator-pg')) {
      if (!state.containerStatus) {
        throw new Error('container not found');
      }
      state.containerStatus = 'running';
      state.startCount += 1;
      return 'devchain-orchestrator-pg\n';
    }

    if (command.startsWith('docker exec devchain-orchestrator-pg pg_isready')) {
      if (state.readyFailuresRemaining > 0) {
        state.readyFailuresRemaining -= 1;
        throw new Error('not ready');
      }
      return '/var/run/postgresql:5432 - accepting connections\n';
    }

    if (command.startsWith('docker port devchain-orchestrator-pg 5432')) {
      return `127.0.0.1:${state.mappedPort}\n`;
    }

    if (command.startsWith('docker stop devchain-orchestrator-pg')) {
      if (!state.containerStatus) {
        throw new Error('container not found');
      }
      state.containerStatus = 'exited';
      state.stopCount += 1;
      return 'devchain-orchestrator-pg\n';
    }

    if (command.startsWith('docker rm devchain-orchestrator-pg')) {
      if (!state.containerStatus) {
        throw new Error('container not found');
      }
      state.containerStatus = null;
      state.rmCount += 1;
      return 'devchain-orchestrator-pg\n';
    }

    if (command.startsWith('docker volume inspect devchain-pg-data')) {
      if (!state.volumeExists) {
        throw new Error('volume not found');
      }
      return '[]\n';
    }

    if (command.startsWith('docker volume rm devchain-pg-data')) {
      if (!state.volumeExists) {
        throw new Error('volume not found');
      }
      state.volumeExists = false;
      state.volumeRmCount += 1;
      return 'devchain-pg-data\n';
    }

    if (command.startsWith('which tmux')) {
      return '/usr/bin/tmux\n';
    }

    throw new Error(`Unhandled mock command: ${command}`);
  });

  return { execSyncMock, state };
}

function loadCliTestApi() {
  const cliModulePath = '../../../scripts/cli.js';
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const cliModule = require(cliModulePath) as {
    __test__: {
      bootstrapContainerMode: (options?: Record<string, unknown>) => Promise<void>;
      deriveRepoRootFromGit: (execSyncFn?: ExecSyncMock) => string;
      ensureProjectGitignoreIncludesDevchain: (repoRoot?: string) => void;
      ensureDockerAvailable: (execSyncFn?: ExecSyncMock) => void;
      hasWorktreeImageLocally: (imageRef: string, execSyncFn?: ExecSyncMock) => boolean;
      buildWorktreeImage: (options?: Record<string, unknown>) => string;
      resolveDevchainApiBaseUrlForRestart: (options?: Record<string, unknown>) => string;
      restartRunningWorktrees: (options?: Record<string, unknown>) => Promise<number>;
      ensureWorktreeImage: (options?: Record<string, unknown>) => Promise<string>;
      ensureWorktreeImageRefFromPackageVersion: () => string;
      getDevUiConfig: (containerMode: boolean) => {
        script: string;
        startMessage: string;
        logLabel: string;
        url: string;
      };
      applyContainerModeDefaults: (
        containerMode: boolean,
        opts?: { port?: number | string },
        env?: NodeJS.ProcessEnv,
      ) => void;
      getPreferredDevApiPort: (
        optsPort?: number | string,
        containerMode?: boolean,
        env?: NodeJS.ProcessEnv,
      ) => number;
      getDevModeSpawnConfig: (params: {
        containerMode: boolean;
        port: number;
        env?: NodeJS.ProcessEnv;
      }) => {
        ui: {
          script: string;
          startMessage: string;
          logLabel: string;
          url: string;
        };
        nest: {
          command: string;
          args: string[];
          env: NodeJS.ProcessEnv;
        };
        vite: {
          command: string;
          args: string[];
          env: NodeJS.ProcessEnv;
        };
      };
      runHostPreflightChecks: (
        params: Record<string, unknown>,
        deps?: Record<string, unknown>,
      ) => Promise<void>;
      resolveStartupOrchestration: (options?: Record<string, unknown>) => Promise<{
        enableOrchestration: boolean;
        skippedByEnvNormal: boolean;
        dockerAvailable: boolean;
        insideGitRepo: boolean;
        bootstrapError?: string;
      }>;
      formatOrchestrationDetectionFailureReason: (options?: Record<string, unknown>) => string;
      isDockerAvailable: (execSyncFn?: ExecSyncMock) => boolean;
      isInsideGitRepo: (execSyncFn?: ExecSyncMock) => boolean;
      normalizeWorktreeRuntimeType: (value?: string | null) => string | null;
      isWorktreeRuntimeModeEnabled: (value?: string | null) => boolean;
    };
  };

  return cliModule.__test__;
}

describe('CLI container bootstrap integration (mocked shell)', () => {
  const originalFetch = global.fetch;
  const originalHome = process.env.HOME;
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalRepoRoot = process.env.REPO_ROOT;
  const originalOrchestratorContainerImage = process.env.ORCHESTRATOR_CONTAINER_IMAGE;
  let tempHome = '';

  beforeEach(() => {
    jest.resetModules();
    tempHome = mkdtempSync(join(tmpdir(), 'cli-bootstrap-home-'));
    process.env.HOME = tempHome;
    delete process.env.DATABASE_URL;
    delete process.env.REPO_ROOT;
    delete process.env.ORCHESTRATOR_CONTAINER_IMAGE;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    rmSync(tempHome, { recursive: true, force: true });
  });

  afterAll(() => {
    if (typeof originalHome === 'string') {
      process.env.HOME = originalHome;
    } else {
      delete process.env.HOME;
    }

    if (typeof originalDatabaseUrl === 'string') {
      process.env.DATABASE_URL = originalDatabaseUrl;
    } else {
      delete process.env.DATABASE_URL;
    }

    if (typeof originalRepoRoot === 'string') {
      process.env.REPO_ROOT = originalRepoRoot;
    } else {
      delete process.env.REPO_ROOT;
    }

    if (typeof originalOrchestratorContainerImage === 'string') {
      process.env.ORCHESTRATOR_CONTAINER_IMAGE = originalOrchestratorContainerImage;
    } else {
      delete process.env.ORCHESTRATOR_CONTAINER_IMAGE;
    }
  });

  it('passes Docker preflight when Docker is available', () => {
    const testApi = loadCliTestApi();
    const { execSyncMock } = createDockerExecSyncMock({ dockerAvailable: true });

    expect(() => testApi.ensureDockerAvailable(execSyncMock)).not.toThrow();
    expect(execSyncMock).toHaveBeenCalledWith(
      'docker info --format "{{.ID}}"',
      expect.objectContaining({ timeout: 10000 }),
    );
  });

  it('fails Docker preflight with a clear message when Docker is unavailable', () => {
    const testApi = loadCliTestApi();
    const { execSyncMock } = createDockerExecSyncMock({ dockerAvailable: false });

    expect(() => testApi.ensureDockerAvailable(execSyncMock)).toThrow(
      'Container mode requires Docker. Please install Docker and try again.',
    );
  });

  it('derives REPO_ROOT from git top-level (including subdirectory invocation)', () => {
    const testApi = loadCliTestApi();
    const { execSyncMock } = createDockerExecSyncMock({ gitTopLevel: '/repo-root' });
    const cwdSpy = jest.spyOn(process, 'cwd').mockReturnValue('/repo-root/apps/local-app');

    try {
      const repoRoot = testApi.deriveRepoRootFromGit(execSyncMock);
      expect(repoRoot).toBe('/repo-root');
      expect(process.env.REPO_ROOT).toBe('/repo-root');
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it('fails REPO_ROOT derivation with a clear message outside a git repository', () => {
    const testApi = loadCliTestApi();
    const { execSyncMock } = createDockerExecSyncMock({ gitTopLevel: null });

    expect(() => testApi.deriveRepoRootFromGit(execSyncMock)).toThrow(
      'Container mode must be run from within a git repository.',
    );
  });

  it('isDockerAvailable returns false instead of throwing when Docker is unavailable', () => {
    const testApi = loadCliTestApi();
    const { execSyncMock } = createDockerExecSyncMock({ dockerAvailable: false });

    expect(testApi.isDockerAvailable(execSyncMock)).toBe(false);
  });

  it('isInsideGitRepo returns false and preserves prior REPO_ROOT when outside git repository', () => {
    const testApi = loadCliTestApi();
    const { execSyncMock } = createDockerExecSyncMock({ gitTopLevel: null });
    process.env.REPO_ROOT = '/existing-root';

    const insideRepo = testApi.isInsideGitRepo(execSyncMock);

    expect(insideRepo).toBe(false);
    expect(process.env.REPO_ROOT).toBe('/existing-root');
  });

  it('normalizes supported --worktree-runtime values', () => {
    const testApi = loadCliTestApi();

    expect(testApi.normalizeWorktreeRuntimeType('process')).toBe('process');
    expect(testApi.normalizeWorktreeRuntimeType('  Container  ')).toBe('container');
  });

  it('rejects unsupported --worktree-runtime values with a clear message', () => {
    const testApi = loadCliTestApi();

    expect(() => testApi.normalizeWorktreeRuntimeType('vm')).toThrow(
      'Invalid --worktree-runtime value "vm". Expected one of: container, process.',
    );
  });

  it('reports worktree runtime mode enabled only for supported values', () => {
    const testApi = loadCliTestApi();

    expect(testApi.isWorktreeRuntimeModeEnabled('process')).toBe(true);
    expect(testApi.isWorktreeRuntimeModeEnabled('container')).toBe(true);
    expect(testApi.isWorktreeRuntimeModeEnabled(null)).toBe(false);
    expect(testApi.isWorktreeRuntimeModeEnabled('vm')).toBe(false);
  });

  it('ensureProjectGitignoreIncludesDevchain appends once when missing', () => {
    const testApi = loadCliTestApi();
    const repoRoot = mkdtempSync(join(tempHome, 'repo-'));
    const gitignorePath = join(repoRoot, '.gitignore');
    writeFileSync(gitignorePath, 'node_modules/\n', 'utf8');

    testApi.ensureProjectGitignoreIncludesDevchain(repoRoot);
    testApi.ensureProjectGitignoreIncludesDevchain(repoRoot);

    expect(readFileSync(gitignorePath, 'utf8')).toBe('node_modules/\n.devchain/\n');
  });

  it('ensureProjectGitignoreIncludesDevchain creates .gitignore when missing', () => {
    const testApi = loadCliTestApi();
    const repoRoot = mkdtempSync(join(tempHome, 'repo-'));
    const gitignorePath = join(repoRoot, '.gitignore');

    testApi.ensureProjectGitignoreIncludesDevchain(repoRoot);

    expect(existsSync(gitignorePath)).toBe(true);
    expect(readFileSync(gitignorePath, 'utf8')).toBe('.devchain/\n');
  });

  it('ensureWorktreeImageRefFromPackageVersion sets image ref without inspect/pull/build', () => {
    const testApi = loadCliTestApi();
    const { execSyncMock, state } = createDockerExecSyncMock({ worktreeImageExists: false });

    const resolved = testApi.ensureWorktreeImageRefFromPackageVersion();

    expect(resolved).toMatch(/^ghcr\.io\/twitech-lab\/devchain:/);
    expect(process.env.ORCHESTRATOR_CONTAINER_IMAGE).toBe(resolved);
    expect(state.imageInspectCount).toBe(0);
    expect(state.imagePullCount).toBe(0);
    expect(state.imageBuildCount).toBe(0);
    expect(execSyncMock).not.toHaveBeenCalled();
  });

  it('ensureWorktreeImage uses env override and skips inspect/pull', async () => {
    const testApi = loadCliTestApi();
    const { execSyncMock, state } = createDockerExecSyncMock();
    process.env.ORCHESTRATOR_CONTAINER_IMAGE = 'ghcr.io/twitech-lab/devchain:override';

    const resolved = await testApi.ensureWorktreeImage({ execSyncFn: execSyncMock });

    expect(resolved).toBe('ghcr.io/twitech-lab/devchain:override');
    expect(state.imageInspectCount).toBe(0);
    expect(state.imagePullCount).toBe(0);
  });

  it('ensureWorktreeImage uses local image when present and sets env', async () => {
    const testApi = loadCliTestApi();
    const { execSyncMock, state } = createDockerExecSyncMock({
      worktreeImageExists: true,
    });
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const packageJson = require('../../../package.json') as { version?: string };
    const expectedImageRef = `ghcr.io/twitech-lab/devchain:${String(packageJson.version ?? '').trim()}`;

    const resolved = await testApi.ensureWorktreeImage({ execSyncFn: execSyncMock });

    expect(resolved).toBe(expectedImageRef);
    expect(process.env.ORCHESTRATOR_CONTAINER_IMAGE).toBe(resolved);
    expect(state.imageInspectCount).toBe(1);
    expect(state.imagePullCount).toBe(0);
    expect(state.lastInspectedImage).toBe(expectedImageRef);
  });

  it('ensureWorktreeImage pulls image when not present locally', async () => {
    const testApi = loadCliTestApi();
    const { execSyncMock, state } = createDockerExecSyncMock({
      worktreeImageExists: false,
    });

    const resolved = await testApi.ensureWorktreeImage({ execSyncFn: execSyncMock });

    expect(process.env.ORCHESTRATOR_CONTAINER_IMAGE).toBe(resolved);
    expect(state.imageInspectCount).toBe(1);
    expect(state.imagePullCount).toBe(1);
    expect(state.lastPulledImage).toBe(resolved);
  });

  it('ensureWorktreeImage builds image when missing with build strategy', async () => {
    const testApi = loadCliTestApi();
    const { execSyncMock, state } = createDockerExecSyncMock({
      worktreeImageExists: false,
    });

    const resolved = await testApi.ensureWorktreeImage({
      execSyncFn: execSyncMock,
      onMissing: 'build',
    });

    expect(process.env.ORCHESTRATOR_CONTAINER_IMAGE).toBe(resolved);
    expect(state.imageInspectCount).toBe(1);
    expect(state.imageBuildCount).toBe(1);
    expect(state.imagePullCount).toBe(0);
    expect(state.lastBuiltImage).toBe(resolved);
  });

  it('ensureWorktreeImage surfaces clear error when build strategy fails', async () => {
    const testApi = loadCliTestApi();
    const { execSyncMock } = createDockerExecSyncMock({
      worktreeImageExists: false,
      worktreeImageBuildFails: true,
    });

    await expect(
      testApi.ensureWorktreeImage({
        execSyncFn: execSyncMock,
        onMissing: 'build',
      }),
    ).rejects.toThrow(/Failed to build worktree image:/);
  });

  it('ensureWorktreeImage surfaces clear manual steps on pull failure', async () => {
    const testApi = loadCliTestApi();
    const { execSyncMock } = createDockerExecSyncMock({
      worktreeImageExists: false,
      worktreeImagePullFails: true,
    });

    await expect(testApi.ensureWorktreeImage({ execSyncFn: execSyncMock })).rejects.toThrow(
      /Failed to pull worktree image:/,
    );
    await expect(testApi.ensureWorktreeImage({ execSyncFn: execSyncMock })).rejects.toThrow(
      /Try manually: docker pull/,
    );
    await expect(testApi.ensureWorktreeImage({ execSyncFn: execSyncMock })).rejects.toThrow(
      /Or build locally: docker build -t/,
    );
  });

  it('restartRunningWorktrees skips restart when no running worktrees exist', async () => {
    const testApi = loadCliTestApi();
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{ id: 'wt-1', name: 'wt-1', status: 'stopped' }],
      });

    const restartedCount = await testApi.restartRunningWorktrees({
      baseUrl: 'http://127.0.0.1:4000',
      fetchFn: fetchMock,
    });

    expect(restartedCount).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:4000/api/worktrees');
  });

  it('restartRunningWorktrees stops and starts only running worktrees', async () => {
    const testApi = loadCliTestApi();
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { id: 'wt-running', name: 'running', status: 'running' },
          { id: 'wt-stopped', name: 'stopped', status: 'stopped' },
        ],
      })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true });

    const restartedCount = await testApi.restartRunningWorktrees({
      baseUrl: 'http://127.0.0.1:4000',
      fetchFn: fetchMock,
    });

    expect(restartedCount).toBe(1);
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'http://127.0.0.1:4000/api/worktrees/wt-running/stop', {
      method: 'POST',
    });
    expect(fetchMock).toHaveBeenNthCalledWith(3, 'http://127.0.0.1:4000/api/worktrees/wt-running/start', {
      method: 'POST',
    });
  });

  it('resolveDevchainApiBaseUrlForRestart fails with clear error when pid file is missing', () => {
    const testApi = loadCliTestApi();
    expect(() =>
      testApi.resolveDevchainApiBaseUrlForRestart({
        readPidFileFn: () => null,
      }),
    ).toThrow(
      'Image was rebuilt, but Devchain is not running. Start container mode first, then retry with --restart.',
    );
  });

  it('resolveDevchainApiBaseUrlForRestart returns local base URL from pid file', () => {
    const testApi = loadCliTestApi();
    expect(
      testApi.resolveDevchainApiBaseUrlForRestart({
        readPidFileFn: () => ({ pid: 777, port: 4567 }),
        isProcessRunningFn: () => true,
      }),
    ).toBe('http://127.0.0.1:4567');
  });

  it('resolveStartupOrchestration enables orchestration and sets DEVCHAIN_MODE=main when Docker+git are available', async () => {
    const testApi = loadCliTestApi();
    const { execSyncMock } = createDockerExecSyncMock({
      dockerAvailable: true,
      gitTopLevel: '/repo-root',
    });
    const env: NodeJS.ProcessEnv = {};
    const bootstrapContainerModeFn = jest.fn().mockResolvedValue(undefined);

    const resolution = await testApi.resolveStartupOrchestration({
      forceContainer: false,
      env,
      execSyncFn: execSyncMock,
      bootstrapContainerModeFn,
    });

    expect(resolution).toEqual({
      enableOrchestration: true,
      skippedByEnvNormal: false,
      dockerAvailable: true,
      insideGitRepo: true,
    });
    expect(env.DEVCHAIN_MODE).toBe('main');
    expect(bootstrapContainerModeFn).toHaveBeenCalledTimes(1);
  });

  it('resolveStartupOrchestration falls back to normal mode when Docker is unavailable', async () => {
    const testApi = loadCliTestApi();
    const { execSyncMock } = createDockerExecSyncMock({
      dockerAvailable: false,
      gitTopLevel: '/repo-root',
    });
    const env: NodeJS.ProcessEnv = {};

    const resolution = await testApi.resolveStartupOrchestration({
      forceContainer: false,
      env,
      execSyncFn: execSyncMock,
    });

    expect(resolution.enableOrchestration).toBe(false);
    expect(resolution.dockerAvailable).toBe(false);
    expect(resolution.insideGitRepo).toBe(true);
    expect(env.DEVCHAIN_MODE).toBeUndefined();
  });

  it('resolveStartupOrchestration falls back to normal mode when not inside a git repository', async () => {
    const testApi = loadCliTestApi();
    const { execSyncMock } = createDockerExecSyncMock({
      dockerAvailable: true,
      gitTopLevel: null,
    });
    const env: NodeJS.ProcessEnv = {};

    const resolution = await testApi.resolveStartupOrchestration({
      forceContainer: false,
      env,
      execSyncFn: execSyncMock,
    });

    expect(resolution.enableOrchestration).toBe(false);
    expect(resolution.dockerAvailable).toBe(true);
    expect(resolution.insideGitRepo).toBe(false);
    expect(env.DEVCHAIN_MODE).toBeUndefined();
  });

  it('resolveStartupOrchestration respects DEVCHAIN_MODE=normal override', async () => {
    const testApi = loadCliTestApi();
    const { execSyncMock } = createDockerExecSyncMock({
      dockerAvailable: true,
      gitTopLevel: '/repo-root',
    });
    const env: NodeJS.ProcessEnv = { DEVCHAIN_MODE: 'normal' };
    const bootstrapContainerModeFn = jest.fn().mockResolvedValue(undefined);

    const resolution = await testApi.resolveStartupOrchestration({
      forceContainer: false,
      env,
      execSyncFn: execSyncMock,
      bootstrapContainerModeFn,
    });

    expect(resolution).toEqual({
      enableOrchestration: false,
      skippedByEnvNormal: true,
      dockerAvailable: false,
      insideGitRepo: false,
    });
    expect(env.DEVCHAIN_MODE).toBe('normal');
    expect(bootstrapContainerModeFn).not.toHaveBeenCalled();
  });

  it('resolveStartupOrchestration throws clear force error when Docker is unavailable', async () => {
    const testApi = loadCliTestApi();
    const { execSyncMock } = createDockerExecSyncMock({
      dockerAvailable: false,
      gitTopLevel: '/repo-root',
    });

    await expect(
      testApi.resolveStartupOrchestration({
        forceContainer: true,
        execSyncFn: execSyncMock,
        env: {},
      }),
    ).rejects.toThrow('--container requires orchestration, but Docker is unavailable.');
  });

  it('resolveStartupOrchestration force mode behaves like auto-detect when prerequisites are available', async () => {
    const testApi = loadCliTestApi();
    const { execSyncMock } = createDockerExecSyncMock({
      dockerAvailable: true,
      gitTopLevel: '/repo-root',
    });
    const bootstrapContainerModeFn = jest.fn().mockResolvedValue(undefined);
    const env: NodeJS.ProcessEnv = {};

    const resolution = await testApi.resolveStartupOrchestration({
      forceContainer: true,
      execSyncFn: execSyncMock,
      env,
      bootstrapContainerModeFn,
    });

    expect(resolution.enableOrchestration).toBe(true);
    expect(env.DEVCHAIN_MODE).toBe('main');
    expect(bootstrapContainerModeFn).toHaveBeenCalledTimes(1);
  });

  it('resolveStartupOrchestration warns and continues normal mode when bootstrap fails in auto-detect mode', async () => {
    const testApi = loadCliTestApi();
    const { execSyncMock } = createDockerExecSyncMock({
      dockerAvailable: true,
      gitTopLevel: '/repo-root',
    });
    const env: NodeJS.ProcessEnv = {};
    const warnFn = jest.fn();

    const resolution = await testApi.resolveStartupOrchestration({
      forceContainer: false,
      env,
      execSyncFn: execSyncMock,
      warnFn,
      bootstrapContainerModeFn: async () => {
        throw new Error('bootstrap exploded');
      },
    });

    expect(resolution.enableOrchestration).toBe(false);
    expect(resolution.bootstrapError).toBe('bootstrap exploded');
    expect(env.DEVCHAIN_MODE).toBeUndefined();
    expect(warnFn).toHaveBeenCalledWith(
      'Container auto-detection found prerequisites but bootstrap failed: bootstrap exploded',
    );
  });

  it('resolveStartupOrchestration throws when force mode bootstrap fails', async () => {
    const testApi = loadCliTestApi();
    const { execSyncMock } = createDockerExecSyncMock({
      dockerAvailable: true,
      gitTopLevel: '/repo-root',
    });

    await expect(
      testApi.resolveStartupOrchestration({
        forceContainer: true,
        execSyncFn: execSyncMock,
        env: {},
        bootstrapContainerModeFn: async () => {
          throw new Error('boom');
        },
      }),
    ).rejects.toThrow('--container failed to initialize orchestration: boom');
  });

  it('skips host preflights in orchestration mode', async () => {
    const testApi = loadCliTestApi();
    const log = jest.fn();
    const isTmuxInstalledFn = jest.fn().mockReturnValue(true);
    const detectInstalledProvidersFn = jest.fn().mockReturnValue(new Map([['codex', '/usr/bin/codex']]));
    const ensureClaudeBypassPermissionsFn = jest.fn().mockResolvedValue(undefined);

    await testApi.runHostPreflightChecks(
      {
        enableOrchestration: true,
        opts: { foreground: true },
        cli: { info: jest.fn(), step: jest.fn(), stepDone: jest.fn(), blank: jest.fn() },
        log,
        isDetachedChild: true,
      },
      {
        isTmuxInstalledFn,
        detectInstalledProvidersFn,
        ensureClaudeBypassPermissionsFn,
      },
    );

    expect(isTmuxInstalledFn).not.toHaveBeenCalled();
    expect(detectInstalledProvidersFn).not.toHaveBeenCalled();
    expect(ensureClaudeBypassPermissionsFn).not.toHaveBeenCalled();
  });

  it('runs host preflights in normal mode', async () => {
    const testApi = loadCliTestApi();
    const log = jest.fn();
    const isTmuxInstalledFn = jest.fn().mockReturnValue(true);
    const detectInstalledProvidersFn = jest
      .fn()
      .mockReturnValue(new Map([['codex', '/usr/bin/codex']]));
    const execSyncFn = jest.fn().mockReturnValue('/usr/bin/tmux\n');
    const opts: { foreground: boolean; __providersDetected?: Map<string, string> } = { foreground: true };

    await testApi.runHostPreflightChecks(
      {
        enableOrchestration: false,
        opts,
        cli: { info: jest.fn(), step: jest.fn(), stepDone: jest.fn(), blank: jest.fn() },
        log,
        isDetachedChild: true,
      },
      {
        execSyncFn,
        isTmuxInstalledFn,
        detectInstalledProvidersFn,
        platformFn: () => 'linux',
        getOSTypeFn: () => 'debian',
      },
    );

    expect(isTmuxInstalledFn).toHaveBeenCalled();
    expect(detectInstalledProvidersFn).toHaveBeenCalled();
    expect(opts.__providersDetected?.size).toBe(1);
  });

  it('selects UI dev script and URL in container mode', () => {
    const testApi = loadCliTestApi();
    const uiConfig = testApi.getDevUiConfig(true);

    expect(uiConfig).toEqual({
      script: 'dev:ui',
      startMessage: 'Starting UI (dev mode)...',
      logLabel: 'UI dev server',
      url: 'http://127.0.0.1:5175',
    });
  });

  it('selects normal UI dev script and URL outside container mode', () => {
    const testApi = loadCliTestApi();
    const uiConfig = testApi.getDevUiConfig(false);

    expect(uiConfig).toEqual({
      script: 'dev:ui',
      startMessage: 'Starting UI (dev mode)...',
      logLabel: 'UI dev server',
      url: 'http://127.0.0.1:5175',
    });
  });

  it('uses normal mode defaults for dev mode spawn config', () => {
    const testApi = loadCliTestApi();
    const env: NodeJS.ProcessEnv = {};
    testApi.applyContainerModeDefaults(false, {}, env);

    const preferredPort = testApi.getPreferredDevApiPort(undefined, false, env);
    const spawnConfig = testApi.getDevModeSpawnConfig({
      containerMode: false,
      port: preferredPort,
      env,
    });

    expect(preferredPort).toBe(3000);
    expect(spawnConfig.vite.args).toEqual(['--filter', 'local-app', 'dev:ui']);
    expect(spawnConfig.vite.env.VITE_API_PORT).toBe('3000');
    expect(spawnConfig.ui.logLabel).toBe('UI dev server');
    expect(spawnConfig.ui.url).toBe('http://127.0.0.1:5175');
    expect(env.DEVCHAIN_MODE).toBeUndefined();
  });

  it('uses orchestration mode defaults for dev mode spawn config with port 3000', () => {
    const testApi = loadCliTestApi();
    const env: NodeJS.ProcessEnv = {};
    testApi.applyContainerModeDefaults(true, {}, env);

    const preferredPort = testApi.getPreferredDevApiPort(undefined, true, env);
    const spawnConfig = testApi.getDevModeSpawnConfig({
      containerMode: true,
      port: preferredPort,
      env,
    });

    expect(env.DEVCHAIN_MODE).toBeUndefined();
    expect(preferredPort).toBe(3000);
    expect(spawnConfig.vite.args).toEqual(['--filter', 'local-app', 'dev:ui']);
    expect(spawnConfig.vite.env.VITE_API_PORT).toBe('3000');
    expect(spawnConfig.nest.env.DEVCHAIN_MODE).toBeUndefined();
    expect(spawnConfig.ui.logLabel).toBe('UI dev server');
    expect(spawnConfig.ui.url).toBe('http://127.0.0.1:5175');
  });

  it('bootstrap is idempotent across consecutive calls and does not pull/build image', async () => {
    const testApi = loadCliTestApi();
    const { execSyncMock, state } = createDockerExecSyncMock({
      gitTopLevel: '/repo-root',
    });

    await testApi.bootstrapContainerMode({ execSyncFn: execSyncMock });
    await testApi.bootstrapContainerMode({ execSyncFn: execSyncMock });

    expect(state.imageInspectCount).toBe(0);
    expect(state.imagePullCount).toBe(0);
    expect(state.imageBuildCount).toBe(0);
    expect(process.env.ORCHESTRATOR_CONTAINER_IMAGE).toMatch(/^ghcr\.io\/twitech-lab\/devchain:/);
    expect(process.env.REPO_ROOT).toBe('/repo-root');
  });

  it('bootstrapContainerMode appends .devchain/ to project .gitignore', async () => {
    const testApi = loadCliTestApi();
    const repoRoot = mkdtempSync(join(tempHome, 'repo-'));
    const gitignorePath = join(repoRoot, '.gitignore');
    writeFileSync(gitignorePath, 'dist/\n', 'utf8');

    const { execSyncMock } = createDockerExecSyncMock({
      gitTopLevel: repoRoot,
    });

    await testApi.bootstrapContainerMode({ execSyncFn: execSyncMock });

    expect(readFileSync(gitignorePath, 'utf8')).toBe('dist/\n.devchain/\n');
  });

  it('bootstrapContainerMode sets image ref without image inspect/pull/build', async () => {
    const testApi = loadCliTestApi();
    const { execSyncMock, state } = createDockerExecSyncMock({
      worktreeImageExists: false,
      gitTopLevel: '/repo-root',
    });

    await testApi.bootstrapContainerMode({ execSyncFn: execSyncMock });

    expect(state.imageInspectCount).toBe(0);
    expect(state.imageBuildCount).toBe(0);
    expect(state.imagePullCount).toBe(0);
    expect(process.env.ORCHESTRATOR_CONTAINER_IMAGE).toMatch(/^ghcr\.io\/twitech-lab\/devchain:/);
  });
});
