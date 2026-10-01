import { TranscriptHandoff } from './transcript-handoff';
import { DockerHandoff } from '../docker/docker-handoff';
import { DockerCopyBack } from '../docker/docker-copy-back';
import type { DockerCopyBackRequest } from '../docker/docker-copy-back.dto';
import { Inject, Injectable } from '@nestjs/common';
import { ConflictError } from '../../../common/errors/error-types';
import type { RemoteOperation } from '../../storage/models/domain.models';
import { ProjectFreezeService } from '../host/project-freeze.service';
import { REMOTE_HEALTH_PORT, type RemoteHealthPort } from '../ports/remote-health.port';
import { ProjectReplicaApplier } from '../replica/project-replica.applier';
import { RemoteBindingsService } from '../services/remote-bindings.service';
import { RemoteLiveSyncService } from '../sync/remote-live-sync.service';
import type { ProjectTimeSettlement } from '../time/project-time-settler.service';
import { FileSyncHandoff, type FileSyncLoss } from './file-sync-handoff';
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

/** Values the detach steps keep in `operation.details`. */
export interface DetachDetails {
  /** Skip every host step: the remote is unreachable and home keeps its mirror as is. */
  force?: boolean;
  /** "Copy Docker data back to this PC" with the user's choices; absent when off. */
  dockerCopyBack?: DockerCopyBackRequest;
  /** Binding cursor when the detach began; restored by a cancel. */
  hostCursor?: string | null;
  /** This operation moved the binding to `detaching`; a cancel moves it back. */
  markedDetaching?: boolean;
  /** `file_sync_final` paused both sides' folders; a cancel unpauses them. */
  fileSyncPaused?: boolean;
  /** How the host settled the project's agent time before the final pull. */
  timeSettlement?: ProjectTimeSettlement;
  /** Host-side time of the final pull. */
  finalCursor?: string;
  /** What a forced detach may have lost, measured when it began. */
  forcedLoss?: {
    hostCursor: string | null;
    /** `now - hostCursor` in ms; null when home never pulled. */
    mirrorAgeMs: number | null;
    /** Per shared folder, what home had not yet received when the detach began. */
    fileSync: FileSyncLoss;
    /**
     * The host's open segments and team batch lanes were never settled, and the
     * mirror carries settled segments only: that agent time is not brought back.
     */
    teamLanes: 'unfinalized';
    transcripts?: 'remote-changes';
  };
}

/** The Disconnect asked for "Copy Docker data back to this PC". */
const asked = (details: Record<string, unknown>) =>
  (details as DetachDetails).dockerCopyBack !== undefined;

const HOST_STEPS = new Set([
  'freeze_host',
  'stop_host_sessions',
  'docker_stop_host',
  'docker_copy_home',
  'wait_time_batches',
  'final_pull',
  'transcripts_pull',
  'file_sync_final',
  'host_release',
]);

/**
 * Disconnect: pulls the project back from the remote and makes home its writer
 * again. `force` skips the host and keeps home's mirror as it is.
 */
@Injectable()
export class DetachOperation implements RemoteOperationDefinition {
  readonly kind = 'detach' as const;
  readonly steps: readonly RemoteOperationStepDefinition[];

