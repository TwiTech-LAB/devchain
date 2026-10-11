import { Inject, Injectable } from '@nestjs/common';
import { createLogger } from '../../../common/logging/logger';
import {
  attachPatternChecks,
  buildExclusionSuggestions,
  type BuildExclusionSuggestionsInput,
} from '../../file-sync/build-exclusion-suggestions';
import { FileSyncManagedExclusionsStore } from '../../file-sync/file-sync-managed-exclusions.store';
import { codeIgnores } from '../../file-sync/file-sync.dto';
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
    await this.attachChecks(input, rootPath, remoteId);
    const result = buildExclusionSuggestions(input);
    return { ownerSide: 'home', home, vm, ...result };
  }

  async vmSuggestions(
    projectId: string,
    remoteId: string,
    paths: string[] = [],
  ): Promise<ProjectExclusionSuggestions> {
    const { rootPath } = await this.storage.getProject(projectId);
    const userIgnores = this.files.getIgnores(projectId);
    const managedExclusions = this.managed.get(projectId);
    const scanned = await this.host.syncInspect(remoteId, {
      path: rootPath,
      scan: true,
      paths,
      skipIgnores: codeIgnores(managedExclusions, userIgnores),
    });
    const vm = {
      ...scanned,
      candidates: [...new Set([...scanned.candidates, ...scanned.requestedPaths])],
    };
    const home = await this.inspector.inspect(rootPath, false, vm.candidates);
    if (home.gitState === 'error' || vm.gitState === 'error' || home.hiddenPaths?.length)
      throw new Error('File sync ownership inspection could not check both Git indexes');
    const input: BuildExclusionSuggestionsInput = {
      ownerSide: 'vm',
      home,
      vm,
      userIgnores,
      managedExclusions,
    };
    await this.attachChecks(input, rootPath, remoteId);
    if (
      input.patternChecks &&
      Object.values(input.patternChecks).some(
        (check) =>
          check === 'unavailable' || (check.state !== 'checked' && check.state !== 'no-root'),
      )
    )
      throw new Error('File sync ownership exclusion checks were unavailable');
    return { ownerSide: 'vm', home, vm, ...buildExclusionSuggestions(input) };
  }

  /** Checks the proposed patterns on both sides; an unavailable VM has no answer. */
  private attachChecks(
    input: BuildExclusionSuggestionsInput,
    rootPath: string,
    remoteId: string,
  ): Promise<void> {
    return attachPatternChecks(input, {
      home: (patterns) => this.inspector.inspect(rootPath, false, [], patterns),
      vm: (patterns) =>
        input.vm === 'unavailable'
          ? Promise.resolve(null)
          : this.host.syncInspect(remoteId, { path: rootPath, scan: false, paths: [], patterns }),
    });
  }
}
