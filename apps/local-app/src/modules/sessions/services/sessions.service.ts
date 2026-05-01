import {
  Injectable,
  Inject,
  NotFoundException,
  ForbiddenException,
  ConflictException,
  InternalServerErrorException,
  forwardRef,
} from '@nestjs/common';
import { stat } from 'fs/promises';
import { ValidationError } from '../../../common/errors/error-types';
import { deliverWithConfirmation } from '../../terminal/services/confirmed-delivery.helper';
import { ModuleRef } from '@nestjs/core';
import { randomUUID } from 'crypto';
import { createLogger } from '../../../common/logging/logger';
import { TmuxService } from '../../terminal/services/tmux.service';
import { TerminalSendCoordinatorService } from '../../terminal/services/terminal-send-coordinator.service';
import { PtyService } from '../../terminal/services/pty.service';
import { PreflightService } from '../../core/services/preflight.service';
import { ProviderMcpEnsureService } from '../../core/services/provider-mcp-ensure.service';
import { STORAGE_SERVICE, StorageService } from '../../storage/interfaces/storage.interface';
import {
  SessionDto,
  SessionDetailDto,
  LaunchSessionDto,
  SessionHistoryItemDto,
  SessionHistoryResponseDto,
} from '../dtos/sessions.dto';
import { DB_CONNECTION } from '../../storage/db/db.provider';
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import Database from 'better-sqlite3';
import {
  parseProfileOptions,
  ProfileOptionsError,
  injectModelOverride,
  rewriteModelTo1m,
  extractModelFromArgs,
  detectClaudeModelFamily,
} from '../utils/profile-options';
import { buildSessionCommand, EnvBuilderError } from '../utils/env-builder';
import { buildInitialPromptContext, renderInitialPromptTemplate } from '../utils/template-renderer';
import { checkClaudeAutoCompact } from '../utils/claude-config';
import { EventsService } from '../../events/services/events.service';
import { TerminalGateway } from '../../terminal/gateways/terminal.gateway';
import { SessionCoordinatorService } from './session-coordinator.service';
import { HooksConfigService } from '../../hooks/services/hooks-config.service';
import { ProviderAdapterFactory } from '../../providers/adapters/provider-adapter.factory';
import { LaunchInitialPromptBehavior } from '../../providers/adapters/provider-adapter.interface';
import { TeamsService } from '../../teams/services/teams.service';
import type {
  Team,
  Agent,
  Project,
  Epic,
  AgentProfile,
  Provider,
} from '../../storage/models/domain.models';
import type { PreflightResult } from '../../core/services/preflight.service';
import { getEnvConfig } from '../../../common/config/env.config';

// ---------------------------------------------------------------------------
// Launch helper types (used by launchSession + future restoreSession)
// ---------------------------------------------------------------------------

export interface LaunchTarget {
  agent: Agent;
  project: Project;
  epic: Epic | null;
  profile: AgentProfile;
  provider: Provider;
  options: string | null;
  configEnv: Record<string, string> | null;
}

export interface ComposedLaunchEnv {
  envVars: Record<string, string> | null;
  processedOptionArgs: string[];
}

const logger = createLogger('SessionsService');

/** Singleton boot identifier — generated once per server process lifetime. */
const BOOT_ID = randomUUID();

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
  transcript_path: string | null;
  created_at: string;
  updated_at: string;
}

interface HistorySessionRow {
  id: string;
  provider_session_id: string | null;
  provider_name_at_launch: string | null;
  status: 'stopped' | 'failed';
  started_at: string;
  ended_at: string | null;
  last_activity_at: string | null;
  size_bytes: number | null;
  transcript_path: string | null;
}

