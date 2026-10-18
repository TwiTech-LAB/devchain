import { Inject, Injectable } from '@nestjs/common';
import { STORAGE_SERVICE, type WorktreeStorage } from '../../storage/interfaces/storage.interface';
import { REMOTE_HEALTH_PORT, type RemoteHealthPort } from '../ports/remote-health.port';
import { RemoteHostClient } from './remote-host.client';
import { RemoteOperationStepRefusedError } from './remote-operation.errors';

export const UNKNOWN_VM_LANES_WARNING = 'Lanes on the VM are unknown and may be lost.';

@Injectable()
export class RemoteWorktreeGuard {
  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: WorktreeStorage,
    private readonly host: RemoteHostClient,
    @Inject(REMOTE_HEALTH_PORT) private readonly health: RemoteHealthPort,
  ) {}

  async assertLocalEmpty(projectId: string): Promise<void> {
    this.assertEmpty(projectId, await this.storage.listWorktrees(projectId));
  }

  async assertRemoteEmpty(remoteId: string, projectId: string): Promise<void> {
    if (!this.health.getState(remoteId).online) {
      throw new RemoteOperationStepRefusedError(
        'REMOTE_OFFLINE',
        'The remote is offline; use a forced Disconnect or reset to keep the last mirrored state.',
        { remoteId },
      );
    }
    let lanes;
    try {
      lanes = (await this.host.listWorktrees(remoteId, projectId)).lanes;
    } catch {
      throw new RemoteOperationStepRefusedError(
        'LANES_UNKNOWN',
        'The VM lanes could not be checked. Restore the VM connection and try again.',
        { remoteId, projectId },
      );
    }
    this.assertEmpty(projectId, lanes);
  }

  async freezeRemoteEmpty(
    remoteId: string,
    projectId: string,
    recordFreeze: () => Promise<void>,
  ): Promise<string | null> {
    if (!this.health.getState(remoteId).online) return UNKNOWN_VM_LANES_WARNING;
    await recordFreeze();
    try {
      await this.host.setLaneAdmission(remoteId, projectId, true);
      await this.assertRemoteEmpty(remoteId, projectId);
      return null;
    } catch (error) {
      if (error instanceof RemoteOperationStepRefusedError && error.code === 'LANES_EXIST')
        throw error;
      if (await this.unreachable(remoteId)) return UNKNOWN_VM_LANES_WARNING;
      if (error instanceof RemoteOperationStepRefusedError) throw error;
      throw new RemoteOperationStepRefusedError(
        'LANES_UNKNOWN',
        'The VM lane admission could not be closed. Restore the VM connection and try again.',
        { remoteId, projectId },
      );
    }
  }

  async thawRemoteAdmission(remoteId: string, projectId: string): Promise<boolean> {
    try {
      await this.host.setLaneAdmission(remoteId, projectId, false);
      return true;
    } catch (error) {
      // Keep the durable freeze record when an unreachable host cannot acknowledge cleanup.
      if (await this.unreachable(remoteId)) return false;
      throw error;
    }
  }

  private async unreachable(remoteId: string): Promise<boolean> {
    try {
      const health = await this.health.refresh(remoteId);
      return !health.online && !health.apiKeyRejected;
    } catch {
      return false;
    }
  }

  private assertEmpty(projectId: string, lanes: { name: string }[]): void {
    if (lanes.length > 0) {
      const names = lanes.map((lane) => lane.name);
      throw new RemoteOperationStepRefusedError(
        'LANES_EXIST',
        `Remove the project lanes before handing off: ${names.join(', ')}.`,
        { projectId, names },
      );
    }
  }
}
