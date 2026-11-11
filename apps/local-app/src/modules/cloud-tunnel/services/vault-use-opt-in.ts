import { Injectable } from '@nestjs/common';

/**
 * The paired devices that asked `vault.listRequests` for `use` requests. Only they get a
 * native push for a pending `use` request: an older build shows its list without the
 * request, so a push would open an empty sheet. Kept in memory; a device opts in again
 * with its next list call after a restart.
 */
@Injectable()
export class VaultUseOptInRegistry {
  private readonly deviceKids = new Set<string>();

  record(deviceKid: string): void {
    this.deviceKids.add(deviceKid);
  }

  snapshot(): ReadonlySet<string> {
    return new Set(this.deviceKids);
  }
}
