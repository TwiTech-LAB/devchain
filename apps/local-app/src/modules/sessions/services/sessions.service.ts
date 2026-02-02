import { Injectable, Inject, NotFoundException, forwardRef } from '@nestjs/common';
import { ValidationError } from '../../../common/errors/error-types';
import { ModuleRef } from '@nestjs/core';
import { randomUUID } from 'crypto';
import { createLogger } from '../../../common/logging/logger';
import { TmuxService } from '../../terminal/services/tmux.service';
import { TerminalSendCoordinatorService } from '../../terminal/services/terminal-send-coordinator.service';
import { PtyService } from '../../terminal/services/pty.service';
import { PreflightService } from '../../core/services/preflight.service';
import { ProviderMcpEnsureService } from '../../core/services/provider-mcp-ensure.service';
import { STORAGE_SERVICE, StorageService } from '../../storage/interfaces/storage.interface';
import { SessionDto, SessionDetailDto, LaunchSessionDto } from '../dtos/sessions.dto';
import { DB_CONNECTION } from '../../storage/db/db.provider';
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import Database from 'better-sqlite3';
import { parseProfileOptions, ProfileOptionsError } from '../utils/profile-options';
import { buildSessionCommand, EnvBuilderError } from '../utils/env-builder';
import { buildInitialPromptContext, renderInitialPromptTemplate } from '../utils/template-renderer';
import { EventsService } from '../../events/services/events.service';
import { TerminalGateway } from '../../terminal/gateways/terminal.gateway';
import { SessionCoordinatorService } from './session-coordinator.service';

const logger = createLogger('SessionsService');

/**
 * Check if an error is a SQLite unique constraint violation.
 * better-sqlite3 throws { code: 'SQLITE_CONSTRAINT' | number } for constraint errors.
 */
function isUniqueConstraintError(error: unknown): error is { code: string; message: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'SQLITE_CONSTRAINT' ||
      error.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
      (typeof error.code === 'number' && error.code === 19))
  );
}

const MAX_INITIAL_PROMPT_LENGTH = 4000;
const MAX_INITIAL_PROMPT_LINES = 80;
const DEFAULT_INITIAL_PROMPT_TEMPLATE =
  'Session {session_id} started for agent {agent_name} on project {project_name} using profile {profile_name}.';

interface SessionRow {
  id: string;
  epic_id: string | null;
  agent_id: string | null;
  tmux_session_id: string | null;
  status: 'running' | 'stopped' | 'failed';
  started_at: string;
  ended_at: string | null;
  last_activity_at: string | null;
  activity_state: 'idle' | 'busy' | null;
  busy_since: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * SessionsService
 * Orchestrates session lifecycle: launch, monitor, terminate
 */
@Injectable()
export class SessionsService {
  private sqlite: Database.Database;
  private terminalGatewayRef?: TerminalGateway;
  private eventsServiceRef?: EventsService;

  constructor(
    @Inject(DB_CONNECTION) private readonly db: BetterSQLite3Database,
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    @Inject(forwardRef(() => TmuxService)) private readonly tmuxService: TmuxService,
    @Inject(forwardRef(() => TerminalSendCoordinatorService))
    private readonly sendCoordinator: TerminalSendCoordinatorService,
    @Inject(forwardRef(() => PtyService)) private readonly ptyService: PtyService,
    @Inject(forwardRef(() => PreflightService)) private readonly preflightService: PreflightService,
    @Inject(forwardRef(() => ProviderMcpEnsureService))
    private readonly mcpEnsureService: ProviderMcpEnsureService,
    private readonly sessionCoordinator: SessionCoordinatorService,
    private readonly moduleRef: ModuleRef,
  ) {
    // Extract raw sqlite instance
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.sqlite = (this.db as any).session?.client ?? this.db;
    logger.info('SessionsService initialized');
  }

