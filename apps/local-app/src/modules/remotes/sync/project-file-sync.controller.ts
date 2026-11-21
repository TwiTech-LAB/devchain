import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { requestAbortSignal } from '../../../common/http/request-abort-signal';
import { IgnoresBodySchema } from '../../file-sync/file-sync.dto';
import { AutoFixBodySchema, type FileSyncAutoFix } from '../../file-sync/file-sync-auto-fix.dto';
import type {
  SaveProjectIgnoresResult,
  ProjectFileSyncFailures,
  ManagedExclusionRow,
} from './remote-file-sync.dto';
import { ManagedExclusionsCheckService } from './managed-exclusions-check.service';
import { FileSyncFailuresService } from './file-sync-failures.service';
import { RemoteFileSyncService } from './remote-file-sync.service';
import { RemoteLiveSyncService } from './remote-live-sync.service';
import {
  SyncSuggestionsRequestSchema,
  type ProjectExclusionSuggestions,
} from '../../file-sync/sync-path-inspection.dto';
import { FileSyncSuggestionsService } from './file-sync-suggestions.service';
import { FileSyncPatternPreviewService } from './file-sync-pattern-preview.service';
import { PatternPreviewRequestSchema, type ProjectPatternPreview } from './remote-file-sync.dto';

@ApiTags('file-sync')
@Controller('api/projects/:id/file-sync')
export class ProjectFileSyncController {
  constructor(
    private readonly live: RemoteLiveSyncService,
    private readonly files: RemoteFileSyncService,
    private readonly suggestions: FileSyncSuggestionsService,
    private readonly failures: FileSyncFailuresService,
    private readonly previews: FileSyncPatternPreviewService,
    private readonly managed: ManagedExclusionsCheckService,
  ) {}

  @Get('managed-exclusions')
  @ApiOperation({ summary: 'List Docker data folders and check which can rejoin file sync' })
  @ApiQuery({ name: 'remoteId', required: false, schema: { type: 'string', format: 'uuid' } })
  @ApiResponse({ status: 200, description: 'Stored Docker exclusions and their status' })
  async managedExclusions(
    @Param('id', ParseUUIDPipe) projectId: string,
    @Query('remoteId', new ParseUUIDPipe({ optional: true })) remoteId: string | undefined,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ exclusions: ManagedExclusionRow[] }> {
    return {
      exclusions: await this.managed.evaluate(projectId, remoteId, requestAbortSignal(req, reply)),
    };
  }

  @Get('ignores')
  getIgnores(@Param('id', ParseUUIDPipe) projectId: string): {
    ignores: string[];
    revision: number;
  } {
    return this.files.getIgnores(projectId);
  }

  @Get('auto-fix')
  getAutoFix(@Param('id', ParseUUIDPipe) projectId: string): FileSyncAutoFix {
    return this.files.getAutoFix(projectId);
  }

  @Put('auto-fix')
  setAutoFix(
    @Param('id', ParseUUIDPipe) projectId: string,
    @Body() body: unknown,
  ): FileSyncAutoFix {
    return this.files.setAutoFix(projectId, AutoFixBodySchema.parse(body).enabled);
  }

  @Get('failed')
  async failedFiles(
    @Param('id', ParseUUIDPipe) projectId: string,
  ): Promise<ProjectFileSyncFailures> {
    const [failures, forceSync] = await Promise.all([
      this.failures.failed(projectId),
      this.files.forceSyncOffer(projectId),
    ]);
    return { ...failures, forceSync };
  }

  @Post('suggestions')
  @HttpCode(200)
  suggestionsForProject(
    @Param('id', ParseUUIDPipe) projectId: string,
    @Body() body: unknown,
  ): Promise<ProjectExclusionSuggestions> {
    const { remoteId } = SyncSuggestionsRequestSchema.parse(body);
    return this.suggestions.suggestions(projectId, remoteId);
  }

  @Post('pattern-preview')
  @HttpCode(200)
  @ApiOperation({ summary: 'Preview tracked and Git-kept files excluded by a pattern' })
  @ApiResponse({ status: 200, description: 'Match counts, samples and inspection states per side' })
  @ApiResponse({ status: 400, description: 'Invalid project ID or pattern syntax' })
  @ApiResponse({ status: 409, description: 'The project is not connected to a VM' })
  patternPreview(
    @Param('id', ParseUUIDPipe) projectId: string,
    @Body() body: unknown,
  ): Promise<ProjectPatternPreview> {
    const { pattern } = PatternPreviewRequestSchema.parse(body);
    return this.previews.preview(projectId, pattern);
  }

  @Put('ignores')
  @ApiOperation({ summary: 'Save project ignores and apply them to a connected VM and this PC' })
  @ApiResponse({ status: 200, description: 'Desired list and whether both sides applied it' })
  @ApiResponse({ status: 400, description: 'Invalid project ID or ignore list' })
  @ApiResponse({ status: 409, description: 'Force sync holds file settings until it finishes' })
  async save(
    @Param('id', ParseUUIDPipe) projectId: string,
    @Body() body: unknown,
  ): Promise<SaveProjectIgnoresResult> {
    await this.files.assertNoHold(projectId);
    const { ignores, revision } = IgnoresBodySchema.parse(body);
    return this.live.runExclusive(projectId, async (active) => {
      await this.files.assertNoHold(projectId);
      return this.files.saveIgnores(projectId, ignores, active, revision);
    });
  }
}
