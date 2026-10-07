import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ConflictError } from '../../../common/errors/error-types';
import { FileSyncService, type ProjectFolder } from '../../file-sync/file-sync.service';
import { projectRepository } from '../../file-sync/project-repository';
import { SyncPathInspector } from '../../file-sync/sync-path-inspector';
import { STORAGE_SERVICE, type ProjectStorage } from '../../storage/interfaces/storage.interface';
import type { RemoteOperation } from '../../storage/models/domain.models';
import { REMOTE_HEALTH_PORT, type RemoteHealthPort } from '../ports/remote-health.port';
import { RemoteBindingsService } from '../services/remote-bindings.service';
import { RemoteFileSyncService } from '../sync/remote-file-sync.service';
import { RemoteLiveSyncService } from '../sync/remote-live-sync.service';
import { HOST_API_KEY_REJECTED, HOST_API_KEY_REJECTED_MESSAGE } from '../host-api-key';
import { FileSyncHandoff, type ForceSyncDetails } from './file-sync-handoff';
import { RemoteHostClient } from './remote-host.client';
import { ForceSyncSourceSchema, type ForceSyncSource } from './remote-operation.dto';
import { RemoteOperationStepRefusedError } from './remote-operation.errors';
import {
  requireProjectId,
  stepStarted,
  type RemoteOperationDefinition,
  type RemoteOperationStepDefinition,
  type RemoteOperationStepRun,
} from './remote-operation.types';

export interface ForceSyncOperationDetails {
  source: ForceSyncSource;
  kinds?: ProjectFolder['kind'][];
  forceSync: Partial<ForceSyncDetails> & {
    source: ForceSyncSource;
    kinds?: ProjectFolder['kind'][];
    gitInit?: 'created';
  };
}

const KindsSchema = z
  .array(z.enum(['code', 'git']))
  .min(1)
  .max(2);

