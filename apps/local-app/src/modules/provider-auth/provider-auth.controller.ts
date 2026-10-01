import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { createLogger } from '../../common/logging/logger';
import { IntegrationAdmissionGuard } from '../../common/guards/integration-admission.guard';
import {
  CheckoutSchema,
  CreateProviderAuthStaticSchema,
  GenerateProviderAuthSchema,
  ImportOpencodeSchema,
  ProviderAuthGenerationIdSchema,
  ProviderAuthEntryIdSchema,
  RenameProviderAuthSchema,
  type OpencodeLoginDto,
  type PerProviderIdImportResult,
  type ProviderAuthEntryDto,
} from './provider-auth.dto';
import { ProviderAuthVaultService } from './provider-auth-vault.service';
import {
  ProviderAuthReleaseService,
  type ProviderAuthReleaseResult,
} from './provider-auth-release.service';
import {
  ProviderAuthGeneratorService,
  type ProviderAuthGeneration,
} from './provider-auth-generator.service';

const logger = createLogger('ProviderAuthController');

/** Bodies carry provider credentials; logs name routes and ids, never values. */
@UseGuards(IntegrationAdmissionGuard)
@Controller('api/provider-auth')
export class ProviderAuthController {
  constructor(
    private readonly vault: ProviderAuthVaultService,
    private readonly generator: ProviderAuthGeneratorService,
    private readonly releaseService: ProviderAuthReleaseService,
  ) {}

  @Get()
  async list(): Promise<{ items: ProviderAuthEntryDto[] }> {
    logger.info('GET /api/provider-auth');
    return { items: await this.vault.list() };
  }

  @Post('static')
  async createStatic(@Body() body: unknown): Promise<ProviderAuthEntryDto> {
    logger.info('POST /api/provider-auth/static');
    const data = CreateProviderAuthStaticSchema.parse(body);
    return this.vault.createStatic(data);
  }

  @Post('opencode-import')
  async importOpencode(@Body() body: unknown): Promise<{ results: PerProviderIdImportResult[] }> {
    logger.info('POST /api/provider-auth/opencode-import');
    const { providerIds } = ImportOpencodeSchema.parse(body);
    return { results: await this.vault.importOpencode(providerIds) };
  }

  /** Ids and fixed types only; the answer never carries a credential value or raw entry field. */
  @Get('opencode-logins')
  async listOpencodeLogins(): Promise<{ logins: OpencodeLoginDto[] }> {
    const logins = await this.vault.listOpencodeLogins();
    logger.info({ count: logins.length }, 'GET /api/provider-auth/opencode-logins');
    return { logins };
  }

  /** Starts an isolated login in a DevChain terminal; attach to `sessionId`, poll the status. */
  @Post('generate')
  async generate(@Body() body: unknown): Promise<ProviderAuthGeneration> {
    logger.info('POST /api/provider-auth/generate');
    const { provider, label } = GenerateProviderAuthSchema.parse(body);
    return this.generator.start(provider, label);
  }

  @Get('generate/:generationId')
  getGeneration(@Param('generationId') generationId: string): ProviderAuthGeneration {
    return this.generator.get(ProviderAuthGenerationIdSchema.parse(generationId));
  }

  @Post('generate/:generationId/cancel')
  @HttpCode(200)
  async cancelGeneration(
    @Param('generationId') generationId: string,
  ): Promise<ProviderAuthGeneration> {
    logger.info({ generationId }, 'POST /api/provider-auth/generate/:id/cancel');
    return this.generator.cancel(ProviderAuthGenerationIdSchema.parse(generationId));
  }

  @Patch(':id')
  async rename(@Param('id') id: string, @Body() body: unknown): Promise<ProviderAuthEntryDto> {
    logger.info({ entryId: id }, 'PATCH /api/provider-auth/:id');
    const { label } = RenameProviderAuthSchema.parse(body);
    return this.vault.rename(ProviderAuthEntryIdSchema.parse(id), label);
  }

  @Delete(':id')
  async delete(@Param('id') id: string): Promise<void> {
    logger.info({ entryId: id }, 'DELETE /api/provider-auth/:id');
    await this.vault.delete(ProviderAuthEntryIdSchema.parse(id));
  }

  @Post(':id/checkout')
  @HttpCode(200)
  async checkout(@Param('id') id: string, @Body() body: unknown): Promise<ProviderAuthEntryDto> {
    logger.info({ entryId: id }, 'POST /api/provider-auth/:id/checkout');
    const { remoteId } = CheckoutSchema.parse(body);
    return this.vault.checkout(ProviderAuthEntryIdSchema.parse(id), remoteId);
  }

  @Post(':id/release')
  @HttpCode(200)
  async release(
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<ProviderAuthReleaseResult> {
    logger.info({ entryId: id }, 'POST /api/provider-auth/:id/release');
    z.object({})
      .strict()
      .parse(body ?? {});
    return this.releaseService.release(ProviderAuthEntryIdSchema.parse(id));
  }
}
