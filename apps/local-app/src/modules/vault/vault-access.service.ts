import { Inject, Injectable } from '@nestjs/common';
import { ConflictError, VaultAccessRefusedError } from '../../common/errors/error-types';
import {
  STORAGE_SERVICE,
  type AgentProfileStorage,
  type RemoteStorage,
  type VaultEntryStorage,
} from '../storage/interfaces/storage.interface';
import type { Agent, VaultFamilyAccess, VaultResolvedEntry } from '../storage/models/domain.models';
import { VaultKeyService } from './vault-key.service';
import {
  VAULT_SESSION_OVERLAY,
  type VaultSessionOverlay,
  type VaultSessionValue,
} from './vault-session-overlay';

type AccessStorage = Pick<
  VaultEntryStorage,
  'listVaultFamilyAccess' | 'getVaultAccessDecision' | 'resolveVaultGrantsForAgent'
> &
  Pick<AgentProfileStorage, 'getAgentProfile'> &
  Pick<RemoteStorage, 'listRemoteProjectBindings'>;

/** An agent session's granted Vault view; see {@link VaultAccessService.grantedForSession}. */
export interface VaultGrantedView {
  /** The agent's normalized profile family, as grant resolution uses it. */
  readonly familySlug: string | null;
  /** Granted stored entries without the names the overlay holds: the overlay wins by name. */
  readonly stored: readonly VaultResolvedEntry[];
  /** Session-only values the user gave to this session. */
  readonly sessionValues: readonly VaultSessionValue[];
}

/**
 * The first two Vault layers: a project with no access row has the Vault off, and the
 * rows name the families that may use it. Entry grants apply only inside this access.
 */
@Injectable()
export class VaultAccessService {
  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: AccessStorage,
    private readonly vault: VaultKeyService,
    @Inject(VAULT_SESSION_OVERLAY) private readonly overlay: VaultSessionOverlay,
  ) {}

  listAccess(projectId?: string): Promise<VaultFamilyAccess[]> {
    return this.storage.listVaultFamilyAccess(projectId ? { projectId } : undefined);
  }

  async hasVaultAccess(projectId: string, familySlug: string | null): Promise<boolean> {
    return (await this.storage.getVaultAccessDecision(projectId, familySlug)) === 'granted';
  }

  /**
   * The one place that turns an agent and its session into the granted Vault view:
   * profile family, access assertion, stored grants, and the session overlay, which
   * wins over a stored entry of the same name. Discovery, the resolve route and
   * Vault requests all rely on it, so they cannot disagree.
   * Throws `VaultAccessRefusedError` when the project or family has no access.
   */
  async grantedForSession(agent: Agent, sessionId: string): Promise<VaultGrantedView> {
    const profile = await this.storage.getAgentProfile(agent.profileId);
    // The delegates normalize again; normalizing here keeps the view's own field exact.
    const familySlug = profile.familySlug?.trim().toLowerCase() || null;
    await this.assertVaultAccess(agent.projectId, familySlug);
    const stored = await this.storage.resolveVaultGrantsForAgent(agent.projectId, familySlug);
    const sessionValues = this.overlay.valuesFor(sessionId);
    const overlaid = new Set(sessionValues.map((value) => value.name));
    return {
      familySlug,
      stored: stored.filter((entry) => !overlaid.has(entry.name)),
      sessionValues,
    };
  }

  /** Throws `VaultAccessRefusedError` with `VAULT_NOT_ENABLED` or `VAULT_ACCESS_DENIED`. */
  async assertVaultAccess(projectId: string, familySlug: string | null): Promise<void> {
    const decision = await this.storage.getVaultAccessDecision(projectId, familySlug);
    if (decision === 'not_enabled') throw new VaultAccessRefusedError('VAULT_NOT_ENABLED');
    if (decision === 'denied') throw new VaultAccessRefusedError('VAULT_ACCESS_DENIED');
  }

  /**
   * Guards writes that change who may receive an entry: grants, access rows, entry
   * delete and owner change. Home pushes nothing to VMs while the Vault is not
   * unlocked, so a VM would keep authorizing from its old snapshot. Without a
   * `remote` binding no VM holds a snapshot, and the write goes through.
   */
  async assertAccessWritable(): Promise<void> {
    if (this.vault.getState() === 'unlocked') return;
    const bindings = await this.storage.listRemoteProjectBindings();
    if (!bindings.some((binding) => binding.state === 'remote')) return;
    throw new ConflictError(
      'Unlock the Vault first. While it is locked, home cannot send access changes to remote VMs, so they would keep the old access.',
      { code: 'VAULT_LOCKED_REMOTE_ACCESS' },
    );
  }
}
