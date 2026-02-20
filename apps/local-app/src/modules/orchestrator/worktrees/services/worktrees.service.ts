import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ChildProcess, spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { createLogger } from '../../../../common/logging/logger';
import { getEnvConfig } from '../../../../common/config/env.config';
import { EventLogService } from '../../../events/services/event-log.service';
import {
  CreateWorktreeDto,
  WorktreeMergeConflictDto,
  WorktreeMergePreviewDto,
  WorktreeLogsQueryDto,
  WorktreeOverviewDto,
  WorktreeResponseDto,
  WorktreeStatusSchema,
} from '../dtos/worktree.dto';
import { WORKTREES_STORE, WorktreeRecord, WorktreesStore } from '../worktrees.store';
import { GitWorktreeService } from '../../git/services/git-worktree.service';
import { OrchestratorDockerService } from '../../docker/services/docker.service';
import { SeedPreparationService } from '../../docker/services/seed-preparation.service';
import { WORKTREE_TASK_MERGE_REQUESTED_EVENT } from '../../sync/events/task-merge.events';
import { WORKTREE_CHANGED_EVENT, WorktreeChangedEvent } from '../events/worktree.events';
import { mkdir, open, readFile, rm } from 'fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'path';
import { isValidGitBranchName, isValidWorktreeName } from '../worktree-validation';

const logger = createLogger('OrchestratorWorktreesService');

const CONTAINER_HEALTH_TIMEOUT_MS = 60_000;
const HEALTH_MONITOR_INTERVAL_MS = 15_000;
const HEALTH_MONITOR_PROBE_TIMEOUT_MS = 1_500;
const MAX_CONSECUTIVE_HEALTH_FAILURES = 3;
const OVERVIEW_FETCH_TIMEOUT_MS = 2_500;
const PROCESS_SHUTDOWN_TIMEOUT_MS = 30_000;
const PROCESS_KILL_TIMEOUT_MS = 5_000;
const PROCESS_LOG_FILE_NAME = 'devchain.log';
const PROCESS_DB_FILE_NAME = 'devchain.db';
const PROCESS_RUNTIME_PORT_FILE = 'runtime-port.json';
const PROCESS_HEALTH_POLL_INTERVAL_MS = 1_000;
const PROCESS_RUNTIME_TIMEOUT_MS = 1_500;
const WORKTREE_ACTIVITY_EVENT_NAME = 'orchestrator.worktree.activity';

const WORKTREE_STATUS_VALUES = WorktreeStatusSchema.options;
type WorktreeStatus = (typeof WORKTREE_STATUS_VALUES)[number];
type WorktreeRuntimeType = 'container' | 'process';
type WorktreeActivityType =
  | 'created'
  | 'started'
  | 'stopped'
  | 'deleted'
  | 'merged'
  | 'rebased'
  | 'error';

interface WorktreeActivity {
  type: WorktreeActivityType;
  message: string;
}

interface RegisterProjectResult {
  projectId: string;
}

interface RuntimeMetadataResponse {
  runtimeToken?: string;
}

interface StartedProcessRuntime {
  processId: number;
  hostPort: number;
  runtimeToken: string;
  startedAt: Date;
}

interface WorktreeContainerEvent {
  id?: string;
  status?: string;
  Action?: string;
  Type?: string;
}

interface ContainerEpicsResponse {
  items?: Array<{ statusId?: string }>;
  total?: number;
}

interface ContainerStatusesResponse {
  items?: Array<{ id?: string; label?: string }>;
}

interface ContainerAgentsResponse {
  total?: number;
}

@Injectable()
export class WorktreesService implements OnModuleInit, OnModuleDestroy {
  private monitorTimer?: NodeJS.Timeout;
  private unsubscribeDockerEvents?: () => void;
  private readonly consecutiveHealthFailures = new Map<string, number>();

  constructor(
    @Inject(WORKTREES_STORE) private readonly store: WorktreesStore,
    private readonly dockerService: OrchestratorDockerService,
    private readonly gitService: GitWorktreeService,
    private readonly seedPreparationService: SeedPreparationService,
    private readonly eventEmitter: EventEmitter2,
    private readonly eventLogService: EventLogService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.monitorTimer = setInterval(() => {
      this.monitorRunningWorktrees().catch((error) => {
        logger.error({ error }, 'Failed to monitor running worktrees');
      });
    }, HEALTH_MONITOR_INTERVAL_MS);

    this.reconcileProcessOrphans().catch((error) => {
      logger.warn({ error }, 'Failed process-runtime orphan detection on startup');
    });

    try {
      this.unsubscribeDockerEvents = await this.dockerService.subscribeToContainerEvents(
        (event) => {
          this.handleContainerEvent(event).catch((error) => {
            logger.error({ error, event }, 'Failed handling docker container event');
          });
        },
      );
    } catch (error) {
      logger.warn({ error }, 'Failed to subscribe to docker events stream');
    }
  }

  onModuleDestroy(): void {
    if (this.monitorTimer) {
      clearInterval(this.monitorTimer);
      this.monitorTimer = undefined;
    }
    if (this.unsubscribeDockerEvents) {
      this.unsubscribeDockerEvents();
      this.unsubscribeDockerEvents = undefined;
    }
  }

