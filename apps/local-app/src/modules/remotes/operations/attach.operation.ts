import { TranscriptHandoff } from './transcript-handoff';
import { DockerHandoff, dockerSelection } from '../docker/docker-handoff';
import { Inject, Injectable } from '@nestjs/common';
import { homeIdentity } from '../home-identity';
import type { ProjectReplicaOfScope } from '@devchain/shared';
import { ConflictError, ReplicaPreflightError } from '../../../common/errors/error-types';
import { createLogger } from '../../../common/logging/logger';
import type { RemoteOperation } from '../../storage/models/domain.models';
import { ProjectFreezeService } from '../host/project-freeze.service';
import { REMOTE_HEALTH_PORT, type RemoteHealthPort } from '../ports/remote-health.port';
import { FileSyncManagedExclusionsStore } from '../../file-sync/file-sync-managed-exclusions.store';
import { ProjectReplicaBuilder } from '../replica/project-replica.builder';
import { ProjectSessionsStopper } from '../services/project-sessions-stopper.service';
import { RemoteBindingsService } from '../services/remote-bindings.service';
import { RemoteLiveSyncService } from '../sync/remote-live-sync.service';
import {
  ProjectTimeSettler,
  type ProjectTimeSettlement,
} from '../time/project-time-settler.service';
import { ProcessExecutor } from '../../terminal/services/process-executor/process-executor.port';
import { FileSyncHandoff } from './file-sync-handoff';
import { buildGlobalGitConfigClaimFile } from './git-global-config';
import { RemoteHostClient } from './remote-host.client';
import { HOST_API_KEY_REJECTED, HOST_API_KEY_REJECTED_MESSAGE } from '../host-api-key';
import { RemoteOperationStepRefusedError } from './remote-operation.errors';
import {
  requireProjectId,
  stepStarted,
  type RemoteOperationDefinition,
  type RemoteOperationStepDefinition,
  type RemoteOperationStepRun,
} from './remote-operation.types';

const logger = createLogger('AttachOperation');

/** Values the attach steps keep in `operation.details`. */
interface AttachDetails {
  /** The `attaching` binding row belongs to this operation. */
  bindingCreated?: boolean;
  /** Set before the host import is sent; the host may hold a copy from then on. */
  pushStarted?: boolean;
  /** Host-side time the imported copy reflects; becomes the binding's `hostCursor`. */
  importCursor?: string;
  /** Why a cancel could not release the host copy. */
  hostReleaseError?: string;
  /** How home's agent time for the project was settled before the copy. */
  timeSettlement?: ProjectTimeSettlement;
  /** Why a cancel could not stop the remote sharing the project's folders. */
  hostFolderRemovalError?: string;
  /** Why a cancel could not remove this attempt's Docker items from the remote. */
  dockerCleanupError?: string;
  /** Home containers this attempt stopped that did not start again after a cancel. */
  dockerNotRestarted?: string[];
  /** The managed exclusions before this attempt changed them; a cancel puts them back. */
  managedExclusionsBefore?: string[];
  /** Outcome of copying this PC's global git config; `sent` shows nothing extra. */
  gitConfig?: 'sent' | 'not_set_on_pc' | 'failed';
  /** Why the git config copy failed; the host's message, never the file content. */
  gitConfigError?: string;
}

/**
 * Connect: copies a home project to the remote with the same IDs and makes the
 * remote its only writer. Home stays frozen while the remote owns the project.
 */
@Injectable()
export class AttachOperation implements RemoteOperationDefinition {
  readonly kind = 'attach' as const;
  readonly steps: readonly RemoteOperationStepDefinition[];
  /** Built replicas by operation, so a push right after the build skips a second read. */
  private readonly replicas = new Map<string, ProjectReplicaOfScope<'attach'>>();

