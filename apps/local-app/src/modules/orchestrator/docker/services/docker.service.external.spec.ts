import Dockerode = require('dockerode');
import { existsSync } from 'fs';
import { mkdtemp, mkdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { OrchestratorDockerService } from './docker.service';

describe('OrchestratorDockerService integration', () => {
  const dockerSocketPath = '/var/run/docker.sock';

  let dockerAvailable = false;
  let docker: Dockerode | null = null;
  let service: OrchestratorDockerService | null = null;

  beforeAll(async () => {
    if (!existsSync(dockerSocketPath)) {
      return;
    }

    docker = new Dockerode({ socketPath: dockerSocketPath });
    try {
      await docker.ping();
      dockerAvailable = true;
      service = new OrchestratorDockerService(docker);
    } catch {
      dockerAvailable = false;
      service = null;
    }
  });

  it('creates, validates readiness, executes command, and removes container', async () => {
    if (!dockerAvailable || !service) {
      return;
    }

    const tempRoot = await mkdtemp(join(tmpdir(), 'orchestrator-docker-integration-'));
    const worktreePath = join(tempRoot, 'worktree');
    const dataPath = join(tempRoot, 'data');
    await mkdir(worktreePath, { recursive: true });
    await mkdir(dataPath, { recursive: true });

    const containerName = `devchain-wt-integration-${Date.now()}`;
    let containerId: string | null = null;

    try {
      const info = await service.createContainer({
        name: containerName,
        image: process.env.ORCHESTRATOR_DOCKER_TEST_IMAGE ?? 'node:20-alpine',
        worktreePath,
        dataPath,
        command: [
          'node',
          '-e',
          "const http=require('http');http.createServer((req,res)=>{if(req.url==='/health/ready'){res.statusCode=200;res.end('ok');return;}res.statusCode=404;res.end('no');}).listen(3000,'0.0.0.0',()=>console.log('server-started'));setInterval(()=>console.log('tick'),1000);",
        ],
      });

      containerId = info.id;
      expect(info.id).toBeTruthy();
      expect(info.hostPort).not.toBeNull();

      const ready = await service.waitForHealthy(info.id, 30000);
      expect(ready).toBe(true);

      const execResult = await service.execInContainer(info.id, [
        'node',
        '-e',
        'process.stdout.write("exec-ok")',
      ]);
      expect(execResult.exitCode).toBe(0);
      expect(execResult.output).toContain('exec-ok');

      const logs = await service.getContainerLogs(info.id, 50);
      expect(logs).toContain('server-started');
    } finally {
      if (containerId) {
        await service.removeContainer(containerId, true).catch(() => undefined);
      }
      await rm(tempRoot, { recursive: true, force: true });
    }
  }, 180000);

  it('attaches worktree to compose network, resolves service name, and cleans labeled resources', async () => {
    if (!dockerAvailable || !docker || !service) {
      return;
    }

    const tempRoot = await mkdtemp(join(tmpdir(), 'orchestrator-compose-integration-'));
    const worktreePath = join(tempRoot, 'worktree');
    const dataPath = join(tempRoot, 'data');
    await mkdir(worktreePath, { recursive: true });
    await mkdir(dataPath, { recursive: true });

    const suffix = `${Date.now()}`;
    const worktreeName = `integration-${suffix}`;
    const worktreeContainerName = `devchain-wt-${worktreeName}`;
    const composeNetworkName = `${worktreeName}_default`;
    const serviceContainerName = `${worktreeName}-postgres-1`;
    const testImage = process.env.ORCHESTRATOR_DOCKER_TEST_IMAGE ?? 'node:20-alpine';

    let worktreeContainerId: string | null = null;
    let serviceContainerId: string | null = null;

    try {
      const worktreeInfo = await service.createContainer({
        name: worktreeContainerName,
        worktreeName,
        image: testImage,
        worktreePath,
        dataPath,
        command: ['node', '-e', 'setInterval(() => {}, 1_000);'],
      });
      worktreeContainerId = worktreeInfo.id;

      await docker.createNetwork({
        Name: composeNetworkName,
        CheckDuplicate: true,
        Labels: {
          'com.docker.compose.project': worktreeName,
          'com.docker.compose.network': 'default',
        },
      });

      const projectContainer = await docker.createContainer({
        name: serviceContainerName,
        Image: testImage,
        Cmd: ['node', '-e', 'setInterval(() => {}, 1_000);'],
        Labels: {
          'com.docker.compose.project': worktreeName,
          'com.docker.compose.service': 'postgres',
        },
        NetworkingConfig: {
          EndpointsConfig: {
            [composeNetworkName]: {
              Aliases: ['postgres'],
            },
          },
        },
      });
      await projectContainer.start();
      serviceContainerId = projectContainer.id;

      await service.ensureWorktreeOnComposeNetwork(worktreeName, worktreeInfo.id);

      const resolveResult = await service.execInContainer(worktreeInfo.id, [
        'node',
        '-e',
        "require('dns').lookup('postgres',(err)=>{if(err){console.error(err.message);process.exit(1);}process.stdout.write('reachable');});",
      ]);
      expect(resolveResult.exitCode).toBe(0);
      expect(resolveResult.output).toContain('reachable');

      await service.cleanupWorktreeProjectContainers(worktreeName, worktreeInfo.id);

      await expect(docker.getContainer(projectContainer.id).inspect()).rejects.toBeTruthy();

      await service.removeContainer(worktreeInfo.id, true).catch(() => undefined);
      worktreeContainerId = null;
      await service.removeWorktreeNetwork(worktreeName);

      await expect(docker.getNetwork(composeNetworkName).inspect()).rejects.toBeTruthy();
    } finally {
      if (serviceContainerId) {
        await service.removeContainer(serviceContainerId, true).catch(() => undefined);
      }
      if (worktreeContainerId) {
        await service.removeContainer(worktreeContainerId, true).catch(() => undefined);
      }
      await docker
        .getNetwork(composeNetworkName)
        .remove()
        .catch(() => undefined);
      await rm(tempRoot, { recursive: true, force: true });
    }
  }, 180000);
});
