import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ProviderAdapterFactory } from '../providers/adapters/provider-adapter.factory';
import { STORAGE_SERVICE, type VaultEntryStorage } from '../storage/interfaces/storage.interface';
import type {
  UpdateVaultEntry,
  VaultEntry,
  VaultEntryGrant,
  VaultEntryKind,
  VaultEntryProjectAccess,
  VaultGrant,
  VaultGrantAccess,
  VaultProjectGrantChange,
  VaultUseFamilyApproval,
} from '../storage/models/domain.models';
import { VaultAccessService } from './vault-access.service';
import { VaultKeyService } from './vault-key.service';
import {
  assertVaultEntryName,
  assertVaultEntryValue,
  reservedVaultEntryNames,
} from './vault-entry-rules';

/** Encryption binding of an entry value; launch decrypts with the same triple. */
export const VAULT_ENTRY_DOMAIN = 'vault-entry';
export const VAULT_ENTRY_VALUE_FIELD = 'value';

export interface CreateVaultEntryInput {
  projects: VaultEntryProjectAccess[];
  name: string;
  kind: VaultEntryKind;
  description: string;
  value: string;
  approvalRequired?: boolean;
}

/**
 * Write-only Vault entries: values go in encrypted and never come back out of
 * this service. Writes refuse on a claimed VM; value writes need an unlocked Vault,
 * and access-affecting writes follow `VaultAccessService.assertAccessWritable`.
 */
@Injectable()
export class VaultEntriesService {
  private reservedNames: Set<string> | null = null;

  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: VaultEntryStorage,
    private readonly vault: VaultKeyService,
    private readonly adapters: ProviderAdapterFactory,
    private readonly access: VaultAccessService,
  ) {}

  /** 400 `VAULT_ENTRY_NAME_INVALID` or `VAULT_ENTRY_NAME_RESERVED`, as a create would. */
  assertEntryName(name: string): void {
    assertVaultEntryName(name, this.reserved());
  }

  listEntries(projectId?: string): Promise<VaultEntry[]> {
    return this.storage.listVaultEntries(projectId ? { projectId } : undefined);
  }

  async createEntry(input: CreateVaultEntryInput): Promise<VaultEntry> {
    this.vault.assertHome();
    assertVaultEntryName(input.name, this.reserved());
    assertVaultEntryValue(input.kind, input.value);
    const id = randomUUID();
    return this.storage.createVaultEntry({
      id,
      projects: input.projects,
      name: input.name,
      kind: input.kind,
      description: input.description,
      valueCiphertext: this.seal(id, input.value),
      approvalRequired: input.approvalRequired ?? false,
    });
  }

  async updateEntry(id: string, data: UpdateVaultEntry): Promise<VaultEntry> {
    this.vault.assertHome();
    if (data.name !== undefined) assertVaultEntryName(data.name, this.reserved());
    // `projects` carries both the grants and the owner change; the flag gates delivery.
    if (data.projects !== undefined || data.approvalRequired !== undefined) {
      await this.access.assertAccessWritable();
    }
    return this.storage.updateVaultEntry(id, data);
  }

  async replaceValue(id: string, value: string): Promise<VaultEntry> {
    this.vault.assertHome();
    const entry = await this.storage.getVaultEntry(id);
    assertVaultEntryValue(entry.kind, value);
    return this.storage.replaceVaultEntryValue(id, this.seal(id, value));
  }

  async deleteEntry(id: string): Promise<void> {
    this.vault.assertHome();
    await this.access.assertAccessWritable();
    await this.storage.deleteVaultEntry(id);
  }

  listGrants(entryId: string): Promise<VaultEntryGrant[]> {
    return this.storage.listVaultEntryGrants(entryId);
  }

  listAllGrants(projectId?: string): Promise<VaultGrant[]> {
    return this.storage.listVaultGrants({ projectId });
  }

  async listUseFamilyApprovals(entryId: string): Promise<VaultUseFamilyApproval[]> {
    await this.storage.getVaultEntry(entryId);
    return this.storage.listVaultUseFamilyApprovals({ entryId });
  }

  /** Agents of the family get the approval prompt again; a missing row changes nothing. */
  async removeUseFamilyApproval(
    entryId: string,
    projectId: string,
    familySlug: string,
  ): Promise<VaultUseFamilyApproval[]> {
    this.vault.assertHome();
    await this.access.assertAccessWritable();
    return this.storage.removeVaultUseFamilyApproval(entryId, projectId, familySlug);
  }

  async setProjectGrants(
    projectId: string,
    entries: VaultProjectGrantChange[],
    access?: VaultGrantAccess,
  ): Promise<VaultGrant[]> {
    this.vault.assertHome();
    await this.access.assertAccessWritable();
    return this.storage.setVaultProjectGrants(projectId, entries, access);
  }

  private seal(id: string, value: string): string {
    return this.vault.encrypt(VAULT_ENTRY_DOMAIN, id, VAULT_ENTRY_VALUE_FIELD, value);
  }

  private reserved(): Set<string> {
    this.reservedNames ??= reservedVaultEntryNames(
      this.adapters.getSupportedProviders().map((name) => this.adapters.getAdapter(name)),
    );
    return this.reservedNames;
  }
}