  /**
   * Launch a new session for an epic
   *
   * This method is idempotent: if the agent already has an active session, it returns
   * that session instead of throwing an error. This enables safe retries and prevents
   * message loss when concurrent requests race to launch sessions.
   *
   * The entire operation is wrapped in withAgentLock() to serialize concurrent
   * session launches for the same agent, preventing TOCTOU race conditions where
   * multiple requests could pass the "no existing session" check and create duplicates.
   *
   * To force a new session (terminate existing first), use the agent restart endpoint
   * (POST /api/agents/:id/restart) or the restart_agent subscriber action instead.
   */
  async launchSession(data: LaunchSessionDto): Promise<SessionDetailDto> {
    const { epicId, agentId, projectId } = data;

    return this.sessionCoordinator.withAgentLock(agentId, async () => {
      logger.info({ epicId, agentId, projectId }, 'Launching session');

      // Fast pre-check: if agent already has an active session, return it (idempotent)
      const existingSession = this.getActiveSessionForAgent(agentId);
      if (existingSession) {
        // Validate tmux existence before returning the session
        // The DB-only check can return orphaned sessions where tmux is already gone
        const tmuxAlive = existingSession.tmuxSessionId
          ? await this.tmuxService.hasSession(existingSession.tmuxSessionId)
          : false;

        if (tmuxAlive) {
          // Tmux session is alive - return existing session
          logger.info(
            { agentId, existingSessionId: existingSession.id },
            'Agent already has active session with live tmux, returning existing session (idempotent)',
          );

          // Enrich SessionDto to SessionDetailDto by fetching related entities
          // Use agent.projectId (not input.projectId) to ensure consistency
          const agent = await this.storage.getAgent(agentId);
          const project = await this.storage.getProject(agent.projectId);
          const epic = existingSession.epicId
            ? await this.storage.getEpic(existingSession.epicId).catch(() => null)
            : null;

          return {
            ...existingSession,
            epic: epic
              ? {
                  id: epic.id,
                  title: epic.title,
                  projectId: epic.projectId,
                }
              : null,
            agent: {
              id: agent.id,
              name: agent.name,
              profileId: agent.profileId,
            },
            project: {
              id: project.id,
              name: project.name,
              rootPath: project.rootPath,
            },
          };
        }

        // Tmux session is gone - this is an orphaned DB session
        // Run targeted orphan cleanup: mark the orphaned session as stopped
        logger.warn(
          {
            agentId,
            orphanedSessionId: existingSession.id,
            tmuxSessionId: existingSession.tmuxSessionId,
          },
          'Found orphaned session (tmux gone), marking as stopped before continuing',
        );

        // Mark orphaned session as stopped
        this.sqlite
          .prepare(
            `
            UPDATE sessions
            SET status = 'stopped', ended_at = ?, updated_at = ?
            WHERE id = ?
          `,
          )
          .run(new Date().toISOString(), new Date().toISOString(), existingSession.id);

        // Fall through to create a new session
        logger.info({ agentId }, 'Orphaned session cleaned up, proceeding to create new session');
      }

      // Fetch required entities
      const agent = await this.storage.getAgent(agentId);
      const project = await this.storage.getProject(projectId);
      if (agent.projectId !== projectId) {
        throw new ValidationError(`Agent ${agentId} does not belong to project ${projectId}.`, {
          agentId,
          agentProjectId: agent.projectId,
          requestedProjectId: projectId,
        });
      }

      const epic = epicId ? await this.storage.getEpic(epicId) : null;

      // Fetch agent profile
      const profile = await this.storage.getAgentProfile(agent.profileId);

      // Resolve provider and options via provider config (if available) or fallback to profile
      let provider;
      let options: string | null;
      let envVars: Record<string, string> | null = null;

      if (agent.providerConfigId) {
        // Use provider config for provider resolution and env vars
        const config = await this.storage.getProfileProviderConfig(agent.providerConfigId);
        provider = await this.storage.getProvider(config.providerId);
        options = config.options;
        envVars = config.env;
        logger.info(
          { agentId, configId: config.id, providerId: provider.id },
          'Resolved provider via config',
        );
      } else {
        // Fallback: use first provider config for this profile
        // Note: profile.providerId removed in Phase 4, configs are the only source
        const configs = await this.storage.listProfileProviderConfigsByProfile(profile.id);

        if (configs.length > 0) {
          // Use the first config's options and env
          const firstConfig = configs[0];
          provider = await this.storage.getProvider(firstConfig.providerId);
          options = firstConfig.options;
          envVars = firstConfig.env;
          logger.info(
            { agentId, profileId: profile.id, configId: firstConfig.id, providerId: provider.id },
            'Resolved provider via first profile config (no providerConfigId set on agent)',
          );
        } else {
          // No configs - cannot launch
          throw new ValidationError(
            `Profile ${profile.id} has no provider configs - cannot launch session`,
          );
        }
      }

      // Run preflight checks
      let preflightResult = await this.preflightService.runChecks(project.rootPath);

      // Auto-configure MCP if not configured
      let providerCheck = preflightResult.providers?.find((p) => p.id === provider.id);
      if (providerCheck?.mcpStatus && providerCheck.mcpStatus !== 'pass') {
        logger.info(
          {
            providerId: provider.id,
            providerName: provider.name,
            mcpStatus: providerCheck.mcpStatus,
          },
          'MCP not configured, attempting auto-ensure',
        );

        // Attempt to auto-configure MCP
        const ensureResult = await this.mcpEnsureService.ensureMcp(provider, project.rootPath);

        if (ensureResult.success) {
          logger.info(
            { providerId: provider.id, action: ensureResult.action },
            'MCP auto-configured successfully',
          );

          // Re-run preflight to verify
          preflightResult = await this.preflightService.runChecks(project.rootPath);
          providerCheck = preflightResult.providers?.find((p) => p.id === provider.id);
        } else {
          logger.warn(
            { providerId: provider.id, message: ensureResult.message },
            'MCP auto-ensure failed',
          );
        }

        // If still not configured after auto-ensure attempt, throw error
        if (providerCheck?.mcpStatus && providerCheck.mcpStatus !== 'pass') {
          throw new ValidationError('Provider MCP is not configured', {
            code: 'MCP_NOT_CONFIGURED',
            providerId: provider.id,
            providerName: provider.name,
            mcpStatus: providerCheck.mcpStatus,
            mcpMessage: providerCheck.mcpMessage,
          });
        }
      }

      if (preflightResult.overall === 'fail') {
        const failedChecks = preflightResult.checks
          .filter((c) => c.status === 'fail')
          .map((c) => `${c.name}: ${c.message}`)
          .join('; ');

        throw new ValidationError('Preflight checks failed', {
          failedChecks,
          projectId,
        });
      }

      // Create session ID
      const sessionId = randomUUID();
      const now = new Date().toISOString();

      // Create project slug for tmux naming
      const projectSlug = project.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '');

      // Create tmux session
      const epicSegment = epicId ?? 'independent';
      const tmuxSessionName = this.tmuxService.createSessionName(
        projectSlug,
        epicSegment,
        agentId,
        sessionId,
      );

      await this.tmuxService.createSession(tmuxSessionName, project.rootPath);

      // Disable tmux alternate-screen so TUI apps (e.g., Claude) write into
      // the primary buffer and scrollback, which improves history seeding.
      await this.tmuxService.setAlternateScreenOff(tmuxSessionName);

      // Start health check for tmux session
      this.tmuxService.startHealthCheck(tmuxSessionName, sessionId);

      // Launch agent command based on provider
      if (!provider.binPath) {
        throw new ValidationError(
          `Provider ${provider.name} is missing a binary path. Set the path before launching sessions.`,
          {
            providerId: provider.id,
            providerName: provider.name,
          },
        );
      }

      let optionArgs: string[] = [];
      try {
        optionArgs = parseProfileOptions(options);
      } catch (error) {
        if (error instanceof ProfileOptionsError) {
          throw new ValidationError(error.message, {
            profileId: profile.id,
            profileName: profile.name,
          });
        }
        throw error;
      }

      // Build command with env vars (if any) using env command prefix
      let commandArgs: string[];
      try {
        commandArgs = buildSessionCommand(envVars, provider.binPath, optionArgs);
      } catch (error) {
        if (error instanceof EnvBuilderError) {
          throw new ValidationError(error.message, {
            agentId,
            providerConfigId: agent.providerConfigId,
          });
        }
        throw error;
      }

      logger.info(
        { sessionId, provider: provider.name, commandArgs, hasEnvVars: !!envVars },
        'Launching agent with provider binary',
      );
      await this.tmuxService.sendCommandArgs(tmuxSessionName, commandArgs);

      // Wait for agent to initialize (7s to allow slower CLIs like Gemini to start)
      await new Promise((resolve) => setTimeout(resolve, 7000));

      // Insert session into database
      // If unique constraint is hit, cleanup tmux and return existing session
      try {
        this.sqlite
          .prepare(
            `
          INSERT INTO sessions (id, epic_id, agent_id, tmux_session_id, status, started_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
          )
          .run(sessionId, epicId ?? null, agentId, tmuxSessionName, 'running', now, now, now);

        logger.info({ sessionId, tmuxSessionName }, 'Session created in database');
      } catch (error: unknown) {
        if (isUniqueConstraintError(error)) {
          // Unique constraint violation: another session was inserted concurrently
          // Cleanup the orphaned tmux session and return the existing session
          logger.warn(
            { agentId, tmuxSessionName, error },
            'Unique constraint violation - cleaning up orphaned tmux session and returning existing session',
          );

          // Destroy the orphaned tmux session
          try {
            await this.tmuxService.destroySession(tmuxSessionName);
            logger.info({ tmuxSessionName }, 'Cleaned up orphaned tmux session');
          } catch (tmuxError) {
            logger.warn({ tmuxError, tmuxSessionName }, 'Failed to cleanup orphaned tmux session');
          }

          // Fetch and return the existing running session
          const existingSession = this.getActiveSessionForAgent(agentId);
          if (existingSession) {
            logger.info(
              { agentId, existingSessionId: existingSession.id },
              'Returning existing running session after constraint violation',
            );

            // Enrich SessionDto to SessionDetailDto
            const existingAgent = await this.storage.getAgent(agentId);
            const existingProject = await this.storage.getProject(projectId);
            const existingEpic = existingSession.epicId
              ? await this.storage.getEpic(existingSession.epicId).catch(() => null)
              : null;

            return {
              ...existingSession,
              epic: existingEpic
                ? {
                    id: existingEpic.id,
                    title: existingEpic.title,
                    projectId: existingEpic.projectId,
                  }
                : null,
              agent: {
                id: existingAgent.id,
                name: existingAgent.name,
                profileId: existingAgent.profileId,
              },
              project: {
                id: existingProject.id,
                name: existingProject.name,
                rootPath: existingProject.rootPath,
              },
            };
          }

          // If no existing session found (shouldn't happen), re-throw
          throw error;
        }
        throw error;
      }

      // Render and inject initial.md
      await this.renderAndPasteInitialPrompt({
        sessionId,
        tmuxSessionName,
        agentId,
        project: { id: project.id, name: project.name },
        agent,
        epic,
        profile,
        provider,
      });

      // Start PTY streaming for terminal output
      await this.ptyService.startStreaming(sessionId, tmuxSessionName);

      // Broadcast session.started event
      await this.getEventsService().publish('session.started', {
        sessionId,
        epicId: epicId ?? null,
        agentId,
        tmuxSessionName,
      });

      // Broadcast presence update via WebSocket
      try {
        this.getTerminalGateway().broadcastEvent(`agent/${agentId}`, 'presence', {
          online: true,
          sessionId,
          agentId,
        });
      } catch (error) {
        logger.warn({ error, agentId, sessionId }, 'Failed to broadcast presence update');
      }

      // Return session detail
      return {
        id: sessionId,
        epicId: epicId ?? null,
        agentId,
        tmuxSessionId: tmuxSessionName,
        status: 'running',
        startedAt: now,
        endedAt: null,
        createdAt: now,
        updatedAt: now,
        epic: epic
          ? {
              id: epic.id,
              title: epic.title,
              projectId: epic.projectId,
            }
          : null,
        agent: {
          id: agent.id,
          name: agent.name,
          profileId: agent.profileId,
        },
        project: {
          id: project.id,
          name: project.name,
          rootPath: project.rootPath,
        },
      };
    });
  }

  /**
   * Terminate a session
   */
  async terminateSession(sessionId: string): Promise<void> {
    logger.info({ sessionId }, 'Terminating session');

    // Get session from database
    const session = this.getSession(sessionId);
    if (!session) {
      logger.warn({ sessionId }, 'Session not found, treating as already terminated');
      return;
    }

    if (session.status !== 'running') {
      logger.info(
        { sessionId, status: session.status },
        'Session already stopped, treating as success',
      );
      return;
    }

    // Stop PTY streaming
    this.ptyService.stopStreaming(sessionId);

    // Kill tmux session if it exists
    if (session.tmuxSessionId) {
      const sessionExists = await this.tmuxService.hasSession(session.tmuxSessionId);
      if (sessionExists) {
        await this.tmuxService.destroySession(session.tmuxSessionId);
      } else {
        logger.warn(
          { sessionId, tmuxSessionId: session.tmuxSessionId },
          'Tmux session already gone, cleaning up database record',
        );
      }
    }

    // Update session status
    const now = new Date().toISOString();
    this.sqlite
      .prepare(
        `
      UPDATE sessions
      SET status = ?, ended_at = ?, updated_at = ?
      WHERE id = ?
    `,
      )
      .run('stopped', now, now, sessionId);

    logger.info({ sessionId }, 'Session terminated');

    // Broadcast session.stopped event
    await this.getEventsService().publish('session.stopped', { sessionId });

    // Broadcast presence update via WebSocket (agent offline)
    if (session.agentId) {
      try {
        this.getTerminalGateway().broadcastEvent(`agent/${session.agentId}`, 'presence', {
          online: false,
          sessionId: null,
          agentId: session.agentId,
        });
      } catch (error) {
        logger.warn(
          { error, agentId: session.agentId, sessionId },
          'Failed to broadcast presence update',
        );
      }
    }
  }

  /**
   * Get session by ID
   */
  getSession(sessionId: string): SessionDto | null {
    const row = this.sqlite
      .prepare(
        `
      SELECT id, epic_id, agent_id, tmux_session_id, status, started_at, ended_at, last_activity_at, activity_state, busy_since, created_at, updated_at
      FROM sessions
      WHERE id = ?
    `,
      )
      .get(sessionId) as SessionRow | undefined;

    if (!row) {
      logger.debug({ sessionId }, 'Session not found in database');
      return null;
    }

    return {
      id: row.id,
      epicId: row.epic_id,
      agentId: row.agent_id,
      tmuxSessionId: row.tmux_session_id,
      status: row.status,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      lastActivityAt: row.last_activity_at ?? null,
      activityState: row.activity_state ?? null,
      busySince: row.busy_since ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * List all active sessions
   * Also performs cleanup of orphaned sessions (sessions in DB but tmux session gone)
   */
  async listActiveSessions(
    projectId?: string,
    allowedAgentIds?: Set<string>,
  ): Promise<SessionDto[]> {
    const rows = this.sqlite
      .prepare(
        `
      SELECT id, epic_id, agent_id, tmux_session_id, status, started_at, ended_at, last_activity_at, activity_state, busy_since, created_at, updated_at
      FROM sessions
      WHERE status = 'running'
      ORDER BY started_at DESC
    `,
      )
      .all() as SessionRow[];

    // Check for orphaned sessions and clean them up
    const now = new Date().toISOString();
    for (const row of rows) {
      if (row.tmux_session_id) {
        const exists = await this.tmuxService.hasSession(row.tmux_session_id);
        if (!exists) {
          logger.warn(
            { sessionId: row.id, tmuxSessionId: row.tmux_session_id },
            'Detected orphaned session, marking as stopped',
          );

          // Mark as stopped in database
          this.sqlite
            .prepare(
              `
            UPDATE sessions
            SET status = ?, ended_at = ?, updated_at = ?
            WHERE id = ?
          `,
            )
            .run('stopped', now, now, row.id);

          // Update row status for return value
          row.status = 'stopped';
          row.ended_at = now;
        }
      }
    }

    // Filter out sessions that were just marked as stopped
    let sessions = rows
      .filter((row) => row.status === 'running')
      .map((row) => ({
        id: row.id,
        epicId: row.epic_id,
        agentId: row.agent_id,
        tmuxSessionId: row.tmux_session_id,
        status: row.status,
        startedAt: row.started_at,
        endedAt: row.ended_at,
        lastActivityAt: row.last_activity_at ?? null,
        activityState: row.activity_state ?? null,
        busySince: row.busy_since ?? null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));

    if (projectId) {
      let agentSet = allowedAgentIds;
      if (!agentSet) {
        const agents = await this.storage.listAgents(projectId);
        agentSet = new Set(agents.items.map((agent) => agent.id));
      }
      sessions = sessions.filter((session) => session.agentId && agentSet!.has(session.agentId));
    }

    return sessions;
  }

  /**
   * Get active session for a specific agent (fast DB-only check, no tmux validation)
   * Returns the session if found, null otherwise
   */
  getActiveSessionForAgent(agentId: string): SessionDto | null {
    const row = this.sqlite
      .prepare(
        `
        SELECT id, epic_id, agent_id, tmux_session_id, status,
               started_at, ended_at, last_activity_at, activity_state,
               busy_since, created_at, updated_at
        FROM sessions
        WHERE status = 'running' AND agent_id = ?
        ORDER BY started_at DESC
        LIMIT 1
      `,
      )
      .get(agentId) as SessionRow | undefined;

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      epicId: row.epic_id,
      agentId: row.agent_id,
      tmuxSessionId: row.tmux_session_id,
      status: row.status,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      lastActivityAt: row.last_activity_at ?? null,
      activityState: row.activity_state ?? null,
      busySince: row.busy_since ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Fast check for active sessions in a project (no tmux validation)
   * Used by import guard to quickly detect if sessions need to be stopped
   */
  getActiveSessionsForProject(projectId: string): SessionDto[] {
    const rows = this.sqlite
      .prepare(
        `
        SELECT s.id, s.epic_id, s.agent_id, s.tmux_session_id, s.status,
               s.started_at, s.ended_at, s.last_activity_at, s.activity_state,
               s.busy_since, s.created_at, s.updated_at
        FROM sessions s
        JOIN agents a ON s.agent_id = a.id
        WHERE s.status = 'running' AND a.project_id = ?
        ORDER BY s.started_at DESC
      `,
      )
      .all(projectId) as SessionRow[];

    return rows.map((row) => ({
      id: row.id,
      epicId: row.epic_id,
      agentId: row.agent_id,
      tmuxSessionId: row.tmux_session_id,
      status: row.status,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      lastActivityAt: row.last_activity_at ?? null,
      activityState: row.activity_state ?? null,
      busySince: row.busy_since ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  /**
   * Get agent presence: map agentId to session info
   * Returns map of agentId → { online: boolean, sessionId?: string }
   */
  async getAgentPresence(projectId?: string): Promise<
    Map<
      string,
      {
        online: boolean;
        sessionId?: string;
        activityState?: 'idle' | 'busy' | null;
        lastActivityAt?: string | null;
        busySince?: string | null;
        currentActivityTitle?: string | null;
      }
    >
  > {
    let allowedAgentIds: Set<string> | undefined;
    if (projectId) {
      const agents = await this.storage.listAgents(projectId);
      allowedAgentIds = new Set(agents.items.map((agent) => agent.id));
    }

    const activeSessions = await this.listActiveSessions(projectId, allowedAgentIds);
    const presenceMap = new Map<
      string,
      {
        online: boolean;
        sessionId?: string;
        activityState?: 'idle' | 'busy' | null;
        lastActivityAt?: string | null;
        busySince?: string | null;
        currentActivityTitle?: string | null;
      }
    >();

    for (const session of activeSessions) {
      if (session.agentId) {
        presenceMap.set(session.agentId, {
          online: true,
          sessionId: session.id,
          activityState: session.activityState ?? null,
          lastActivityAt: session.lastActivityAt ?? null,
          busySince: session.busySince ?? null,
          currentActivityTitle: this.getCurrentActivityTitle(session.agentId, projectId),
        });
      }
    }

    if (allowedAgentIds) {
      for (const agentId of allowedAgentIds) {
        if (!presenceMap.has(agentId)) {
          presenceMap.set(agentId, { online: false });
        }
      }
    }

    return presenceMap;
  }

  private getCurrentActivityTitle(agentId: string, projectId?: string): string | null {
    const row = projectId
      ? (this.sqlite
          .prepare(
            `SELECT ca.title
             FROM chat_activities ca
             JOIN chat_threads ct ON ct.id = ca.thread_id
             WHERE ca.agent_id = ? AND ca.status = 'running' AND ct.project_id = ?
             ORDER BY ca.started_at DESC
             LIMIT 1`,
          )
          .get(agentId, projectId) as { title: string } | undefined)
      : (this.sqlite
          .prepare(
            `SELECT title FROM chat_activities WHERE agent_id = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1`,
          )
          .get(agentId) as { title: string } | undefined);
    return row?.title ?? null;
  }

  /**
   * Inject text into an active session's tmux pane and submit it.
   * Uses bracketed paste + Enter to improve reliability across provider TUIs.
   * Throttles per agent to avoid overlapping pastes.
   */
  async injectTextIntoSession(sessionId: string, text: string): Promise<void> {
    const session = this.getSession(sessionId);
    if (!session) {
      throw new NotFoundException(`Session not found: ${sessionId}`);
    }

    if (session.status !== 'running') {
      throw new ValidationError(`Session is not running: ${sessionId}`, {
        sessionId,
        status: session.status,
      });
    }

    if (!session.tmuxSessionId) {
      throw new ValidationError(`Session has no tmux session: ${sessionId}`, {
        sessionId,
      });
    }

    logger.info({ sessionId, tmuxSessionId: session.tmuxSessionId }, 'Injecting text into session');

    // Throttle consecutive sends per agent to avoid race conditions
    if (session.agentId) {
      await this.sendCoordinator.ensureAgentGap(session.agentId, 1000);
    }

    // Use unified helper to paste and submit
    await this.tmuxService.pasteAndSubmit(session.tmuxSessionId, text, {
      bracketed: true,
      submitKeys: ['Enter'],
      delayMs: 250,
    });
  }

  /**
   * Render and paste the initial session prompt into tmux
   */
  private async renderAndPasteInitialPrompt(params: {
    sessionId: string;
    tmuxSessionName: string;
    agentId: string;
    project: { id: string; name: string };
    agent: { name: string };
    epic: { title: string | null } | null;
    profile: { name: string };
    provider: { name: string };
  }): Promise<void> {
    const { sessionId, tmuxSessionName, agentId, project, agent, epic, profile, provider } = params;

    const context = buildInitialPromptContext({
      agent,
      project,
      epic,
      profile,
      provider,
      sessionId,
    });

    const defaultRendered = this.normalizeInitialPromptContent(
      renderInitialPromptTemplate(DEFAULT_INITIAL_PROMPT_TEMPLATE, context),
    );

    let promptTitle: string | undefined;
    let rendered = defaultRendered;

    // Try loading via storage API first
    let initialPrompt: { id: string; title: string; content: string } | null = null;
    try {
      const viaStorage = await this.storage.getInitialSessionPrompt(project.id);
      if (viaStorage) {
        initialPrompt = {
          id: viaStorage.id,
          title: viaStorage.title,
          content: viaStorage.content,
        };
        logger.debug(
          { sessionId, promptId: viaStorage.id, source: 'storage.getInitialSessionPrompt' },
          'Resolved initial session prompt via storage',
        );
      }
    } catch (error) {
      logger.warn(
        { error },
        'Storage getInitialSessionPrompt failed; will try raw settings fallback',
      );
    }

    // No fallback: rely on StorageService implementation. If null, default template is used.
    if (!initialPrompt) {
      logger.debug(
        { sessionId, source: 'storage.getInitialSessionPrompt' },
        'No initial session prompt resolved via storage',
      );
    }

    if (initialPrompt?.content) {
      promptTitle = initialPrompt.title;
      const candidate = this.normalizeInitialPromptContent(
        renderInitialPromptTemplate(initialPrompt.content, context),
      );
      if (candidate) {
        rendered = candidate;
      } else {
        logger.warn(
          { sessionId, promptId: initialPrompt.id },
          'Initial session prompt rendered to empty content; using default template',
        );
      }
    }

    if (!this.isInitialPromptWithinLimits(rendered)) {
      logger.warn(
        {
          sessionId,
          length: rendered.length,
          lines: this.countInitialPromptLines(rendered),
        },
        'Initial session prompt exceeded limits; falling back to default template',
      );
      rendered = defaultRendered;
      promptTitle = undefined;
    }

    if (!promptTitle) {
      logger.debug(
        { sessionId, source: 'default_template' },
        'Using default initial session prompt',
      );
    }

    // Unify injection approach for all providers: bracketed paste + brief delay + Enter
    // Throttle consecutive sends per agent to avoid race conditions in provider TUIs
    await this.sendCoordinator.ensureAgentGap(agentId, 1000);
    await this.tmuxService.pasteAndSubmit(tmuxSessionName, rendered, {
      bracketed: true,
      submitKeys: ['Enter'],
      delayMs: 250,
    });
    logger.debug(
      { sessionId, provider: provider.name, submitKeys: ['Enter'], bracketedPaste: true },
      'Submitted initial prompt',
    );
    logger.info({ sessionId, promptTitle }, 'Initial session prompt pasted');
  }

  // Fallback helpers removed to ensure we rely on StorageService only.

  private normalizeInitialPromptContent(content: string): string {
    if (!content) {
      return '';
    }
    return content.replace(/\r\n/g, '\n').trimEnd();
  }

  private countInitialPromptLines(content: string): number {
    if (!content) {
      return 0;
    }
    return content.split('\n').length;
  }

  private isInitialPromptWithinLimits(content: string): boolean {
    return (
      content.length <= MAX_INITIAL_PROMPT_LENGTH &&
      this.countInitialPromptLines(content) <= MAX_INITIAL_PROMPT_LINES
    );
  }

  private getTerminalGateway(): TerminalGateway {
    if (!this.terminalGatewayRef) {
      this.terminalGatewayRef = this.moduleRef.get(TerminalGateway, { strict: false });
      if (!this.terminalGatewayRef) {
        throw new Error('TerminalGateway is not available in the current module context');
      }
    }
    return this.terminalGatewayRef;
  }

  private getEventsService(): EventsService {
    if (!this.eventsServiceRef) {
      this.eventsServiceRef = this.moduleRef.get(EventsService, { strict: false });
      if (!this.eventsServiceRef) {
        throw new Error('EventsService is not available in the current module context');
      }
    }
    return this.eventsServiceRef;
  }
}
