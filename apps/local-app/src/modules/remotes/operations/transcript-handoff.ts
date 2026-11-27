import { Injectable } from '@nestjs/common';
import { ValidationError } from '../../../common/errors/error-types';
import { TranscriptFilesService, fileKey } from '../transcripts/transcript-files.service';
import { TRANSCRIPT_LIST_REF_LIMIT } from '../transcripts/transcript-transfer.dto';
import type {
  TranscriptListRequest,
  TranscriptListing,
  TranscriptTransferDetails,
} from '../transcripts/transcript-transfer.dto';
import { RemoteHostClient } from './remote-host.client';
import type { RemoteOperationStepRun } from './remote-operation.types';

// The route uses Fastify's default 1 MiB JSON limit. Keep 16 KiB clear.
const TRANSCRIPT_LIST_BODY_BUDGET = 1024 ** 2 - 16 * 1024;

function* transcriptListBatches({
  refs,
  ...options
}: TranscriptListRequest): Generator<TranscriptListRequest> {
  const emptyBytes = Buffer.byteLength(JSON.stringify({ ...options, refs: [] }));
  let batch: TranscriptListRequest['refs'] = [];
  let batchBytes = emptyBytes;
  for (const ref of refs) {
    const refBytes = Buffer.byteLength(JSON.stringify(ref));
    if (emptyBytes + refBytes > TRANSCRIPT_LIST_BODY_BUDGET)
      throw new ValidationError('Transcript reference exceeds the list request size limit');
    if (
      batch.length === TRANSCRIPT_LIST_REF_LIMIT ||
      (batch.length > 0 && batchBytes + refBytes + 1 > TRANSCRIPT_LIST_BODY_BUDGET)
    ) {
      yield { ...options, refs: batch };
      batch = [];
      batchBytes = emptyBytes;
    }
    batchBytes += refBytes + (batch.length === 0 ? 0 : 1);
    batch.push(ref);
  }
  if (batch.length > 0) yield { ...options, refs: batch };
}

@Injectable()
export class TranscriptHandoff {
  private readonly active = new Map<string, AbortController>();

  constructor(
    private readonly files: TranscriptFilesService,
    private readonly host: RemoteHostClient,
  ) {}

  interrupt(operationId: string): void {
    this.active.get(operationId)?.abort();
  }

  async copy(
    run: RemoteOperationStepRun,
    projectId: string,
    direction: 'push' | 'pull',
  ): Promise<void> {
    const controller = new AbortController();
    const { signal } = controller;
    this.active.set(run.operation.id, controller);
    try {
      const remoteId = run.operation.remoteId;
      let source: TranscriptListing;
      let destination: TranscriptListing['files'];
      let skipped: number;
      if (direction === 'push') {
        const inventory = await this.files.projectRefs(projectId, signal);
        source = inventory.listing;
        skipped = inventory.skipped;
        destination = (await this.listRemote(remoteId, { refs: inventory.refs }, signal)).files;
      } else {
        const recorded = this.files.recordedProjectRefs(projectId);
        source = await this.listRemote(
          remoteId,
          { refs: recorded.refs, dependencyProjectId: projectId },
          signal,
        );
        skipped = recorded.skipped + (source.skipped ?? 0);
        destination = await this.files.listFiles(source.files.map(({ file }) => file));
      }
      const existing = new Map(destination.map((entry) => [fileKey(entry.file), entry]));
      // A listing carries a hash only for providers that rewrite files at the same size.
      const pending = source.files.filter(({ file, size, sha256 }) => {
        const copy = existing.get(fileKey(file));
        return copy?.size !== size || copy.sha256 !== sha256;
      });
      const progress: TranscriptTransferDetails = {
        filesDone: 0,
        filesTotal: pending.length,
        bytesDone: 0,
        bytesTotal: pending.reduce((sum, file) => sum + file.size, 0),
        missing: source.missing,
        skipped,
      };
      await run.progress({ transcripts: { ...progress } });
      for (const { file, size } of pending) {
        signal.throwIfAborted();
        if (direction === 'push')
          await this.host.uploadTranscript(run.operation.remoteId, file, this.files, signal);
        else await this.host.downloadTranscript(run.operation.remoteId, file, this.files, signal);
        progress.filesDone++;
        progress.bytesDone += size;
        await run.progress({ transcripts: { ...progress } });
      }
    } finally {
      this.active.delete(run.operation.id);
    }
  }

  private async listRemote(
    remoteId: string,
    request: TranscriptListRequest,
    signal: AbortSignal,
  ): Promise<TranscriptListing> {
    const files = new Map<string, TranscriptListing['files'][number]>();
    let missing = 0;
    let skipped = 0;
    for (const batch of transcriptListBatches(request)) {
      signal.throwIfAborted();
      const listing = await this.host.listTranscripts(remoteId, batch, signal);
      for (const entry of listing.files) files.set(fileKey(entry.file), entry);
      missing += listing.missing;
      // The host reports a count without identities, so a skipped dependency
      // shared by batches makes this sum an upper bound.
      skipped += listing.skipped ?? 0;
    }
    return {
      files: [...files.values()].sort((a, b) => a.file.path.localeCompare(b.file.path)),
      missing,
      skipped,
    };
  }
}
