import { OrchestratorDockerService } from '../../docker/services/docker.service';
import { ContainerRuntime } from './container-runtime';
import type { ContainerInfo, CreateContainerConfig } from './worktree-runtime';

describe('ContainerRuntime', () => {
  let docker: jest.Mocked<
    Pick<
      OrchestratorDockerService,
      | 'createContainer'
      | 'startContainer'
      | 'stopContainer'
      | 'removeContainer'
      | 'waitForHealthy'
      | 'getContainerHostPort'
      | 'getContainerLogs'
      | 'ensureWorktreeOnComposeNetwork'
      | 'removeWorktreeNetwork'
      | 'cleanupWorktreeProjectContainers'
      | 'subscribeToContainerEvents'
    >
  >;
  let runtime: ContainerRuntime;

  beforeEach(() => {
    docker = {
      createContainer: jest.fn(),
      startContainer: jest.fn().mockResolvedValue(undefined),
      stopContainer: jest.fn().mockResolvedValue(undefined),
      removeContainer: jest.fn().mockResolvedValue(undefined),
      waitForHealthy: jest.fn().mockResolvedValue(true),
      getContainerHostPort: jest.fn().mockResolvedValue(41002),
      getContainerLogs: jest.fn().mockResolvedValue('logs'),
      ensureWorktreeOnComposeNetwork: jest.fn().mockResolvedValue(undefined),
      removeWorktreeNetwork: jest.fn().mockResolvedValue(undefined),
      cleanupWorktreeProjectContainers: jest.fn().mockResolvedValue(undefined),
      subscribeToContainerEvents: jest.fn(),
    } as unknown as typeof docker;
    runtime = new ContainerRuntime(docker as unknown as OrchestratorDockerService);
  });

  it('forwards createContainer to the docker service and returns its result', async () => {
    const config = {
      name: 'devchain-wt-x',
      worktreePath: '/wt',
      dataPath: '/data',
    } as CreateContainerConfig;
    const info: ContainerInfo = {
      id: 'container-1',
      name: 'devchain-wt-x',
      image: 'devchain:latest',
      hostPort: 41002,
      state: 'running',
    };
    docker.createContainer.mockResolvedValue(info);

    await expect(runtime.createContainer(config)).resolves.toBe(info);
    expect(docker.createContainer).toHaveBeenCalledWith(config);
  });

  it('forwards the container lifecycle calls verbatim', async () => {
    await runtime.startContainer('container-1');
    await runtime.stopContainer('container-1');
    await runtime.removeContainer('container-1', true);

    expect(docker.startContainer).toHaveBeenCalledWith('container-1');
    expect(docker.stopContainer).toHaveBeenCalledWith('container-1');
    expect(docker.removeContainer).toHaveBeenCalledWith('container-1', true);
  });

  it('forwards the readiness wait with its timeout', async () => {
    await expect(runtime.waitForHealthy('container-1', 60_000)).resolves.toBe(true);
    expect(docker.waitForHealthy).toHaveBeenCalledWith('container-1', 60_000);
  });

  it('forwards host-port and logs reads', async () => {
    await expect(runtime.getContainerHostPort('container-1')).resolves.toBe(41002);
    await expect(runtime.getContainerLogs('container-1', 50)).resolves.toBe('logs');
    expect(docker.getContainerHostPort).toHaveBeenCalledWith('container-1');
    expect(docker.getContainerLogs).toHaveBeenCalledWith('container-1', 50);
  });

  it('forwards compose-network reconciliation and teardown', async () => {
    await runtime.ensureWorktreeOnComposeNetwork('feature-auth', 'container-1');
    await runtime.removeWorktreeNetwork('feature-auth');
    await runtime.cleanupWorktreeProjectContainers('feature-auth', 'container-1');

    expect(docker.ensureWorktreeOnComposeNetwork).toHaveBeenCalledWith(
      'feature-auth',
      'container-1',
    );
    expect(docker.removeWorktreeNetwork).toHaveBeenCalledWith('feature-auth');
    expect(docker.cleanupWorktreeProjectContainers).toHaveBeenCalledWith(
      'feature-auth',
      'container-1',
    );
  });

  it('forwards the raw event subscription and returns the unsubscribe handle', async () => {
    const unsubscribe = jest.fn();
    const onEvent = jest.fn();
    docker.subscribeToContainerEvents.mockResolvedValue(unsubscribe);

    const handle = await runtime.subscribeToContainerEvents(onEvent);

    expect(docker.subscribeToContainerEvents).toHaveBeenCalledWith(onEvent);
    expect(handle).toBe(unsubscribe);
  });
});
