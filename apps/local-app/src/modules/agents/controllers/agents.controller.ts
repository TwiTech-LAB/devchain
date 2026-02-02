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
  /** Resolved config details when providerConfigId is set */
  providerConfig?: {
    id: string;
    providerId: string;
    providerName: string;
    options: string | null;
    hasEnv: boolean;
  };
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
  /** Provider config ID for agents (Phase 4+) */
  providerConfigId?: string | null;
  /** Resolved provider config details for agents */
  providerConfig?: {
    id: string;
    name: string;
    providerId: string;
    providerName: string;
  } | null;
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
  projectId: z.string().min(1, 'projectId is required'),
  profileId: z.string().min(1, 'profileId is required'),
  name: z.string().min(1, 'name is required'),
  description: z.string().nullable().optional(),
  providerConfigId: z.string().min(1, 'providerConfigId is required'),
});

const UpdateAgentSchema = z.object({
  name: z.string().min(1).optional(),
  profileId: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  // providerConfigId can be updated but NOT set to null (DB column is NOT NULL)
  providerConfigId: z.string().min(1).optional(),
});

@Controller('api/agents')
export class AgentsController {
  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    @Inject(forwardRef(() => SessionsService)) private readonly sessionsService: SessionsService,
    @Inject(forwardRef(() => SessionCoordinatorService))
    private readonly sessionCoordinator: SessionCoordinatorService,
  ) {}

  /**
   * Validate that a provider config belongs to the specified profile.
   * @throws BadRequestException if config doesn't exist or belongs to a different profile
   */
  private async validateConfigOwnership(configId: string, profileId: string): Promise<void> {
    try {
      const config = await this.storage.getProfileProviderConfig(configId);
      if (config.profileId !== profileId) {
        throw new BadRequestException({
          message: 'Provider config does not belong to the selected profile',
          code: 'CONFIG_PROFILE_MISMATCH',
          configId,
          configProfileId: config.profileId,
          expectedProfileId: profileId,
        });
      }
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      // Config not found
      throw new BadRequestException({
        message: 'Provider config not found',
        code: 'CONFIG_NOT_FOUND',
        configId,
      });
    }
  }

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

    // Batch-load provider configs for all agents to avoid N+1 queries
    const configIds = agentsResult.items
      .map((a) => a.providerConfigId)
      .filter((id): id is string => id !== null && id !== undefined);

    const configs =
      configIds.length > 0 ? await this.storage.listProfileProviderConfigsByIds(configIds) : [];

    // Batch-load providers referenced by configs
    const providerIds = [...new Set(configs.map((c) => c.providerId))];
    const providers =
      providerIds.length > 0 ? await this.storage.listProvidersByIds(providerIds) : [];

    // Build lookup maps
    const configMap = new Map(configs.map((c) => [c.id, c]));
    const providerMap = new Map(providers.map((p) => [p.id, p]));

    const agentItems: AgentOrGuestItem[] = agentsResult.items.map((agent) => {
      const config = agent.providerConfigId ? configMap.get(agent.providerConfigId) : null;
      const provider = config ? providerMap.get(config.providerId) : null;

      return {
        id: agent.id,
        name: agent.name,
        profileId: agent.profileId,
        description: agent.description,
        type: 'agent' as const,
        providerConfigId: agent.providerConfigId,
        providerConfig:
          config && provider
            ? {
                id: config.id,
                name: config.name,
                providerId: config.providerId,
                providerName: provider.name,
              }
            : null,
      };
    });

    const guestItems: AgentOrGuestItem[] = guests.map((guest) => ({
      id: guest.id,
      name: guest.name,
      profileId: null,
      description: null,
      type: 'guest' as const,
      tmuxSessionId: guest.tmuxSessionId,
      providerConfigId: null,
      providerConfig: null,
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

    // Build enriched response
    const result: AgentWithProvider = { ...agent };

    // If agent has providerConfigId, resolve config details
    if (agent.providerConfigId) {
      try {
        const config = await this.storage.getProfileProviderConfig(agent.providerConfigId);
        const provider = await this.storage.getProvider(config.providerId);
        result.providerId = provider.id;
        result.providerName = provider.name;
        result.providerConfig = {
          id: config.id,
          providerId: config.providerId,
          providerName: provider.name,
          options: config.options,
          hasEnv: config.env !== null && Object.keys(config.env).length > 0,
        };
      } catch (error) {
        logger.warn(
          { id, providerConfigId: agent.providerConfigId, error },
          'Failed to resolve provider config',
        );
      }
    }

    // Note: Legacy fallback to profile.providerId removed in Phase 4
    // Provider info is now always resolved via providerConfig

    return result;
  }

  @Post()
  async createAgent(@Body() body: unknown): Promise<Agent> {
    logger.info('POST /api/agents');
    const data = CreateAgentSchema.parse(body);

    // Validate providerConfigId belongs to the selected profile
    await this.validateConfigOwnership(data.providerConfigId, data.profileId);

    return this.storage.createAgent(data as CreateAgent);
  }

  @Put(':id')
  async updateAgent(@Param('id') id: string, @Body() body: unknown): Promise<Agent> {
    logger.info({ id }, 'PUT /api/agents/:id');
    const data = UpdateAgentSchema.parse(body);

    // Validate providerConfigId belongs to the correct profile (if being updated)
    if (data.providerConfigId !== undefined) {
      // Determine which profile to validate against
      const profileId = data.profileId ?? (await this.storage.getAgent(id)).profileId;
      await this.validateConfigOwnership(data.providerConfigId, profileId);
    }

    return this.storage.updateAgent(id, data as UpdateAgent);
  }

  @Patch(':id')
  async patchAgent(@Param('id') id: string, @Body() body: unknown): Promise<Agent> {
    logger.info({ id }, 'PATCH /api/agents/:id');
    const data = UpdateAgentSchema.parse(body);

    // Validate providerConfigId belongs to the correct profile (if being updated)
    if (data.providerConfigId !== undefined) {
      const profileId = data.profileId ?? (await this.storage.getAgent(id)).profileId;
      await this.validateConfigOwnership(data.providerConfigId, profileId);
    }

    return this.storage.updateAgent(id, data as UpdateAgent);
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

    // Note: launchSession() has internal withAgentLock for serialization.
    // No outer lock needed here - it would cause deadlock (nested non-reentrant locks).
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
    // launchSession() is idempotent and handles its own locking internally
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

    const result = { session: sessionDto, terminateStatus, terminateWarning };

    logger.info(
      { agentId, sessionId: result.session.id, terminateStatus: result.terminateStatus },
      'Agent restart completed',
    );

    return result;
  }
}
