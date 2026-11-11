import { Inject, Injectable } from '@nestjs/common';
import type { HostVaultPush } from '@devchain/shared';
import { STORAGE_SERVICE, type VaultEntryStorage } from '../storage/interfaces/storage.interface';
import type { VaultSnapshot } from '../storage/models/domain.models';
import { VAULT_ENTRY_DOMAIN, VAULT_ENTRY_VALUE_FIELD } from './vault-entries.service';
import { VaultKeyService } from './vault-key.service';
import { vaultSnapshotRevision } from './vault-snapshot-revision';

export interface VaultPushPlan {
  readonly snapshot: VaultSnapshot;
  readonly revision: string;
}

type PushStorage = Pick<VaultEntryStorage, 'readVaultPushSnapshot' | 'readVaultEntryCiphertexts'>;

/**
 * Builds home's push to one VM. The plan needs no data key, so a caller can compare
 * revisions before `payload` decrypts anything. The payload holds plaintext: never log it.
 */
@Injectable()
export class VaultPushBuilder {
  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: PushStorage,
    private readonly vault: VaultKeyService,
  ) {}

  /** Only `unlocked` can push: a VM keeps its cache while home cannot read values. */
  canPush(): boolean {
    return this.vault.getState() === 'unlocked';
  }

  async plan(projectIds: readonly string[]): Promise<VaultPushPlan> {
    const snapshot = await this.storage.readVaultPushSnapshot(projectIds);
    return { snapshot, revision: vaultSnapshotRevision(snapshot) };
  }

  /** Throws `VaultUnavailableError` when the Vault locks before every value is read. */
  async payload({ snapshot, revision }: VaultPushPlan): Promise<HostVaultPush> {
    const sealed = new Map(
      (await this.storage.readVaultEntryCiphertexts(snapshot.entries.map((entry) => entry.id))).map(
        (row) => [row.id, row.valueCiphertext],
      ),
    );
    const values = snapshot.entries.map((entry) => {
      const ciphertext = sealed.get(entry.id);
      // A delete between the two reads: the next poll sends a plan without the entry.
      if (ciphertext === undefined) throw new Error('A Vault entry changed while home read it.');
      const value = this.vault.decrypt(
        VAULT_ENTRY_DOMAIN,
        entry.id,
        VAULT_ENTRY_VALUE_FIELD,
        ciphertext,
      );
      return { entryId: entry.id, revision: entry.revision, valueBase64: value.toString('base64') };
    });
    return { revision, ...snapshot, values };
  }
}