  async createWorktree(input: CreateWorktreeDto): Promise<WorktreeResponseDto> {
    this.assertValidWorktreeName(input.name);
    this.assertValidBranchName(input.branchName, 'branchName');
    this.assertValidBranchName(input.baseBranch, 'baseBranch');

    const runtimeType = this.resolveRuntimeType(input.runtimeType);
    const repoPath = this.resolveRepoPath(input.repoPath);
    const existing = await this.store.getByName(input.name);
    if (existing) {
      throw new ConflictException(`Worktree with name "${input.name}" already exists`);
    }

    const worktreePath = this.resolveWorktreePath(repoPath, input.name);
    const dataPath = this.resolveDataPath(repoPath, input.name);
    const containerName = this.getContainerName(input.name);
    const projectId = randomUUID();

    let created = await this.store.create({
      name: input.name,
      branchName: input.branchName,
      baseBranch: input.baseBranch,
      repoPath,
      worktreePath,
      templateSlug: input.templateSlug,
      ownerProjectId: input.ownerProjectId,
      status: 'creating',
      description: input.description ?? null,
      runtimeType,
    });

    let containerId: string | null = null;
    let processId: number | null = null;
    let gitWorktreeCreated = false;

    try {
      await this.gitService.createWorktree({
        name: input.name,
        branchName: input.branchName,
        baseBranch: input.baseBranch,
        repoPath,
        worktreePath,
      });
      gitWorktreeCreated = true;

      await mkdir(dataPath, { recursive: true });
      await this.seedPreparationService.prepareSeedData(dataPath);

      if (runtimeType === 'process') {
        const runtime = await this.startProcessRuntime({
          worktreePath,
          dataPath,
          projectId,
        });
        processId = runtime.processId;

        const project = await this.registerProjectInContainer(runtime.hostPort, {
          name: input.name,
          templateSlug: input.templateSlug,
          description: input.description ?? null,
          projectId,
          rootPath: worktreePath,
          presetName: input.presetName,
        });

        created = (await this.store.update(created.id, {
          containerId: null,
          processId: runtime.processId,
          runtimeToken: runtime.runtimeToken,
          startedAt: runtime.startedAt,
          containerPort: runtime.hostPort,
          devchainProjectId: project.projectId,
          status: 'running',
          errorMessage: null,
        })) as WorktreeRecord;
      } else {
        const container = await this.dockerService.createContainer({
          name: containerName,
          worktreePath,
          dataPath,
          worktreeName: input.name,
          env: {
            CONTAINER_PROJECT_ID: projectId,
          },
        });
        containerId = container.id;
        await this.dockerService
          .ensureWorktreeOnComposeNetwork(input.name, container.id)
          .catch(() => undefined);

        const healthy = await this.dockerService.waitForHealthy(
          container.id,
          CONTAINER_HEALTH_TIMEOUT_MS,
        );
        if (!healthy) {
          throw new Error('Container did not become healthy before timeout');
        }

        const project = await this.registerProjectInContainer(container.hostPort, {
          name: input.name,
          templateSlug: input.templateSlug,
          description: input.description ?? null,
          projectId,
          rootPath: '/project',
          presetName: input.presetName,
        });

        created = (await this.store.update(created.id, {
          containerId: container.id,
          containerPort: container.hostPort,
          devchainProjectId: project.projectId,
          status: 'running',
          errorMessage: null,
        })) as WorktreeRecord;
      }

      this.consecutiveHealthFailures.set(created.id, 0);

      this.eventEmitter.emit(WORKTREE_CHANGED_EVENT, {
        worktreeId: created.id,
      } satisfies WorktreeChangedEvent);
      this.recordWorktreeActivity({
        worktreeId: created.id,
        worktreeName: created.name,
        ownerProjectId: created.ownerProjectId,
        type: 'created',
        message: `Worktree '${created.name}' created on branch ${created.branchName}`,
      });

      return this.toResponse(created);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await this.tryUpdateStatus(created.id, 'error', {
        errorMessage,
      });

      if (containerId) {
        await this.dockerService.removeContainer(containerId, true).catch(() => undefined);
      }
      if (processId) {
        await this.terminateProcess(processId).catch(() => undefined);
      }

      if (gitWorktreeCreated) {
        await this.gitService.removeWorktree(worktreePath, repoPath, true).catch(() => undefined);
        if (created.branchName !== created.baseBranch) {
          await this.gitService
            .deleteBranch(created.branchName, repoPath, true)
            .catch((cleanupError) =>
              logger.warn(
                {
                  error: cleanupError,
                  worktreeId: created.id,
                  branchName: created.branchName,
                },
                'Failed to clean up branch after create-worktree error',
              ),
            );
        }
      }

      // Log child process output before cleanup for debugging
      const logPath = this.resolveProcessLogPath(dataPath);
      try {
        const logContent = await readFile(logPath, 'utf-8');
        if (logContent.trim()) {
          logger.error(
            { worktreeId: created.id, logContent: logContent.slice(-2000) },
            'Process runtime log before cleanup',
          );
        }
      } catch {
        // Log file may not exist
      }

      await rm(dataPath, { recursive: true, force: true }).catch(() => undefined);
      throw new BadRequestException(`Failed to create worktree: ${errorMessage}`);
    }
  }

  async listWorktrees(): Promise<WorktreeResponseDto[]> {
    const rows = await this.store.list();
    return Promise.all(rows.map((row) => this.toResponse(row)));
  }

  async listByOwnerProject(ownerProjectId: string): Promise<WorktreeResponseDto[]> {
    const rows = await this.store.listByOwnerProject(ownerProjectId);
    return Promise.all(rows.map((row) => this.toResponse(row)));
  }

  async getWorktree(id: string): Promise<WorktreeResponseDto> {
    const row = await this.store.getById(id);
    if (!row) {
      throw new NotFoundException(`Worktree not found: ${id}`);
    }
    return this.toResponse(row);
  }

  async listWorktreeOverviews(ownerProjectId?: string): Promise<WorktreeOverviewDto[]> {
    const rows = ownerProjectId
      ? await this.store.listByOwnerProject(ownerProjectId)
      : await this.store.list();
    return Promise.all(rows.map((row) => this.buildWorktreeOverview(row)));
  }

  async getWorktreeOverview(id: string): Promise<WorktreeOverviewDto> {
    const row = await this.requireWorktree(id);
    return this.buildWorktreeOverview(row);
  }

  async deleteWorktree(
    id: string,
    options: {
      deleteBranch?: boolean;
    } = {},
  ): Promise<{ success: true }> {
    const row = await this.requireWorktree(id);
    const runtimeType = this.resolveRuntimeType(row.runtimeType);
    const shouldDeleteBranch = options.deleteBranch ?? true;
    const repoPath = this.resolveRepoPath(row.repoPath);
    const worktreeRoot = this.resolveWorktreeRoot(repoPath);
    const worktreePath = row.worktreePath
      ? this.ensurePathWithinRoot(worktreeRoot, row.worktreePath, 'worktree path')
      : null;
    const dataPath = this.resolveDataPath(repoPath, row.name);

    if (runtimeType === 'container' || row.containerId) {
      await this.dockerService
        .cleanupWorktreeProjectContainers(row.name, row.containerId)
        .catch((error) =>
          logger.warn({ error, worktreeId: row.id }, 'Failed cleaning project sub-containers'),
        );

      if (row.containerId) {
        await this.dockerService.stopContainer(row.containerId).catch(() => undefined);
        await this.dockerService.removeContainer(row.containerId, true).catch(() => undefined);
      }

      await this.dockerService
        .removeWorktreeNetwork(row.name)
        .catch((error) =>
          logger.warn({ error, worktreeId: row.id }, 'Failed removing worktree docker network'),
        );
    } else {
      await this.terminateProcess(row.processId).catch((error) =>
        logger.warn(
          { error, worktreeId: row.id },
          'Failed stopping worktree process during delete',
        ),
      );
    }

    if (worktreePath) {
      await this.gitService.removeWorktree(worktreePath, repoPath, true).catch(() => undefined);
    }
    if (shouldDeleteBranch && row.branchName !== row.baseBranch) {
      await this.gitService.deleteBranch(row.branchName, repoPath, true).catch((error) =>
        logger.warn(
          {
            error,
            worktreeId: row.id,
            branchName: row.branchName,
          },
          'Failed deleting branch during worktree cleanup',
        ),
      );
    }

    await rm(dataPath, { recursive: true, force: true }).catch(() => undefined);

    this.consecutiveHealthFailures.delete(row.id);
    await this.store.remove(row.id);
    this.recordWorktreeActivity({
      worktreeId: row.id,
      worktreeName: row.name,
      ownerProjectId: row.ownerProjectId,
      type: 'deleted',
      message: `Worktree '${row.name}' deleted`,
    });

    this.eventEmitter.emit(WORKTREE_CHANGED_EVENT, {
      worktreeId: row.id,
    } satisfies WorktreeChangedEvent);

    return { success: true };
  }

