import type {
  CreateContainerConfig,
  ContainerInfo,
  DockerContainerEvent,
} from '../../docker/services/docker.service';

export type { CreateContainerConfig, ContainerInfo, DockerContainerEvent };

/**
 * Module-private runtime seam for a worktree's container mechanics.
 *
 * This is NOT an exported port: nothing outside `orchestrator/worktrees`
 * consumes it, and external callers keep knowing only `WorktreesService`. It
 * exists so the service depends on a single, narrow transport surface instead
 * of the whole {@link OrchestratorDockerService} (which also serves
 * non-worktree consumers).
 *
 * Transport vs. policy: every method here is pure TRANSPORT — it talks to
 * Docker and returns raw results. All POLICY (when to act, status transitions,
 * the 3-strike health counter, row-shape conditionals, event semantics) stays
 * in `WorktreesService`. In particular `subscribeToContainerEvents` only
 * forwards raw parsed events; the service's `handleContainerEvent` decides what
 * each action means.
 *
 * The service still owns the row-shape conditionals that decide WHICH rows get
 * container mechanics (`runtimeType === 'container' || row.containerId`), so
 * these methods are invoked by container id — never gated on the resolved
 * runtime kind. A process/unknown row that carries a legacy `containerId` is
 * driven through this same surface (see docs/worktree-runtime-matrix.md).
 */
export interface WorktreeRuntime {
  createContainer(config: CreateContainerConfig): Promise<ContainerInfo>;
  startContainer(containerId: string): Promise<void>;
  stopContainer(containerId: string): Promise<void>;
  removeContainer(containerId: string, force?: boolean): Promise<void>;
  waitForHealthy(containerId: string, timeoutMs: number): Promise<boolean>;
  getContainerHostPort(containerId: string): Promise<number | null>;
  getContainerLogs(containerId: string, tail: number): Promise<string>;
  ensureWorktreeOnComposeNetwork(worktreeName: string, containerId: string): Promise<void>;
  removeWorktreeNetwork(worktreeName: string): Promise<void>;
  cleanupWorktreeProjectContainers(
    worktreeName: string,
    containerId?: string | null,
  ): Promise<void>;
  /**
   * Subscribe to raw container lifecycle events. The adapter forwards each
   * parsed event verbatim; interpreting `Action`/`status` is the service's job.
   * Returns an unsubscribe function.
   */
  subscribeToContainerEvents(onEvent: (event: DockerContainerEvent) => void): Promise<() => void>;
}
