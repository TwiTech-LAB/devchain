import { Injectable } from '@nestjs/common';
import { TranscriptFilesService } from '../transcripts/transcript-files.service';
import type { TranscriptTransferDetails } from '../transcripts/transcript-transfer.dto';
import { RemoteHostClient } from './remote-host.client';
import type { RemoteOperationStepRun } from './remote-operation.types';

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
    this.active.set(run.operation.id, controller);
    try {
      const { refs, skipped } = this.files.projectRefs(projectId);
      const home = await this.files.list(refs);
      const host = await this.host.listTranscripts(run.operation.remoteId, refs);
      const [source, destination] = direction === 'push' ? [home, host] : [host, home];
      const sizes = new Map(
        destination.files.map(({ file, size }) => [`${file.provider}:${file.path}`, size]),
      );
      const pending = source.files.filter(
        ({ file, size }) => sizes.get(`${file.provider}:${file.path}`) !== size,
      );
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
        controller.signal.throwIfAborted();
        if (direction === 'push')
          await this.host.uploadTranscript(
            run.operation.remoteId,
            file,
            this.files,
            controller.signal,
          );
        else
          await this.host.downloadTranscript(
            run.operation.remoteId,
            file,
            this.files,
            controller.signal,
          );
        progress.filesDone++;
        progress.bytesDone += size;
        await run.progress({ transcripts: { ...progress } });
      }
    } finally {
      this.active.delete(run.operation.id);
    }
  }
}
