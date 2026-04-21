import { Inject, Injectable } from '@nestjs/common';
import { createLogger } from '../../../common/logging/logger';
import { resolveBinary } from '../../../common/resolve-binary';
import { STORAGE_SERVICE, type StorageService } from '../../storage/interfaces/storage.interface';
import { ProviderAdapterFactory } from '../adapters';

const logger = createLogger('ProviderDiscoveryService');

export interface DiscoveredBinary {
  name: string;
  binPath: string;
}

export interface DiscoveryResult {
  discovered: DiscoveredBinary[];
  alreadyPresent: string[];
  notFound: string[];
}

@Injectable()
export class ProviderDiscoveryService {
  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    private readonly adapterFactory: ProviderAdapterFactory,
  ) {}

  async discoverInstalledBinaries(): Promise<DiscoveryResult> {
    const supportedNames = this.adapterFactory.getSupportedProviders();
    const { items: existingProviders } = await this.storage.listProviders();
    const existingNamesLower = new Set(existingProviders.map((p) => p.name.trim().toLowerCase()));

    const result: DiscoveryResult = {
      discovered: [],
      alreadyPresent: [],
      notFound: [],
    };

    for (const name of supportedNames) {
      const nameLower = name.trim().toLowerCase();

      if (existingNamesLower.has(nameLower)) {
        result.alreadyPresent.push(nameLower);
        continue;
      }

      const binPath = await resolveBinary(nameLower);
      if (binPath) {
        result.discovered.push({ name: nameLower, binPath });
      } else {
        result.notFound.push(nameLower);
      }
    }

    logger.info(
      {
        discovered: result.discovered.length,
        alreadyPresent: result.alreadyPresent.length,
        notFound: result.notFound.length,
      },
      'Binary discovery completed',
    );

    return result;
  }
}
