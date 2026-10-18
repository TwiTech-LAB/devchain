import { Body, Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { isLoopbackHost } from '../../../common/config/integration-admission';
import { AppError, ForbiddenError } from '../../../common/errors/error-types';
import { HostApiKeyService } from './host-api-key.service';
import { HostHelperService } from './host-helper.service';
import { HostSharedVmService } from './host-shared-vm.service';
import { HostSharedVmStore } from './host-shared-vm.store';
import {
  SharedVmAbandonSchema,
  SharedVmDismissSchema,
  SharedVmFenceRequestSchema,
  SharedVmInboxSchema,
  SharedVmNotifySchema,
} from './shared-vm.contract';

@ApiTags('host')
@Controller('api/host/shared-vm')
export class HostSharedVmController {
  constructor(
    private readonly shared: HostSharedVmService,
    private readonly store: HostSharedVmStore,
    private readonly keys: HostApiKeyService,
    private readonly helper: HostHelperService,
  ) {}

  @Get('connected-count')
  @ApiOperation({ summary: 'Loopback-only connected-project count' })
  @ApiResponse({ status: 200, description: 'Count of non-template, non-abandoned projects' })
  @ApiResponse({
    status: 503,
    description: 'An admitted writer prevents a current occupancy snapshot',
  })
  count(@Req() request: FastifyRequest): ReturnType<HostSharedVmStore['readOccupancy']> {
    this.loopback(request);
    return this.store.readOccupancy();
  }

  @Post('inbox')
  @HttpCode(204)
  @ApiOperation({ summary: 'Loopback-only notice delivery' })
  @ApiResponse({ status: 204, description: 'Notice stored in this instance' })
  async receive(@Req() request: FastifyRequest, @Body() body: unknown): Promise<void> {
    this.loopback(request);
    await this.store.receive(SharedVmInboxSchema.parse(body));
  }

  @Get('roster')
  @ApiOperation({ summary: 'Read every claimed instance and its occupancy' })
  @ApiResponse({
    status: 200,
    description: 'Registry instances, with unknown for unavailable counts',
  })
  roster(@Req() request: FastifyRequest): ReturnType<HostSharedVmService['roster']> {
    this.key(request);
    return this.shared.roster();
  }

  @Post('notify')
  @HttpCode(200)
  @ApiOperation({ summary: 'Notify every other VM user once' })
  @ApiResponse({ status: 200, description: 'Per-user delivery results' })
  notify(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): ReturnType<HostSharedVmService['notify']> {
    this.key(request);
    return this.shared.notify(SharedVmNotifySchema.parse(body));
  }

  @Get('notices')
  @ApiOperation({ summary: 'Read this instance notice inbox' })
  @ApiResponse({ status: 200, description: 'Notices awaiting dismissal' })
  notices(@Req() request: FastifyRequest): { notices: ReturnType<HostSharedVmStore['notices']> } {
    this.key(request);
    return { notices: this.store.notices() };
  }

  @Post('dismiss')
  @HttpCode(204)
  @ApiOperation({ summary: 'Dismiss one notice' })
  @ApiResponse({ status: 204, description: 'Notice dismissed, including already absent IDs' })
  async dismiss(@Req() request: FastifyRequest, @Body() body: unknown): Promise<void> {
    this.key(request);
    await this.store.dismiss(SharedVmDismissSchema.parse(body).id);
  }

  @Post('abandon')
  @HttpCode(204)
  @ApiOperation({ summary: 'Exclude a forced-disconnected project from occupancy' })
  @ApiResponse({ status: 204, description: 'Project excluded; its rows and files remain' })
  async abandon(@Req() request: FastifyRequest, @Body() body: unknown): Promise<void> {
    this.key(request);
    await this.store.abandon(SharedVmAbandonSchema.parse(body).projectId);
  }

  @Post('fence')
  @HttpCode(200)
  @ApiOperation({ summary: 'Set or clear the owner destroy fence' })
  @ApiResponse({ status: 200, description: 'VM-wide fence, or null after clearing' })
  fence(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): ReturnType<HostHelperService['destroyFence']> {
    this.key(request);
    this.shared.assertOwner();
    const { mode, operationId } = SharedVmFenceRequestSchema.parse(body);
    return this.helper.destroyFence(mode, operationId);
  }

  private key(request: FastifyRequest): void {
    const refusal = this.keys.allows(request.raw, 'http', true);
    if (refusal) throw new AppError(refusal.message, refusal.code, refusal.statusCode);
    this.helper.assertClaimedHost();
  }

  private loopback(request: FastifyRequest): void {
    if (!isLoopbackHost(request.raw.socket.remoteAddress ?? '')) {
      throw new ForbiddenError('This route accepts only loopback callers.', {
        code: 'HOST_LOOPBACK_REQUIRED',
      });
    }
    this.helper.assertClaimedHost();
  }
}