  constructor(
    @Inject(REMOTE_HEALTH_PORT) private readonly health: RemoteHealthPort,
    private readonly bindings: RemoteBindingsService,
    private readonly builder: ProjectReplicaBuilder,
    private readonly host: RemoteHostClient,
    private readonly freeze: ProjectFreezeService,
    private readonly sessionsStopper: ProjectSessionsStopper,
    private readonly liveSync: RemoteLiveSyncService,
    private readonly timeSettler: ProjectTimeSettler,
    private readonly fileSync: FileSyncHandoff,
    private readonly managedExclusions: FileSyncManagedExclusionsStore,
    private readonly transcripts: TranscriptHandoff,
    private readonly docker: DockerHandoff,
    private readonly processExecutor: ProcessExecutor,
  ) {
    const noDocker = (details: Record<string, unknown>) => !dockerSelection(details);
    this.steps = [
      { id: 'preflight', label: 'Check the VM and the project', run: (c) => this.preflight(c) },
      {
        id: 'git_config',
        label: "Copy this PC's git settings to the VM",
        run: (c) => this.gitConfig(c),
      },
      {
        id: 'docker_preflight',
        label: 'Check the Docker items',
        run: (c) => this.docker.preflight(c),
        skip: noDocker,
      },
      {
        id: 'stop_home_sessions',
        label: 'Stop agent sessions on this PC',
        run: (c) => this.stopHomeSessions(c),
      },
      {
        id: 'docker_stop_home',
        label: 'Stop Docker containers on this PC',
        run: (c) => this.docker.stopHome(c),
        skip: noDocker,
      },
      {
        id: 'wait_time_batches',
        label: 'Save agent time',
        run: (c) => this.waitTimeBatches(c),
      },
      { id: 'freeze_home', label: 'Lock the project on this PC', run: (c) => this.freezeHome(c) },
      { id: 'build_replica', label: 'Build the project copy', run: (c) => this.buildReplica(c) },
      {
        id: 'push_replica',
        label: 'Send the project copy to the VM',
        run: (c) => this.pushReplica(c),
      },
      {
        id: 'transcripts_push',
        label: 'Copy session transcripts',
        run: (c) => this.transcripts.copy(c, requireProjectId(c.operation), 'push'),
      },
      {
        id: 'docker_push',
        label: 'Copy Docker images and volumes to the VM',
        run: (c) => this.docker.push(c),
        skip: noDocker,
      },
      {
        id: 'file_sync_initial',
        label: 'Sync files to the VM',
        run: (c) => this.fileSync.initial(c, requireProjectId(c.operation)),
      },
      {
        id: 'file_sync_flip',
        label: 'Switch the file sync direction',
        run: (c) => this.fileSync.flipToHost(c, requireProjectId(c.operation)),
      },
      {
        id: 'docker_create_host',
        label: 'Create Docker containers on the VM',
        run: (c) => this.docker.createHost(c),
        skip: noDocker,
      },
      { id: 'bind_remote', label: 'Make the VM the project owner', run: (c) => this.bindRemote(c) },
      { id: 'thaw_host', label: 'Unlock the project on the VM', run: (c) => this.thawHost(c) },
      { id: 'start_live_sync', label: 'Start live sync', run: (c) => this.startLiveSync(c) },
    ];
  }

  forget(operationId: string): void {
    this.replicas.delete(operationId);
    this.docker.finish(operationId).catch(() => {
      logger.warn({ operationId }, 'Docker settings of a superseded operation were not removed');
    });
  }

  async completed(operation: RemoteOperation): Promise<void> {
    await this.docker.finish(operation.id);
  }

  async interrupt(operationId: string): Promise<void> {
    this.transcripts.interrupt(operationId);
    this.docker.interrupt(operationId);
  }

  assertCancellable(operation: RemoteOperation): void {
    const bind = operation.steps.find((step) => step.id === 'bind_remote');
    if (bind && bind.state !== 'pending') {
      throw new ConflictError('The remote already owns the project; disconnect it instead.', {
        code: 'REMOTE_OPERATION_NOT_CANCELLABLE',
        operationId: operation.id,
      });
    }
  }