  async startWorktree(id: string): Promise<WorktreeResponseDto> {
    const row = await this.requireWorktree(id);
    const runtimeType = this.resolveRuntimeType(row.runtimeType);

    if (runtimeType === 'process') {
      const projectId = row.devchainProjectId?.trim();
      if (!projectId) {
        throw new BadRequestException('Worktree has no scoped project id to start');
      }
      const repoPath = this.resolveRepoPath(row.repoPath);
      const worktreePath = row.worktreePath ?? this.resolveWorktreePath(repoPath, row.name);
      const dataPath = this.resolveDataPath(repoPath, row.name);
      await mkdir(dataPath, { recursive: true });

      try {
        const runtime = await this.startProcessRuntime({
          worktreePath,
          dataPath,
          projectId,
        });

        const updated = await this.tryUpdateStatus(row.id, 'running', {
          processId: runtime.processId,
          runtimeToken: runtime.runtimeToken,
          startedAt: runtime.startedAt,
          containerPort: runtime.hostPort,
          errorMessage: null,
        });
        return this.toResponse(updated ?? row);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.tryUpdateStatus(row.id, 'error', {
          errorMessage: `Process failed readiness check after start: ${message}`,
        });
        throw new BadRequestException(`Failed to start process worktree: ${message}`);
      }
    }

    if (!row.containerId) {
      throw new BadRequestException('Worktree has no container to start');
    }

    await this.dockerService.startContainer(row.containerId);
    const healthy = await this.dockerService.waitForHealthy(
      row.containerId,
      CONTAINER_HEALTH_TIMEOUT_MS,
    );
    if (!healthy) {
      await this.tryUpdateStatus(row.id, 'error', {
        errorMessage: 'Container failed readiness check after start',
      });
      throw new BadRequestException('Container started but failed readiness check');
    }

    await this.dockerService
      .ensureWorktreeOnComposeNetwork(row.name, row.containerId)
      .catch(() => undefined);

    const hostPort = await this.dockerService
      .getContainerHostPort(row.containerId)
      .catch(() => null);

    const updated = await this.tryUpdateStatus(row.id, 'running', {
      errorMessage: null,
      ...(hostPort != null ? { containerPort: hostPort } : {}),
    });
    return this.toResponse(updated ?? row);
  }

  async stopWorktree(id: string): Promise<WorktreeResponseDto> {
    const row = await this.requireWorktree(id);
    const runtimeType = this.resolveRuntimeType(row.runtimeType);

    if (runtimeType === 'process') {
      await this.terminateProcess(row.processId);
      this.consecutiveHealthFailures.set(row.id, 0);
      const updated = await this.tryUpdateStatus(row.id, 'stopped', {
        processId: null,
        runtimeToken: null,
        startedAt: null,
        containerPort: null,
        errorMessage: null,
      });
      return this.toResponse(updated ?? row);
    }

    if (!row.containerId) {
      throw new BadRequestException('Worktree has no container to stop');
    }

    await this.dockerService.stopContainer(row.containerId);
    this.consecutiveHealthFailures.set(row.id, 0);
    const updated = await this.tryUpdateStatus(row.id, 'stopped');
    return this.toResponse(updated ?? row);
  }

  async previewMergeWorktree(id: string): Promise<WorktreeMergePreviewDto> {
    const row = await this.requireWorktree(id);
    const currentStatus = String(row.status).toLowerCase();
    if (currentStatus === 'merged') {
      throw new BadRequestException('Worktree is already merged');
    }

    const [branchStatus, changeSummary, preview] = await Promise.all([
      this.gitService.getBranchStatus(row.repoPath, row.baseBranch, row.branchName),
      this.gitService.getBranchChangeSummary(row.repoPath, row.baseBranch, row.branchName),
      this.gitService.previewMerge(row.repoPath, row.branchName, row.baseBranch),
    ]);

    const conflicts = this.buildConflictDetails(
      preview.conflicts.length > 0 ? preview.conflicts : this.extractConflictFiles(preview.output),
      'merge',
    );

    if (conflicts.length === 0 && row.mergeConflicts?.trim()) {
      await this.store.update(row.id, {
        mergeConflicts: null,
      });
    }

    return {
      canMerge: !preview.hasConflicts,
      commitsAhead: branchStatus.commitsAhead,
      commitsBehind: branchStatus.commitsBehind,
      filesChanged: changeSummary.filesChanged,
      insertions: changeSummary.insertions,
      deletions: changeSummary.deletions,
      conflicts,
    };
  }

  async mergeWorktree(id: string): Promise<WorktreeResponseDto> {
    const row = await this.requireWorktree(id);
    const currentStatus = String(row.status).toLowerCase();

    if (currentStatus === 'merged') {
      throw new BadRequestException('Worktree is already merged');
    }
    if (!['running', 'stopped', 'completed', 'error'].includes(currentStatus)) {
      throw new BadRequestException(`Cannot merge worktree while status is "${row.status}"`);
    }

    await this.assertCleanWorkingTree(row.worktreePath ?? row.repoPath, 'Merge');

    const extractionRow =
      currentStatus === 'running' ? row : await this.ensureContainerReadyForTaskExtraction(row);

    await this.extractTasksForMergedHistory(extractionRow);

    if (row.containerId) {
      await this.dockerService.stopContainer(row.containerId).catch(() => undefined);
    }

    const mergeResult = await this.gitService.executeMerge(
      row.repoPath,
      row.branchName,
      row.baseBranch,
      {
        message: this.buildMergeCommitMessage(row),
      },
    );
    if (!mergeResult.success || !mergeResult.mergeCommit) {
      const message = mergeResult.output.trim() || 'Merge failed';
      const conflictFiles =
        mergeResult.conflicts && mergeResult.conflicts.length > 0
          ? mergeResult.conflicts
          : this.extractConflictFiles(message);
      const conflictDetails = this.buildConflictDetails(conflictFiles, 'merge');
      const hasConflicts = conflictDetails.length > 0 || /\bconflict\b/i.test(message);
      await this.tryUpdateStatus(row.id, 'error', {
        mergeConflicts: hasConflicts && conflictFiles.length > 0 ? conflictFiles.join('\n') : null,
        errorMessage: message,
      });
      if (hasConflicts) {
        throw new ConflictException({
          message: 'Merge failed with conflicts',
          conflicts: conflictDetails,
        });
      }
      throw new BadRequestException(`Merge failed: ${message}`);
    }

    this.consecutiveHealthFailures.set(row.id, 0);
    const mergedMessage = `Worktree '${row.name}' merged into ${row.baseBranch}`;
    const updated = await this.tryUpdateStatus(
      row.id,
      'merged',
      {
        mergeCommit: mergeResult.mergeCommit,
        mergeConflicts: null,
        errorMessage: null,
      },
      { activity: { type: 'merged', message: mergedMessage } },
    );
    return this.toResponse(updated ?? row);
  }

