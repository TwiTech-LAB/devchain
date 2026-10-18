import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requestAbortSignal } from '../../../common/http/request-abort-signal';
import { HostProjectIdSchema } from '../host/host.dto';
import { assertLoopback } from '../git-coordinator/loopback';
import { HomeGitWriteService, type HomeGitProject } from './home-git-write.service';

const LOOPBACK_ONLY = 'Home Git writes require a loopback connection';
const ProjectQuerySchema = z.object({ path: z.string().min(1).startsWith('/') });
const AcquireSchema = z
  .object({ projectId: HostProjectIdSchema, pid: z.number().int().positive() })
  .strict();

/** The supervisor protocol for home Git writes; see docs/git-coordinator.md. */
@ApiTags('Home Git writes')
@Controller('api/git-writes')
export class HomeGitWriteController {
  constructor(private readonly writes: HomeGitWriteService) {}

  @Get('project')
  @ApiOperation({ summary: 'Find the project containing a folder and its VM, if connected' })
  @ApiOkResponse({ description: 'Project id and VM name (null when not connected)' })
  async project(@Req() request: FastifyRequest, @Query() query: unknown): Promise<HomeGitProject> {
    assertLoopback(request, LOOPBACK_ONLY);
    const project = await this.writes.project(ProjectQuerySchema.parse(query).path);
    if (!project) throw new NotFoundException('No registered project contains this folder');
    return project;
  }

  @Post('acquire')
  @HttpCode(200)
  @ApiOperation({ summary: 'Register a gated git child as a home write on the VM' })
  @ApiOkResponse({ description: 'Write id to release the child with' })
  acquire(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Body() body: unknown,
  ): Promise<{ writeId: string }> {
    assertLoopback(request, LOOPBACK_ONLY);
    const { projectId, pid } = AcquireSchema.parse(body);
    // The supervisor holds this request open; a closed connection before the answer means it died.
    return this.writes.acquire(projectId, pid, requestAbortSignal(request, reply));
  }
}
