import { Inject, Injectable } from '@nestjs/common';
import { hostname } from 'node:os';
import { HomeGitGuardService } from '../../file-sync/home-git-guard.service';
import { FileSyncService, projectFolderId } from '../../file-sync/file-sync.service';
import type { RemoteOperation } from '../../storage/models/domain.models';
import { GitOwnerStore } from '../git-owner.store';
import { REMOTE_HEALTH_PORT, type RemoteHealthPort } from '../ports/remote-health.port';
import { RemoteBindingsService } from '../services/remote-bindings.service';
import { RemoteLiveSyncService } from '../sync/remote-live-sync.service';
import { FileSyncHandoff } from './file-sync-handoff';
import { gitOwnerCommand, type GitOwnerDetails } from './git-owner.dto';
import { HOST_API_KEY_REJECTED, HOST_API_KEY_REJECTED_MESSAGE } from '../host-api-key';
import { RemoteHostClient } from './remote-host.client';
import { RemoteOperationStepRefusedError } from './remote-operation.errors';
import {
  requireProjectId,
  stepStarted,
  type RemoteOperationDefinition,
  type RemoteOperationStepDefinition,
  type RemoteOperationStepRun,
} from './remote-operation.types';

@Injectable()
export class GitOwnerOperation implements RemoteOperationDefinition {
  readonly kind = 'git_owner' as const;
  readonly steps: readonly RemoteOperationStepDefinition[];

  constructor(
    @Inject(REMOTE_HEALTH_PORT) private readonly health: RemoteHealthPort,
    private readonly bindings: RemoteBindingsService,
    private readonly host: RemoteHostClient,
    private readonly files: FileSyncService,
    private readonly handoff: FileSyncHandoff,
    private readonly live: RemoteLiveSyncService,
    private readonly owners: GitOwnerStore,
    private readonly guard: HomeGitGuardService,
  ) {
    this.steps = [
      {
        id: 'preflight',
        label: 'Check the VM and Git',
        run: (run) =>
          this.validate(run.operation.remoteId, requireProjectId(run.operation), run.operation),
      },
      {
        id: 'freeze_host',
        label: 'Block new agents on the VM',
        run: ({ operation }) =>
          this.host.freeze(operation.remoteId, requireProjectId(operation)).then(() => undefined),
      },
      {
        id: 'stop_host_sessions',
        label: 'Stop agent sessions on the VM',
        run: ({ operation }) =>
          this.host.stopSessions(operation.remoteId, requireProjectId(operation)),
      },
      { id: 'vm_guard', label: 'Block Git on the VM', run: (run) => this.vmGuard(run) },
      {
        id: 'thaw_host',
        label: 'Allow new agents on the VM',
        run: ({ operation }) => this.host.thaw(operation.remoteId, requireProjectId(operation)),
      },
      { id: 'pc_guard', label: 'Block Git on this PC', run: (run) => this.pcGuard(run) },
      {
        id: 'git_settle',
        label: 'Wait for Git changes to sync',
        run: (run) =>
          this.handoff.settleGit(
            run,
            requireProjectId(run.operation),
            run.details.owner === 'home' ? 'vm' : 'home',
          ),
      },
      {
        id: 'git_flip',
        label: 'Move Git control',
        run: (run) =>
          this.live.runExclusive(requireProjectId(run.operation), () =>
            this.handoff.flipGit(run, requireProjectId(run.operation), this.details(run).owner),
          ),
      },
      {
        id: 'pc_guard_remove',
        label: 'Enable Git and rebuild the index on this PC',
        run: (run) => this.pcGuardRemove(run),
      },
      {
        id: 'vm_guard_remove',
        label: 'Enable Git and rebuild the index on the VM',
        run: (run) => this.vmGuardRemove(run),
      },
    ];
  }

  stepsFor(details: Record<string, unknown>): readonly RemoteOperationStepDefinition[] {
    const take = details.owner === 'home';
    const excluded = new Set(
      take
        ? ['pc_guard', 'vm_guard_remove']
        : ['freeze_host', 'stop_host_sessions', 'vm_guard', 'thaw_host', 'pc_guard_remove'],
    );
    if (take && details.force !== true)
      for (const id of ['freeze_host', 'stop_host_sessions', 'thaw_host']) excluded.add(id);
    return this.steps.filter((step) => !excluded.has(step.id));
  }

