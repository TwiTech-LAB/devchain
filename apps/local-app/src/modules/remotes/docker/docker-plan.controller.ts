import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { requestAbortSignal } from '../../../common/http/request-abort-signal';
import { DockerCopyBack } from './docker-copy-back';
import type { DockerSyncState } from './docker-copy-back.dto';
import { DockerPlanService } from './docker-plan.service';
import type { DockerPlan, DockerPresence, DockerUserFixApplyResult } from './docker-plan.dto';

@ApiTags('docker-plan')
@Controller('api/projects/:id/docker')
export class DockerPlanController {
  constructor(
    private readonly plans: DockerPlanService,
    private readonly copyBack: DockerCopyBack,
  ) {}

  @Get('presence')
  @ApiOperation({ summary: 'Check whether this project has Docker work on this PC' })
  @ApiResponse({ status: 200, description: 'Docker work is present, absent, or unknown' })
  presence(
    @Param('id', ParseUUIDPipe) projectId: string,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<DockerPresence> {
    return this.plans.presence(projectId, requestAbortSignal(req, reply));
  }

  @Post('plan')
  @HttpCode(200)
  @ApiOperation({ summary: 'Scan home Docker and plan an import to the selected VM' })
  @ApiResponse({
    status: 200,
    description: 'Secret-free Docker availability, selections, fit and reconnect plan',
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid selection; only item IDs and modes are accepted',
  })
  @ApiResponse({ status: 422, description: 'An unsupported Docker setting prevents a safe scan' })
  plan(
    @Param('id', ParseUUIDPipe) projectId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<DockerPlan> {
    // An abandoned plan (the dialog re-planned or closed) stops scanning.
    return this.plans.plan(projectId, body, requestAbortSignal(req, reply), { reuse: true });
  }

  @Post('user-fix/apply')
  @HttpCode(200)
  @ApiOperation({ summary: 'Apply a confirmed Compose user scalar proposal from the plan' })
  @ApiResponse({ status: 200, description: 'The scalar was edited; Verify returns a fresh plan' })
  @ApiResponse({
    status: 409,
    description: 'The proposal or expected scalar is stale; get a fresh plan',
  })
  @ApiResponse({ status: 422, description: 'The proposal requires a manual edit' })
  applyUserFix(
    @Param('id', ParseUUIDPipe) projectId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<DockerUserFixApplyResult> {
    return this.plans.applyUserFix(projectId, body, requestAbortSignal(req, reply));
  }

  @Post('user-fix/verify')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Freshly resolve Compose with home and VM ids and return the Docker plan',
  })
  @ApiResponse({ status: 200, description: 'Fresh plan, including the resolved VM target user' })
  verifyUserFix(
    @Param('id', ParseUUIDPipe) projectId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<DockerPlan> {
    return this.plans.verifyUserFix(projectId, body, requestAbortSignal(req, reply));
  }

  @Post('sync-state')
  @HttpCode(200)
  @ApiOperation({ summary: "Check which of the project's imported Docker data changed where" })
  @ApiResponse({
    status: 200,
    description: 'Docker availability and the state of each imported data group; metadata only',
  })
  @ApiResponse({ status: 400, description: 'Invalid remote id' })
  syncState(
    @Param('id', ParseUUIDPipe) projectId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<DockerSyncState> {
    return this.copyBack.syncState(projectId, body, requestAbortSignal(req, reply));
  }
}
