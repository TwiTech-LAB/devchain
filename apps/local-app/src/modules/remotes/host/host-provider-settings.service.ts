import { Inject, Injectable } from '@nestjs/common';
import {
  STORAGE_SERVICE,
  type ProviderStorage,
  type ReplicaProviderSettingsRow,
} from '../../storage/interfaces/storage.interface';
import type { HostProviderSettingsStatus } from '../contract/host-routes';

/**
 * The VM's provider env, scopes and the two provider scalars, set by home. The applied
 * revision lives in memory only: it holds while the stored settings still have the
 * fingerprint of the last push, so any other change (a local edit, a new provider or
 * project, a release, a restart) brings home's push back.
 */
@Injectable()
export class HostProviderSettingsService {
  private applied: { revision: string; stateHash: string } | null = null;

  constructor(
    @Inject(STORAGE_SERVICE)
    private readonly storage: Pick<
      ProviderStorage,
      'applyHomeProviderSettings' | 'readProviderSettingsFingerprint'
    >,
  ) {}

  status(): HostProviderSettingsStatus {
    const applied = this.applied;
    if (!applied || this.storage.readProviderSettingsFingerprint() !== applied.stateHash) {
      return { appliedRevision: null };
    }
    return { appliedRevision: applied.revision };
  }

  async accept(revision: string, providers: ReplicaProviderSettingsRow[]): Promise<void> {
    this.applied = null;
    const { fingerprint } = await this.storage.applyHomeProviderSettings(providers);
    this.applied = { revision, stateHash: fingerprint };
  }
}
