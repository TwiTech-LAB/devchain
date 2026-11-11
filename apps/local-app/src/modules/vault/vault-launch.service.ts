import { Inject, Injectable } from '@nestjs/common';
import { STORAGE_SERVICE, type VaultEntryStorage } from '../storage/interfaces/storage.interface';
import { VaultAccessService } from './vault-access.service';

type LaunchStorage = Pick<VaultEntryStorage, 'resolveVaultGrantsForAgent'>;

/**
 * What a launch knows about an agent's Vault: metadata only, for the prompt block.
 * A restore reads nothing here. Values reach an agent only through the resolve
 * route, so a launch never reads one and never waits for the Vault to unlock.
 */
@Injectable()
export class VaultLaunchService {
  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: LaunchStorage,
    private readonly access: VaultAccessService,
  ) {}

  /** Whether the agent may use the Vault at all: the project's access covers its family. */
  hasAccess(projectId: string, familySlug: string | null): Promise<boolean> {
    return this.access.hasVaultAccess(projectId, familySlug);
  }

  /** Entries granted to the agent from backend facts only: its project and profile family. */
  async grantedEntryCount(projectId: string, familySlug: string | null): Promise<number> {
    return (await this.storage.resolveVaultGrantsForAgent(projectId, familySlug)).length;
  }
}