  constructor(
    @Inject(REMOTE_HEALTH_PORT) private readonly health: RemoteHealthPort,
    private readonly bindings: RemoteBindingsService,
    private readonly applier: ProjectReplicaApplier,
    private readonly host: RemoteHostClient,
    private readonly freeze: ProjectFreezeService,
    private readonly liveSync: RemoteLiveSyncService,
    private readonly fileSync: FileSyncHandoff,
    private readonly transcripts: TranscriptHandoff,
    private readonly docker: DockerHandoff,
    private readonly dockerCopyBack: DockerCopyBack,
  ) {
    const skipOnForce = (details: Record<string, unknown>) =>
      (details as DetachDetails).force === true;
    const steps: RemoteOperationStepDefinition[] = [
      { id: 'preflight', label: 'Check the VM and the project', run: (c) => this.preflight(c) },
      { id: 'freeze_host', label: 'Lock the project on the VM', run: (c) => this.freezeHost(c) },
      {
        id: 'stop_host_sessions',
        label: 'Stop agent sessions on the VM',
        run: (c) => this.stopHostSessions(c),
      },
      {
        id: 'docker_stop_host',
        label: 'Stop Docker containers on the VM',
        run: (c) => this.docker.stopHost(c),
      },
      {
        // Opt-in whoever composes it: without the request the step skips, and a
        // stored step that still runs without it does nothing.
        id: 'docker_copy_home',
        label: 'Copy Docker data to this PC',
        skip: (details) => !asked(details),
        run: async (c) => {
          if (asked(c.details)) await this.dockerCopyBack.copyHome(c);
        },
      },
      {
        id: 'wait_time_batches',
        label: 'Save agent time',
        run: (c) => this.waitTimeBatches(c),
      },
      {
        id: 'final_pull',
        label: 'Copy the project back to this PC',
        run: (c) => this.finalPull(c),
      },
      {
        id: 'transcripts_pull',
        label: 'Copy session transcripts',
        run: (c) => this.transcripts.copy(c, requireProjectId(c.operation), 'pull'),
      },
      {
        id: 'file_sync_final',
        label: 'Sync files back to this PC',
        run: (c) => this.fileSync.final(c, requireProjectId(c.operation)),
      },
      {
        id: 'file_sync_flip',
        label: 'Switch the file sync direction',
        // Runs on a forced detach too, changing home's folders only.
        run: (c) =>
          this.fileSync.flipToHome(
            c,
            requireProjectId(c.operation),
            (c.details as DetachDetails).force === true,
          ),
      },
      {
        id: 'host_release',
        label: 'Remove the project copy from the VM',
        run: (c) => this.hostRelease(c),
      },
      { id: 'unbind', label: 'Make this PC the project owner', run: (c) => this.unbind(c) },
      { id: 'thaw_home', label: 'Unlock the project on this PC', run: (c) => this.thawHome(c) },
    ];
    this.steps = steps.map((step) =>
      HOST_STEPS.has(step.id)
        ? {
            ...step,
            skip: (details: Record<string, unknown>) =>
              skipOnForce(details) || (step.skip?.(details) ?? false),
          }
        : step,
    );
  }

  /** The Docker copy step exists only when the Disconnect asked for it; composers use this list. */
  stepsFor(details: Record<string, unknown>): readonly RemoteOperationStepDefinition[] {
    return this.steps.filter((step) => asked(details) || step.id !== 'docker_copy_home');
  }

  async interrupt(operationId: string): Promise<void> {
    this.transcripts.interrupt(operationId);
    this.docker.interrupt(operationId);
    this.dockerCopyBack.interrupt(operationId);
  }

  async completed(operation: RemoteOperation): Promise<void> {
    await this.dockerCopyBack.finish(operation.id);
  }

  assertCancellable(operation: RemoteOperation): void {
    if (stepStarted(operation, 'host_release') || stepStarted(operation, 'unbind')) {
      throw new ConflictError('The remote copy is already being removed; the detach must finish.', {
        code: 'REMOTE_OPERATION_NOT_CANCELLABLE',
        operationId: operation.id,
      });
    }
  }

  /**
   * Gives the project back to the remote: binding `remote`, host thawed, mirror
   * running. Home data groups the Docker copy emptied but never verified are
   * named, from its durable record.
   */
  async rollback(operation: RemoteOperation): Promise<{ dockerCopyBackPartial?: string[] } | void> {
    const projectId = requireProjectId(operation);
    const details = operation.details as DetachDetails;
    const partial = await this.dockerCopyBack.partialGroups(operation.id);
    const result = partial.length ? { dockerCopyBackPartial: partial } : undefined;
    if (details.markedDetaching) await this.giveBack(operation, projectId, details);
    // Kept until here, so a rollback that failed can name the groups when it runs again.
    await this.dockerCopyBack.finish(operation.id);
    return result;
  }

