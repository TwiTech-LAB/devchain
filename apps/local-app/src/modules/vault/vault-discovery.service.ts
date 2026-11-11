import { Inject, Injectable } from '@nestjs/common';
import { STORAGE_SERVICE, type AgentStorage } from '../storage/interfaces/storage.interface';
import type { VaultEntryKind } from '../storage/models/domain.models';
import { VaultAccessService } from './vault-access.service';
import { VaultKeyService } from './vault-key.service';
import { VaultVmCacheService } from './vault-vm-cache.service';

/** `available`: the resolve route can serve the value now; `vault_locked`: it cannot yet. */
export type VaultDiscoveryStatus = 'available' | 'vault_locked';

/** Names and descriptions only: never a value. */
export interface VaultDiscoveryEntry {
  name: string;
  kind: VaultEntryKind;
  description: string;
  status: VaultDiscoveryStatus;
  /** The user must approve a session's use; a session-only value never needs it. */
  approvalRequired: boolean;
}

type DiscoveryStorage = Pick<AgentStorage, 'getAgent'>;

/** Lists what an agent may fetch through the resolve route; it reads no value. */
@Injectable()
export class VaultDiscoveryService {
  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: DiscoveryStorage,
    private readonly vault: VaultKeyService,
    private readonly vmCache: VaultVmCacheService,
    private readonly access: VaultAccessService,
  ) {}

  /** Throws `VaultAccessRefusedError` when the agent's project or family has no Vault access. */
  async listForSession(sessionId: string, agentId: string): Promise<VaultDiscoveryEntry[]> {
    const agent = await this.storage.getAgent(agentId);
    const { stored, sessionValues } = await this.access.grantedForSession(agent, sessionId);
    const locked =
      stored.length > 0 &&
      (this.vmCache.isClaimedHost()
        ? !(await this.vmCache.holds(stored))
        : this.vault.getState() !== 'unlocked');
    // A session-only value needs no data key, so it is always available while it exists.
    return [
      ...stored.map(({ name, kind, description, approvalRequired }) => ({
        name,
        kind,
        description,
        status: locked ? ('vault_locked' as const) : ('available' as const),
        approvalRequired,
      })),
      ...sessionValues.map(({ name, kind, description }) => ({
        name,
        kind,
        description,
        status: 'available' as const,
        approvalRequired: false,
      })),
    ];
  }
}
