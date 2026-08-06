import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { randomUUID } from 'crypto';
import { createLogger } from '../../../../common/logging/logger';
import { getEnvConfig } from '../../../../common/config/env.config';
import { EventLogService } from '../../../events/services/event-log.service';
import {
  CreateWorktreeDto,
  WorktreeMergeConflictDto,
  WorktreeMergePreviewDto,
  WorktreeLogsQueryDto,
  WorktreeOverviewDto,
  WorktreeCopyResultsDto,
  WorktreeResponseDto,
  WorktreeStatusSchema,
} from '../dtos/worktree.dto';
import { WORKTREES_STORE, WorktreeRecord, WorktreesStore } from '../worktrees.store';
import { GitWorktreeService } from '../../git/services/git-worktree.service';
import { SeedPreparationService } from '../../docker/services/seed-preparation.service';
import { ContainerRuntime } from '../runtime/container-runtime';
import { ProcessRuntime } from '../runtime/process-runtime';
import { WORKTREE_TASK_MERGE_REQUESTED_EVENT } from '../../sync/events/task-merge.events';
import { WORKTREE_CHANGED_EVENT, WorktreeChangedEvent } from '../events/worktree.events';
import { cp, mkdir, rm } from 'fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path';
import { isValidGitBranchName, isValidWorktreeName } from '../worktree-validation';
import {
  STORAGE_SERVICE,
  type StorageService,
} from '../../../storage/interfaces/storage.interface';
import { ValidationError } from '../../../../common/errors/error-types';
import {
  validatePathWithinRoot,
  validateResolvedPathWithinRoot,
} from '../../../../common/validation/path-validation';

const logger = createLogger('OrchestratorWorktreesService');

const CONTAINER_HEALTH_TIMEOUT_MS = 60_000;
const HEALTH_MONITOR_INTERVAL_MS = 15_000;
const HEALTH_MONITOR_PROBE_TIMEOUT_MS = 1_500;
const MAX_CONSECUTIVE_HEALTH_FAILURES = 3;
const OVERVIEW_FETCH_TIMEOUT_MS = 2_500;
const WORKTREE_ACTIVITY_EVENT_NAME = 'orchestrator.worktree.activity';

type WorktreeStatus = (typeof WorktreeStatusSchema.options)[number];
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

interface IgnoredCopyOperation {
  relativePath: string;
  sourcePath: string;
  destinationPath: string;
}

interface IgnoredCopyPlan {
  requestedCount: number;
  deduplicatedCount: number;
  operations: IgnoredCopyOperation[];
}

interface RegisterProjectResult {
  projectId: string;
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

// Operations covered by the per-worktree in-flight guard (user-approved fix-set).
// Create-by-name is intentionally NOT here: worktrees.name has a UNIQUE constraint
// that is the guard for create races.
type GuardedOperation = 'start' | 'stop' | 'merge' | 'rebase' | 'delete';

interface InFlightOperation {
  operation: GuardedOperation;
  // Shared promise so same-op duplicates resolve together. Typed loosely because
  // different operations return different DTOs.
  promise: Promise<unknown>;
}

@Injectable()
export class WorktreesService implements OnModuleInit, OnModuleDestroy {
  private monitorTimer?: NodeJS.Timeout;
  private unsubscribeDockerEvents?: () => void;
  private readonly consecutiveHealthFailures = new Map<string, number>();
  // Per-worktree in-flight operation guard state. In-memory only: a process restart
  // clears it, and reconcileProcessOrphans + status transitions restore consistency
  // for any row left mid-operation.
  private readonly inFlightOperations = new Map<string, InFlightOperation>();