@Injectable()
export class ForceSyncOperation implements RemoteOperationDefinition {
  readonly kind = 'force_sync' as const;
  readonly steps: readonly RemoteOperationStepDefinition[];

  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: ProjectStorage,
    @Inject(REMOTE_HEALTH_PORT) private readonly health: RemoteHealthPort,
    private readonly bindings: RemoteBindingsService,
    private readonly host: RemoteHostClient,
    private readonly files: FileSyncService,
    private readonly inspector: SyncPathInspector,
    private readonly handoff: FileSyncHandoff,
    private readonly live: RemoteLiveSyncService,
    private readonly upkeep: RemoteFileSyncService,
  ) {
    this.steps = [
      { id: 'preflight', label: 'Check the VM and the project', run: (run) => this.preflight(run) },
      {
        id: 'freeze_host',
        label: 'Lock the project on the VM',
        run: async ({ operation }) => {
          await this.host.freeze(operation.remoteId, requireProjectId(operation));
        },
      },
      {
        id: 'stop_host_sessions',
        label: 'Stop agent sessions on the VM',
        run: async ({ operation }) => {
          await this.host.stopSessions(operation.remoteId, requireProjectId(operation));
        },
      },
      {
        id: 'force_copy',
        label: 'Copy files',
        run: (run) =>
          this.handoff.forceCopy(
            run,
            requireProjectId(run.operation),
            ForceSyncSourceSchema.parse(run.details.source),
            KindsSchema.parse(run.details.kinds),
          ),
      },
      {
        id: 'restore',
        label: 'Turn normal file sync back on',
        run: async (run) => {
          const projectId = requireProjectId(run.operation);
          await this.handoff.restoreConnected(run, projectId, KindsSchema.parse(run.details.kinds));
          this.upkeep.forget(projectId);
        },
      },
      {
        id: 'thaw_host',
        label: 'Unlock the project on the VM',
        run: ({ operation }) => this.host.thaw(operation.remoteId, requireProjectId(operation)),
      },
    ];
  }

  stepsFor(details: Record<string, unknown>): readonly RemoteOperationStepDefinition[] {
    const source = ForceSyncSourceSchema.parse(details.source);
    return this.steps.map((step) =>
      step.id === 'force_copy'
        ? { ...step, label: `Copy files from ${source === 'home' ? 'this PC' : 'the VM'}` }
        : step,
    );
  }

  assertCancellable(operation: RemoteOperation): void {
    if (stepStarted(operation, 'force_copy'))
      throw new ConflictError('Force sync is copying; retry it, or force a disconnect.', {
        code: 'REMOTE_OPERATION_NOT_CANCELLABLE',
        operationId: operation.id,
      });
  }

  async rollback(operation: RemoteOperation): Promise<void> {
    if (stepStarted(operation, 'freeze_host'))
      await this.host.thaw(operation.remoteId, requireProjectId(operation));
  }

  private async preflight(run: RemoteOperationStepRun): Promise<void> {
    const projectId = requireProjectId(run.operation);
    const { remoteId } = run.operation;
    await this.live.runExclusive(projectId, async () => {
      const binding = await this.bindings.get(projectId);
      if (binding?.state !== 'remote' || binding.remoteId !== remoteId)
        throw new RemoteOperationStepRefusedError(
          'REMOTE_BINDING_MISSING',
          'The project is not connected to this remote.',
          { projectId, remoteId },
        );
      const health = await this.health.refresh(remoteId);
      if (!health.online)
        throw new RemoteOperationStepRefusedError('REMOTE_OFFLINE', 'The VM is offline.', {
          remoteId,
        });
      if (health.apiKeyRejected)
        throw new RemoteOperationStepRefusedError(
          HOST_API_KEY_REJECTED,
          HOST_API_KEY_REJECTED_MESSAGE,
          { remoteId },
        );
      if (!health.versionMatches)
        throw new RemoteOperationStepRefusedError(
          'REMOTE_VERSION_MISMATCH',
          'The VM runs a different DevChain version.',
          { remoteId },
        );
      await this.handoff.ensureAvailable();
      const device = await this.host.syncDevice(remoteId);
      if (!(await this.files.isConnected(device.deviceId)))
        throw new RemoteOperationStepRefusedError(
          'FILE_SYNC_NOT_CONNECTED',
          'There is no file sync connection to the VM.',
          { remoteId },
        );
      const source = ForceSyncSourceSchema.parse(run.details.source);
      const project = await this.storage.getProject(projectId);
      const homeRoot = await this.files.folderPath(projectId);
      const [home, vm] = await Promise.all([
        this.inspector.inspect(homeRoot, false),
        this.host.syncInspect(remoteId, { path: project.rootPath, scan: false, paths: [] }),
      ]);
      const sourceFacts = source === 'home' ? home : vm;
      if (!sourceFacts.exists)
        throw new RemoteOperationStepRefusedError(
          'FORCE_SYNC_SOURCE_MISSING',
          `The project folder is missing on ${source === 'home' ? 'this PC' : 'the VM'}.`,
          { projectId, source },
        );
      if (source === 'vm' && !vm.repository)
        throw new RemoteOperationStepRefusedError(
          'FORCE_SYNC_REPOSITORY_MISSING',
          "The VM has no Git repository. Use this PC's files.",
          { projectId },
        );
      if (source === 'home' && !home.repository && vm.repository)
        throw new RemoteOperationStepRefusedError(
          'FORCE_SYNC_REPOSITORY_MISSING',
          "The VM has a Git repository and this PC has none. Use the VM's files, or restore the repository on this PC.",
          { projectId },
        );
      const forceSync = {
        ...(run.details.forceSync as ForceSyncOperationDetails['forceSync']),
        source,
      };
      let hasRepository = sourceFacts.repository;
      if (source === 'home' && !home.repository && !vm.repository) {
        if (await this.handoff.ensureRepository(projectId)) {
          forceSync.gitInit = 'created';
          await run.progress({ gitInit: 'created', forceSync }, { durable: true });
        }
        hasRepository = (await projectRepository(homeRoot)) === 'repository';
      }
      const kinds: ProjectFolder['kind'][] = hasRepository ? ['code', 'git'] : ['code'];
      await run.progress({ kinds, forceSync: { ...forceSync, kinds } }, { durable: true });
    });
  }
}
