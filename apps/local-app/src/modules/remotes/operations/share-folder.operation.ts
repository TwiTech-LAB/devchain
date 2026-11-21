import { Inject, Injectable, Optional } from '@nestjs/common';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { ConflictError } from '../../../common/errors/error-types';
import {
  SHARED_FOLDER_MISSING,
  ShareIdSchema,
  ShareIgnoresSchema,
} from '../../file-sync/file-sync.dto';
import { FileSyncService } from '../../file-sync/file-sync.service';
import { shareId } from '../../file-sync/share-paths';
import type { RemoteOperation } from '../../storage/models/domain.models';
import { REMOTE_HEALTH_PORT, type RemoteHealthPort } from '../ports/remote-health.port';
import {
  SHARED_FOLDER_ENTRIES,
  type SharedFolderEntriesPort,
} from '../ports/shared-folder-entries.port';
import {
  FileSyncHandoff,
  type ShareFolderCopyDetails,
  type ShareFolderInput,
} from './file-sync-handoff';
import { assertHostReady } from './host-readiness';
import { RemoteOperationStepRefusedError } from './remote-operation.errors';
import {
  stepStarted,
  type RemoteOperationDefinition,
  type RemoteOperationStepDefinition,
  type RemoteOperationStepRun,
} from './remote-operation.types';

export const ShareFolderOperationInputSchema = z.object({
  shareId: ShareIdSchema,
  path: z.string().min(1),
  ignores: ShareIgnoresSchema,
});
export type ShareFolderOperationInput = z.infer<typeof ShareFolderOperationInputSchema>;

export interface ShareFolderOperationDetails extends ShareFolderOperationInput {
  shareFolder?: ShareFolderCopyDetails;
}

export type ShareFolderRequestInput = Omit<ShareFolderOperationInput, 'shareId'>;

/** The details a new share operation starts with. */
export function shareFolderOperationDetails(
  input: ShareFolderRequestInput,
): ShareFolderOperationInput {
  const path = resolve(input.path);
  return { shareId: shareId(path), path, ignores: input.ignores };
}

/**
 * Shares a user folder with the VM at the same path. This PC's files win the first copy; then
 * both sides sync two ways. Not a host-lifecycle kind, so Connect and Disconnect still run.
 */
@Injectable()
export class ShareFolderOperation implements RemoteOperationDefinition {
  readonly kind = 'share_folder' as const;
  readonly steps: readonly RemoteOperationStepDefinition[];

  constructor(
    @Inject(REMOTE_HEALTH_PORT) private readonly health: RemoteHealthPort,
    private readonly files: FileSyncService,
    private readonly handoff: FileSyncHandoff,
    @Optional()
    @Inject(SHARED_FOLDER_ENTRIES)
    private readonly entries?: SharedFolderEntriesPort,
  ) {
    this.steps = [
      { id: 'preflight', label: 'Check the folder and the VM', run: (run) => this.preflight(run) },
      {
        id: 'pair',
        label: 'Connect file sync to the VM',
        run: async ({ operation }) => {
          await this.handoff.pair(operation.remoteId);
        },
      },
      {
        id: 'copy',
        label: "Copy this PC's files to the VM",
        run: (run) => this.handoff.copyShare(run, shareInput(run.details)),
      },
      {
        id: 'sync',
        label: 'Turn on two-way sync',
        run: (run) => this.handoff.syncShareBothWays(run, shareInput(run.details)),
      },
    ];
  }

  /**
   * A running share stops accepting Cancel at the end of the copy: the VM folder already holds
   * this PC's files. A failed share always accepts it, so a cause that does not go away (a VM
   * deleted outside DevChain, a removed folder) cannot lock the VM and the share for good.
   */
  assertCancellable(operation: RemoteOperation): void {
    if (operation.state === 'failed') return;
    const copied = operation.steps.some((step) => step.id === 'copy' && step.state === 'done');
    if (copied || stepStarted(operation, 'sync'))
      throw new ConflictError('The folder is already copied to the VM; retry the share instead.', {
        code: 'REMOTE_OPERATION_NOT_CANCELLABLE',
        operationId: operation.id,
      });
  }

  async interrupt(operationId: string): Promise<void> {
    this.handoff.interrupt(operationId, 'Sharing the folder was cancelled.');
  }

  /** Stops sharing on both sides and forgets the entry; files stay. */
  async rollback(operation: RemoteOperation): Promise<Record<string, unknown>> {
    const share = shareInput(operation.details);
    const hostFolderRemovalError = stepStarted(operation, 'copy')
      ? await this.handoff.removeShare(operation.remoteId, share.shareId)
      : null;
    await this.entries?.remove(operation.remoteId, share.path);
    return hostFolderRemovalError ? { hostFolderRemovalError } : {};
  }

  private async preflight(run: RemoteOperationStepRun): Promise<void> {
    const { remoteId } = run.operation;
    const share = shareInput(run.details);
    if (shareId(share.path) !== share.shareId)
      throw new RemoteOperationStepRefusedError(
        'SHARE_FOLDER_ID_MISMATCH',
        `The share id does not belong to ${share.path}.`,
        { path: share.path },
      );
    assertHostReady(remoteId, await this.health.refresh(remoteId));
    await this.handoff.ensureAvailable();
    const others = (this.entries?.sharedPaths() ?? []).filter(
      (path) => resolve(path) !== share.path,
    );
    await this.files.assertSharePath(share.path, others);
    const info = await stat(share.path).catch(() => null);
    if (!info?.isDirectory())
      throw new RemoteOperationStepRefusedError(
        SHARED_FOLDER_MISSING,
        `${share.path} is not a folder on this PC.`,
        { path: share.path },
      );
  }
}

function shareInput(details: Record<string, unknown>): ShareFolderInput {
  return ShareFolderOperationInputSchema.parse(details);
}