  constructor(
    @Inject(WORKTREES_STORE) private readonly store: WorktreesStore,
    private readonly containerRuntime: ContainerRuntime,
    private readonly processRuntime: ProcessRuntime,
    private readonly gitService: GitWorktreeService,
    private readonly seedPreparationService: SeedPreparationService,
    private readonly eventEmitter: EventEmitter2,
    private readonly eventLogService: EventLogService,
    @Optional() @Inject(STORAGE_SERVICE) private readonly storage?: StorageService,
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
      this.unsubscribeDockerEvents = await this.containerRuntime.subscribeToContainerEvents(
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
    const repoPath = await this.resolveCreateRepoPath(input);
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
    const copyResults: WorktreeCopyResultsDto = {
      copied: [],
      failed: [],
    };

    try {
      await this.gitService.createWorktree({
        name: input.name,
        branchName: input.branchName,
        baseBranch: input.baseBranch,
        repoPath,
        worktreePath,
      });
      gitWorktreeCreated = true;

      const ignoredCopyPlan = await this.prepareIgnoredCopyPlan(
        repoPath,
        worktreePath,
        input.includeIgnoredFiles ?? [],
      );
      for (const operation of ignoredCopyPlan.operations) {
        try {
          await mkdir(dirname(operation.destinationPath), { recursive: true });
          await cp(operation.sourcePath, operation.destinationPath, { recursive: true });
          copyResults.copied.push(operation.relativePath);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          copyResults.failed.push({
            path: operation.relativePath,
            error: errorMessage,
          });
          logger.warn(
            {
              error,
              sourcePath: operation.sourcePath,
              destinationPath: operation.destinationPath,
              worktreeName: input.name,
            },
            'Failed to copy selected ignored path into worktree',
          );
        }
      }
      logger.info(
        {
          worktreeName: input.name,
          ownerProjectId: input.ownerProjectId,
          requested: ignoredCopyPlan.requestedCount,
          deduplicated: ignoredCopyPlan.deduplicatedCount,
          copied: copyResults.copied.length,
          failed: copyResults.failed.length,
          skipped: ignoredCopyPlan.requestedCount - ignoredCopyPlan.deduplicatedCount,
        },
        'Ignored file copy step completed',
      );

      await mkdir(dataPath, { recursive: true });
      await this.seedPreparationService.prepareSeedData(dataPath);

      if (runtimeType === 'process') {
        const runtime = await this.processRuntime.startProcessRuntime({
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
        const container = await this.containerRuntime.createContainer({
          name: containerName,
          worktreePath,
          dataPath,
          worktreeName: input.name,
          env: {
            CONTAINER_PROJECT_ID: projectId,
            // Forward the parent's cloud-UI setting so container worktrees stay
            // consistent with the main instance (and with process worktrees, which
            // inherit it via ...process.env). Conditional on purpose: unset in the
            // parent → unset in the child → child defaults ON; an explicit value
            // (e.g. '0' from --no-cloud) is forwarded so the child honours it.
            ...(process.env.DEVCHAIN_CLOUD_UI_ENABLED !== undefined
              ? { DEVCHAIN_CLOUD_UI_ENABLED: process.env.DEVCHAIN_CLOUD_UI_ENABLED }
              : {}),
          },
        });
        containerId = container.id;
        await this.containerRuntime
          .ensureWorktreeOnComposeNetwork(input.name, container.id)
          .catch(() => undefined);

        const healthy = await this.containerRuntime.waitForHealthy(
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

      const response = await this.toResponse(created);
      return {
        ...response,
        copyResults,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await this.tryUpdateStatus(created.id, 'error', {
        errorMessage,
      });

      if (containerId) {
        await this.containerRuntime.removeContainer(containerId, true).catch(() => undefined);
      }
      if (processId) {
        await this.processRuntime.terminateProcess(processId).catch(() => undefined);
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
      const crashLog = await this.processRuntime.readRecentLog(dataPath);
      if (crashLog) {
        logger.error(
          { worktreeId: created.id, logContent: crashLog },
          'Process runtime log before cleanup',
        );
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
    return this.withOperationGuard(id, 'delete', () => this.executeDelete(id, options));
  }

  private async executeDelete(
    id: string,
    options: {
      deleteBranch?: boolean;
    },
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
      await this.containerRuntime
        .cleanupWorktreeProjectContainers(row.name, row.containerId)
        .catch((error) =>
          logger.warn({ error, worktreeId: row.id }, 'Failed cleaning project sub-containers'),
        );

      if (row.containerId) {
        await this.containerRuntime.stopContainer(row.containerId).catch(() => undefined);
        await this.containerRuntime.removeContainer(row.containerId, true).catch(() => undefined);
      }

      await this.containerRuntime
        .removeWorktreeNetwork(row.name)
        .catch((error) =>
          logger.warn({ error, worktreeId: row.id }, 'Failed removing worktree docker network'),
        );
    } else {
      await this.processRuntime
        .terminateProcess(row.processId)
        .catch((error) =>
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
    return this.withOperationGuard(id, 'start', () => this.executeStart(id));
  }

  private async executeStart(id: string): Promise<WorktreeResponseDto> {
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
        const runtime = await this.processRuntime.startProcessRuntime({
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

    await this.containerRuntime.startContainer(row.containerId);
    const healthy = await this.containerRuntime.waitForHealthy(
      row.containerId,
      CONTAINER_HEALTH_TIMEOUT_MS,
    );
    if (!healthy) {
      await this.tryUpdateStatus(row.id, 'error', {
        errorMessage: 'Container failed readiness check after start',
      });
      throw new BadRequestException('Container started but failed readiness check');
    }

    await this.containerRuntime
      .ensureWorktreeOnComposeNetwork(row.name, row.containerId)
      .catch(() => undefined);

    const hostPort = await this.containerRuntime
      .getContainerHostPort(row.containerId)
      .catch(() => null);

    const updated = await this.tryUpdateStatus(row.id, 'running', {
      errorMessage: null,
      ...(hostPort != null ? { containerPort: hostPort } : {}),
    });
    return this.toResponse(updated ?? row);
  }

  async stopWorktree(id: string): Promise<WorktreeResponseDto> {
    return this.withOperationGuard(id, 'stop', () => this.executeStop(id));
  }

  private async executeStop(id: string): Promise<WorktreeResponseDto> {
    const row = await this.requireWorktree(id);
    const runtimeType = this.resolveRuntimeType(row.runtimeType);

    if (runtimeType === 'process') {
      await this.processRuntime.terminateProcess(row.processId);
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

    await this.containerRuntime.stopContainer(row.containerId);
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
    return this.withOperationGuard(id, 'merge', () => this.executeMerge(id));
  }

  private async executeMerge(id: string): Promise<WorktreeResponseDto> {
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
      await this.containerRuntime.stopContainer(row.containerId).catch(() => undefined);
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
    return this.withOperationGuard(id, 'rebase', () => this.executeRebase(id));
  }

  private async executeRebase(id: string): Promise<WorktreeResponseDto> {
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
      await this.containerRuntime.stopContainer(row.containerId).catch(() => undefined);
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
      await this.containerRuntime.startContainer(row.containerId).catch(() => undefined);
      const healthy = await this.containerRuntime.waitForHealthy(
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
      await this.containerRuntime.startContainer(row.containerId).catch(() => undefined);
      const healthy = await this.containerRuntime.waitForHealthy(
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
      const dataPath = this.resolveDataPath(row.repoPath, row.name);
      return { logs: await this.processRuntime.readLogs(dataPath, query.tail) };
    }

    if (!row.containerId) {
      throw new BadRequestException('Worktree has no container');
    }
    const logs = await this.containerRuntime.getContainerLogs(row.containerId, query.tail);
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

        await this.containerRuntime
          .ensureWorktreeOnComposeNetwork(row.name, row.containerId)
          .catch(() => undefined);

        const healthy = await this.containerRuntime.waitForHealthy(
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
    const verdict = await this.processRuntime.probeHealth({
      pid: row.processId ?? null,
      hostPort: row.containerPort ?? null,
      runtimeToken: row.runtimeToken?.trim() || null,
    });

    // A dead pid or a reused-port token mismatch is `stopped`, not a health
    // failure: the counter resets and runtime fields clear. Only an alive-but-
    // unreachable runtime counts toward the 3-strike enforcement below.
    if (verdict === 'dead' || verdict === 'token-mismatch') {
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

    if (verdict === 'unreachable') {
      await this.handleProcessProbeFailure(row.id, row.status);
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
        if (!pid || !this.processRuntime.isProcessAlive(pid)) {
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

        const metadata = await this.processRuntime.fetchRuntimeMetadata(row.containerPort);
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

  /**
   * Per-worktree in-flight operation guard (user-approved fix-set). Contract:
   * - SAME-op duplicate (e.g. double-click start) → awaits and SHARES the in-flight
   *   result: the underlying work runs exactly once and both callers resolve with
   *   the same value (no new error surface).
   * - CONFLICTING op (e.g. merge-during-start) → 409 ConflictException naming the
   *   in-flight operation.
   * The check + register pair is synchronous up to the wrapped call's first await,
   * so two calls in the same tick cannot both miss the registration. Registration
   * is cleared in a finally so a thrown/404 result never wedges a worktree.
   */
  private withOperationGuard<T>(
    worktreeId: string,
    operation: GuardedOperation,
    run: () => Promise<T>,
  ): Promise<T> {
    const inFlight = this.inFlightOperations.get(worktreeId);
    if (inFlight) {
      if (inFlight.operation === operation) {
        return inFlight.promise as Promise<T>;
      }
      throw new ConflictException(
        `Worktree is already running an in-flight "${inFlight.operation}" operation`,
      );
    }

    const promise = run().finally(() => {
      this.inFlightOperations.delete(worktreeId);
    });
    this.inFlightOperations.set(worktreeId, { operation, promise });
    return promise;
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

  private async resolveCreateRepoPath(input: CreateWorktreeDto): Promise<string> {
    if (!this.storage) {
      return this.resolveRepoPath(input.repoPath);
    }

    const project = await this.storage.getProject(input.ownerProjectId);
    const rootPath = project.rootPath?.trim();
    if (!rootPath) {
      throw new BadRequestException(`Project ${input.ownerProjectId} has no rootPath configured`);
    }

    return resolve(rootPath);
  }

  private async prepareIgnoredCopyPlan(
    repoPath: string,
    worktreePath: string,
    requestedPaths: string[],
  ): Promise<IgnoredCopyPlan> {
    if (requestedPaths.length === 0) {
      return {
        requestedCount: 0,
        deduplicatedCount: 0,
        operations: [],
      };
    }

    const normalizedRequested = this.normalizeAndDedupeIgnoredPaths(requestedPaths);
    const ignoredFiles = await this.gitService.listIgnoredFiles(repoPath);
    const allowedPaths = new Set(
      ignoredFiles.map((entry) => this.normalizeIgnoredPath(entry.path)),
    );

    const operations: IgnoredCopyOperation[] = [];
    for (const relativePath of normalizedRequested) {
      if (!allowedPaths.has(relativePath)) {
        throw new BadRequestException(
          `Ignored path "${relativePath}" is not currently gitignored in repository`,
        );
      }

      try {
        const validatedSource = validatePathWithinRoot(repoPath, relativePath, {
          errorPrefix: 'Ignored file validation failed',
        });
        const sourcePath = await validateResolvedPathWithinRoot(
          validatedSource.absolutePath,
          repoPath,
          {
            errorPrefix: 'Ignored file validation failed',
          },
        );
        const validatedDestination = validatePathWithinRoot(worktreePath, relativePath, {
          errorPrefix: 'Ignored file validation failed',
        });
        const destinationPath = await validateResolvedPathWithinRoot(
          validatedDestination.absolutePath,
          worktreePath,
          {
            errorPrefix: 'Ignored file validation failed',
            allowNonExistent: true,
          },
        );
        operations.push({
          relativePath,
          sourcePath,
          destinationPath,
        });
      } catch (error) {
        if (error instanceof ValidationError) {
          throw new BadRequestException(error.message);
        }
        throw error;
      }
    }

    return {
      requestedCount: requestedPaths.length,
      deduplicatedCount: normalizedRequested.length,
      operations,
    };
  }

  private normalizeAndDedupeIgnoredPaths(requestedPaths: string[]): string[] {
    const deduplicated: string[] = [];
    const seen = new Set<string>();

    for (const requestedPath of requestedPaths) {
      const normalizedPath = this.normalizeIgnoredPath(requestedPath);
      if (!normalizedPath) {
        throw new BadRequestException('Ignored file path cannot be empty');
      }
      if (seen.has(normalizedPath)) {
        continue;
      }
      seen.add(normalizedPath);
      deduplicated.push(normalizedPath);
    }

    return deduplicated;
  }

  private normalizeIgnoredPath(path: string): string {
    const trimmed = path.trim().replace(/\\/g, '/');
    const withoutLeadingDot = trimmed.replace(/^\.\/+/, '');
    const collapsedSeparators = withoutLeadingDot.replace(/\/{2,}/g, '/');
    return collapsedSeparators.replace(/\/+$/, '');
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
