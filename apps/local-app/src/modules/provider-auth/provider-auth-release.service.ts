import { Injectable } from '@nestjs/common';
import type { ProviderAuthEntryDto } from './provider-auth.dto';
import { ProviderAuthVaultService } from './provider-auth-vault.service';
import { ProviderAuthWritebackService } from './provider-auth-writeback.service';

export type ProviderAuthReleasePullStatus = 'pulled' | 'offline' | 'not-needed';

export interface ProviderAuthReleaseResult {
  entry: ProviderAuthEntryDto;
  pullStatus: ProviderAuthReleasePullStatus;
}

@Injectable()
export class ProviderAuthReleaseService {
  constructor(
    private readonly vault: ProviderAuthVaultService,
    private readonly writeback: ProviderAuthWritebackService,
  ) {}

  async release(id: string): Promise<ProviderAuthReleaseResult> {
    const current = await this.vault.get(id);
    let pullStatus: ProviderAuthReleasePullStatus = 'not-needed';

    if (current.checkedOutRemoteId) {
      const pull = await this.writeback.pullFamiliesNow(current.checkedOutRemoteId);
      pullStatus = pull.pulled ? 'pulled' : 'offline';
    }

    const entry = await this.vault.release(id);
    return { entry, pullStatus };
  }
}
