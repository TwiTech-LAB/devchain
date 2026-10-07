import { Inject, Injectable } from '@nestjs/common';
import { AppError, ValidationError } from '../../../common/errors/error-types';
import { createLogger } from '../../../common/logging/logger';
import { compileIgnorePattern } from '../../file-sync/ignore-pattern-matcher';
import { SyncPathInspector } from '../../file-sync/sync-path-inspector';
import type { SyncPathInspection } from '../../file-sync/sync-path-inspection.dto';
import { STORAGE_SERVICE, type ProjectStorage } from '../../storage/interfaces/storage.interface';
import { RemoteHostClient } from '../operations/remote-host.client';
import { RemoteBindingsService } from '../services/remote-bindings.service';
import type { PatternPreviewSide, ProjectPatternPreview } from './remote-file-sync.dto';

const logger = createLogger('FileSyncPatternPreviewService');
const PREVIEW_SAMPLE_MAX = 5;

@Injectable()
export class FileSyncPatternPreviewService {
  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: ProjectStorage,
    private readonly bindings: RemoteBindingsService,
    private readonly host: RemoteHostClient,
    private readonly inspector: SyncPathInspector,
  ) {}

  async preview(projectId: string, pattern: string): Promise<ProjectPatternPreview> {
    const compiled = compileIgnorePattern(pattern);
    if (compiled.kind === 'error') throw new ValidationError(compiled.error);
    const binding = await this.bindings.get(projectId);
    if (binding?.state !== 'remote') {
      throw new AppError(
        'The project must be connected to preview a file sync pattern.',
        'FILE_SYNC_NOT_CONNECTED',
        409,
      );
    }
    const { rootPath } = await this.storage.getProject(projectId);
    const [home, vm] = await Promise.allSettled([
      this.inspector.inspect(rootPath, false, [], [pattern]),
      this.host.syncInspect(binding.remoteId, {
        path: rootPath,
        scan: false,
        paths: [],
        patterns: [pattern],
      }),
    ]);
    for (const [side, read] of [
      ['home', home],
      ['vm', vm],
    ] as const) {
      if (read.status === 'rejected') {
        logger.warn(
          { error: read.reason, projectId, side },
          'File sync pattern preview unavailable',
        );
      }
    }
    return {
      home:
        home.status === 'fulfilled'
          ? this.summarize(home.value, pattern)
          : { state: 'error', tracked: null, kept: null },
      vm:
        vm.status === 'fulfilled'
          ? this.summarize(vm.value, pattern)
          : { state: 'unavailable', tracked: null, kept: null },
    };
  }

  private summarize(inspection: SyncPathInspection, pattern: string): PatternPreviewSide {
    const checks = inspection.patternChecks;
    if (!checks) return { state: 'error', tracked: null, kept: null };
    if (checks.state !== 'checked') return { state: checks.state, tracked: null, kept: null };
    const match = checks.results.find((result) => result.pattern === pattern);
    if (!match) return { state: 'error', tracked: null, kept: null };
    return {
      state: 'checked',
      tracked: {
        count: match.tracked.count,
        sample: match.tracked.files.slice(0, PREVIEW_SAMPLE_MAX),
      },
      kept: { count: match.kept.count, sample: match.kept.sample.slice(0, PREVIEW_SAMPLE_MAX) },
    };
  }
}
