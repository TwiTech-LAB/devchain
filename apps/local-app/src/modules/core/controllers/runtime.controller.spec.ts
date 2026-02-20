import { resetEnvConfig } from '../../../common/config/env.config';
import { RuntimeController } from './runtime.controller';
import { OrchestratorDockerService } from '../../orchestrator/docker/services/docker.service';

describe('RuntimeController', () => {
  const originalEnv = process.env;
  let controller: RuntimeController;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.DEVCHAIN_MODE;
    delete process.env.DATABASE_URL;
    delete process.env.REPO_ROOT;
    delete process.env.RUNTIME_TOKEN;
    resetEnvConfig();
    controller = new RuntimeController();
  });

  afterAll(() => {
    process.env = originalEnv;
    resetEnvConfig();
  });

  it('returns runtime mode and version in normal mode', async () => {
    const result = await controller.getRuntime();

    expect(result).toEqual({
      mode: 'normal',
      version: expect.any(String),
      dockerAvailable: false,
    });
  });

  it('returns runtime mode and version in main mode', async () => {
    process.env.DEVCHAIN_MODE = 'main';
    process.env.REPO_ROOT = process.cwd();
    resetEnvConfig();

    const result = await controller.getRuntime();

    expect(result).toEqual({
      mode: 'main',
      version: expect.any(String),
      dockerAvailable: false,
    });
  });

  it('includes runtimeToken when RUNTIME_TOKEN is set', async () => {
    process.env.RUNTIME_TOKEN = 'token-123';
    resetEnvConfig();

    const result = await controller.getRuntime();

    expect(result.runtimeToken).toBe('token-123');
  });

  it('caches docker availability checks in non-normal mode', async () => {
    const dockerService = {
      ping: jest.fn(async () => true),
    } as unknown as OrchestratorDockerService;

    controller = new RuntimeController(dockerService);
    process.env.DEVCHAIN_MODE = 'main';
    process.env.REPO_ROOT = process.cwd();
    resetEnvConfig();

    await controller.getRuntime();
    await controller.getRuntime();

    expect((dockerService.ping as unknown as jest.Mock).mock.calls).toHaveLength(1);
  });

  it('reports dockerAvailable=true when docker ping succeeds in main mode', async () => {
    const dockerService = {
      ping: jest.fn(async () => true),
    } as unknown as OrchestratorDockerService;

    controller = new RuntimeController(dockerService);
    process.env.DEVCHAIN_MODE = 'main';
    process.env.REPO_ROOT = process.cwd();
    resetEnvConfig();

    const result = await controller.getRuntime();

    expect(result.dockerAvailable).toBe(true);
    expect((dockerService.ping as unknown as jest.Mock).mock.calls).toHaveLength(1);
  });
});