  async validate(remoteId: string, projectId: string, operation?: RemoteOperation): Promise<void> {
    const refuse = (code: string, message: string): never => {
      throw new RemoteOperationStepRefusedError(code, message, { projectId, remoteId });
    };
    const binding = await this.bindings.get(projectId);
    if (binding?.state !== 'remote' || binding.remoteId !== remoteId)
      refuse('GIT_PROJECT_NOT_CONNECTED', 'The project must be connected to this VM to move Git.');
    const unavailable = (): never =>
      refuse(
        'GIT_SYNC_UNAVAILABLE',
        'The VM Git sync state could not be checked. Restore the VM connection and try again.',
      );
    const health = await this.health.refresh(remoteId).catch(unavailable);
    if (!health.online) refuse('GIT_REMOTE_OFFLINE', 'The VM must be online to move Git.');
    if (health.apiKeyRejected) refuse(HOST_API_KEY_REJECTED, HOST_API_KEY_REJECTED_MESSAGE);
    if (!health.versionMatches)
      refuse('GIT_REMOTE_VERSION_MISMATCH', 'The VM runs a different DevChain version.');
    const device = await this.host.syncDevice(remoteId).catch(unavailable);
    if (!(await this.files.isConnected(device.deviceId).catch(unavailable)))
      refuse('GIT_SYNC_DISCONNECTED', 'There is no file sync connection to the VM.');
    if (
      !(await this.files.projectFolders(projectId).catch(unavailable)).some(
        (folder) => folder.kind === 'git',
      )
    )
      refuse(
        'GIT_SYNC_FOLDER_MISSING',
        'Git sync is not ready for this project. Wait for Connect to finish.',
      );
    if (!operation || !stepStarted(operation, 'git_flip')) {
      const id = projectFolderId(projectId, 'git');
      const [home, vm] = await Promise.all([
        this.files.folderConfiguration(id).catch(unavailable),
        this.host.syncFolderConfiguration(remoteId, id).catch(unavailable),
      ]);
      const owner = this.owners.get(projectId);
      if (
        home.paused ||
        vm.paused ||
        home.type !== (owner === 'home' ? 'sendonly' : 'receiveonly') ||
        vm.type !== (owner === 'vm' ? 'sendonly' : 'receiveonly')
      )
        refuse(
          'GIT_SYNC_NOT_READY',
          'Git sync is not ready. Let file sync finish its setup, then run the command again.',
        );
    }
    if (
      operation &&
      !stepStarted(operation, 'git_flip') &&
      this.owners.get(projectId) === operation.details.owner
    )
      refuse(
        'GIT_OWNER_CHANGED',
        'The Git owner changed before this switch began. Cancel it and run the command again.',
      );
  }

  assertCancellable(operation: RemoteOperation): void {
    if (stepStarted(operation, 'git_flip')) {
      const details = operation.details as unknown as GitOwnerDetails;
      throw new RemoteOperationStepRefusedError(
        'GIT_SWITCH_UNFINISHED',
        `Git control is already moving. Repeat \`${gitOwnerCommand(details.owner, details.force)}\` to finish.`,
        { operationId: operation.id },
      );
    }
  }

  /**
   * Before `git_flip`, a retry installs the sender's guard again. A cancel that failed, or a
   * restart during a rollback, can leave that guard removed while its step still shows done.
   */
  retryFrom(operation: RemoteOperation): string | null {
    if (stepStarted(operation, 'git_flip')) return null;
    return operation.details.owner === 'home' ? 'vm_guard' : 'pc_guard';
  }

  /** A restart during a running cancel can leave the guard removed too, so resume like a retry. */
  resumeFrom(operation: RemoteOperation): string | null {
    return this.retryFrom(operation);
  }

  async interrupt(operationId: string): Promise<void> {
    this.handoff.interrupt(operationId, 'The Git switch was cancelled.');
  }

  async rollback(operation: RemoteOperation): Promise<void> {
    this.assertCancellable(operation);
    const projectId = requireProjectId(operation);
    const details = operation.details as unknown as GitOwnerDetails;
    if (details.vmGuardInstalled) await this.host.removeGitGuard(operation.remoteId, projectId);
    if (details.pcGuardInstalled)
      await this.guard.remove(projectId, { refreshIndex: false, failOnReadError: true });
    if (stepStarted(operation, 'freeze_host')) await this.host.thaw(operation.remoteId, projectId);
  }

  private details(run: RemoteOperationStepRun): GitOwnerDetails {
    return run.details as unknown as GitOwnerDetails;
  }

  private async vmGuard(run: RemoteOperationStepRun): Promise<void> {
    await run.progress({ vmGuardInstalled: true }, { durable: true });
    const { warning } = await this.host.installGitGuard(
      run.operation.remoteId,
      requireProjectId(run.operation),
      { homeName: hostname(), reason: 'pc-git' },
    );
    await run.progress(
      { vmGuardInstalled: warning === null, vmGuardWarning: warning },
      { durable: true },
    );
    if (warning) throw new RemoteOperationStepRefusedError('GIT_SWITCH_GUARD_WARNING', warning);
  }

  private async pcGuard(run: RemoteOperationStepRun): Promise<void> {
    await run.progress({ pcGuardInstalled: true }, { durable: true });
    const warning = await this.guard.install(
      requireProjectId(run.operation),
      run.operation.remoteId,
    );
    await run.progress(
      { pcGuardInstalled: warning === null, guardWarning: warning },
      { durable: true },
    );
    if (warning) throw new RemoteOperationStepRefusedError('GIT_SWITCH_GUARD_WARNING', warning);
  }

  private async pcGuardRemove(run: RemoteOperationStepRun): Promise<void> {
    const result = await this.guard.remove(requireProjectId(run.operation), {
      refreshIndex: true,
      failOnReadError: true,
    });
    await run.progress({ pcGuardRemove: result }, { durable: true });
    if (result.warning || result.indexRefreshed !== true)
      throw new RemoteOperationStepRefusedError(
        'GIT_SWITCH_INDEX_REFRESH_FAILED',
        result.warning ?? 'The PC Git index was not rebuilt. Retry the switch.',
      );
  }

  private async vmGuardRemove(run: RemoteOperationStepRun): Promise<void> {
    const result = await this.host.removeGitGuard(
      run.operation.remoteId,
      requireProjectId(run.operation),
      { refreshIndex: true },
    );
    await run.progress({ vmGuardRemove: result }, { durable: true });
    if (result.warning || result.indexRefreshed !== true)
      throw new RemoteOperationStepRefusedError(
        'GIT_SWITCH_INDEX_REFRESH_FAILED',
        result.warning ?? 'The VM Git index was not rebuilt. Retry the switch.',
      );
  }
}