  async rebaseWorktree(id: string): Promise<WorktreeResponseDto> {
    const row = await this.requireWorktree(id);
    const currentStatus = String(row.status).toLowerCase();
    if (currentStatus === 'merged') {
      throw new BadRequestException('Cannot rebase a merged worktree');
    }
    if (!['running', 'stopped', 'completed', 'error'].includes(currentStatus)) {
      throw new BadRequestException(`Cannot rebase worktree while status is "${row.status}"`);
    }

    await this.assertCleanWorkingTree(row.worktreePath ?? row.repoPath, 'Rebase');

    if (row.containerId) {
      await this.dockerService.stopContainer(row.containerId).catch(() => undefined);
    }

    const rebaseResult = await this.gitService.executeRebase(
      row.worktreePath ?? row.repoPath,
      row.branchName,
      row.baseBranch,
    );

    if (!rebaseResult.success) {
      const message = rebaseResult.output.trim() || 'Rebase failed';
      const conflictFiles =
        rebaseResult.conflicts.length > 0
          ? rebaseResult.conflicts
          : this.extractConflictFiles(rebaseResult.output);
      const conflictDetails = this.buildConflictDetails(conflictFiles, 'rebase');
      const hasConflicts = conflictDetails.length > 0 || /\bconflict\b/i.test(message);
      await this.tryUpdateStatus(row.id, 'error', {
        mergeConflicts: hasConflicts && conflictFiles.length > 0 ? conflictFiles.join('\n') : null,
        errorMessage: message,
      });
      if (hasConflicts) {
        throw new ConflictException({
          message: 'Rebase failed with conflicts',
          conflicts: conflictDetails,
        });
      }
      throw new BadRequestException(`Rebase failed: ${message}`);
    }

    if (row.containerId) {
      await this.dockerService.startContainer(row.containerId).catch(() => undefined);
      const healthy = await this.dockerService.waitForHealthy(
        row.containerId,
        CONTAINER_HEALTH_TIMEOUT_MS,
      );
      if (!healthy) {
        await this.tryUpdateStatus(row.id, 'error', {
          errorMessage: 'Container failed readiness check after rebase',
        });
        throw new BadRequestException('Rebase succeeded but container failed readiness check');
      }

      this.recordWorktreeActivity({
        worktreeId: row.id,
        worktreeName: row.name,
        ownerProjectId: row.ownerProjectId,
        type: 'rebased',
        message: `Worktree '${row.name}' rebased onto ${row.baseBranch}`,
      });
      const updated = await this.tryUpdateStatus(row.id, 'running', {
        mergeConflicts: null,
        errorMessage: null,
      });
      return this.toResponse(updated ?? row);
    }

    this.recordWorktreeActivity({
      worktreeId: row.id,
      worktreeName: row.name,
      ownerProjectId: row.ownerProjectId,
      type: 'rebased',
      message: `Worktree '${row.name}' rebased onto ${row.baseBranch}`,
    });
    const updated = await this.store.update(row.id, {
      mergeConflicts: null,
      errorMessage: null,
    });
    return this.toResponse(updated ?? row);
  }

  private async extractTasksForMergedHistory(row: WorktreeRecord): Promise<void> {
    let extractionError: unknown;

    try {
      await this.emitTaskMergeRequested(row.id);
      return;
    } catch (error) {
      extractionError = error;
    }

    const recovered = await this.tryRecoverContainerForTaskExtraction(row);
    if (recovered) {
      try {
        await this.emitTaskMergeRequested(row.id);
        return;
      } catch (retryError) {
        extractionError = retryError;
      }
    }

    const message =
      extractionError instanceof Error ? extractionError.message : String(extractionError);
    const actionableMessage =
      'Merge blocked: unable to preserve task history. Start or restore the worktree container, then retry merge.';

    await this.tryUpdateStatus(row.id, 'error', {
      errorMessage: `Task extraction failed before merge: ${message}`,
    });
    throw new BadRequestException(`${actionableMessage} (${message})`);
  }

  private async emitTaskMergeRequested(worktreeId: string): Promise<void> {
    const results = await this.eventEmitter.emitAsync(WORKTREE_TASK_MERGE_REQUESTED_EVENT, {
      worktreeId,
    });
    if (results.length === 0) {
      throw new Error('No task merge handlers registered');
    }
  }

  // Option B semantics: auto-start a stopped/unreachable container and retry extraction once.
  private async ensureContainerReadyForTaskExtraction(
    row: WorktreeRecord,
  ): Promise<WorktreeRecord> {
    if (!row.containerId) {
      throw new BadRequestException(
        'Merge blocked: worktree container is missing. Recreate or start a container before merge to preserve task history.',
      );
    }

    const recovered = await this.tryRecoverContainerForTaskExtraction(row);
    if (!recovered) {
      await this.tryUpdateStatus(row.id, 'error', {
        errorMessage: 'Task extraction failed before merge: container could not be started',
      });
      throw new BadRequestException(
        'Merge blocked: unable to start worktree container for task extraction. Restore the container and retry merge.',
      );
    }

    const refreshed = await this.requireWorktree(row.id);
    return refreshed;
  }

  private async tryRecoverContainerForTaskExtraction(row: WorktreeRecord): Promise<boolean> {
    if (!row.containerId) {
      return false;
    }

    try {
      await this.dockerService.startContainer(row.containerId).catch(() => undefined);
      const healthy = await this.dockerService.waitForHealthy(
        row.containerId,
        CONTAINER_HEALTH_TIMEOUT_MS,
      );
      if (!healthy) {
        return false;
      }

      await this.tryUpdateStatus(row.id, 'running', {
        errorMessage: null,
      }).catch(() => undefined);
      return true;
    } catch (error) {
      logger.warn({ error, worktreeId: row.id }, 'Failed recovering container for task extraction');
      return false;
    }
  }

  private async assertCleanWorkingTree(path: string | undefined, operation: 'Merge' | 'Rebase') {
    const status = await this.gitService.getWorkingTreeStatus(path);
    if (status.clean) {
      return;
    }
    throw new ConflictException({
      message: `${operation} blocked: worktree has uncommitted changes`,
      conflicts: [{ file: 'WORKTREE_DIRTY', type: 'uncommitted' }],
      details: status.output,
    });
  }

  private buildMergeCommitMessage(row: WorktreeRecord): string {
    const description = row.description?.trim();
    if (!description) {
      return `Merge ${row.branchName}`;
    }
    return `Merge ${row.branchName}: ${description}`;
  }