  /**
   * Undoes only what this operation did, leaving home unbound and writable.
   * When the host copy cannot be released, the binding stays as `failed`
   * (home-owned) and the reason is kept.
   */
  async rollback(operation: RemoteOperation): Promise<Partial<AttachDetails>> {
    const projectId = requireProjectId(operation);
    const details = operation.details as AttachDetails;
    this.replicas.delete(operation.id);
    // Before the host copy is released: the VM Docker items belong to this attempt.
    // Nothing here may keep the rest of the cancel from giving the project back.
    const docker = await this.docker.rollback(operation).catch((error: unknown) => {
      logger.warn({ operationId: operation.id }, 'Docker cancel cleanup failed');
      return { dockerCleanupError: error instanceof Error ? error.message : String(error) };
    });
    // Home keeps its files and stays the only writer; neither side shares the folders any more.
    const folderError = stepStarted(operation, 'file_sync_initial')
      ? await this.fileSync.removeFolders(operation.remoteId, projectId)
      : null;
    // The set this attempt replaced: a live connection or an earlier import may own it.
    if (details.managedExclusionsBefore)
      this.managedExclusions.set(projectId, details.managedExclusionsBefore);
    let releaseError: string | null = null;
    if (details.pushStarted) {
      try {
        if (await this.host.projectExists(operation.remoteId, projectId)) {
          // The host only releases a frozen project; the push may have stopped before freezing it.
          await this.host.freeze(operation.remoteId, projectId);
          await this.host.release(operation.remoteId, projectId);
        }
      } catch (error) {
        releaseError = error instanceof Error ? error.message : String(error);
        logger.warn({ operationId: operation.id, projectId }, 'Host copy was not released');
      }
    }
    const binding = details.bindingCreated ? await this.bindings.get(projectId) : null;
    if (binding && binding.remoteId === operation.remoteId) {
      if (releaseError) {
        await this.bindings.update(projectId, { state: 'failed' });
      } else {
        await this.bindings.delete(projectId);
      }
    }
    if (stepStarted(operation, 'freeze_home')) {
      await this.freeze.thaw(projectId);
    }
    return {
      ...docker,
      ...(releaseError && { hostReleaseError: releaseError }),
      ...(folderError && { hostFolderRemovalError: folderError }),
    };
  }

  private async preflight({ operation, details }: RemoteOperationStepRun): Promise<void> {
    const projectId = requireProjectId(operation);
    const { remoteId } = operation;
    const health = this.health.getState(remoteId);
    if (!health.online) {
      throw new RemoteOperationStepRefusedError('REMOTE_OFFLINE', 'The remote is offline.', {
        remoteId,
      });
    }
    if (health.apiKeyRejected) {
      throw new RemoteOperationStepRefusedError(
        HOST_API_KEY_REJECTED,
        HOST_API_KEY_REJECTED_MESSAGE,
        { remoteId },
      );
    }
    if (!health.versionMatches) {
      throw new RemoteOperationStepRefusedError(
        'REMOTE_VERSION_MISMATCH',
        `The remote runs version ${health.version ?? 'unknown'}, which differs from this instance.`,
        { remoteId, version: health.version },
      );
    }
    // Only a reported home is compared: a build without the field is older, and
    // the version gate above refuses it.
    const home = homeIdentity().homePath;
    if (typeof health.homePath === 'string' && health.homePath !== home) {
      throw new RemoteOperationStepRefusedError(
        'REMOTE_HOME_MISMATCH',
        `The remote's home folder is ${health.homePath}, but this PC's is ${home}. ` +
          'The VM identity must match this PC; claim the VM again with this PC user.',
        { remoteId, homePath: health.homePath },
      );
    }
    // Only Connect needs home's Syncthing; its error carries the install guidance.
    await this.fileSync.ensureAvailable();

    const existing = await this.bindings.get(projectId);
    // An `attaching` row for this remote is this operation's own, from an earlier run of this step.
    const ours = existing?.state === 'attaching' && existing.remoteId === remoteId;
    if (existing && !ours && existing.state !== 'failed') {
      throw new RemoteOperationStepRefusedError(
        'REMOTE_BINDING_EXISTS',
        'The project is already connected to a remote.',
        { projectId, remoteId: existing.remoteId, state: existing.state },
      );
    }

    const build = await this.builder.build({ projectIds: [projectId], scope: 'attach' });
    if (!build.ok) {
      throw new ReplicaPreflightError(build.errors);
    }
    if (!ours && (await this.host.projectExists(remoteId, projectId))) {
      throw new RemoteOperationStepRefusedError(
        'HOST_PROJECT_EXISTS',
        'The remote already has a project with this ID.',
        { projectId, remoteId },
      );
    }

    if (existing?.state === 'failed') {
      await this.bindings.delete(projectId);
    }
    if (!ours) {
      await this.bindings.create(projectId, remoteId);
    }
    (details as AttachDetails).bindingCreated = true;
  }

