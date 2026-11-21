import { ConflictError } from '../../../common/errors/error-types';
import type { RemoteStorage } from '../../storage/interfaces/storage.interface';
import type { RemoteOperation } from '../../storage/models/domain.models';
import { isOpenShareOperation, OPEN_SHARE_STATES } from './remote-operation.types';

export const SHARE_OPERATION_OPEN_MESSAGE = 'Finish or cancel the shared folder operation first.';

/** The VM's running or failed `share_folder` operations, newest first; with `shareId`, of that share. */
export async function listOpenShareOperations(
  storage: Pick<RemoteStorage, 'listRemoteOperations'>,
  remoteId: string,
  shareId?: string,
): Promise<RemoteOperation[]> {
  return (
    await storage.listRemoteOperations({
      remoteId,
      kinds: ['share_folder'],
      states: [...OPEN_SHARE_STATES],
    })
  ).filter(
    (operation) => operation.remoteId === remoteId && isOpenShareOperation(operation, shareId),
  );
}

/** Refuses while a `share_folder` operation of the VM is open; with `shareId`, only one of that share. */
export async function assertNoOpenShareOperation(
  storage: Pick<RemoteStorage, 'listRemoteOperations'>,
  remoteId: string,
  shareId?: string,
): Promise<void> {
  const [open] = await listOpenShareOperations(storage, remoteId, shareId);
  if (open)
    throw new ConflictError(SHARE_OPERATION_OPEN_MESSAGE, {
      code: 'REMOTE_OPERATION_IN_PROGRESS',
      remoteId,
      operationId: open.id,
      kind: open.kind,
      state: open.state,
    });
}