  private extractConflictFiles(raw: string): string[] {
    const lines = raw.split('\n');
    const files = new Set<string>();
    for (const line of lines) {
      let match = line.match(/CONFLICT \([^)]+\): .* in (.+)$/i);
      if (!match) {
        match = line.match(/^\s*both modified:\s+(.+)$/i);
      }
      if (!match) {
        match = line.match(/^\s*UU\s+(.+)$/i);
      }
      if (match?.[1]) {
        files.add(match[1].trim());
      }
    }
    return [...files];
  }

  private buildConflictDetails(
    files: string[],
    type: WorktreeMergeConflictDto['type'],
  ): WorktreeMergeConflictDto[] {
    return [...new Set(files.map((file) => file.trim()).filter(Boolean))].map((file) => ({
      file,
      type,
    }));
  }

  async getWorktreeLogs(id: string, query: WorktreeLogsQueryDto): Promise<{ logs: string }> {
    const row = await this.requireWorktree(id);
    if (this.resolveRuntimeType(row.runtimeType) === 'process') {
      const logPath = this.resolveProcessLogPath(this.resolveDataPath(row.repoPath, row.name));
      const content = await readFile(logPath, 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error?.code === 'ENOENT') {
          return '';
        }
        throw error;
      });
      const lines = content.split(/\r?\n/).filter((line, index, all) => {
        if (line.length > 0) {
          return true;
        }
        return index < all.length - 1;
      });
      const tailed = lines.slice(-query.tail).join('\n');
      return { logs: tailed ? `${tailed}\n` : '' };
    }

    if (!row.containerId) {
      throw new BadRequestException('Worktree has no container');
    }
    const logs = await this.dockerService.getContainerLogs(row.containerId, query.tail);
    return { logs };
  }

  private async buildWorktreeOverview(row: WorktreeRecord): Promise<WorktreeOverviewDto> {
    const worktree = await this.toResponse(row);
    const fallback: WorktreeOverviewDto = {
      worktree,
      epics: { total: null, done: null },
      agents: { total: null },
      fetchedAt: new Date().toISOString(),
    };

    if (!row.containerPort || !row.devchainProjectId) {
      return fallback;
    }

    const status = String(row.status).toLowerCase();
    if (!['running', 'stopped', 'completed'].includes(status)) {
      return fallback;
    }

    const baseUrl = `http://127.0.0.1:${row.containerPort}`;

    const [epicsPayload, statusesPayload, agentsPayload] = await Promise.all([
      this.fetchContainerJson<ContainerEpicsResponse>(
        `${baseUrl}/api/epics?projectId=${encodeURIComponent(row.devchainProjectId)}&limit=1000`,
      ),
      this.fetchContainerJson<ContainerStatusesResponse>(
        `${baseUrl}/api/projects/${encodeURIComponent(row.devchainProjectId)}/statuses?limit=500`,
      ),
      this.fetchContainerJson<ContainerAgentsResponse>(
        `${baseUrl}/api/agents?projectId=${encodeURIComponent(row.devchainProjectId)}`,
      ),
    ]);

    if (!epicsPayload || !statusesPayload || !agentsPayload) {
      return fallback;
    }

    const statusItems = statusesPayload.items ?? [];
    const doneStatusIds = new Set(
      statusItems
        .filter((statusItem) => {
          const label = statusItem.label?.trim().toLowerCase();
          return label === 'done' || label === 'completed';
        })
        .map((statusItem) => statusItem.id)
        .filter((statusId): statusId is string => Boolean(statusId)),
    );

    const epicItems = epicsPayload.items ?? [];
    const doneCount = epicItems.reduce((total, epic) => {
      if (!epic.statusId) {
        return total;
      }
      return doneStatusIds.has(epic.statusId) ? total + 1 : total;
    }, 0);

    return {
      worktree,
      epics: {
        total: typeof epicsPayload.total === 'number' ? epicsPayload.total : epicItems.length,
        done: doneCount,
      },
      agents: {
        total: typeof agentsPayload.total === 'number' ? agentsPayload.total : null,
      },
      fetchedAt: new Date().toISOString(),
    };
  }

  private async fetchContainerJson<T>(url: string): Promise<T | null> {
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), OVERVIEW_FETCH_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: abortController.signal,
      });

      if (!response.ok) {
        return null;
      }

      return (await response.json()) as T;
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async monitorRunningWorktrees(): Promise<void> {
    const rows = await this.store.listMonitored();

    await Promise.all(
      rows.map(async (row) => {
        const runtimeType = this.resolveRuntimeType(row.runtimeType);
        if (runtimeType === 'process') {
          await this.monitorProcessWorktree(row);
          return;
        }
        if (!row.containerId) {
          return;
        }

        await this.dockerService
          .ensureWorktreeOnComposeNetwork(row.name, row.containerId)
          .catch(() => undefined);

        const healthy = await this.dockerService.waitForHealthy(
          row.containerId,
          HEALTH_MONITOR_PROBE_TIMEOUT_MS,
        );

        if (healthy) {
          this.consecutiveHealthFailures.set(row.id, 0);
          if (row.status === 'error') {
            await this.tryUpdateStatus(row.id, 'running', {
              errorMessage: null,
            });
          }
          return;
        }

        const failures = (this.consecutiveHealthFailures.get(row.id) ?? 0) + 1;
        this.consecutiveHealthFailures.set(row.id, failures);

        if (row.status === 'running' && failures >= MAX_CONSECUTIVE_HEALTH_FAILURES) {
          await this.tryUpdateStatus(row.id, 'error', {
            errorMessage: `Readiness probe failed ${failures} consecutive times`,
          });
        }
      }),
    );
  }

  private async monitorProcessWorktree(row: WorktreeRecord): Promise<void> {
    const pid = row.processId ?? null;
    if (!pid || !this.isProcessAlive(pid)) {
      this.consecutiveHealthFailures.set(row.id, 0);
      await this.tryUpdateStatus(row.id, 'stopped', {
        processId: null,
        runtimeToken: null,
        startedAt: null,
        containerPort: null,
        errorMessage: null,
      });
      return;
    }

    const hostPort = row.containerPort ?? null;
    const runtimeToken = row.runtimeToken?.trim() || null;
    if (!hostPort || !runtimeToken) {
      await this.handleProcessProbeFailure(row.id, row.status);
      return;
    }

    const healthy = await this.checkRuntimeReady(hostPort);
    if (!healthy) {
      await this.handleProcessProbeFailure(row.id, row.status);
      return;
    }

    const runtimeMetadata = await this.fetchRuntimeMetadata(hostPort);
    const runtimeTokenMatches = runtimeMetadata?.runtimeToken === runtimeToken;
    if (!runtimeTokenMatches) {
      this.consecutiveHealthFailures.set(row.id, 0);
      await this.tryUpdateStatus(row.id, 'stopped', {
        processId: null,
        runtimeToken: null,
        startedAt: null,
        containerPort: null,
        errorMessage: null,
      });
      return;
    }

    this.consecutiveHealthFailures.set(row.id, 0);
    if (row.status === 'error') {
      await this.tryUpdateStatus(row.id, 'running', {
        errorMessage: null,
      });
    }
  }

  private async handleProcessProbeFailure(id: string, status: string): Promise<void> {
    const failures = (this.consecutiveHealthFailures.get(id) ?? 0) + 1;
    this.consecutiveHealthFailures.set(id, failures);

    if (status === 'running' && failures >= MAX_CONSECUTIVE_HEALTH_FAILURES) {
      await this.tryUpdateStatus(id, 'error', {
        errorMessage: `Readiness probe failed ${failures} consecutive times`,
      });
    }
  }

  private async reconcileProcessOrphans(): Promise<void> {
    const rows = await this.store.listMonitored();
    const candidates = rows.filter(
      (row) => this.resolveRuntimeType(row.runtimeType) === 'process' && row.status === 'running',
    );

    await Promise.all(
      candidates.map(async (row) => {
        const pid = row.processId ?? null;
        if (!pid || !this.isProcessAlive(pid)) {
          await this.tryUpdateStatus(row.id, 'stopped', {
            processId: null,
            runtimeToken: null,
            startedAt: null,
            containerPort: null,
            errorMessage: null,
          });
          return;
        }

        if (!row.containerPort || !row.runtimeToken) {
          await this.tryUpdateStatus(row.id, 'stopped', {
            processId: null,
            runtimeToken: null,
            startedAt: null,
            containerPort: null,
            errorMessage: null,
          });
          return;
        }

        const metadata = await this.fetchRuntimeMetadata(row.containerPort);
        if (!metadata || metadata.runtimeToken !== row.runtimeToken) {
          await this.tryUpdateStatus(row.id, 'stopped', {
            processId: null,
            runtimeToken: null,
            startedAt: null,
            containerPort: null,
            errorMessage: null,
          });
        }
      }),
    );
  }

  private resolveRuntimeType(runtimeType?: string | null): WorktreeRuntimeType {
    return runtimeType === 'process' ? 'process' : 'container';
  }

  private async startProcessRuntime(input: {
    worktreePath: string;
    dataPath: string;
    projectId: string;
  }): Promise<StartedProcessRuntime> {
    const runtimeToken = randomUUID();
    const portFilePath = join(input.dataPath, PROCESS_RUNTIME_PORT_FILE);

    // Clean up stale port file from a previous attempt
    await rm(portFilePath, { force: true }).catch(() => undefined);

    const processId = await this.spawnProcessRuntime({
      worktreePath: input.worktreePath,
      dataPath: input.dataPath,
      projectId: input.projectId,
      runtimeToken,
    });

    // Wait for child to report its OS-assigned port via the port file
    const portInfo = await this.waitForRuntimePortFile(
      portFilePath,
      CONTAINER_HEALTH_TIMEOUT_MS,
      processId,
    );

    if (!portInfo) {
      await this.terminateProcess(processId).catch(() => undefined);
      throw new Error('Process runtime did not report its port before timeout');
    }

    // Verify the port file was written by our child (token match)
    if (portInfo.runtimeToken !== runtimeToken) {
      await this.terminateProcess(processId).catch(() => undefined);
      throw new Error(
        `Runtime port file token mismatch: expected ${runtimeToken}, ` +
          `got ${portInfo.runtimeToken ?? 'none'}`,
      );
    }

    const hostPort = portInfo.port;

    // Confirm the server is ready to accept requests
    const healthy = await this.waitForRuntimeHealthy(
      hostPort,
      CONTAINER_HEALTH_TIMEOUT_MS,
      processId,
    );
    if (!healthy) {
      await this.terminateProcess(processId).catch(() => undefined);
      throw new Error('Process runtime did not become healthy before timeout');
    }

    return { processId, hostPort, runtimeToken, startedAt: new Date() };
  }

  private async spawnProcessRuntime(input: {
    worktreePath: string;
    dataPath: string;
    projectId: string;
    runtimeToken: string;
  }): Promise<number> {
    const cliPath = this.resolveCliPath();
    const logPath = this.resolveProcessLogPath(input.dataPath);
    const portFilePath = join(input.dataPath, PROCESS_RUNTIME_PORT_FILE);
    await mkdir(input.dataPath, { recursive: true });
    const logFile = await open(logPath, 'a');

    try {
      const child = spawn(
        process.execPath,
        [cliPath, 'start', '--foreground', '--worktree-runtime', 'process', '--port', '0'],
        {
          cwd: input.worktreePath,
          detached: true,
          stdio: ['ignore', logFile.fd, logFile.fd],
          env: {
            ...process.env,
            PORT: '0',
            HOST: '127.0.0.1',
            NODE_ENV: 'production',
            DB_PATH: input.dataPath,
            DB_FILENAME: PROCESS_DB_FILE_NAME,
            DEVCHAIN_MODE: 'normal',
            CONTAINER_PROJECT_ID: input.projectId,
            RUNTIME_TOKEN: input.runtimeToken,
            RUNTIME_PORT_FILE: portFilePath,
          },
        },
      );

      const pid = await this.awaitSpawn(child);
      child.unref();
      return pid;
    } finally {
      await logFile.close().catch(() => undefined);
    }
  }

  private async awaitSpawn(child: ChildProcess): Promise<number> {
    if (typeof child.pid === 'number') {
      return child.pid;
    }

    return new Promise<number>((resolve, reject) => {
      const onSpawn = () => {
        cleanup();
        if (typeof child.pid !== 'number') {
          reject(new Error('Process runtime started without a PID'));
          return;
        }
        resolve(child.pid);
      };
      const onError = (error: unknown) => {
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      const cleanup = () => {
        child.off('spawn', onSpawn);
        child.off('error', onError);
      };

      child.once('spawn', onSpawn);
      child.once('error', onError);
    });
  }

  private async waitForRuntimeHealthy(
    hostPort: number,
    timeoutMs: number,
    pid?: number,
  ): Promise<boolean> {
    if (timeoutMs <= 0) {
      return false;
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      // Early exit if child process died (e.g., EADDRINUSE with strict port binding)
      if (pid && !this.isProcessAlive(pid)) {
        logger.warn({ pid, hostPort }, 'Child process exited during health polling');
        return false;
      }

      const isReady = await this.checkRuntimeReady(hostPort);
      if (isReady) {
        return true;
      }
      await this.sleep(PROCESS_HEALTH_POLL_INTERVAL_MS);
    }

    return false;
  }

  private async waitForRuntimePortFile(
    filePath: string,
    timeoutMs: number,
    pid?: number,
  ): Promise<{ port: number; runtimeToken: string | null } | null> {
    if (timeoutMs <= 0) {
      return null;
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      // Early exit if child process died before writing the port file
      if (pid && !this.isProcessAlive(pid)) {
        logger.warn({ pid, filePath }, 'Child process exited before writing port file');
        return null;
      }

      try {
        const raw = await readFile(filePath, 'utf-8');
        const parsed = JSON.parse(raw) as { port?: number; runtimeToken?: string | null };
        if (typeof parsed.port === 'number' && parsed.port > 0) {
          return { port: parsed.port, runtimeToken: parsed.runtimeToken ?? null };
        }
      } catch {
        // File doesn't exist yet or is being written — keep polling
      }

      await this.sleep(PROCESS_HEALTH_POLL_INTERVAL_MS);
    }

    return null;
  }

  private async checkRuntimeReady(hostPort: number): Promise<boolean> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PROCESS_RUNTIME_TIMEOUT_MS);
    try {
      const response = await fetch(`http://127.0.0.1:${hostPort}/health/ready`, {
        signal: controller.signal,
      });
      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async fetchRuntimeMetadata(hostPort: number): Promise<RuntimeMetadataResponse | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PROCESS_RUNTIME_TIMEOUT_MS);
    try {
      const response = await fetch(`http://127.0.0.1:${hostPort}/api/runtime`, {
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) {
        return null;
      }
      return (await response.json()) as RuntimeMetadataResponse;
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  private resolveCliPath(): string {
    const candidates = [
      // Dev mode: scripts/cli.js in repo root
      resolve(process.cwd(), 'scripts', 'cli.js'),
      resolve(__dirname, '../../../../../../../../scripts/cli.js'),
      resolve(__dirname, '../../../../../../../scripts/cli.js'),
      // Installed CLI: dist/cli.js relative to compiled service location
      resolve(__dirname, '../../../../../cli.js'),
    ];

    // Also try the entry point of the currently running process
    if (process.argv[1] && !candidates.includes(resolve(process.argv[1]))) {
      candidates.push(resolve(process.argv[1]));
    }

    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }

    throw new Error(
      'Unable to locate CLI entry point for process runtime start. ' +
        `Searched: ${candidates.join(', ')}`,
    );
  }

  private resolveProcessLogPath(dataPath: string): string {
    return join(dataPath, PROCESS_LOG_FILE_NAME);
  }

  private async terminateProcess(pid?: number | null): Promise<void> {
    if (!pid) {
      return;
    }

    const stillRunningAfterSigterm = await this.signalProcessAndAwaitExit(
      pid,
      'SIGTERM',
      PROCESS_SHUTDOWN_TIMEOUT_MS,
    );
    if (!stillRunningAfterSigterm) {
      return;
    }

    await this.signalProcessAndAwaitExit(pid, 'SIGKILL', PROCESS_KILL_TIMEOUT_MS).catch((error) => {
      logger.warn({ error, pid }, 'Failed sending SIGKILL to worktree process');
    });
  }

  private async signalProcessAndAwaitExit(
    pid: number,
    signal: NodeJS.Signals,
    timeoutMs: number,
  ): Promise<boolean> {
    const signalPid = process.platform === 'win32' ? pid : -pid;
    try {
      process.kill(signalPid, signal);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') {
        return false;
      }
      throw error;
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!this.isProcessAlive(pid)) {
        return false;
      }
      await this.sleep(200);
    }
    return this.isProcessAlive(pid);
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') {
        return false;
      }
      if (code === 'EPERM') {
        return true;
      }
      return false;
    }
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
  }

  private async handleContainerEvent(event: WorktreeContainerEvent): Promise<void> {
    const containerId = event.id;
    if (!containerId) {
      return;
    }

    const action = event.Action ?? event.status;
    if (!action) {
      return;
    }

    const row = await this.store.getByContainerId(containerId);
    if (!row) {
      return;
    }

    if (['die', 'stop', 'kill', 'destroy'].includes(action)) {
      this.consecutiveHealthFailures.set(row.id, 0);
      await this.tryUpdateStatus(row.id, 'stopped', {
        errorMessage: null,
      });
      return;
    }

    if (['start', 'restart'].includes(action)) {
      this.consecutiveHealthFailures.set(row.id, 0);
      await this.tryUpdateStatus(row.id, 'running', {
        errorMessage: null,
      });
    }
  }

  private async requireWorktree(id: string): Promise<WorktreeRecord> {
    const row = await this.store.getById(id);
    if (!row) {
      throw new NotFoundException(`Worktree not found: ${id}`);
    }
    return row;
  }

  private async registerProjectInContainer(
    hostPort: number | null,
    input: {
      name: string;
      templateSlug: string;
      description: string | null;
      projectId: string;
      rootPath: string;
      presetName?: string;
    },
  ): Promise<RegisterProjectResult> {
    if (!hostPort) {
      throw new Error('Container did not expose a host port');
    }

    await this.ensureTemplateExists(hostPort, input.templateSlug);

    const response = await fetch(`http://127.0.0.1:${hostPort}/api/projects/from-template`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: input.name,
        description: input.description,
        rootPath: input.rootPath,
        slug: input.templateSlug,
        projectId: input.projectId,
        ...(input.presetName && { presetName: input.presetName }),
      }),
    });

    const payload = (await response.json().catch(() => ({}))) as {
      success?: boolean;
      project?: { id?: string };
      message?: string;
    };

    logger.debug(
      {
        hostPort,
        status: response.status,
        success: payload.success,
        projectId: payload.project?.id,
        message: payload.message,
      },
      'registerProjectInContainer response',
    );

    if (!response.ok) {
      throw new Error(
        payload.message || `Project registration failed with HTTP ${response.status}`,
      );
    }

    if (!payload.success || !payload.project?.id) {
      throw new Error('Project registration failed: invalid response payload');
    }

    if (payload.project.id !== input.projectId) {
      throw new Error(
        'Project registration failed: returned project id did not match requested id',
      );
    }

    return { projectId: payload.project.id };
  }

  private async ensureTemplateExists(hostPort: number, templateSlug: string): Promise<void> {
    const response = await fetch(`http://127.0.0.1:${hostPort}/api/templates`);
    const payload = (await response.json().catch(() => ({}))) as {
      templates?: Array<{ slug?: string }>;
    };
    const templates = payload.templates ?? [];
    if (!response.ok || !templates.some((template) => template.slug === templateSlug)) {
      throw new Error(`Template slug "${templateSlug}" is not available in runtime`);
    }
  }

  private resolveRepoPath(repoPath?: string): string {
    if (repoPath) {
      return resolve(repoPath);
    }

    const env = getEnvConfig();
    if (env.DEVCHAIN_MODE !== 'normal' && env.REPO_ROOT) {
      return resolve(env.REPO_ROOT);
    }

    return resolve(process.cwd());
  }

  private resolveWorktreeRoot(repoPath: string): string {
    const env = getEnvConfig();
    const root = env.WORKTREES_ROOT ?? join(repoPath, 'worktrees');
    return resolve(root);
  }

  private resolveDataRoot(repoPath: string): string {
    const env = getEnvConfig();
    const root = env.WORKTREES_DATA_ROOT ?? join(repoPath, 'worktrees-data');
    return resolve(root);
  }

  private resolveWorktreePath(repoPath: string, name: string): string {
    this.assertValidWorktreeName(name);
    const root = this.resolveWorktreeRoot(repoPath);
    return this.ensurePathWithinRoot(root, resolve(root, name), 'worktree path');
  }

  private resolveDataPath(repoPath: string, name: string): string {
    this.assertValidWorktreeName(name);
    const root = this.resolveDataRoot(repoPath);
    return this.ensurePathWithinRoot(root, resolve(root, name, 'data'), 'worktree data path');
  }

  private getContainerName(name: string): string {
    this.assertValidWorktreeName(name);
    return `devchain-wt-${name}`;
  }

  private ensurePathWithinRoot(rootPath: string, candidatePath: string, label: string): string {
    const resolvedRoot = resolve(rootPath);
    const resolvedCandidate = resolve(candidatePath);
    const rootWithSeparator = resolvedRoot.endsWith(sep) ? resolvedRoot : `${resolvedRoot}${sep}`;

    if (resolvedCandidate !== resolvedRoot && !resolvedCandidate.startsWith(rootWithSeparator)) {
      throw new BadRequestException(`Invalid ${label}: path escapes configured root`);
    }

    const relativePath = relative(resolvedRoot, resolvedCandidate);
    if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
      throw new BadRequestException(`Invalid ${label}: path escapes configured root`);
    }

    return resolvedCandidate;
  }

  private assertValidWorktreeName(name: string): void {
    if (!isValidWorktreeName(name)) {
      throw new BadRequestException(
        'Invalid worktree name. Use lowercase letters, numbers, and hyphens (1-63 chars, no edge hyphen).',
      );
    }
  }

  private assertValidBranchName(branchName: string, fieldName: string): void {
    if (!isValidGitBranchName(branchName)) {
      throw new BadRequestException(`Invalid ${fieldName}`);
    }
  }

  private async toResponse(row: WorktreeRecord): Promise<WorktreeResponseDto> {
    let commitsAhead: number | null = null;
    let commitsBehind: number | null = null;

    if (row.repoPath && row.baseBranch && row.branchName) {
      try {
        const branchStatus = await this.gitService.getBranchStatus(
          row.repoPath,
          row.baseBranch,
          row.branchName,
        );
        commitsAhead = branchStatus.commitsAhead;
        commitsBehind = branchStatus.commitsBehind;
      } catch (error) {
        logger.debug({ error, worktreeId: row.id }, 'Unable to compute branch ahead/behind');
      }
    }

    return {
      id: row.id,
      name: row.name,
      branchName: row.branchName,
      baseBranch: row.baseBranch,
      repoPath: row.repoPath,
      worktreePath: row.worktreePath ?? null,
      containerId: row.containerId ?? null,
      containerPort: row.containerPort ?? null,
      templateSlug: row.templateSlug,
      ownerProjectId: row.ownerProjectId,
      status: row.status,
      description: row.description ?? null,
      devchainProjectId: row.devchainProjectId ?? null,
      mergeCommit: row.mergeCommit ?? null,
      mergeConflicts: row.mergeConflicts ?? null,
      errorMessage: row.errorMessage ?? null,
      commitsAhead,
      commitsBehind,
      runtimeType: row.runtimeType ?? 'container',
      processId: row.processId ?? null,
      runtimeToken: row.runtimeToken ?? null,
      startedAt: row.startedAt ? row.startedAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private async tryUpdateStatus(
    id: string,
    nextStatus: WorktreeStatus,
    extraPatch: Partial<WorktreeRecord> = {},
    options: {
      activity?: WorktreeActivity;
    } = {},
  ): Promise<WorktreeRecord | null> {
    const current = await this.store.getById(id);
    if (!current) {
      return null;
    }

    this.assertValidStatusTransition(current.status as WorktreeStatus, nextStatus);
    const updated = await this.store.update(id, {
      ...extraPatch,
      status: nextStatus,
    });
    if (!updated) {
      return null;
    }

    if (current.status !== nextStatus) {
      this.eventEmitter.emit(WORKTREE_CHANGED_EVENT, {
        worktreeId: id,
      } satisfies WorktreeChangedEvent);

      const activity =
        options.activity ?? this.getStatusTransitionActivity(current, updated, nextStatus);
      if (activity) {
        this.recordWorktreeActivity({
          worktreeId: id,
          worktreeName: updated.name,
          ownerProjectId: updated.ownerProjectId,
          type: activity.type,
          message: activity.message,
        });
      }
    }

    return updated;
  }

  private getStatusTransitionActivity(
    current: WorktreeRecord,
    updated: WorktreeRecord,
    nextStatus: WorktreeStatus,
  ): WorktreeActivity | null {
    if (current.status === nextStatus) {
      return null;
    }

    if (nextStatus === 'running') {
      return {
        type: 'started',
        message: `Worktree '${updated.name}' started`,
      };
    }

    if (nextStatus === 'stopped') {
      return {
        type: 'stopped',
        message: `Worktree '${updated.name}' stopped`,
      };
    }

    if (nextStatus === 'error') {
      const detail = updated.errorMessage?.trim() || 'Unknown error';
      return {
        type: 'error',
        message: `Worktree '${updated.name}' encountered an error: ${detail}`,
      };
    }

    if (nextStatus === 'merged') {
      return {
        type: 'merged',
        message: `Worktree '${updated.name}' merged`,
      };
    }

    return null;
  }

  private recordWorktreeActivity(params: {
    worktreeId: string;
    worktreeName: string;
    ownerProjectId: string;
    type: WorktreeActivityType;
    message: string;
  }): void {
    void this.eventLogService
      .recordPublished({
        name: WORKTREE_ACTIVITY_EVENT_NAME,
        payload: {
          worktreeId: params.worktreeId,
          worktreeName: params.worktreeName,
          ownerProjectId: params.ownerProjectId,
          type: params.type,
          message: params.message,
        },
      })
      .catch((error) => {
        logger.warn(
          { error, worktreeId: params.worktreeId, type: params.type },
          'Failed to record worktree activity event',
        );
      });
  }

  private assertValidStatusTransition(current: WorktreeStatus, next: WorktreeStatus): void {
    if (current === next) {
      return;
    }

    const allowed: Record<WorktreeStatus, WorktreeStatus[]> = {
      creating: ['running', 'error'],
      running: ['stopped', 'completed', 'merged', 'error'],
      stopped: ['running', 'merged', 'error'],
      completed: ['merged', 'running', 'error'],
      merged: [],
      error: ['running', 'stopped'],
    };

    if (!allowed[current]?.includes(next)) {
      throw new BadRequestException(`Invalid worktree status transition: ${current} -> ${next}`);
    }
  }
}