  private async giveBack(
    operation: RemoteOperation,
    projectId: string,
    details: DetachDetails,
  ): Promise<void> {
    // final() re-creates both sides paused; a failure before its unpause leaves them so.
    if (stepStarted(operation, 'file_sync_flip') || details.fileSyncPaused) {
      await this.fileSync.flipBackToHost(operation.remoteId, projectId, details.force === true);
    }
    if (stepStarted(operation, 'freeze_host')) {
      await this.host.thaw(operation.remoteId, projectId);
    }
    const binding = await this.bindings.get(projectId);
    if (binding && binding.remoteId === operation.remoteId) {
      await this.bindings.update(projectId, { state: 'remote' });
      // The pull may have been stopped for a while; start with a full reconcile.
      this.liveSync.start(projectId, operation.remoteId, { full: true });
    }
  }

  private async preflight({ operation, details }: RemoteOperationStepRun): Promise<void> {
    const projectId = requireProjectId(operation);
    const { remoteId } = operation;
    const force = (details as DetachDetails).force === true;
    const binding = await this.bindings.get(projectId);
    if (
      !binding ||
      binding.remoteId !== remoteId ||
      (binding.state !== 'remote' && binding.state !== 'detaching')
    ) {
      throw new RemoteOperationStepRefusedError(
        'REMOTE_BINDING_MISSING',
        'The project is not connected to this remote.',
        { projectId, remoteId, state: binding?.state ?? null },
      );
    }
    if (!force) {
      const health = this.health.getState(remoteId);
      if (!health.online) {
        throw new RemoteOperationStepRefusedError(
          'REMOTE_OFFLINE',
          'The remote is offline; a forced disconnect keeps the last mirrored state.',
          { remoteId },
        );
      }
      if (health.apiKeyRejected) {
        throw new RemoteOperationStepRefusedError(
          HOST_API_KEY_REJECTED,
          `${HOST_API_KEY_REJECTED_MESSAGE} A forced disconnect keeps the last mirrored state.`,
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
    }

    const target = details as DetachDetails;
    if (binding.state === 'remote') {
      target.hostCursor = binding.hostCursor;
    }
    if (force && !target.forcedLoss) {
      const cursor = target.hostCursor ?? binding.hostCursor;
      target.forcedLoss = {
        hostCursor: cursor,
        mirrorAgeMs: cursor ? Math.max(0, Date.now() - Date.parse(cursor)) : null,
        fileSync: await this.fileSync.forcedLoss(projectId),
        teamLanes: 'unfinalized',
        transcripts: 'remote-changes',
      };
    }
    await this.liveSync.stop(projectId);
    if (binding.state !== 'detaching') {
      await this.bindings.update(projectId, { state: 'detaching' });
    }
    target.markedDetaching = true;
  }

  private async freezeHost({ operation }: RemoteOperationStepRun): Promise<void> {
    await this.host.freeze(operation.remoteId, requireProjectId(operation));
  }

  private async stopHostSessions({ operation }: RemoteOperationStepRun): Promise<void> {
    await this.host.stopSessions(operation.remoteId, requireProjectId(operation));
  }

  private async waitTimeBatches({ operation, details }: RemoteOperationStepRun): Promise<void> {
    (details as DetachDetails).timeSettlement = await this.host.settleTime(
      operation.remoteId,
      requireProjectId(operation),
    );
  }

  private async finalPull({ operation, details }: RemoteOperationStepRun): Promise<void> {
    const replica = await this.host.exportReplica(
      operation.remoteId,
      requireProjectId(operation),
      'detach',
    );
    await this.applier.apply(replica, {
      mode: 'full',
      remoteId: operation.remoteId,
      cursor: replica.generatedAt,
    });
    (details as DetachDetails).finalCursor = replica.generatedAt;
  }

  private async hostRelease({ operation }: RemoteOperationStepRun): Promise<void> {
    await this.host.release(operation.remoteId, requireProjectId(operation));
  }

  private async unbind({ operation }: RemoteOperationStepRun): Promise<void> {
    const projectId = requireProjectId(operation);
    await this.liveSync.stop(projectId);
    await this.bindings.delete(projectId);
  }

  private async thawHome({ operation }: RemoteOperationStepRun): Promise<void> {
    await this.freeze.thaw(requireProjectId(operation));
  }
}
