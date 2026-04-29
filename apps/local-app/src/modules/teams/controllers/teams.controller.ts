import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  Query,
  Inject,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { z } from 'zod';
import { createLogger } from '../../../common/logging/logger';
import { STORAGE_SERVICE, type StorageService } from '../../storage/interfaces/storage.interface';
import { TeamsService } from '../services/teams.service';

const logger = createLogger('TeamsController');

const CreateTeamSchema = z.object({
  projectId: z.string().min(1),
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  teamLeadAgentId: z.string().min(1).nullable().optional(),
  memberAgentIds: z.array(z.string().min(1)).min(1),
  maxMembers: z.number().int().min(2).max(10).optional(),
  maxConcurrentTasks: z.number().int().min(1).max(10).optional(),
  allowTeamLeadCreateAgents: z.boolean().optional(),
  profileIds: z.array(z.string().min(1)).optional().default([]),
  profileConfigSelections: z
    .array(
      z
        .object({
          profileId: z.string().uuid(),
          configIds: z.array(z.string().uuid()),
        })
        .strict(),
    )
    .optional(),
});

const UpdateTeamSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  teamLeadAgentId: z.string().min(1).nullable().optional(),
  memberAgentIds: z.array(z.string().min(1)).min(1).optional(),
  maxMembers: z.number().int().min(2).max(10).optional(),
  maxConcurrentTasks: z.number().int().min(1).max(10).optional(),
  allowTeamLeadCreateAgents: z.boolean().optional(),
  profileIds: z.array(z.string().min(1)).optional(),
  profileConfigSelections: z
    .array(
      z
        .object({
          profileId: z.string().uuid(),
          configIds: z.array(z.string().uuid()),
        })
        .strict(),
    )
    .optional(),
});

/** Member with resolved agent name and lead flag */
export interface TeamMemberResponse {
  agentId: string;
  agentName: string | null;
  isLead: boolean;
  createdAt: string;
}

/** Get team response with enriched members */
export interface TeamDetailResponse {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  teamLeadAgentId: string | null;
  teamLeadAgentName: string | null;
  maxMembers: number;
  maxConcurrentTasks: number;
  allowTeamLeadCreateAgents: boolean;
  members: TeamMemberResponse[];
  profileIds: string[];
  profileConfigSelections: Array<{ profileId: string; configIds: string[] }>;
  createdAt: string;
  updatedAt: string;
}

@Controller('api/teams')
export class TeamsController {
  constructor(
    private readonly teamsService: TeamsService,
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
  ) {}

  @Get()
  async listTeams(
    @Query('projectId') projectId: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    logger.info({ projectId }, 'GET /api/teams');
    if (!projectId) {
      throw new BadRequestException('projectId query parameter required');
    }

    return this.teamsService.listTeams(projectId, {
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
    });
  }

  @Get(':id')
  async getTeam(@Param('id') id: string): Promise<TeamDetailResponse> {
    logger.info({ id }, 'GET /api/teams/:id');

    const team = await this.teamsService.getTeam(id);
    if (!team) {
      throw new NotFoundException(`Team with identifier ${id} not found`);
    }

    // Batch-load agent names for all members + lead
    const allAgentIds = [
      ...new Set([
        ...team.members.map((m) => m.agentId),
        ...(team.teamLeadAgentId ? [team.teamLeadAgentId] : []),
      ]),
    ];
    const agentNameMap = await this.resolveAgentNames(allAgentIds);

    return {
      id: team.id,
      projectId: team.projectId,
      name: team.name,
      description: team.description,
      teamLeadAgentId: team.teamLeadAgentId,
      teamLeadAgentName: team.teamLeadAgentId ? (agentNameMap[team.teamLeadAgentId] ?? null) : null,
      maxMembers: team.maxMembers,
      maxConcurrentTasks: team.maxConcurrentTasks,
      allowTeamLeadCreateAgents: team.allowTeamLeadCreateAgents,
      members: team.members.map((m) => ({
        agentId: m.agentId,
        agentName: agentNameMap[m.agentId] ?? null,
        isLead: m.agentId === team.teamLeadAgentId,
        createdAt: m.createdAt,
      })),
      profileIds: team.profileIds,
      profileConfigSelections: team.profileConfigSelections ?? [],
      createdAt: team.createdAt,
      updatedAt: team.updatedAt,
    };
  }

  @Post()
  async createTeam(@Body() body: unknown) {
    logger.info('POST /api/teams');
    const data = CreateTeamSchema.parse(body);
    return this.teamsService.createTeam(data);
  }

  @Put(':id')
  async updateTeam(@Param('id') id: string, @Body() body: unknown) {
    logger.info({ id }, 'PUT /api/teams/:id');
    const data = UpdateTeamSchema.parse(body);
    return this.teamsService.updateTeam(id, data);
  }

  @Post(':teamId/agents')
  async createTeamAgent(@Param('teamId') teamId: string, @Body() body: unknown) {
    logger.info({ teamId }, 'POST /api/teams/:teamId/agents');
    const schema = z
      .object({
        providerConfigId: z.string().uuid(),
        name: z.string().trim().min(1),
        description: z.string().optional(),
      })
      .strict();
    const data = schema.parse(body);

    const team = await this.teamsService.getTeam(teamId);
    if (!team) {
      throw new NotFoundException('Team not found');
    }
    if (team.teamLeadAgentId === null) {
      throw new BadRequestException('Team has no lead');
    }

    return this.teamsService.createTeamAgentForRest({
      actorLeadAgentId: team.teamLeadAgentId,
      projectId: team.projectId,
      teamId,
      providerConfigId: data.providerConfigId,
      name: data.name,
      description: data.description,
    });
  }

  @Delete(':id')
  async deleteTeam(@Param('id') id: string): Promise<void> {
    logger.info({ id }, 'DELETE /api/teams/:id');
    await this.teamsService.disbandTeam(id);
  }

  private async resolveAgentNames(agentIds: string[]): Promise<Record<string, string>> {
    const nameMap: Record<string, string> = {};
    for (const agentId of agentIds) {
      try {
        const agent = await this.storage.getAgent(agentId);
        nameMap[agentId] = agent.name;
      } catch {
        // Agent may have been deleted; leave out of map
      }
    }
    return nameMap;
  }
}
