import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { IntegrationAdmissionGuard } from '../../common/guards/integration-admission.guard';
import { createLogger } from '../../common/logging/logger';
import { RuntimeDirectoryService } from '../runtime-directory/runtime-directory.service';
import {
  VaultSetupSchema,
  VaultUnlockSchema,
  type VaultStatusDto,
  type VaultStatusResponseDto,
} from './vault.dto';
import { VaultKeyService, type VaultStatus } from './vault-key.service';
import { VaultStoreMigrationService } from './vault-store-migration.service';
import { VaultVmCacheService } from './vault-vm-cache.service';

const logger = createLogger('VaultController');

/** Home-only. Bodies carry a recovery code; logs name routes, never bodies. */
@UseGuards(IntegrationAdmissionGuard)
@Controller('api/vault')
export class VaultController {
  constructor(
    private readonly vault: VaultKeyService,
    private readonly runtimeDirectory: RuntimeDirectoryService,
    private readonly vmCache: VaultVmCacheService,
    private readonly storeMigration: VaultStoreMigrationService,
  ) {}

  @Get('status')
  async status(): Promise<VaultStatusResponseDto> {
    const runtime = await this.runtimeDirectory.getStatus();
    const status = {
      ...this.withPendingCode(this.vault.getStatus()),
      runtime,
      storeMigration: this.storeMigration.getStatus(),
    };
    if (!this.vmCache.isClaimedHost()) return status;
    const { cacheReady, cacheUnavailable } = await this.vmCache.status();
    return { ...status, vmCache: { cacheReady, cacheUnavailable } };
  }

  @Post('setup')
  @HttpCode(200)
  async setup(@Body() body: unknown): Promise<VaultStatusDto> {
    logger.info('POST /api/vault/setup');
    const { mode } = VaultSetupSchema.parse(body);
    return this.withPendingCode(await this.vault.setup(mode));
  }

  @Post('unlock')
  @HttpCode(200)
  async unlock(@Body() body: unknown): Promise<VaultStatusDto> {
    logger.info('POST /api/vault/unlock');
    const { recoveryCode } = VaultUnlockSchema.parse(body);
    return this.withPendingCode(await this.vault.unlockWithRecoveryCode(recoveryCode));
  }

  @Post('recovery/confirm')
  @HttpCode(200)
  async confirmRecovery(): Promise<VaultStatusDto> {
    logger.info('POST /api/vault/recovery/confirm');
    return this.vault.confirmRecoveryCode();
  }

  private withPendingCode(status: VaultStatus): VaultStatusDto {
    const recoveryCode = this.vault.getPendingRecoveryCode();
    return recoveryCode ? { ...status, recoveryCode } : status;
  }
}
