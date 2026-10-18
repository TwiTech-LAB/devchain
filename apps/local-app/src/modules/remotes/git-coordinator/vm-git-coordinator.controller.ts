import { Body, Controller, HttpCode, Param, Post, Req } from '@nestjs/common';
import { ApiNoContentResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { HostProjectIdSchema } from '../host/host.dto';
import { VmHoldRequestSchema } from './git-coordinator.dto';
import type { GitCoordinatorRecord } from './git-coordinator.dto';
import { GitCoordinatorService } from './git-coordinator.service';
import { assertLoopback } from './loopback';

@ApiTags('VM Git coordinator')
@Controller('api/git-coordinator/projects/:id')
export class VmGitCoordinatorController {
  constructor(private readonly coordinator: GitCoordinatorService) {}

  @Post('acquire')
  @HttpCode(200)
  @ApiOperation({ summary: 'Admit a local supervised Git child by PID and start identity' })
  @ApiOkResponse({ description: 'VM ownership and durable process hold, after any reclaim' })
  acquire(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<GitCoordinatorRecord> {
    assertLoopback(request, 'VM Git holds require a loopback connection');
    return this.coordinator.acquireVmHold(
      HostProjectIdSchema.parse(id),
      VmHoldRequestSchema.parse(body),
    );
  }

  @Post('release')
  @HttpCode(204)
  @ApiOperation({ summary: 'Release a local supervised Git hold after the child exits' })
  @ApiNoContentResponse()
  release(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<void> {
    assertLoopback(request, 'VM Git holds require a loopback connection');
    return this.coordinator.releaseVmHold(
      HostProjectIdSchema.parse(id),
      VmHoldRequestSchema.parse(body),
    );
  }
}
