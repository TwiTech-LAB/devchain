import { Inject, Injectable } from '@nestjs/common';
import { STORAGE_SERVICE, type StorageService } from '../../storage/interfaces/storage.interface';
import { E2eeDeviceStoreService } from '../../e2ee/services/e2ee-device-store.service';
import {
  PairedDeviceWorkspaceAccessService,
  canAccessWorkspace,
} from '../../e2ee/services/paired-device-workspace-access.service';

/**
 * Event-time notification recipient resolution.
 *
 * For a project event, enumerates the routing kids of paired devices that (a) have a
 * notification routing kid bound (sealed-lane bind) and (b) can access the project's
 * CURRENT workspace under the ONE shared {@link canAccessWorkspace} predicate — the same
 * authority the RPC lane uses (implicit Default-only or explicit grants). The snapshot is
 * taken per event: grant changes, unpairing, and project moves change future recipient
 * sets only; previously enqueued history is never re-evaluated.
 *
 * Returns deduplicated routing kids — never paired-device records — so no raw
 * paired-device data leaves the device.
 */
@Injectable()
export class NotificationRecipientResolverService {
  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    private readonly deviceStore: E2eeDeviceStoreService,
    private readonly deviceAccess: PairedDeviceWorkspaceAccessService,
  ) {}

  /**
   * Resolve the authorized recipient routing kids for a project. Empty array means
   * "no authorized recipient" (including an unknown/deleted project) — the caller must
   * not enqueue the event then.
   */
  async resolveProjectRecipientRoutingKids(projectId: string): Promise<string[]> {
    let workspaceId: string;
    try {
      workspaceId = (await this.storage.getProject(projectId)).workspaceId;
    } catch {
      return [];
    }

    const routingKids = new Set<string>();
    for (const device of this.deviceStore.list()) {
      if (!device.notificationRoutingKid) continue;
      if (canAccessWorkspace(this.deviceAccess.getAccess(device.kid), workspaceId)) {
        routingKids.add(device.notificationRoutingKid);
      }
    }
    return [...routingKids];
  }
}
