import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { IntegrationAdmissionGuard } from '../../common/guards/integration-admission.guard';
import { createLogger } from '../../common/logging/logger';
import type {
  VaultEntry,
  VaultEntryGrant,
  VaultFamilyAccess,
  VaultGrant,
  VaultUseFamilyApproval,
} from '../storage/models/domain.models';
import {
  VaultEntryCreateSchema,
  VaultEntryUpdateSchema,
  VaultEntryValueSchema,
  VaultProjectGrantsSchema,
  VaultProjectQuerySchema,
} from './vault.dto';
import { VaultAccessService } from './vault-access.service';
import { VaultEntriesService } from './vault-entries.service';

const logger = createLogger('VaultEntriesController');

/** Home-only and write-only: bodies carry values, responses never do; logs name routes only. */
@UseGuards(IntegrationAdmissionGuard)
@Controller('api/vault')
export class VaultEntriesController {
  constructor(
    private readonly entries: VaultEntriesService,
    private readonly access: VaultAccessService,
  ) {}

  @Get('entries')
  list(@Query() query: unknown): Promise<VaultEntry[]> {
    const { projectId } = VaultProjectQuerySchema.parse(query);
    return this.entries.listEntries(projectId);
  }

  @Post('entries')
  create(@Body() body: unknown): Promise<VaultEntry> {
    logger.info('POST /api/vault/entries');
    return this.entries.createEntry(VaultEntryCreateSchema.parse(body));
  }

  @Patch('entries/:id')
  update(@Param('id') id: string, @Body() body: unknown): Promise<VaultEntry> {
    logger.info({ entryId: id }, 'PATCH /api/vault/entries/:id');
    return this.entries.updateEntry(id, VaultEntryUpdateSchema.parse(body));
  }

  @Put('entries/:id/value')
  replaceValue(@Param('id') id: string, @Body() body: unknown): Promise<VaultEntry> {
    logger.info({ entryId: id }, 'PUT /api/vault/entries/:id/value');
    return this.entries.replaceValue(id, VaultEntryValueSchema.parse(body).value);
  }

  @Delete('entries/:id')
  @HttpCode(204)
  async remove(@Param('id') id: string): Promise<void> {
    logger.info({ entryId: id }, 'DELETE /api/vault/entries/:id');
    await this.entries.deleteEntry(id);
  }

  @Get('entries/:id/grants')
  listGrants(@Param('id') id: string): Promise<VaultEntryGrant[]> {
    return this.entries.listGrants(id);
  }

  /** The entry's "never ask again" rows: families that skip the approval prompt. */
  @Get('entries/:id/approvals')
  listApprovals(@Param('id') id: string): Promise<VaultUseFamilyApproval[]> {
    return this.entries.listUseFamilyApprovals(id);
  }

  /** Returns the entry's remaining approvals. */
  @Delete('entries/:id/approvals/:projectId/:familySlug')
  removeApproval(
    @Param('id') id: string,
    @Param('projectId') projectId: string,
    @Param('familySlug') familySlug: string,
  ): Promise<VaultUseFamilyApproval[]> {
    logger.info({ entryId: id, projectId }, 'DELETE /api/vault/entries/:id/approvals');
    return this.entries.removeUseFamilyApproval(id, projectId, familySlug);
  }

  /** Grant rows of every entry, or of one project's entries with `projectId`. */
  @Get('grants')
  listAllGrants(@Query() query: unknown): Promise<VaultGrant[]> {
    const { projectId } = VaultProjectQuerySchema.parse(query);
    return this.entries.listAllGrants(projectId);
  }

  /**
   * Changes only the listed entries in this project; one bad item rejects all. With
   * `access`, the project's Vault access saves in the same transaction; `none` turns it off.
   */
  @Put('projects/:projectId/grants')
  setProjectGrants(
    @Param('projectId') projectId: string,
    @Body() body: unknown,
  ): Promise<VaultGrant[]> {
    logger.info({ projectId }, 'PUT /api/vault/projects/:projectId/grants');
    const { entries, access } = VaultProjectGrantsSchema.parse(body);
    return this.entries.setProjectGrants(projectId, entries, access);
  }

  /** Access rows of every project, or of one project with `projectId`. */
  @Get('access')
  listAccess(@Query() query: unknown): Promise<VaultFamilyAccess[]> {
    const { projectId } = VaultProjectQuerySchema.parse(query);
    return this.access.listAccess(projectId);
  }
}
