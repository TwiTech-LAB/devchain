import { NotFoundError } from '../../../common/errors/error-types';
import type { RemoteStorage } from '../../storage/interfaces/storage.interface';
import type { RemoteOperation } from '../../storage/models/domain.models';
import type { VmProvidersService } from '../../vm-providers/vm-providers.service';

/** A missing VM is success only after a guarded delete was attempted on an earlier run. */
export async function destroyGuardedVm(input: {
  storage: RemoteStorage;
  providers: VmProvidersService;
  operation: RemoteOperation;
  details: Record<string, unknown>;
  connectionId: string;
  vmIdentity: string;
  vmidKey: string;
  attemptKey: string;
}): Promise<void> {
  const { storage, providers, operation, details, connectionId, vmIdentity, vmidKey, attemptKey } =
    input;
  const provider = await providers.forConnection(connectionId);
  if (typeof details[vmidKey] !== 'number') {
    details[vmidKey] = await provider.assertOwnedVmIdentity(vmIdentity);
    await storage.updateRemoteOperation(operation.id, { details: { ...details } });
  }
  const previouslyAttempted = details[attemptKey] === true;
  if (!previouslyAttempted) {
    details[attemptKey] = true;
    await storage.updateRemoteOperation(operation.id, { details: { ...details } });
  }
  try {
    await provider.destroyVm(vmIdentity);
  } catch (error) {
    if (!previouslyAttempted || !(error instanceof NotFoundError)) throw error;
  }
}

export async function destroyGuardedVmid(input: {
  storage: RemoteStorage;
  providers: VmProvidersService;
  operation: RemoteOperation;
  details: Record<string, unknown>;
  connectionId: string;
  vmid: number;
  attemptKey: string;
}): Promise<void> {
  const { storage, providers, operation, details, connectionId, vmid, attemptKey } = input;
  const previouslyAttempted = details[attemptKey] === true;
  if (!previouslyAttempted) {
    details[attemptKey] = true;
    await storage.updateRemoteOperation(operation.id, { details: { ...details } });
  }
  try {
    await (await providers.forConnection(connectionId)).destroyOwnedVmid(vmid);
  } catch (error) {
    if (!previouslyAttempted || !(error instanceof NotFoundError)) throw error;
  }
}
