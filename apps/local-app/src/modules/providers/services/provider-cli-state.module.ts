import { Module } from '@nestjs/common';
import { dirname, join } from 'node:path';
import { getDbConfig } from '../../storage/db/db.config';
import {
  PROVIDER_CLI_INSTALL_ROOT,
  ProviderCliInstallStateService,
} from './provider-cli-install-state.service';

@Module({
  providers: [
    {
      provide: PROVIDER_CLI_INSTALL_ROOT,
      useFactory: () => join(dirname(getDbConfig().dbPath), 'provider-clis'),
    },
    ProviderCliInstallStateService,
  ],
  exports: [ProviderCliInstallStateService, PROVIDER_CLI_INSTALL_ROOT],
})
export class ProviderCliStateModule {}
