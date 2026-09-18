import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import type {
  AgentTimeBufferAssignmentResult,
  AgentTimeBufferResetResult,
  AgentTimeBufferSnapshot,
} from '../models/epic-time.models';
import { EpicTimeService } from '../services/epic-time.service';

const ProjectIdSchema = z.string().uuid();
const AgentIdSchema = z.string().min(1);
const SnapshotTokenSchema = z.string().regex(/^[0-9a-f]{64}$/);
const AssignAgentTimeBufferSchema = z
  .object({
    projectId: ProjectIdSchema,
    targetEpicId: z.string().uuid(),
    capturedAt: z.string().datetime(),
    snapshotToken: SnapshotTokenSchema,
  })
  .strict();
const ResetAgentTimeBufferSchema = z
  .object({
    projectId: ProjectIdSchema,
    capturedAt: z.string().datetime(),
    snapshotToken: SnapshotTokenSchema,
  })
  .strict();

@Controller('api/agent-time-buffers')
export class AgentTimeBufferController {
  constructor(private readonly epicTimeService: EpicTimeService) {}

  @Get()
  getAgentTimeBuffers(@Query('projectId') projectId: string | undefined): AgentTimeBufferSnapshot {
    return this.epicTimeService.getAgentTimeBuffers(ProjectIdSchema.parse(projectId));
  }

  @Post(':agentId/assign')
  @HttpCode(HttpStatus.OK)
  assignAgentTimeBuffer(
    @Param('agentId') agentId: string,
    @Body() body: unknown,
  ): Promise<AgentTimeBufferAssignmentResult> {
    const parsed = AssignAgentTimeBufferSchema.parse(body);
    return this.epicTimeService.assignAgentTimeBuffer({
      agentId: AgentIdSchema.parse(agentId),
      ...parsed,
    });
  }

  @Post(':agentId/reset')
  @HttpCode(HttpStatus.OK)
  resetAgentTimeBuffer(
    @Param('agentId') agentId: string,
    @Body() body: unknown,
  ): Promise<AgentTimeBufferResetResult> {
    const parsed = ResetAgentTimeBufferSchema.parse(body);
    return this.epicTimeService.resetAgentTimeBuffer({
      agentId: AgentIdSchema.parse(agentId),
      ...parsed,
    });
  }
}
