import { Inject, Injectable } from '@nestjs/common';
import { createLogger } from '../../../common/logging/logger';
import {
  attachPatternChecks,
  buildExclusionSuggestions,
  type BuildExclusionSuggestionsInput,
} from '../../file-sync/build-exclusion-suggestions';
import { FileSyncManagedExclusionsStore } from '../../file-sync/file-sync-managed-exclusions.store';
import { FileSyncService } from '../../file-sync/file-sync.service';
import { SyncPathInspector } from '../../file-sync/sync-path-inspector';
import type {
  ProjectExclusionSuggestions,
  SyncPathInspection,
} from '../../file-sync/sync-path-inspection.dto';
import { STORAGE_SERVICE, type ProjectStorage } from '../../storage/interfaces/storage.interface';
import { RemoteHostClient } from '../operations/remote-host.client';

const logger = createLogger('FileSyncSuggestionsService');

@Injectable()
export class FileSyncSuggestionsService {
  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: ProjectStorage,
    private readonly inspector: SyncPathInspector,
    private readonly host: RemoteHostClient,
    private readonly files: FileSyncService,
    private readonly managed: FileSyncManagedExclusionsStore,
  ) {}

  async suggestions(projectId: string, remoteId: string): Promise<ProjectExclusionSuggestions> {
    const { rootPath } = await this.storage.getProject(projectId);
    const scanned = await this.inspector.inspect(rootPath, true);
    let vm: SyncPathInspection | 'unavailable';
    try {
      vm = await this.host.syncInspect(remoteId, {
        path: rootPath,
        scan: true,
        paths: scanned.candidates,
      });
    } catch (error) {
      logger.warn({ error, projectId, remoteId }, 'VM file-sync inspection was unavailable');
      vm = 'unavailable';
    }
    let home = scanned;
    if (vm !== 'unavailable' && vm.candidates.length) {
      const additional = await this.inspector.inspect(rootPath, false, vm.candidates);
      home = {
        ...additional,
        candidates: scanned.candidates,
        entries: [
          ...new Map(
            [...scanned.entries, ...additional.entries].map((entry) => [entry.path, entry]),
          ).values(),
        ],
      };
    }
    const input: BuildExclusionSuggestionsInput = {
      ownerSide: 'home',
      home,
      vm,
      userIgnores: this.files.getIgnores(projectId),
      managedExclusions: this.managed.get(projectId),
    };
    await attachPatternChecks(input, {
      home: (patterns) => this.inspector.inspect(rootPath, false, [], patterns),
      vm: (patterns) =>
        vm === 'unavailable'
          ? Promise.resolve(null)
          : this.host.syncInspect(remoteId, { path: rootPath, scan: false, paths: [], patterns }),
    });
    const result = buildExclusionSuggestions(input);
    return { ownerSide: 'home', home, vm, ...result };
  }
}
