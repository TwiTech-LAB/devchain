import { Injectable, Optional } from '@nestjs/common';
import { execFileSync } from 'child_process';
import Dockerode = require('dockerode');
import { existsSync, readFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { dirname, join, posix } from 'path';
import { createLogger } from '../../../../common/logging/logger';
import { resolveTemplatesDirectory } from '../../../../common/templates-directory';

const logger = createLogger('OrchestratorDockerService');

const DOCKER_SOCKET_PATH = '/var/run/docker.sock';
const DEFAULT_CONTAINER_PORT = 3000;
const DEFAULT_CONTAINER_HOME_PATH = '/home/node';
const DEFAULT_CONTAINER_PROJECT_PATH = '/project';
const DEFAULT_CONTAINER_DATA_PATH = `${DEFAULT_CONTAINER_HOME_PATH}/.devchain`;
const DEFAULT_CONTAINER_SKILLS_SEED_PATH = '/seed-skills';
const DEFAULT_CONTAINER_TEMPLATES_PATH = '/app/apps/local-app/dist/templates';
const DEFAULT_CONTAINER_REGISTRY_CACHE_PATH = `${DEFAULT_CONTAINER_HOME_PATH}/.devchain/registry-cache`;
const WORKTREE_NETWORK_PREFIX = 'devchain-wt-';
const WORKTREE_NETWORK_SUFFIX = '-net';
const WORKTREE_CONTAINER_PREFIX = 'devchain-wt-';
const COMPOSE_PROJECT_LABEL = 'com.docker.compose.project';
const COMPOSE_DEFAULT_NETWORK_SUFFIX = '_default';
const HEALTH_POLL_INTERVAL_MS = 1000;
const HEALTH_REQUEST_TIMEOUT_MS = 1500;

export interface CreateContainerConfig {
  name: string;
  worktreePath: string;
  dataPath: string;
  image?: string;
  env?: Record<string, string>;
  labels?: Record<string, string>;
  command?: string[];
  entrypoint?: string[];
  additionalBinds?: string[];
  worktreeName?: string;
  containerProjectPath?: string;
  containerDataPath?: string;
  containerPort?: number;
}

export interface ContainerInfo {
  id: string;
  name: string;
  image: string;
  hostPort: number | null;
  state: string;
}

export interface ExecResult {
  exitCode: number;
  output: string;
}

export interface ExecOptions {
  workingDir?: string;
}

export interface DockerContainerEvent {
  id?: string;
  status?: string;
  Action?: string;
  Type?: string;
  from?: string;
  time?: number;
}

interface ProviderAuthMount {
  provider: string;
  bind: string;
}

function readGitConfig(worktreePath: string, key: string): string | null {
  try {
    return (
      execFileSync('git', ['-C', worktreePath, 'config', key], { encoding: 'utf-8' }).trim() || null
    );
  } catch {
    return null;
  }
}

@Injectable()
export class OrchestratorDockerService {
  constructor(
    @Optional()
    private readonly docker: Dockerode = new Dockerode({ socketPath: DOCKER_SOCKET_PATH }),
  ) {}

  async createContainer(config: CreateContainerConfig): Promise<ContainerInfo> {
    const containerPort = config.containerPort ?? DEFAULT_CONTAINER_PORT;
    const image = this.resolveContainerImage(config.image);
    const worktreeName = this.resolveWorktreeName(config);
    await this.ensureImageAvailable(image);
    const networkName = await this.ensureWorktreeNetwork(worktreeName);

    const envMap = this.buildEnvMap(config.env, worktreeName);

    // Resolve host git identity and inject into container env (don't clobber user-supplied values).
    const gitUserName = readGitConfig(config.worktreePath, 'user.name');
    const gitUserEmail = readGitConfig(config.worktreePath, 'user.email');
    if (gitUserName) {
      envMap.GIT_AUTHOR_NAME ??= gitUserName;
      envMap.GIT_COMMITTER_NAME ??= gitUserName;
    }
    if (gitUserEmail) {
      envMap.GIT_AUTHOR_EMAIL ??= gitUserEmail;
      envMap.GIT_COMMITTER_EMAIL ??= gitUserEmail;
    }

    const authMounts = this.discoverProviderAuthMounts();
    if (!envMap.ENABLED_PROVIDERS) {
      envMap.ENABLED_PROVIDERS = authMounts.map((mount) => mount.provider).join(',');
    }

    const binds = this.buildBindMounts(config, authMounts);
    const labels = this.buildLabels(config, worktreeName);

    logger.info(
      {
        name: config.name,
        worktreeName,
        networkName,
        image,
        bindCount: binds.length,
        providers: envMap.ENABLED_PROVIDERS,
      },
      'Creating orchestrator worktree container',
    );

    const container = await this.docker.createContainer({
      name: config.name,
      Image: image,
      Env: Object.entries(envMap).map(([key, value]) => `${key}=${value}`),
      Cmd: config.command,
      Entrypoint: config.entrypoint,
      Labels: labels,
      ExposedPorts: {
        [`${containerPort}/tcp`]: {},
      },
      HostConfig: {
        Binds: binds,
        CapAdd: ['SYS_PTRACE'],
        NetworkMode: networkName,
        PortBindings: {
          [`${containerPort}/tcp`]: [{ HostIp: '127.0.0.1', HostPort: '' }],
        },
      },
    });

    await container.start();
    await this.ensureWorktreeOnComposeNetwork(worktreeName, container.id).catch((error) => {
      logger.warn(
        { error, worktreeName, containerId: container.id },
        'Failed attaching worktree container to compose default network',
      );
    });
    const inspect = await container.inspect();

    return {
      id: container.id,
      name: inspect.Name.replace(/^\//, ''),
      image,
      hostPort: this.extractHostPort(inspect, containerPort),
      state: inspect.State?.Status ?? 'unknown',
    };
  }

  async startContainer(containerId: string): Promise<void> {
    await this.docker.getContainer(containerId).start();
  }

  async getContainerHostPort(
    containerId: string,
    containerPort = DEFAULT_CONTAINER_PORT,
  ): Promise<number | null> {
    const inspect = await this.docker.getContainer(containerId).inspect();
    return this.extractHostPort(inspect, containerPort);
  }

  async stopContainer(containerId: string): Promise<void> {
    await this.docker.getContainer(containerId).stop({ t: 30 });
  }

  async removeContainer(containerId: string, force = false): Promise<void> {
    await this.docker.getContainer(containerId).remove({ force });
  }

  async inspectContainer(containerId: string): Promise<Dockerode.ContainerInspectInfo> {
    return this.docker.getContainer(containerId).inspect();
  }

  async getContainerLogs(containerId: string, tail = 200): Promise<string> {
    const logs = await this.docker.getContainer(containerId).logs({
      stdout: true,
      stderr: true,
      timestamps: false,
      tail,
    });

    if (Buffer.isBuffer(logs)) {
      return this.decodeDockerMultiplexStream(logs);
    }

    const output = await this.readStreamFully(logs);
    return this.decodeDockerMultiplexStream(output);
  }

  async waitForHealthy(containerId: string, timeoutMs: number): Promise<boolean> {
    if (timeoutMs <= 0) {
      return false;
    }

    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const inspect = await this.inspectContainer(containerId);
      const hostPort = this.extractHostPort(inspect, DEFAULT_CONTAINER_PORT);

      if (hostPort) {
        const isHealthy = await this.checkReadyEndpoint(hostPort);
        if (isHealthy) {
          return true;
        }
      }

      await this.sleep(HEALTH_POLL_INTERVAL_MS);
    }

    return false;
  }

  async execInContainer(
    containerId: string,
    cmd: string[],
    options?: ExecOptions,
  ): Promise<ExecResult> {
    const exec = await this.docker.getContainer(containerId).exec({
      Cmd: cmd,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      WorkingDir: options?.workingDir,
    });

    const stream = await exec.start({ hijack: false, stdin: false });
    const outputBuffer = await this.readStreamFully(stream);
    const inspect = await exec.inspect();

    return {
      exitCode: inspect.ExitCode ?? 1,
      output: this.decodeDockerMultiplexStream(outputBuffer),
    };
  }

  async subscribeToContainerEvents(
    onEvent: (event: DockerContainerEvent) => void,
  ): Promise<() => void> {
    const filters = JSON.stringify({ type: ['container'] });
    const stream = await this.docker.getEvents({ filters });

    let buffered = '';
    const onData = (chunk: Buffer | string) => {
      buffered += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }
        try {
          const parsed = JSON.parse(line) as DockerContainerEvent;
          onEvent(parsed);
        } catch (error) {
          logger.warn({ error, line }, 'Failed parsing docker event line');
        }
      }
    };

    const onError = (error: unknown) => {
      logger.warn({ error }, 'Docker events stream error');
    };

    stream.on('data', onData);
    stream.on('error', onError);

    return () => {
      stream.off('data', onData);
      stream.off('error', onError);
      if ('destroy' in stream && typeof stream.destroy === 'function') {
        stream.destroy();
      }
    };
  }

  async ping(): Promise<boolean> {
    try {
      await this.docker.ping();
      return true;
    } catch {
      return false;
    }
  }

  async cleanupWorktreeProjectContainers(
    worktreeName: string,
    worktreeContainerId?: string | null,
  ): Promise<void> {
    const normalizedWorktreeName = worktreeName.trim();
    if (!normalizedWorktreeName) {
      return;
    }

    const networkName = this.getWorktreeNetworkName(normalizedWorktreeName);
    const worktreeContainerName = this.getWorktreeContainerName(normalizedWorktreeName);

    if (worktreeContainerId) {
      await this.tryComposeDown(normalizedWorktreeName, worktreeContainerId);
    }

    await this.cleanupComposeProjectContainers({
      composeProjectName: normalizedWorktreeName,
      worktreeContainerId: worktreeContainerId ?? undefined,
      worktreeContainerName,
    });
    await this.cleanupComposeProjectNetworks(normalizedWorktreeName);

    await this.cleanupContainersAttachedToNetwork({
      networkName,
      worktreeContainerId: worktreeContainerId ?? undefined,
      worktreeContainerName,
    });
  }

  async ensureWorktreeOnComposeNetwork(worktreeName: string, containerId: string): Promise<void> {
    const normalizedWorktreeName = worktreeName.trim();
    const normalizedContainerId = containerId.trim();
    if (!normalizedWorktreeName || !normalizedContainerId) {
      return;
    }

    const composeNetworkName = this.getComposeDefaultNetworkName(normalizedWorktreeName);
    const network = this.docker.getNetwork(composeNetworkName);
    let inspect: Dockerode.NetworkInspectInfo;
    try {
      inspect = await network.inspect();
    } catch (error) {
      if (this.isDockerNotFoundError(error)) {
        return;
      }
      logger.warn(
        { error, worktreeName: normalizedWorktreeName, networkName: composeNetworkName },
        'Failed inspecting compose network for worktree attachment',
      );
      return;
    }

    const attached = Object.keys(inspect.Containers ?? {}).some((id) =>
      this.matchesContainerId(normalizedContainerId, id),
    );
    if (attached) {
      return;
    }

    if (typeof (network as { connect?: unknown }).connect !== 'function') {
      return;
    }

    try {
      await network.connect({ Container: normalizedContainerId });
    } catch (error) {
      if (this.isDockerNotFoundError(error) || this.isAlreadyConnectedError(error)) {
        return;
      }
      logger.warn(
        {
          error,
          worktreeName: normalizedWorktreeName,
          containerId: normalizedContainerId,
          networkName: composeNetworkName,
        },
        'Failed connecting worktree container to compose network',
      );
    }
  }

  async removeWorktreeNetwork(worktreeName: string): Promise<void> {
    const normalizedWorktreeName = worktreeName.trim();
    if (!normalizedWorktreeName) {
      return;
    }

    await this.removeNetworkByName(this.getWorktreeNetworkName(normalizedWorktreeName));
    await this.removeNetworkByName(this.getComposeDefaultNetworkName(normalizedWorktreeName));
  }

  private buildEnvMap(
    userEnv: Record<string, string> | undefined,
    worktreeName: string,
  ): Record<string, string> {
    const envMap: Record<string, string> = {
      HOST: '0.0.0.0',
      NODE_ENV: 'production',
      ...(userEnv ?? {}),
    };

    if (!envMap.COMPOSE_PROJECT_NAME) {
      envMap.COMPOSE_PROJECT_NAME = worktreeName;
    }
    return envMap;
  }

  private buildLabels(config: CreateContainerConfig, worktreeName: string): Record<string, string> {
    return {
      'devchain.worktree': worktreeName,
      ...(config.labels ?? {}),
    };
  }

  private buildBindMounts(
    config: CreateContainerConfig,
    authMounts: ProviderAuthMount[],
  ): string[] {
    const containerProjectPath = config.containerProjectPath ?? DEFAULT_CONTAINER_PROJECT_PATH;
    const containerDataPath = config.containerDataPath ?? DEFAULT_CONTAINER_DATA_PATH;

    const binds = [
      `${config.worktreePath}:${containerProjectPath}:rw`,
      `${config.dataPath}:${containerDataPath}:rw`,
      ...authMounts.map((mount) => mount.bind),
      ...(config.additionalBinds ?? []),
      `${DOCKER_SOCKET_PATH}:${DOCKER_SOCKET_PATH}:rw`,
    ];

    const gitCommonDirMount = this.discoverGitCommonDirMount(config.worktreePath);
    if (gitCommonDirMount) {
      binds.push(gitCommonDirMount);
    }

    const skillsSeedMount = this.discoverSkillsSeedMount();
    if (skillsSeedMount) {
      binds.push(skillsSeedMount);
    }

    const templatesMounts = this.discoverTemplatesMounts();
    binds.push(...templatesMounts);

    return binds;
  }

  private discoverGitCommonDirMount(worktreePath: string): string | null {
    const gitPath = join(worktreePath, '.git');
    if (!existsSync(gitPath)) {
      return null;
    }

    let gitPathStats: ReturnType<typeof statSync>;
    try {
      gitPathStats = statSync(gitPath);
    } catch (error) {
      logger.warn({ error, gitPath }, 'Failed to stat .git path while resolving bind mounts');
      return null;
    }

    if (gitPathStats.isDirectory()) {
      return null;
    }
    if (!gitPathStats.isFile()) {
      logger.warn({ gitPath }, 'Skipping git metadata mount: .git is not a file or directory');
      return null;
    }

    let gitdirPath: string | null = null;
    try {
      const gitFileContents = readFileSync(gitPath, 'utf8');
      const gitdirLine = gitFileContents
        .split(/\r?\n/)
        .find((line) => line.trimStart().toLowerCase().startsWith('gitdir:'));
      if (gitdirLine) {
        gitdirPath = gitdirLine.slice(gitdirLine.indexOf(':') + 1).trim();
      }
    } catch (error) {
      logger.warn({ error, gitPath }, 'Failed to read .git file while resolving bind mounts');
      return null;
    }

    if (!gitdirPath) {
      logger.warn({ gitPath }, 'Skipping git metadata mount: .git file missing gitdir entry');
      return null;
    }
    if (!posix.isAbsolute(gitdirPath)) {
      logger.warn(
        { gitPath, gitdirPath },
        'Skipping git metadata mount: gitdir path is not POSIX-absolute',
      );
      return null;
    }

    const repoGitCommonDir = dirname(dirname(gitdirPath));
    try {
      const commonDirStats = statSync(repoGitCommonDir);
      if (!commonDirStats.isDirectory()) {
        logger.warn(
          { gitPath, gitdirPath, repoGitCommonDir },
          'Skipping git metadata mount: computed git common dir is not a directory',
        );
        return null;
      }
    } catch (error) {
      logger.warn(
        { error, gitPath, gitdirPath, repoGitCommonDir },
        'Skipping git metadata mount: computed git common dir does not exist',
      );
      return null;
    }

    return `${repoGitCommonDir}:${repoGitCommonDir}:rw`;
  }

  private discoverProviderAuthMounts(): ProviderAuthMount[] {
    const home = this.getHostHomeDir();
    const providers = [
      {
        provider: 'claude',
        source: join(home, '.claude', '.credentials.json'),
        target: `${DEFAULT_CONTAINER_HOME_PATH}/.claude/.credentials.json`,
      },
      {
        provider: 'codex',
        source: join(home, '.codex', 'auth.json'),
        target: `${DEFAULT_CONTAINER_HOME_PATH}/.codex/auth.json`,
      },
      {
        provider: 'gemini',
        source: join(home, '.gemini', 'oauth_creds.json'),
        target: `${DEFAULT_CONTAINER_HOME_PATH}/.gemini/oauth_creds.json`,
      },
    ];

    return providers
      .filter((provider) => existsSync(provider.source))
      .map((provider) => ({
        provider: provider.provider,
        bind: `${provider.source}:${provider.target}:ro`,
      }));
  }

  private discoverSkillsSeedMount(): string | null {
    const hostSkillsPath = join(this.getHostHomeDir(), '.devchain', 'skills');
    if (!existsSync(hostSkillsPath)) {
      return null;
    }
    return `${hostSkillsPath}:${DEFAULT_CONTAINER_SKILLS_SEED_PATH}:ro`;
  }

  private discoverTemplatesMounts(): string[] {
    const mounts: string[] = [];

    // Built-in templates directory
    const hostTemplatesDir = resolveTemplatesDirectory(__dirname);
    if (hostTemplatesDir) {
      mounts.push(`${hostTemplatesDir}:${DEFAULT_CONTAINER_TEMPLATES_PATH}:ro`);
    }

    // Registry-cached templates (nested mount inside the dataPath → ~/.devchain bind)
    const hostRegistryCache = join(this.getHostHomeDir(), '.devchain', 'registry-cache');
    if (existsSync(hostRegistryCache)) {
      mounts.push(`${hostRegistryCache}:${DEFAULT_CONTAINER_REGISTRY_CACHE_PATH}:ro`);
    }

    return mounts;
  }

  private getHostHomeDir(): string {
    return process.env.HOME?.trim() || homedir();
  }

  private resolveWorktreeName(config: CreateContainerConfig): string {
    const explicit = config.worktreeName?.trim();
    if (explicit) {
      return explicit;
    }
    const derived = config.name.replace(/^devchain-wt-/, '').trim();
    return derived || config.name.trim();
  }

  private resolveContainerImage(explicitImage?: string): string {
    const imageFromConfig = explicitImage?.trim();
    if (imageFromConfig) {
      return imageFromConfig;
    }

    const imageFromEnv = process.env.ORCHESTRATOR_CONTAINER_IMAGE?.trim();
    if (imageFromEnv) {
      return imageFromEnv;
    }

    const mode = process.env.DEVCHAIN_MODE?.trim();
    if (mode === 'orchestrator' || mode === 'main') {
      throw new Error(
        'ORCHESTRATOR_CONTAINER_IMAGE is required in container mode. Set it to a versioned GHCR image reference.',
      );
    }

    throw new Error(
      'Container image is required. Provide config.image or set ORCHESTRATOR_CONTAINER_IMAGE.',
    );
  }

  private getWorktreeNetworkName(worktreeName: string): string {
    return `${WORKTREE_NETWORK_PREFIX}${worktreeName}${WORKTREE_NETWORK_SUFFIX}`;
  }

  private getWorktreeContainerName(worktreeName: string): string {
    return `${WORKTREE_CONTAINER_PREFIX}${worktreeName}`;
  }

  private getComposeDefaultNetworkName(worktreeName: string): string {
    return `${worktreeName}${COMPOSE_DEFAULT_NETWORK_SUFFIX}`;
  }

  private async ensureWorktreeNetwork(worktreeName: string): Promise<string> {
    const networkName = this.getWorktreeNetworkName(worktreeName);
    try {
      await this.docker.getNetwork(networkName).inspect();
      return networkName;
    } catch {
      // Network doesn't exist yet; create it.
    }

    try {
      await this.docker.createNetwork({
        Name: networkName,
        CheckDuplicate: true,
        Labels: {
          'devchain.worktree': worktreeName,
          'devchain.managed': 'true',
        },
      });
      return networkName;
    } catch {
      // Handle create races by re-checking the expected network name.
      await this.docker.getNetwork(networkName).inspect();
      return networkName;
    }
  }

  private async tryComposeDown(worktreeName: string, containerId: string): Promise<void> {
    try {
      const result = await this.execInContainer(
        containerId,
        ['docker', 'compose', '-p', worktreeName, 'down', '--remove-orphans'],
        { workingDir: DEFAULT_CONTAINER_PROJECT_PATH },
      );
      if (result.exitCode !== 0) {
        logger.warn(
          {
            worktreeName,
            containerId,
            exitCode: result.exitCode,
            output: result.output,
          },
          'docker compose down returned non-zero exit code; continuing with fallback cleanup',
        );
      }
    } catch (error) {
      logger.warn(
        { error, worktreeName, containerId },
        'docker compose down failed; continuing with fallback cleanup',
      );
    }
  }

  private async cleanupContainersAttachedToNetwork(input: {
    networkName: string;
    worktreeContainerId?: string;
    worktreeContainerName: string;
  }): Promise<void> {
    const network = this.docker.getNetwork(input.networkName);
    let inspect: Dockerode.NetworkInspectInfo;
    try {
      inspect = await network.inspect();
    } catch (error) {
      if (this.isDockerNotFoundError(error)) {
        return;
      }
      logger.warn(
        { error, networkName: input.networkName },
        'Failed inspecting worktree network for fallback cleanup',
      );
      return;
    }

    const containers = inspect.Containers ?? {};
    for (const [containerId, containerInfo] of Object.entries(containers)) {
      const containerName = containerInfo?.Name;
      if (
        (input.worktreeContainerId &&
          this.matchesContainerId(input.worktreeContainerId, containerId)) ||
        containerName === input.worktreeContainerName
      ) {
        continue;
      }

      try {
        await this.stopContainer(containerId);
      } catch {
        // Container may already be stopped/removed.
      }

      try {
        await this.removeContainer(containerId, true);
      } catch (error) {
        if (this.isDockerNotFoundError(error)) {
          continue;
        }
        logger.warn(
          { error, containerId, networkName: input.networkName },
          'Failed removing project sub-container during fallback cleanup',
        );
      }
    }
  }

  private async cleanupComposeProjectContainers(input: {
    composeProjectName: string;
    worktreeContainerId?: string;
    worktreeContainerName: string;
  }): Promise<void> {
    let containers: Dockerode.ContainerInfo[] = [];
    try {
      containers = await this.docker.listContainers({
        all: true,
        filters: {
          label: [`${COMPOSE_PROJECT_LABEL}=${input.composeProjectName}`],
        },
      });
    } catch (error) {
      logger.warn(
        { error, composeProjectName: input.composeProjectName },
        'Failed listing compose project containers for cleanup',
      );
      return;
    }

    for (const container of containers) {
      const containerId = container.Id;
      if (!containerId) {
        continue;
      }
      const names = container.Names ?? [];
      const normalizedNames = names.map((name) => name.replace(/^\//, ''));
      if (
        (input.worktreeContainerId &&
          this.matchesContainerId(input.worktreeContainerId, containerId)) ||
        normalizedNames.includes(input.worktreeContainerName)
      ) {
        continue;
      }

      try {
        await this.stopContainer(containerId);
      } catch {
        // Container may already be stopped/removed.
      }

      try {
        await this.removeContainer(containerId, true);
      } catch (error) {
        if (this.isDockerNotFoundError(error)) {
          continue;
        }
        logger.warn(
          { error, containerId, composeProjectName: input.composeProjectName },
          'Failed removing compose project container during cleanup',
        );
      }
    }
  }

  private async cleanupComposeProjectNetworks(composeProjectName: string): Promise<void> {
    let networks: Dockerode.NetworkInspectInfo[] = [];
    try {
      networks = await this.docker.listNetworks({
        filters: {
          label: [`${COMPOSE_PROJECT_LABEL}=${composeProjectName}`],
        },
      });
    } catch (error) {
      logger.warn(
        { error, composeProjectName },
        'Failed listing compose project networks for cleanup',
      );
      return;
    }

    for (const networkInfo of networks) {
      const networkId = networkInfo.Id;
      const networkName = networkInfo.Name;
      if (!networkId) {
        continue;
      }
      try {
        await this.docker.getNetwork(networkId).remove();
      } catch (error) {
        if (this.isDockerNotFoundError(error) || this.isNetworkInUseError(error)) {
          continue;
        }
        logger.warn(
          { error, composeProjectName, networkId, networkName },
          'Failed removing compose project network during cleanup',
        );
      }
    }
  }

  private matchesContainerId(expected: string, actual: string): boolean {
    return expected === actual || expected.startsWith(actual) || actual.startsWith(expected);
  }

  private isDockerNotFoundError(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
      return false;
    }
    const maybeError = error as { statusCode?: number; reason?: string; message?: string };
    if (maybeError.statusCode === 404) {
      return true;
    }
    const message = `${maybeError.reason ?? ''} ${maybeError.message ?? ''}`.toLowerCase();
    return message.includes('not found') || message.includes('no such');
  }

  private isAlreadyConnectedError(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
      return false;
    }
    const maybeError = error as { statusCode?: number; reason?: string; message?: string };
    if (maybeError.statusCode === 409) {
      return true;
    }
    const message = `${maybeError.reason ?? ''} ${maybeError.message ?? ''}`.toLowerCase();
    return (
      message.includes('already exists') ||
      message.includes('already connected') ||
      message.includes('endpoint with name')
    );
  }

  private isNetworkInUseError(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
      return false;
    }
    const maybeError = error as { statusCode?: number; reason?: string; message?: string };
    if (maybeError.statusCode === 409) {
      return true;
    }
    const message = `${maybeError.reason ?? ''} ${maybeError.message ?? ''}`.toLowerCase();
    return message.includes('active endpoints') || message.includes('resource is still in use');
  }

  private async removeNetworkByName(networkName: string): Promise<void> {
    try {
      await this.docker.getNetwork(networkName).remove();
    } catch (error) {
      if (this.isDockerNotFoundError(error)) {
        return;
      }
      logger.warn({ error, networkName }, 'Failed to remove docker network');
    }
  }

  private async ensureImageAvailable(image: string): Promise<void> {
    try {
      await this.docker.getImage(image).inspect();
      return;
    } catch {
      logger.info({ image }, 'Docker image not found locally; pulling');
    }

    const pullStream = await this.docker.pull(image);
    await new Promise<void>((resolve, reject) => {
      this.docker.modem.followProgress(pullStream, (error: unknown) =>
        error ? reject(error) : resolve(),
      );
    });
  }

  private extractHostPort(
    inspect: Dockerode.ContainerInspectInfo,
    containerPort: number,
  ): number | null {
    const key = `${containerPort}/tcp`;
    const bindings = inspect.NetworkSettings?.Ports?.[key];
    const hostPortRaw = bindings?.[0]?.HostPort;
    if (!hostPortRaw) {
      return null;
    }

    const parsed = Number.parseInt(hostPortRaw, 10);
    return Number.isNaN(parsed) ? null : parsed;
  }

  private async checkReadyEndpoint(hostPort: number): Promise<boolean> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), HEALTH_REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(`http://127.0.0.1:${hostPort}/health/ready`, {
        signal: controller.signal,
      });
      return response.status === 200;
    } catch {
      return false;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async readStreamFully(stream: NodeJS.ReadableStream): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
    });
  }

  private decodeDockerMultiplexStream(buffer: Buffer): string {
    if (buffer.length < 8) {
      return buffer.toString('utf8');
    }

    const chunks: string[] = [];
    let offset = 0;

    while (offset + 8 <= buffer.length) {
      const payloadLength = buffer.readUInt32BE(offset + 4);
      const payloadStart = offset + 8;
      const payloadEnd = payloadStart + payloadLength;

      if (payloadLength < 0 || payloadEnd > buffer.length) {
        return buffer.toString('utf8');
      }

      chunks.push(buffer.subarray(payloadStart, payloadEnd).toString('utf8'));
      offset = payloadEnd;
    }

    if (offset !== buffer.length) {
      return buffer.toString('utf8');
    }

    return chunks.join('');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
