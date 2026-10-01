import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { requestAbortSignal } from '../../../common/http/request-abort-signal';
import { DockerCopyBack } from './docker-copy-back';
import type { DockerSyncState } from './docker-copy-back.dto';
import { DockerPlanService } from './docker-plan.service';
import type { DockerPlan } from './docker-plan.dto';

@ApiTags('docker-plan')
@Controller('api/projects/:id/docker')
export class DockerPlanController {
  constructor(
    private readonly plans: DockerPlanService,
    private readonly copyBack: DockerCopyBack,
  ) {}

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
    return this.plans.plan(projectId, body, requestAbortSignal(req, reply));
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