  private async stopHomeSessions({ operation }: RemoteOperationStepRun): Promise<void> {
    await this.sessionsStopper.stop(requireProjectId(operation));
  }

  /**
   * Makes the VM's `~/.gitconfig` this PC's effective global config. The copy
   * replaces whatever the VM had, so it never runs partially: any failure
   * leaves the VM's own file untouched and Connect continues.
   */
  private async gitConfig({ operation, details }: RemoteOperationStepRun): Promise<void> {
    const attachDetails = details as AttachDetails;
    try {
      const file = await buildGlobalGitConfigClaimFile(
        this.processExecutor,
        homeIdentity().homePath,
      );
      if (file === null) {
        attachDetails.gitConfig = 'not_set_on_pc';
        return;
      }
      await this.host.applyProviderAuth(operation.remoteId, { env: {}, files: [file] });
      attachDetails.gitConfig = 'sent';
    } catch (error) {
      // The file can hold secrets; only the host's message is kept, never content.
      const message = error instanceof Error ? error.message : String(error);
      attachDetails.gitConfig = 'failed';
      attachDetails.gitConfigError = message;
      logger.warn({ operationId: operation.id }, `The VM kept its own git settings: ${message}`);
    }
  }

  /** Home's sweeps skip the project from `attaching` on, so this settles it explicitly. */
  private async waitTimeBatches({ operation, details }: RemoteOperationStepRun): Promise<void> {
    (details as AttachDetails).timeSettlement = await this.timeSettler.settle(
      requireProjectId(operation),
    );
  }

  private async freezeHome({ operation }: RemoteOperationStepRun): Promise<void> {
    await this.freeze.freeze(requireProjectId(operation));
  }

  private async buildReplica({ operation }: RemoteOperationStepRun): Promise<void> {
    this.replicas.set(operation.id, await this.buildAttachReplica(operation));
  }

  private async pushReplica({ operation, details }: RemoteOperationStepRun): Promise<void> {
    const projectId = requireProjectId(operation);
    // Home is frozen, so a rebuild after a restart yields the same rows.
    const replica = this.replicas.get(operation.id) ?? (await this.buildAttachReplica(operation));
    details.pushStarted = true;
    await this.host.importProject(operation.remoteId, replica);
    // The freeze answer carries the host-issued cursor: the copy is frozen from
    // creation with `frozenAt` equal to the import cursor, and a re-freeze keeps
    // that original value. On a first push and on a replay after a lost answer
    // alike, this cursor precedes every host write — home's clock never stands
    // in for it.
    const { frozenAt } = await this.host.freeze(operation.remoteId, projectId);
    details.importCursor = frozenAt;
    this.replicas.delete(operation.id);
  }

  private async bindRemote({ operation, details }: RemoteOperationStepRun): Promise<void> {
    const cursor = (details as AttachDetails).importCursor;
    if (!cursor) {
      throw new Error('The import cursor is missing; retry the push step.');
    }
    await this.bindings.update(requireProjectId(operation), {
      state: 'remote',
      hostCursor: cursor,
    });
  }

  private async thawHost({ operation }: RemoteOperationStepRun): Promise<void> {
    await this.host.thaw(operation.remoteId, requireProjectId(operation));
  }

  private async startLiveSync({ operation }: RemoteOperationStepRun): Promise<void> {
    this.liveSync.start(requireProjectId(operation), operation.remoteId);
  }

  private async buildAttachReplica(
    operation: RemoteOperation,
  ): Promise<ProjectReplicaOfScope<'attach'>> {
    const build = await this.builder.build({
      projectIds: [requireProjectId(operation)],
      scope: 'attach',
    });
    if (!build.ok) {
      throw new ReplicaPreflightError(build.errors);
    }
    return build.replica;
  }
}
