import { Injectable } from '@nestjs/common';
import { OrchestratorDockerService } from '../../docker/services/docker.service';
import type {
  ContainerInfo,
  CreateContainerConfig,
  DockerContainerEvent,
  WorktreeRuntime,
} from './worktree-runtime';

/**
 * Docker-backed {@link WorktreeRuntime}. Wraps the container lifecycle,
 * readiness wait, logs, compose-network reconciliation, and event stream of
 * {@link OrchestratorDockerService} behind the module-private runtime seam.
 *
 * Deliberately thin: it is the TRANSPORT boundary the worktrees service talks
 * through, keeping `OrchestratorDockerService` (and its non-worktree consumers)
 * out of the service's dependency surface. No policy lives here.
 */
@Injectable()
export class ContainerRuntime implements WorktreeRuntime {
  constructor(private readonly docker: OrchestratorDockerService) {}

  createContainer(config: CreateContainerConfig): Promise<ContainerInfo> {
    return this.docker.createContainer(config);
  }

  startContainer(containerId: string): Promise<void> {
    return this.docker.startContainer(containerId);
  }

  stopContainer(containerId: string): Promise<void> {
    return this.docker.stopContainer(containerId);
  }

  removeContainer(containerId: string, force?: boolean): Promise<void> {
    return this.docker.removeContainer(containerId, force);
  }

  waitForHealthy(containerId: string, timeoutMs: number): Promise<boolean> {
    return this.docker.waitForHealthy(containerId, timeoutMs);
  }

  getContainerHostPort(containerId: string): Promise<number | null> {
    return this.docker.getContainerHostPort(containerId);
  }

  getContainerLogs(containerId: string, tail: number): Promise<string> {
    return this.docker.getContainerLogs(containerId, tail);
  }

  ensureWorktreeOnComposeNetwork(worktreeName: string, containerId: string): Promise<void> {
    return this.docker.ensureWorktreeOnComposeNetwork(worktreeName, containerId);
  }

  removeWorktreeNetwork(worktreeName: string): Promise<void> {
    return this.docker.removeWorktreeNetwork(worktreeName);
  }

  cleanupWorktreeProjectContainers(
    worktreeName: string,
    containerId?: string | null,
  ): Promise<void> {
    return this.docker.cleanupWorktreeProjectContainers(worktreeName, containerId);
  }

  subscribeToContainerEvents(onEvent: (event: DockerContainerEvent) => void): Promise<() => void> {
    return this.docker.subscribeToContainerEvents(onEvent);
  }
}
