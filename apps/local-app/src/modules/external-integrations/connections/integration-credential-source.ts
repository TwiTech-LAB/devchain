import { Inject, Injectable } from '@nestjs/common';
import { AppError } from '../../../common/errors/error-types';
import { STORAGE_SERVICE, type StorageService } from '../../storage/interfaces/storage.interface';
import type {
  IntegrationConnection,
  IntegrationCredentials,
} from '../../storage/models/domain.models';
import { IntegrationVmCacheService } from '../vm-cache/integration-vm-cache.service';

/** Where the credentials of one connection row come from. */
export interface IntegrationCredentialSource {
  /** Null when the row has no credentials. */
  read(
    connection: IntegrationConnection & { projectId: string },
  ): Promise<IntegrationCredentials | null>;
}

export const INTEGRATION_CREDENTIAL_SOURCE = Symbol('INTEGRATION_CREDENTIAL_SOURCE');

/** Home: the sealed credentials in the connection row. */
export function storageCredentialSource(
  storage: Pick<StorageService, 'getIntegrationConnectionCredentials'>,
): IntegrationCredentialSource {
  return {
    read: ({ projectId, provider }) =>
      storage.getIntegrationConnectionCredentials({ projectId, provider }),
  };
}

/**
 * Claimed VM: the credentials home pushed to the tmpfs cache, only at the row's
 * generation. Refuses instead of returning null, so the agent learns what to do.
 */
export function vmCacheCredentialSource(
  cache: Pick<IntegrationVmCacheService, 'readCredentials'>,
): IntegrationCredentialSource {
  return {
    read: async (connection) => {
      const cached = await cache.readCredentials(connection);
      const details = { provider: connection.provider, projectId: connection.projectId };
      if (cached.state === 'ready') return cached.credentials;
      if (cached.state === 'unavailable') {
        throw new AppError(
          'This VM cannot keep integration credentials in memory. Update the VM.',
          'INTEGRATION_CACHE_UNAVAILABLE',
          409,
          { ...details, reason: cached.reason },
        );
      }
      throw new AppError(
        'Home has not sent this connection to the VM yet. Home must be online once after a VM reboot or a token change.',
        'INTEGRATION_NOT_DELIVERED',
        409,
        details,
      );
    },
  };
}

/** Picks the source on each read: a claimed host reads its cache, home reads storage. */
@Injectable()
export class IntegrationCredentialReader implements IntegrationCredentialSource {
  private readonly home: IntegrationCredentialSource;
  private readonly vm: IntegrationCredentialSource;

  constructor(
    @Inject(STORAGE_SERVICE)
    storage: Pick<StorageService, 'getIntegrationConnectionCredentials'>,
    private readonly cache: IntegrationVmCacheService,
  ) {
    this.home = storageCredentialSource(storage);
    this.vm = vmCacheCredentialSource(cache);
  }

  read(
    connection: IntegrationConnection & { projectId: string },
  ): Promise<IntegrationCredentials | null> {
    return (this.cache.isClaimedHost() ? this.vm : this.home).read(connection);
  }
}
