import { Inject, Injectable } from '@nestjs/common';
import { AppError } from '../../../common/errors/error-types';
import { createLogger } from '../../../common/logging/logger';
import {
  attachPatternChecks,
  buildExclusionSuggestions,
  type BuildExclusionSuggestionsInput,
} from '../../file-sync/build-exclusion-suggestions';
import { FileSyncManagedExclusionsStore } from '../../file-sync/file-sync-managed-exclusions.store';
import { codeIgnores, TRANSIENT_SYNC_ERROR } from '../../file-sync/file-sync.dto';
import { FileSyncService, projectFolderId } from '../../file-sync/file-sync.service';
import { SyncPathInspector } from '../../file-sync/sync-path-inspector';
import type { SyncPathInspection } from '../../file-sync/sync-path-inspection.dto';
import { STORAGE_SERVICE, type ProjectStorage } from '../../storage/interfaces/storage.interface';
import { RemoteHostClient } from '../operations/remote-host.client';
import { RemoteBindingsService } from '../services/remote-bindings.service';
import type { FailedSyncSide, ProjectFileSyncFailures } from './remote-file-sync.dto';

const logger = createLogger('FileSyncFailuresService');

@Injectable()
export class FileSyncFailuresService {
  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: ProjectStorage,
    private readonly bindings: RemoteBindingsService,
    private readonly files: FileSyncService,
    private readonly host: RemoteHostClient,
    private readonly inspector: SyncPathInspector,
    private readonly managed: FileSyncManagedExclusionsStore,
  ) {}

  async failed(projectId: string): Promise<Omit<ProjectFileSyncFailures, 'forceSync'>> {
    const binding = await this.bindings.get(projectId);
    if (binding?.state !== 'remote')
      throw new AppError(
        'The project must be connected to read file sync failures.',
        'FILE_SYNC_NOT_CONNECTED',
        409,
      );
    const { rootPath } = await this.storage.getProject(projectId);
    const codeId = projectFolderId(projectId, 'code');
    const managedExclusions = this.managed.get(projectId);
    const reads = await Promise.allSettled([
      this.files.status(codeId, undefined, { allErrors: true }),
      this.host.syncStatus(binding.remoteId, codeId, undefined, { allErrors: true }),
    ]);
    const sides = ['home', 'vm'] as const;
    const result: Omit<ProjectFileSyncFailures, 'forceSync'> = {
      ownerSide: 'vm',
      installedPrefix: codeIgnores(managedExclusions, []),
      home: { entries: [] },
      vm: { entries: [] },
      groups: [],
      overLimit: false,
    };
    for (const [index, side] of sides.entries()) {
      const read = reads[index];
      if (read.status === 'rejected') {
        result[side].readError =
          side === 'home'
            ? "DevChain could not read this PC's errors."
            : "DevChain could not read the VM's errors.";
        logger.warn({ error: read.reason, projectId, side }, 'File sync errors could not be read');
        continue;
      }
      const unique = new Map<string, { path: string; error: string }>();
      for (const entry of read.value.fileErrors ?? [])
        if (!entry.error.includes(TRANSIENT_SYNC_ERROR) && !unique.has(entry.path))
          unique.set(entry.path, entry);
      result[side].entries = [...unique.values()].map((entry) => ({
        ...entry,
        owner: null,
        git: null,
      }));
    }
    const paths = [
      ...new Set(sides.flatMap((side) => result[side].entries.map((entry) => entry.path))),
    ];
    if (!paths.length) return result;
    const inspections = await Promise.allSettled([
      this.inspector.inspect(rootPath, false, paths),
      this.host.syncInspect(binding.remoteId, { path: rootPath, scan: false, paths }),
    ]);
    for (const [index, side] of sides.entries()) {
      const read = inspections[index];
      if (read.status === 'rejected') {
        result[side].readError ??=
          side === 'home'
            ? "DevChain could not inspect this PC's failed files."
            : "DevChain could not inspect the VM's failed files.";
        logger.warn({ error: read.reason, projectId, side }, 'Failed file facts could not be read');
      } else this.addFacts(result[side], read.value);
    }
    const [home, vm] = inspections;
    if (vm.status === 'fulfilled') result.vmUser = vm.value.vmUser ?? vm.value.projectOwner;
    if (home.status === 'fulfilled') {
      const input: BuildExclusionSuggestionsInput = {
        ownerSide: 'vm',
        home: home.value,
        vm: vm.status === 'fulfilled' ? vm.value : 'unavailable',
        userIgnores: this.files.getIgnores(projectId),
        managedExclusions,
      };
      await attachPatternChecks(input, {
        home: (patterns) => this.inspector.inspect(rootPath, false, [], patterns),
        vm: (patterns) =>
          this.host.syncInspect(binding.remoteId, {
            path: rootPath,
            scan: false,
            paths: [],
            patterns,
          }),
      });
      Object.assign(result, buildExclusionSuggestions(input));
    }
    return result;
  }

  private addFacts(side: FailedSyncSide, inspection: SyncPathInspection): void {
    const facts = new Map(inspection.entries.map((entry) => [entry.path, entry]));
    for (const entry of side.entries) {
      const fact = facts.get(entry.path);
      if (!fact) continue;
      entry.owner = fact.owner;
      const { ignored, ignoreRule, ignoredAncestor, tracked, trackedDescendants } = fact;
      entry.git = {
        state: inspection.gitState,
        ignored,
        ignoreRule,
        ignoredAncestor,
        tracked,
        trackedDescendants,
      };
    }
  }
}