interface RestoreSourceRow {
  id: string;
  epic_id: string | null;
  agent_id: string;
  tmux_session_id: string | null;
  status: string;
  started_at: string;
  ended_at: string | null;
  transcript_path: string | null;
  provider_session_id: string | null;
  provider_name_at_launch: string | null;
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
    private readonly hooksConfigService: HooksConfigService,
    private readonly providerAdapterFactory: ProviderAdapterFactory,
    private readonly moduleRef: ModuleRef,
  ) {
    // Extract raw sqlite instance
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.sqlite = (this.db as any).session?.client ?? this.db;
    logger.info('SessionsService initialized');
  }

  // ---------------------------------------------------------------------------
  // Launch helpers (composable by both launchSession and future restoreSession)
  // ---------------------------------------------------------------------------

  async resolveLaunchTarget(params: {
    agentId: string;
    projectId: string;
    epicId?: string | null;
  }): Promise<LaunchTarget> {
    const { agentId, projectId, epicId } = params;

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
    const profile = await this.storage.getAgentProfile(agent.profileId);

    let provider: Provider;
    let options: string | null;
    let configEnv: Record<string, string> | null = null;

    if (agent.providerConfigId) {
      const config = await this.storage.getProfileProviderConfig(agent.providerConfigId);
      provider = await this.storage.getProvider(config.providerId);
      options = config.options;
      configEnv = config.env;
      logger.info(
        { agentId, configId: config.id, providerId: provider.id },
        'Resolved provider via config',
      );
    } else {
      const configs = await this.storage.listProfileProviderConfigsByProfile(profile.id);

      if (configs.length > 0) {
        const firstConfig = configs[0];
        provider = await this.storage.getProvider(firstConfig.providerId);
        options = firstConfig.options;
        configEnv = firstConfig.env;
        logger.info(
          { agentId, profileId: profile.id, configId: firstConfig.id, providerId: provider.id },
          'Resolved provider via first profile config (no providerConfigId set on agent)',
        );
      } else {
        throw new ValidationError(
          `Profile ${profile.id} has no provider configs - cannot launch session`,
        );
      }
    }

    return { agent, project, epic, profile, provider, options, configEnv };
  }

  verifyProviderBinary(provider: Pick<Provider, 'id' | 'name' | 'binPath'>): void {
    if (!provider.binPath) {
      throw new ValidationError(
        `Provider ${provider.name} is missing a binary path. Set the path before launching sessions.`,
        {
          code: 'PROVIDER_BINARY_NOT_FOUND',
          providerId: provider.id,
          providerName: provider.name,
        },
      );
    }
  }

  composeLaunchEnv(params: {
    sessionId: string;
    tmuxSessionName: string;
    projectId: string;
    agentId: string;
    provider: Provider;
    configEnv: Record<string, string> | null;
    optionArgs: string[];
  }): ComposedLaunchEnv {
    const { sessionId, tmuxSessionName, projectId, agentId, provider, configEnv, optionArgs } =
      params;

    const providerEnv = provider.env ?? {};
    const mergedBaseEnv = { ...providerEnv, ...(configEnv ?? {}) };
    let envVars: Record<string, string> | null =
      Object.keys(mergedBaseEnv).length > 0 ? mergedBaseEnv : null;
    let processedOptionArgs = optionArgs;

    if (provider.name.toLowerCase() === 'claude') {
      const env = getEnvConfig();
      const devchainEnv: Record<string, string> = {
        DEVCHAIN_API_URL: `http://127.0.0.1:${env.PORT}`,
        DEVCHAIN_PROJECT_ID: projectId,
        DEVCHAIN_AGENT_ID: agentId,
        DEVCHAIN_SESSION_ID: sessionId,
        DEVCHAIN_TMUX_SESSION_NAME: tmuxSessionName,
      };

      if (provider.oneMillionContextEnabled) {
        processedOptionArgs = rewriteModelTo1m(processedOptionArgs);
      }

      const modelStr = extractModelFromArgs(processedOptionArgs);
      const family = modelStr ? detectClaudeModelFamily(modelStr) : null;

      if (
        provider.oneMillionContextEnabled &&
        family === 'opus' &&
        provider.autoCompactThreshold1m != null
      ) {
        devchainEnv.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = String(provider.autoCompactThreshold1m);
      } else if (provider.autoCompactThreshold != null) {
        devchainEnv.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = String(provider.autoCompactThreshold);
      }

      envVars = { ...devchainEnv, ...providerEnv, ...(configEnv ?? {}) };
      delete envVars.CLAUDE_CODE_DISABLE_1M_CONTEXT;
    }

    return { envVars, processedOptionArgs };
  }

  async ensureMcpConfig(
    provider: Pick<Provider, 'id' | 'name'>,
    projectRootPath: string,
  ): Promise<PreflightResult> {
    let preflightResult = await this.preflightService.runChecks(projectRootPath);
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

      const ensureResult = await this.mcpEnsureService.ensureMcp(
        provider as Provider,
        projectRootPath,
      );

      if (ensureResult.success) {
        logger.info(
          { providerId: provider.id, action: ensureResult.action },
          'MCP auto-configured successfully',
        );

        preflightResult = await this.preflightService.runChecks(projectRootPath);
        providerCheck = preflightResult.providers?.find((p) => p.id === provider.id);
      } else {
        logger.warn(
          { providerId: provider.id, message: ensureResult.message },
          'MCP auto-ensure failed',
        );
      }

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

    return preflightResult;
  }

  async setupHooksConfig(provider: Pick<Provider, 'name'>, projectRootPath: string): Promise<void> {
    if (provider.name.toLowerCase() !== 'claude') return;

    try {
      await this.hooksConfigService.ensureHooksConfig(projectRootPath);
      logger.info({ projectRootPath }, 'Hooks config ensured for Claude provider');
    } catch (error) {
      logger.warn({ error }, 'Failed to ensure hooks config (non-fatal)');
    }
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
    const { epicId, agentId, projectId, options: launchOptions } = data;
    const silent = launchOptions?.silent === true;

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

      // --- Helper 1: Resolve launch target (agent, project, epic, provider) ---
      const { agent, project, epic, profile, provider, options, configEnv } =
        await this.resolveLaunchTarget({ agentId, projectId, epicId });

      // Recommend enabling auto-compact for Claude when it's disabled (non-blocking).
      if (provider.name.toLowerCase() === 'claude') {
        const { autoCompactEnabled, configState } = await checkClaudeAutoCompact();
        if (!autoCompactEnabled && configState !== 'malformed') {
          this.getTerminalGateway().broadcastEvent('system', 'session_recommendation', {
            reason: 'claude_auto_compact_disabled',
            agentId,
            agentName: agent.name,
            providerId: provider.id,
            providerName: provider.name,
            silent,
            bootId: BOOT_ID,
          });
        }
      }

      // --- Helper 4: Ensure MCP config (preflight + auto-ensure) ---
      const preflightResult = await this.ensureMcpConfig(provider, project.rootPath);

      // --- Helper 5: Setup hooks config (Claude only, non-fatal) ---
      await this.setupHooksConfig(provider, project.rootPath);

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

      // --- Helper 2: Verify provider binary exists ---
      this.verifyProviderBinary(provider);

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

      if (agent.modelOverride) {
        optionArgs = injectModelOverride(optionArgs, agent.modelOverride);
      }

      // --- Helper 3: Compose launch env (DEVCHAIN_*, provider env, config env) ---
      const { envVars, processedOptionArgs } = this.composeLaunchEnv({
        sessionId,
        tmuxSessionName,
        projectId,
        agentId,
        provider,
        configEnv,
        optionArgs,
      });
      optionArgs = processedOptionArgs;

      // Resolve per-provider launch argv (mode: 'new' for initial session launch)
      let launchArgv = optionArgs;
      try {
        const launchAdapter = this.providerAdapterFactory.getAdapter(provider.name);
        launchArgv = launchAdapter.buildLaunchArgs({
          mode: 'new',
          profileOptionArgs: optionArgs,
        }).argv;
      } catch {
        // Unknown provider — fall back to raw profile option args
      }

      // Build command with env vars (if any) using env command prefix
      let commandArgs: string[];
      try {
        commandArgs = buildSessionCommand(envVars, provider.binPath!, launchArgv);
      } catch (error) {
        if (error instanceof EnvBuilderError) {
          throw new ValidationError(error.message, {
            agentId,
            providerConfigId: agent.providerConfigId,
          });
        }
        throw error;
      }

      // Insert session into database BEFORE starting CLI command.
      // This ensures the session row exists when hook events fire during startup,
      // preventing subscriber executor from skipping init/startup hook events
      // with 'session_error' due to missing session row.
      try {
        this.sqlite
          .prepare(
            `
          INSERT INTO sessions (id, epic_id, agent_id, tmux_session_id, status, started_at, provider_name_at_launch, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
          )
          .run(
            sessionId,
            epicId ?? null,
            agentId,
            tmuxSessionName,
            'running',
            now,
            provider.name.toLowerCase(),
            now,
            now,
          );

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

      logger.info(
        { sessionId, provider: provider.name, commandArgs, hasEnvVars: !!envVars },
        'Launching agent with provider binary',
      );

      try {
        await this.tmuxService.sendCommandArgs(tmuxSessionName, commandArgs);
      } catch (error) {
        // CLI launch failed — clean up the pre-inserted session row and tmux session
        this.sqlite.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
        logger.warn(
          { sessionId, error: String(error) },
          'CLI launch failed, cleaned up session row',
        );
        try {
          await this.tmuxService.destroySession(tmuxSessionName);
        } catch (tmuxError) {
          logger.warn(
            { tmuxError, tmuxSessionName },
            'Failed to cleanup tmux session after CLI launch failure',
          );
        }
        throw error;
      }

      const launchTimestamp = Date.now();
      const { ready, elapsedMs } = await this.tmuxService.waitForOutput(tmuxSessionName, {
        pollIntervalMs: 500,
        timeoutMs: 30_000,
        settleMs: 1_000,
      });
      if (!ready) {
        logger.warn(
          { sessionId, tmuxSessionName, elapsedMs },
          'CLI output detection timed out, proceeding anyway',
        );
      }

      // Ensure a minimum delay after CLI launch so the provider fully initialises
      // (loads credentials, renders banner, enters raw/input-ready mode).
      const MIN_LAUNCH_DELAY_MS = 7_000;
      const elapsed = Date.now() - launchTimestamp;
      if (elapsed < MIN_LAUNCH_DELAY_MS) {
        const remaining = MIN_LAUNCH_DELAY_MS - elapsed;
        logger.debug(
          { sessionId, elapsed, remaining },
          'Waiting for minimum launch delay before initial prompt paste',
        );
        await new Promise((resolve) => setTimeout(resolve, remaining));
      }

      // Resolve provider adapter for launch handshake metadata
      let launchHandshake: LaunchInitialPromptBehavior | undefined;
      try {
        const adapter = this.providerAdapterFactory.getAdapter(provider.name);
        launchHandshake = adapter.launchInitialPromptBehavior;
        logger.debug(
          {
            sessionId,
            providerName: provider.name,
            hasHandshake: !!launchHandshake,
            preKeys: launchHandshake?.preKeys,
            preDelayMs: launchHandshake?.preDelayMs,
          },
          'Resolved provider launch handshake metadata',
        );
      } catch (adapterError) {
        logger.debug(
          { sessionId, providerName: provider.name, error: String(adapterError) },
          'No adapter found for provider, skipping launch handshake',
        );
      }

      // Render and inject initial.md (non-fatal — session is already running)
      try {
        await this.renderAndPasteInitialPrompt({
          sessionId,
          tmuxSessionName,
          agentId,
          project: { id: project.id, name: project.name },
          agent,
          epic,
          profile,
          provider,
          launchHandshake,
        });
      } catch (promptError) {
        logger.warn(
          { sessionId, error: String(promptError) },
          'Initial prompt submit failed, session continues',
        );
      }

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
        transcriptPath: null,
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
   * Restore a previously stopped/failed session in-place.
   * Reuses the original session id so DEVCHAIN_SESSION_ID stays stable.
   */
  async restoreSession(sessionId: string, projectId: string): Promise<SessionDetailDto> {
    // Step 1: Fetch source row (outside lock — for agentId to acquire the right lock)
    const source = this.sqlite
      .prepare(
        `SELECT id, epic_id, agent_id, tmux_session_id, status, started_at, ended_at,
                transcript_path, provider_session_id, provider_name_at_launch, created_at, updated_at
         FROM sessions WHERE id = ?`,
      )
      .get(sessionId) as RestoreSourceRow | undefined;

    if (!source) {
      throw new NotFoundException('Session not found');
    }

    // Step 2: Authorize — agent must belong to the requested project
    const sourceAgent = await this.storage.getAgent(source.agent_id);
    if (sourceAgent.projectId !== projectId) {
      throw new ForbiddenException('PROJECT_MISMATCH');
    }

    // Step 3: Validate restorable state
    if (source.status !== 'stopped' && source.status !== 'failed') {
      throw new ConflictException({
        message: 'Session is not in a restorable state',
        code: 'INVALID_SESSION_STATE',
      });
    }
    if (!source.provider_session_id) {
      throw new ConflictException({
        message: 'Session has no provider session ID',
        code: 'NO_PROVIDER_SESSION_ID',
      });
    }

    // Step 4: Provider-mismatch guard — compare current provider to launch-time provider
    const { provider: currentProvider } = await this.resolveLaunchTarget({
      agentId: source.agent_id,
      projectId,
      epicId: source.epic_id,
    });
    if (
      source.provider_name_at_launch &&
      currentProvider.name.toLowerCase() !== source.provider_name_at_launch.toLowerCase()
    ) {
      throw new ConflictException({
        message: 'Current provider differs from launch-time provider',
        code: 'PROVIDER_MISMATCH',
      });
    }

    // Step 5: Per-agent lock with TOCTOU defense
    return this.sessionCoordinator.withAgentLock(source.agent_id, async () => {
      // Re-read inside lock to defeat TOCTOU races
      const lockedSource = this.sqlite
        .prepare(
          `SELECT id, epic_id, agent_id, tmux_session_id, status, started_at, ended_at,
                  transcript_path, provider_session_id, provider_name_at_launch, created_at, updated_at
           FROM sessions WHERE id = ?`,
        )
        .get(sessionId) as RestoreSourceRow | undefined;

      if (!lockedSource) {
        throw new NotFoundException('Session not found');
      }
      if (lockedSource.status !== 'stopped' && lockedSource.status !== 'failed') {
        throw new ConflictException({
          message: 'Session is not in a restorable state',
          code: 'INVALID_SESSION_STATE',
        });
      }
      if (!lockedSource.provider_session_id) {
        throw new ConflictException({
          message: 'Session has no provider session ID',
          code: 'NO_PROVIDER_SESSION_ID',
        });
      }
      if (
        lockedSource.provider_name_at_launch &&
        currentProvider.name.toLowerCase() !== lockedSource.provider_name_at_launch.toLowerCase()
      ) {
        throw new ConflictException({
          message: 'Current provider differs from launch-time provider',
          code: 'PROVIDER_MISMATCH',
        });
      }

      // Also ensure agent has no running session (unique index defense)
      const existingRunning = this.getActiveSessionForAgent(lockedSource.agent_id);
      if (existingRunning) {
        throw new ConflictException({
          message: 'Agent already has a running session',
          code: 'INVALID_SESSION_STATE',
        });
      }

      // Step 6: Capture rollback state
      const prior = {
        status: lockedSource.status,
        ended_at: lockedSource.ended_at,
        tmux_session_id: lockedSource.tmux_session_id,
      };

      // Step 7: Resolve launch context using P2.1 helpers (SKIP ensureMcpConfig/setupHooksConfig)
      const { agent, project, epic, profile, provider, options, configEnv } =
        await this.resolveLaunchTarget({
          agentId: lockedSource.agent_id,
          projectId,
          epicId: lockedSource.epic_id,
        });

      this.verifyProviderBinary(provider);

      // In-lock provider re-validation (defeats TOCTOU on agent provider reconfiguration)
      if (
        lockedSource.provider_name_at_launch &&
        provider.name.toLowerCase() !== lockedSource.provider_name_at_launch.toLowerCase()
      ) {
        throw new ConflictException({
          message: 'Current provider differs from launch-time provider',
          code: 'PROVIDER_MISMATCH',
        });
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

      if (agent.modelOverride) {
        optionArgs = injectModelOverride(optionArgs, agent.modelOverride);
      }

      // Create tmux session name
      const projectSlug = project.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '');
      const epicSegment = lockedSource.epic_id ?? 'independent';
      const tmuxSessionName = this.tmuxService.createSessionName(
        projectSlug,
        epicSegment,
        agent.id,
        lockedSource.id,
      );

      const { envVars, processedOptionArgs } = this.composeLaunchEnv({
        sessionId: lockedSource.id,
        tmuxSessionName,
        projectId,
        agentId: agent.id,
        provider,
        configEnv,
        optionArgs,
      });
      optionArgs = processedOptionArgs;

      // Build CLI command with restore-mode argv (before UPDATE — no rollback needed on failure)
      const adapter = this.providerAdapterFactory.getAdapter(provider.name);
      const launchArgv = adapter.buildLaunchArgs({
        mode: 'restore',
        providerSessionId: lockedSource.provider_session_id!,
        profileOptionArgs: optionArgs,
      }).argv;

      if (!launchArgv.includes(lockedSource.provider_session_id!)) {
        throw new ValidationError(
          'Restore argv does not include provider session ID — adapter contract violation',
          {
            code: 'RESTORE_ARGS_UNAVAILABLE',
            providerName: provider.name,
            providerSessionId: lockedSource.provider_session_id,
          },
        );
      }

      let commandArgs: string[];
      try {
        commandArgs = buildSessionCommand(envVars, provider.binPath!, launchArgv);
      } catch (error) {
        if (error instanceof EnvBuilderError) {
          throw new ValidationError(error.message, {
            agentId: agent.id,
            providerConfigId: agent.providerConfigId,
          });
        }
        throw error;
      }

      // Step 8: In-place UPDATE — status flip BEFORE tmux creation
      const now = new Date().toISOString();
      this.sqlite
        .prepare(
          `UPDATE sessions
           SET status = 'running', tmux_session_id = ?, ended_at = NULL,
               last_activity_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(tmuxSessionName, now, now, lockedSource.id);

      // Step 10: Spawn tmux session
      try {
        await this.tmuxService.createSession(tmuxSessionName, project.rootPath);
      } catch (tmuxError) {
        // Rollback: revert the status flip
        this.sqlite
          .prepare(
            `UPDATE sessions
             SET status = ?, ended_at = ?, tmux_session_id = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(prior.status, prior.ended_at, prior.tmux_session_id, now, lockedSource.id);
        logger.error(
          { sessionId: lockedSource.id, error: String(tmuxError) },
          'Restore failed: tmux creation error — rolled back',
        );
        throw new InternalServerErrorException('RESTORE_FAILED');
      }

      await this.tmuxService.setAlternateScreenOff(tmuxSessionName);
      this.tmuxService.startHealthCheck(tmuxSessionName, lockedSource.id);

      // Step 11: Send CLI command (NO preKeys, NO renderAndPasteInitialPrompt)
      try {
        await this.tmuxService.sendCommandArgs(tmuxSessionName, commandArgs);
      } catch (sendError) {
        // Rollback: revert the status flip and destroy tmux
        this.sqlite
          .prepare(
            `UPDATE sessions
             SET status = ?, ended_at = ?, tmux_session_id = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(prior.status, prior.ended_at, prior.tmux_session_id, now, lockedSource.id);
        try {
          await this.tmuxService.destroySession(tmuxSessionName);
        } catch (destroyErr) {
          logger.warn(
            { tmuxSessionName, error: String(destroyErr) },
            'Failed to destroy tmux session during restore rollback',
          );
        }
        logger.error(
          { sessionId: lockedSource.id, error: String(sendError) },
          'Restore failed: CLI launch error — rolled back',
        );
        throw new InternalServerErrorException('RESTORE_FAILED');
      }

      // Start PTY streaming
      await this.ptyService.startStreaming(lockedSource.id, tmuxSessionName);

      // Step 13: Emit session.restored (NOT session.started)
      await this.getEventsService().publish('session.restored', {
        sessionId: lockedSource.id,
        epicId: lockedSource.epic_id,
        agentId: agent.id,
        tmuxSessionName,
      });

      // Re-emit session.transcript.discovered to re-arm watcher
      if (lockedSource.transcript_path) {
        await this.getEventsService().publish('session.transcript.discovered', {
          sessionId: lockedSource.id,
          agentId: agent.id,
          projectId,
          transcriptPath: lockedSource.transcript_path,
          providerName: provider.name.toLowerCase(),
        });
      }

      // Broadcast presence
      try {
        this.getTerminalGateway().broadcastEvent(`agent/${agent.id}`, 'presence', {
          online: true,
          sessionId: lockedSource.id,
          agentId: agent.id,
        });
      } catch (error) {
        logger.warn({ error, agentId: agent.id }, 'Failed to broadcast presence after restore');
      }

      return {
        id: lockedSource.id,
        epicId: lockedSource.epic_id,
        agentId: agent.id,
        tmuxSessionId: tmuxSessionName,
        status: 'running',
        startedAt: lockedSource.started_at,
        endedAt: null,
        transcriptPath: lockedSource.transcript_path,
        createdAt: lockedSource.created_at,
        updatedAt: now,
        epic: epic ? { id: epic.id, title: epic.title, projectId: epic.projectId } : null,
        agent: { id: agent.id, name: agent.name, profileId: agent.profileId },
        project: { id: project.id, name: project.name, rootPath: project.rootPath },
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

    // Best-effort: read transcript file size at stop time to avoid per-request stat on history queries.
    // If transcript_path is NULL or stat fails (deleted file, race with auto-discovery), leave size_bytes NULL.
    let sizeBytes: number | null = null;
    if (session.transcriptPath) {
      try {
        const fileStat = await stat(session.transcriptPath);
        sizeBytes = fileStat.size;
      } catch (error) {
        logger.warn(
          { error, sessionId, transcriptPath: session.transcriptPath },
          'Could not stat transcript file for size_bytes — leaving NULL (best-effort)',
        );
      }
    }

    // Update session status; fold size_bytes into the same statement to keep stop atomic.
    const now = new Date().toISOString();
    this.sqlite
      .prepare(
        `
      UPDATE sessions
      SET status = ?, ended_at = ?, size_bytes = ?, updated_at = ?
      WHERE id = ?
    `,
      )
      .run('stopped', now, sizeBytes, now, sessionId);

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

  async getAgentSessionHistory(
    agentId: string,
    projectId: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<SessionHistoryResponseDto> {
    const agent = await this.storage.getAgent(agentId);
    if (agent.projectId !== projectId) {
      throw new ForbiddenException('PROJECT_MISMATCH');
    }

    const clampedLimit = Math.min(Math.max(1, limit), 100);
    const sortExpr = `COALESCE(last_activity_at, ended_at, started_at)`;
    const selectCols = `id, provider_session_id, provider_name_at_launch, status, started_at, ended_at, last_activity_at, size_bytes, transcript_path`;
    const baseStatus = `status IN ('stopped','failed')`;

    // Total count uses base filters only — no cursor predicate (stable across pages)
    const { cnt: total } = this.sqlite
      .prepare(`SELECT COUNT(*) as cnt FROM sessions WHERE agent_id = ? AND ${baseStatus}`)
      .get(agentId) as { cnt: number };

    // Decode opaque cursor
    let cursorSortKey: string | null = null;
    let cursorId: string | null = null;
    if (cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf-8')) as {
          s: string;
          i: string;
        };
        cursorSortKey = decoded.s;
        cursorId = decoded.i;
      } catch {
        // Malformed cursor — treat as first page
      }
    }

    let rows: HistorySessionRow[];
    if (cursorSortKey && cursorId) {
      rows = this.sqlite
        .prepare(
          `SELECT ${selectCols} FROM sessions
           WHERE agent_id = ? AND ${baseStatus}
             AND (${sortExpr} < ? OR (${sortExpr} = ? AND id < ?))
           ORDER BY ${sortExpr} DESC, id DESC
           LIMIT ?`,
        )
        .all(
          agentId,
          cursorSortKey,
          cursorSortKey,
          cursorId,
          clampedLimit + 1,
        ) as HistorySessionRow[];
    } else {
      rows = this.sqlite
        .prepare(
          `SELECT ${selectCols} FROM sessions
           WHERE agent_id = ? AND ${baseStatus}
           ORDER BY ${sortExpr} DESC, id DESC
           LIMIT ?`,
        )
        .all(agentId, clampedLimit + 1) as HistorySessionRow[];
    }

    const hasMore = rows.length > clampedLimit;
    const pageRows = hasMore ? rows.slice(0, clampedLimit) : rows;

    // Lazy size backfill — bounded to current page, best-effort
    const now = new Date().toISOString();
    for (const row of pageRows) {
      if (row.size_bytes === null && row.transcript_path !== null) {
        try {
          const fileStat = await stat(row.transcript_path);
          this.sqlite
            .prepare(`UPDATE sessions SET size_bytes = ?, updated_at = ? WHERE id = ?`)
            .run(fileStat.size, now, row.id);
          row.size_bytes = fileStat.size;
        } catch {
          // best-effort — leave NULL
        }
      }
    }

    let nextCursor: string | null = null;
    if (hasMore && pageRows.length > 0) {
      const last = pageRows[pageRows.length - 1];
      const sortKey = last.last_activity_at ?? last.ended_at ?? last.started_at;
      nextCursor = Buffer.from(JSON.stringify({ s: sortKey, i: last.id })).toString('base64url');
    }

    const items: SessionHistoryItemDto[] = pageRows.map((row) => ({
      id: row.id,
      providerSessionId: row.provider_session_id ?? null,
      providerNameAtLaunch: row.provider_name_at_launch,
      status: row.status,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      lastActivityAt: row.last_activity_at,
      sizeBytes: row.size_bytes,
      transcriptAvailable: row.transcript_path !== null,
    }));

    return { items, nextCursor, hasMore, total };
  }

  /**
   * Get session by ID
   */
  getSession(sessionId: string): SessionDto | null {
    const row = this.sqlite
      .prepare(
        `
      SELECT id, epic_id, agent_id, tmux_session_id, status, started_at, ended_at, last_activity_at, activity_state, busy_since, transcript_path, created_at, updated_at
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
      transcriptPath: row.transcript_path ?? null,
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
      SELECT id, epic_id, agent_id, tmux_session_id, status, started_at, ended_at, last_activity_at, activity_state, busy_since, transcript_path, created_at, updated_at
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
        transcriptPath: row.transcript_path ?? null,
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
               busy_since, transcript_path,
               created_at, updated_at
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
      transcriptPath: row.transcript_path ?? null,
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
               s.busy_since, s.transcript_path,
               s.created_at, s.updated_at
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
      transcriptPath: row.transcript_path ?? null,
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
  async injectTextIntoSession(
    sessionId: string,
    text: string,
  ): Promise<{ confirmed: boolean; method?: string }> {
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

    // Use shared confirmed delivery helper (retry, Escape, Enter fallback)
    const result = await deliverWithConfirmation(this.tmuxService, this.sendCoordinator, {
      tmuxSessionId: session.tmuxSessionId,
      text,
      submitKeys: ['Enter'],
      agentId: session.agentId ?? undefined,
    });

    return { confirmed: result.confirmed, method: result.method };
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
    launchHandshake?: LaunchInitialPromptBehavior;
  }): Promise<void> {
    const {
      sessionId,
      tmuxSessionName,
      agentId,
      project,
      agent,
      epic,
      profile,
      provider,
      launchHandshake,
    } = params;

    const teams = await this.loadTeamsForAgentOrEmpty(agentId);

    const context = buildInitialPromptContext({
      agent: { name: agent.name, id: agentId },
      project,
      epic,
      profile,
      provider,
      sessionId,
      teams,
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
      preKeys: launchHandshake?.preKeys,
      preDelayMs: launchHandshake?.preDelayMs,
    });
    logger.debug(
      {
        sessionId,
        provider: provider.name,
        submitKeys: ['Enter'],
        bracketedPaste: true,
        preKeys: launchHandshake?.preKeys,
        preDelayMs: launchHandshake?.preDelayMs,
      },
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

  private async loadTeamsForAgentOrEmpty(agentId: string | undefined): Promise<Team[]> {
    if (!agentId) return [];
    try {
      const teamsService = this.moduleRef.get(TeamsService, { strict: false });
      if (!teamsService || typeof teamsService.listTeamsByAgent !== 'function') {
        return [];
      }
      return await teamsService.listTeamsByAgent(agentId);
    } catch (error) {
      logger.warn(
        { error, agentId },
        'Failed to load teams for initial prompt; defaulting to teamless context',
      );
      return [];
    }
  }
}
