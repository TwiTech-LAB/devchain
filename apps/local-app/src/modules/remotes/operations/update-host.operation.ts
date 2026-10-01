import { dockerStep } from './docker.step';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConflictError } from '../../../common/errors/error-types';
import { createLogger } from '../../../common/logging/logger';
import type { RemoteOperation } from '../../storage/models/domain.models';
import { REMOTE_HEALTH_PORT, type RemoteHealthPort } from '../ports/remote-health.port';
import { RemoteBindingsService } from '../services/remote-bindings.service';
import { RemoteHostClient } from './remote-host.client';
import { HOST_API_KEY_REJECTED, HOST_API_KEY_REJECTED_MESSAGE } from '../host-api-key';
import { RemoteOperationStepRefusedError } from './remote-operation.errors';
import {
  DEFAULT_REMOTE_OPERATION_TIMING,
  REMOTE_OPERATION_TIMING,
  sleep,
  type RemoteOperationTiming,
} from './remote-operation.timing';
import {
  stepStarted,
  type RemoteOperationDefinition,
  type RemoteOperationStepDefinition,
  type RemoteOperationStepRun,
} from './remote-operation.types';

const logger = createLogger('UpdateHostOperation');

export interface UpdateHostDetails {
  versionChange?: boolean;
  installDocker?: boolean;
  dockerChange?: boolean;
  /** The version the host installs: this home's. */
  version: string;
  /** Projects the remote owns, frozen on the host for the update. */
  frozenProjectIds?: string[];
}

/**
 * Installs this home's DevChain version on a claimed host VM. The host's
 * projects are frozen while its DevChain restarts, so nothing writes to them
 * across the version change.
 */
@Injectable()
export class UpdateHostOperation implements RemoteOperationDefinition {
  readonly kind = 'update_host' as const;
  readonly steps: readonly RemoteOperationStepDefinition[];
  private readonly timing: RemoteOperationTiming;

  constructor(
    @Inject(REMOTE_HEALTH_PORT) private readonly health: RemoteHealthPort,
    private readonly bindings: RemoteBindingsService,
    private readonly host: RemoteHostClient,
    @Optional() @Inject(REMOTE_OPERATION_TIMING) timing: RemoteOperationTiming | null = null,
  ) {
    this.timing = timing ?? DEFAULT_REMOTE_OPERATION_TIMING;
    this.steps = [
      { id: 'preflight', label: 'Check the VM', run: (c) => this.preflight(c) },
      {
        id: 'freeze_projects',
        label: 'Lock the projects on the VM',
        run: (c) => this.freezeProjects(c),
      },
      { id: 'update', label: 'Install the new version', run: (c) => this.update(c) },
      {
        id: 'wait_healthy',
        label: 'Wait for DevChain to restart',
        run: (c) => this.waitHealthy(c),
      },
      dockerStep(this.host, this.timing),
      {
        id: 'thaw_projects',
        label: 'Unlock the projects on the VM',
        run: (c) => this.thawProjects(c),
      },
    ];
  }

  stepsFor(details: Record<string, unknown>): readonly RemoteOperationStepDefinition[] {
    return this.steps.filter((step) => {
      if (step.id === 'docker') return details.dockerChange === true;
      if (step.id === 'update' || step.id === 'wait_healthy')
        return details.versionChange !== false;
      return true;
    });
  }

  assertCancellable(operation: RemoteOperation): void {
    if (stepStarted(operation, 'update') || stepStarted(operation, 'docker')) {
      throw new ConflictError('The host may be installing the version; retry instead.', {
        code: 'REMOTE_OPERATION_NOT_CANCELLABLE',
        operationId: operation.id,
      });
    }
  }

  async rollback(operation: RemoteOperation): Promise<void> {
    await this.thaw(operation);
  }

  private async preflight({ operation, details }: RemoteOperationStepRun): Promise<void> {
    const { version } = details as unknown as UpdateHostDetails;
    const health = await this.health.refresh(operation.remoteId);
    if (!health.online) {
      throw new RemoteOperationStepRefusedError('REMOTE_OFFLINE', 'The remote is offline.', {
        remoteId: operation.remoteId,
      });
    }
    if (health.apiKeyRejected) {
      throw new RemoteOperationStepRefusedError(
        HOST_API_KEY_REJECTED,
        HOST_API_KEY_REJECTED_MESSAGE,
        { remoteId: operation.remoteId },
      );
    }
    if (health.version === version && details.dockerChange !== true) {
      throw new RemoteOperationStepRefusedError(
        'REMOTE_VERSION_CURRENT',
        `The remote already runs ${version}.`,
        { remoteId: operation.remoteId },
      );
    }
  }

  private async freezeProjects({ operation, details }: RemoteOperationStepRun): Promise<void> {
    const projectIds = (await this.bindings.list())
      .filter((binding) => binding.remoteId === operation.remoteId && binding.state === 'remote')
      .map((binding) => binding.projectId);
    // Recorded first: a cancel thaws whatever the loop reached.
    (details as unknown as UpdateHostDetails).frozenProjectIds = projectIds;
    for (const projectId of projectIds) {
      await this.host.freeze(operation.remoteId, projectId);
    }
  }

  private async update({ operation, details }: RemoteOperationStepRun): Promise<void> {
    const { version } = details as unknown as UpdateHostDetails;
    const remote = await this.hostRuntime(operation);
    if (remote === version) return;
    const outcome = await this.host.requestHostUpdate(operation.remoteId, version);
    logger.info({ operationId: operation.id, version, outcome }, 'Host update requested');
  }

  /** The host restarts during the update, so failed polls are expected until it is back. */
  private async waitHealthy({ operation, details }: RemoteOperationStepRun): Promise<void> {
    const { version } = details as unknown as UpdateHostDetails;
    const deadline = Date.now() + this.timing.hostUpdateTimeoutMs;
    for (;;) {
      if ((await this.hostRuntime(operation)) === version) break;
      const status = await this.host.hostUpdateStatus(operation.remoteId).catch(() => null);
      if (status?.state === 'failed' && status.version === version) {
        throw new RemoteOperationStepRefusedError(
          'HOST_UPDATE_FAILED',
          `The host could not install ${version}: ${status.error ?? 'unknown error'}.`,
        );
      }
      if (Date.now() >= deadline) {
        throw new RemoteOperationStepRefusedError(
          'HOST_UPDATE_TIMEOUT',
          `The host did not come back on ${version} in time.`,
        );
      }
      await sleep(this.timing.pollIntervalMs);
    }
    const health = await this.health.refresh(operation.remoteId);
    if (!health.versionMatches) {
      throw new RemoteOperationStepRefusedError(
        'REMOTE_VERSION_MISMATCH',
        `The remote runs ${health.version ?? 'an unknown version'}, which differs from this instance.`,
      );
    }
  }

  private async thawProjects({ operation }: RemoteOperationStepRun): Promise<void> {
    await this.thaw(operation);
  }

  private async thaw(operation: RemoteOperation): Promise<void> {
    const projectIds = (operation.details as unknown as UpdateHostDetails).frozenProjectIds ?? [];
    for (const projectId of projectIds) {
      await this.host.thaw(operation.remoteId, projectId);
    }
  }

  /** A plain runtime probe: health.refresh would also flip the shared online state on each restart miss. */
  private async hostRuntime(operation: RemoteOperation): Promise<string | null> {
    const remote = await this.host.remoteRuntime(operation.remoteId).catch(() => null);
    return remote?.version ?? null;
  }
}
