import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  Inject,
  BadRequestException,
  forwardRef,
} from '@nestjs/common';
import { StorageService, STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import { CreateAgent, UpdateAgent, Agent } from '../../storage/models/domain.models';
import { SessionsService } from '../../sessions/services/sessions.service';
import { SessionCoordinatorService } from '../../sessions/services/session-coordinator.service';
import { SessionDto } from '../../sessions/dtos/sessions.dto';
import { z } from 'zod';
import { createLogger } from '../../../common/logging/logger';

const logger = createLogger('AgentsController');

/** Extended agent response with optional provider information (backward compatible) */
export interface AgentWithProvider extends Agent {
  providerName?: string;
  providerId?: string;
}

/** Agent or guest item with type marker */
export interface AgentOrGuestItem {
  id: string;
  name: string;
  profileId: string | null;
  description?: string | null;
  type: 'agent' | 'guest';
  /** For guests, their tmux session ID */
  tmuxSessionId?: string;
}

/** Response shape for the atomic restart endpoint */
export interface RestartAgentResponse {
  session: SessionDto;
  terminateStatus: 'success' | 'not_found' | 'error';
  terminateWarning?: string;
}

const RestartAgentSchema = z.object({
  projectId: z.string().min(1, 'projectId is required'),
});

const CreateAgentSchema = z.object({
  projectId: z.string(),
  profileId: z.string(),
  name: z.string().min(1),
  description: z.string().nullable().optional(),
});

const UpdateAgentSchema = z.object({
  name: z.string().min(1).optional(),
  profileId: z.string().optional(),
  description: z.string().nullable().optional(),
});

@Controller('api/agents')
export class AgentsController {
  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    @Inject(forwardRef(() => SessionsService)) private readonly sessionsService: SessionsService,
    @Inject(forwardRef(() => SessionCoordinatorService))
    private readonly sessionCoordinator: SessionCoordinatorService,
  ) {}

  @Get()
  async listAgents(
    @Query('projectId') projectId: string,
    @Query('includeGuests') includeGuests?: string,
  ) {
    logger.info({ projectId, includeGuests }, 'GET /api/agents');
    if (!projectId) {
      throw new BadRequestException('projectId query parameter required');
    }

    const agentsResult = await this.storage.listAgents(projectId);

    // If includeGuests is not 'true', return just agents (backward compatible)
    if (includeGuests !== 'true') {
      return agentsResult;
    }

    // Fetch guests and combine with agents
    const guests = await this.storage.listGuests(projectId);

    const agentItems: AgentOrGuestItem[] = agentsResult.items.map((agent) => ({
      id: agent.id,
      name: agent.name,
      profileId: agent.profileId,
      description: agent.description,
      type: 'agent' as const,
    }));

    const guestItems: AgentOrGuestItem[] = guests.map((guest) => ({
      id: guest.id,
      name: guest.name,
      profileId: null,
      description: null,
      type: 'guest' as const,
      tmuxSessionId: guest.tmuxSessionId,
    }));

    return {
      items: [...agentItems, ...guestItems],
      total: agentsResult.total + guests.length,
      limit: agentsResult.limit,
      offset: agentsResult.offset,
    };
  }

  @Get(':id')
  async getAgent(@Param('id') id: string): Promise<AgentWithProvider> {
    logger.info({ id }, 'GET /api/agents/:id');
    const agent = await this.storage.getAgent(id);

    // Enrich with provider information to eliminate agent → profile → provider fetch chain
    try {
      const profile = await this.storage.getAgentProfile(agent.profileId);
      const provider = await this.storage.getProvider(profile.providerId);
      return {
        ...agent,
        providerId: provider.id,
        providerName: provider.name,
      };
    } catch (error) {
      // If profile or provider lookup fails, return agent without provider info
      // This maintains backward compatibility
      logger.warn({ id, error }, 'Failed to enrich agent with provider info');
      return agent;
    }
  }

  @Post()
  async createAgent(@Body() body: unknown): Promise<Agent> {
    logger.info('POST /api/agents');
    const data = CreateAgentSchema.parse(body) as CreateAgent;
    return this.storage.createAgent(data);
  }

  @Put(':id')
  async updateAgent(@Param('id') id: string, @Body() body: unknown): Promise<Agent> {
    logger.info({ id }, 'PUT /api/agents/:id');
    const data = UpdateAgentSchema.parse(body) as UpdateAgent;
    return this.storage.updateAgent(id, data);
  }

  @Patch(':id')
  async patchAgent(@Param('id') id: string, @Body() body: unknown): Promise<Agent> {
    logger.info({ id }, 'PATCH /api/agents/:id');
    const data = UpdateAgentSchema.parse(body) as UpdateAgent;
    return this.storage.updateAgent(id, data);
  }

  @Delete(':id')
  async deleteAgent(@Param('id') id: string): Promise<void> {
    logger.info({ id }, 'DELETE /api/agents/:id');
    await this.storage.deleteAgent(id);
  }

  /**
   * Atomically restart an agent session.
   * Terminates any existing session and launches a new one within a per-agent lock.
   * This prevents race conditions and ensures atomic terminate+launch operations.
   */
  @Post(':id/restart')
  async restartAgent(
    @Param('id') agentId: string,
    @Body() body: unknown,
  ): Promise<RestartAgentResponse> {
    logger.info({ agentId }, 'POST /api/agents/:id/restart');

    // Validate request body
    const parseResult = RestartAgentSchema.safeParse(body);
    if (!parseResult.success) {
      throw new BadRequestException(parseResult.error.errors.map((e) => e.message).join(', '));
    }
    const { projectId } = parseResult.data;

    // Verify agent exists and belongs to the project
    const agent = await this.storage.getAgent(agentId);
    if (agent.projectId !== projectId) {
      throw new BadRequestException(`Agent ${agentId} does not belong to project ${projectId}`);
    }

    // Use agent lock to ensure atomicity (concurrent restarts for same agent are serialized)
    const result = await this.sessionCoordinator.withAgentLock(agentId, async () => {
      let terminateStatus: 'success' | 'not_found' | 'error' = 'not_found';
      let terminateWarning: string | undefined;

      // Find and terminate existing session for this agent
      const activeSessions = await this.sessionsService.listActiveSessions(projectId);
      const existingSession = activeSessions.find((s) => s.agentId === agentId);

      if (existingSession) {
        try {
          logger.info(
            { sessionId: existingSession.id, agentId },
            'Terminating existing session before restart',
          );
          await this.sessionsService.terminateSession(existingSession.id);
          terminateStatus = 'success';
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.warn(
            { sessionId: existingSession.id, error: message },
            'Failed to terminate session',
          );
          terminateStatus = 'error';
          terminateWarning = `Previous session may still be running: ${message}`;
        }
      }

      // Launch new independent session (no epicId)
      logger.info({ agentId, projectId }, 'Launching new session');
      const newSession = await this.sessionsService.launchSession({
        agentId,
        projectId,
      });

      // Convert SessionDetailDto to SessionDto (strip nested objects)
      const sessionDto: SessionDto = {
        id: newSession.id,
        epicId: newSession.epicId,
        agentId: newSession.agentId,
        tmuxSessionId: newSession.tmuxSessionId,
        status: newSession.status,
        startedAt: newSession.startedAt,
        endedAt: newSession.endedAt,
        createdAt: newSession.createdAt,
        updatedAt: newSession.updatedAt,
      };

      return { session: sessionDto, terminateStatus, terminateWarning };
    });

    logger.info(
      { agentId, sessionId: result.session.id, terminateStatus: result.terminateStatus },
      'Agent restart completed',
    );

    return result;
  }
}
