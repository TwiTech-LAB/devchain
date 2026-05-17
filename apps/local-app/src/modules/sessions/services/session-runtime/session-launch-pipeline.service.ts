import { Injectable, Inject } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PROCESS_BOOT_ID } from '../../../../common/process-identity';
import type Database from 'better-sqlite3';
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { DB_CONNECTION } from '../../../storage/db/db.provider';
import { getRawSqliteClient } from '../../../storage/db/sqlite-raw';
import {
  STORAGE_SERVICE,
  type StorageService,
} from '../../../storage/interfaces/storage.interface';
import type {
  Agent,
  Project,
  Epic,
  AgentProfile,
  Provider,
} from '../../../storage/models/domain.models';
import { ValidationError } from '../../../../common/errors/error-types';
import { createLogger } from '../../../../common/logging/logger';
import { getEnvConfig } from '../../../../common/config/env.config';
import { HostResolver } from '@devchain/shared';
import { SessionCoordinatorService } from '../session-coordinator.service';
import { ProviderAdapterFactory } from '../../../providers/adapters/provider-adapter.factory';
import {
  isContextWindowCapable,
  isHookCapable,
  isProjectProvisioningCapable,
} from '../../../providers/adapters/capabilities';
import { TerminalIOService } from '../../../terminal/services/terminal-io/terminal-io.service';

import { PtyService } from '../../../terminal/services/pty.service';
import { TerminalSessionRegistry } from '../../../terminal/services/terminal-session/terminal-session-registry';
import { HooksConfigService } from '../../../hooks/services/hooks-config.service';
import { PreflightService } from '../../../core/services/preflight.service';
import { ProviderMcpEnsureService } from '../../../providers/services/provider-mcp-ensure.service';
import { EventsService } from '../../../events/services/events.service';
import { TeamsStore } from '../../../teams/storage/teams.store';
import { resolve as resolveLaunchConfig, type LaunchConfig } from '../provider-launch-config';
import { buildTmuxSessionName } from '../../utils/tmux-naming.util';
import { renderTemplate } from '../../../../common/template/handlebars-renderer';
import { buildPromptRenderContext } from '../../../../common/template/prompt-render-context';
import { CleanupStack } from './cleanup-stack';
import type { LaunchSessionDto, SessionDetailDto } from '../../dtos/sessions.dto';

const logger = createLogger('SessionLaunchPipeline');

@Injectable()
export class SessionLaunchPipeline {
  private readonly sqlite: Database.Database;

  constructor(
    @Inject(DB_CONNECTION) db: BetterSQLite3Database,
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    private readonly sessionCoordinator: SessionCoordinatorService,
    private readonly providerAdapterFactory: ProviderAdapterFactory,
    private readonly terminalIO: TerminalIOService,
    private readonly ptyService: PtyService,
    private readonly terminalSessionRegistry: TerminalSessionRegistry,
    private readonly hooksConfigService: HooksConfigService,
    private readonly preflightService: PreflightService,
    private readonly mcpEnsureService: ProviderMcpEnsureService,
    private readonly eventsService: EventsService,
    private readonly teamsStore: TeamsStore,
  ) {
    this.sqlite = getRawSqliteClient(db);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────────

  async launch(data: LaunchSessionDto): Promise<SessionDetailDto> {
    const { epicId, agentId, projectId, options: launchOptions } = data;
    const silent = launchOptions?.silent === true;

    // Phase 1: acquireAgentLock
    return this.sessionCoordinator.withAgentLock(agentId, async () => {
      const cleanup = new CleanupStack();
      let sessionId: string | undefined;
      let tmuxSessionName: string | undefined;

      try {
        // Fast idempotency check
        const existing = await this.checkExistingSession(agentId, projectId);
        if (existing) return existing;

        // Phase 2: resolveLaunchTarget (pure)
        const target = await this.resolveLaunchTarget({ agentId, projectId, epicId });
        const { agent, project, epic, profile, provider, options, configEnv } = target;

        // Auto-compact recommendation (non-blocking)
        this.emitAutoCompactRecommendation(provider, agent, agentId, silent);

        // Phase 3: verifyProvider (preflight + MCP ensure)
        await this.verifyProvider(provider, project.rootPath);

        // Phase 4: resolveLaunchConfig (pure — via ProviderLaunchConfig.resolve)
        const adapter = this.providerAdapterFactory.getAdapter(provider.name);
        const env = getEnvConfig();

        // Generate session ID and tmux name
        sessionId = randomUUID();
        const now = new Date().toISOString();
        const projectSlug = project.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/(^-|-$)/g, '');
        const epicSegment = epicId ?? 'independent';
        tmuxSessionName = buildTmuxSessionName(projectSlug, epicSegment, agentId, sessionId);

        // Re-resolve with real sessionId + tmuxSessionName for hook env
        const finalConfig = resolveLaunchConfig({
          mode: 'new',
          adapter,
          profileOptions: options,
          modelOverride: agent.modelOverride,
          providerBinPath: provider.binPath!,
          providerEnv: provider.env,
          configEnv,
          provider,
          hookContext: isHookCapable(adapter)
            ? {
                apiUrl: HostResolver.buildInternalBaseUrl({ host: env.HOST, port: env.PORT }),
                projectId,
                agentId,
                sessionId,
                tmuxSessionName,
              }
            : undefined,
        });

        // ── Phase 5: Runtime plan finalized checkpoint ─────────────────
        // From here: argv, env, sessionId, hook paths are immutable.
        // No tmux side effects have happened yet.

        // Phase 6: setupHooksConfig (filesystem write, non-fatal)
        await this.setupHooksConfig(provider, project.rootPath);

        // Phase 7: createSession (SQLite write)
        this.createSessionRow(
          sessionId,
          epicId ?? null,
          agentId,
          tmuxSessionName,
          provider.name,
          now,
        );
        cleanup.push('createSession', async () => {
          this.sqlite
            .prepare('UPDATE sessions SET status = ?, ended_at = ?, updated_at = ? WHERE id = ?')
            .run('failed', new Date().toISOString(), new Date().toISOString(), sessionId);
        });

        // Phase 8: createTmuxSession
        await this.terminalIO.createEmptySession(tmuxSessionName, { cwd: project.rootPath });
        cleanup.push('createTmuxSession', async () => {
          try {
            await this.terminalIO.destroySession({ name: tmuxSessionName! });
          } catch (e) {
            logger.warn(
              { tmuxSessionName, error: e },
              'Failed to destroy tmux session during rollback',
            );
          }
        });

        await this.terminalIO.disableAlternateScreen({ name: tmuxSessionName });
        this.terminalIO.startHealthCheck(tmuxSessionName, sessionId);

        // Phase 9: flipToRunning (already running from createSession insert)
        // In the current model, we insert as 'running' directly.
        // The compensator from createSession handles rollback.

        // Phase 10: bindStreaming
        this.terminalSessionRegistry.create(sessionId, tmuxSessionName, {
          normalizeCapturedLineEndings: true,
        });
        cleanup.push('bindStreaming', async () => {
          this.terminalSessionRegistry.dispose(sessionId!);
        });

        await this.ptyService.startStreaming(sessionId, tmuxSessionName);
        this.terminalSessionRegistry.bind(sessionId, this.terminalIO);

        // Phase 11: pasteInitialPrompt + launch CLI + emit session.started
        await this.launchCliAndPastePrompt(sessionId, tmuxSessionName, finalConfig, {
          agent,
          project,
          epic,
          profile,
          provider,
        });

        await this.eventsService.publish('session.started', {
          sessionId,
          epicId: epicId ?? null,
          agentId,
          tmuxSessionName,
        });

        try {
          await this.eventsService.publish('session.presence.changed', {
            agentId,
            online: true,
            sessionId,
          });
        } catch {
          // Non-fatal
        }

        return this.buildSessionDetail(
          sessionId,
          epicId ?? null,
          agentId,
          tmuxSessionName,
          now,
          agent,
          project,
          epic,
        );
      } catch (error) {
        await cleanup.rollback({ sessionId });
        throw error;
      }
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Phase implementations (private)
  // ─────────────────────────────────────────────────────────────────────────

  private async checkExistingSession(
    agentId: string,
    _projectId: string,
  ): Promise<SessionDetailDto | null> {
    const rows = this.sqlite
      .prepare(
        `SELECT id, epic_id, agent_id, tmux_session_id, status, started_at, ended_at,
                transcript_path, created_at, updated_at
         FROM sessions WHERE agent_id = ? AND status = 'running'`,
      )
      .all(agentId) as Array<Record<string, unknown>>;

    if (rows.length === 0) return null;

    const row = rows[0];
    const tmuxAlive = row.tmux_session_id
      ? await this.terminalIO.sessionExists({ name: row.tmux_session_id as string })
      : false;

    if (tmuxAlive) {
      const agent = await this.storage.getAgent(agentId);
      const project = await this.storage.getProject(agent.projectId);
      const epic = row.epic_id
        ? await this.storage.getEpic(row.epic_id as string).catch(() => null)
        : null;

      return {
        id: row.id as string,
        epicId: (row.epic_id as string) ?? null,
        agentId: row.agent_id as string,
        tmuxSessionId: row.tmux_session_id as string,
        status: row.status as 'running' | 'stopped' | 'failed',
        startedAt: row.started_at as string,
        endedAt: (row.ended_at as string) ?? null,
        transcriptPath: (row.transcript_path as string) ?? null,
        createdAt: row.created_at as string,
        updatedAt: row.updated_at as string,
        epic: epic ? { id: epic.id, title: epic.title, projectId: epic.projectId } : null,
        agent: { id: agent.id, name: agent.name, profileId: agent.profileId },
        project: { id: project.id, name: project.name, rootPath: project.rootPath },
      };
    }

    // Orphaned session — mark as stopped
    this.sqlite
      .prepare(`UPDATE sessions SET status = 'stopped', ended_at = ?, updated_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), new Date().toISOString(), row.id);

    return null;
  }

  private async resolveLaunchTarget(params: {
    agentId: string;
    projectId: string;
    epicId?: string | null;
  }) {
    const agent = await this.storage.getAgent(params.agentId);
    if (agent.projectId !== params.projectId) {
      throw new ValidationError('Agent does not belong to the specified project', {
        agentId: params.agentId,
        projectId: params.projectId,
      });
    }

    const project = await this.storage.getProject(params.projectId);
    const epic = params.epicId ? await this.storage.getEpic(params.epicId) : null;
    const profile = await this.storage.getAgentProfile(agent.profileId);

    const configs = await this.storage.listProfileProviderConfigsByProfile(profile.id);
    const config = agent.providerConfigId
      ? (configs.find((c) => c.id === agent.providerConfigId) ?? configs[0])
      : configs[0];

    if (!config) {
      throw new ValidationError('Profile has no provider configurations', {
        profileId: profile.id,
      });
    }

    const provider = await this.storage.getProvider(config.providerId);

    return {
      agent,
      project,
      epic,
      profile,
      provider,
      options: config.options,
      configEnv: config.env,
    };
  }

  private async verifyProvider(provider: Provider, projectRootPath: string): Promise<void> {
    if (!provider.binPath) {
      throw new ValidationError(
        `Provider ${provider.name} is missing a binary path. Set the path before launching sessions.`,
        { providerId: provider.id, providerName: provider.name },
      );
    }

    const preflightResult = await this.preflightService.runChecks(projectRootPath);
    let providerCheck = preflightResult.providers?.find((p) => p.id === provider.id);

    if (providerCheck?.mcpStatus && providerCheck.mcpStatus !== 'pass') {
      await this.mcpEnsureService.ensureMcp(provider, projectRootPath);
      const recheck = await this.preflightService.runChecks(projectRootPath);
      providerCheck = recheck.providers?.find((p) => p.id === provider.id);

      if (providerCheck?.mcpStatus !== 'pass') {
        throw new ValidationError('MCP configuration failed after auto-ensure', {
          providerId: provider.id,
          mcpStatus: providerCheck?.mcpStatus,
          mcpMessage: providerCheck?.mcpMessage,
        });
      }
    }

    // Gemini-like providers: always ensure project-scope MCP
    try {
      const adapter = this.providerAdapterFactory.getAdapter(provider.name);
      if (isProjectProvisioningCapable(adapter) && projectRootPath) {
        await this.mcpEnsureService.ensureMcp(provider, projectRootPath);
      }
    } catch {
      // Non-fatal
    }

    if (preflightResult.overall === 'fail') {
      const failedChecks = preflightResult.checks
        .filter((c) => c.status === 'fail')
        .map((c) => `${c.name}: ${c.message}`)
        .join('; ');
      throw new ValidationError('Preflight checks failed', { failedChecks });
    }
  }

  private emitAutoCompactRecommendation(
    provider: Provider,
    agent: Agent,
    agentId: string,
    silent: boolean,
  ): void {
    try {
      const adapter = this.providerAdapterFactory.getAdapter(provider.name);
      if (isContextWindowCapable(adapter)) {
        adapter.evaluateAutoCompactConfig().then(({ enabled, reason }) => {
          if (!enabled && reason) {
            this.eventsService.publish('session.recommendation', {
              reason,
              agentId,
              agentName: agent.name,
              providerId: provider.id,
              providerName: provider.name,
              silent,
              bootId: PROCESS_BOOT_ID,
            });
          }
        });
      }
    } catch {
      // Non-blocking
    }
  }

  private async setupHooksConfig(
    provider: Pick<Provider, 'name'>,
    projectRootPath: string,
  ): Promise<void> {
    try {
      const adapter = this.providerAdapterFactory.getAdapter(provider.name);
      if (!isHookCapable(adapter)) return;
      await this.hooksConfigService.ensureHooksConfig(projectRootPath);
    } catch (error) {
      logger.warn({ error }, 'Failed to ensure hooks config (non-fatal)');
    }
  }

  private createSessionRow(
    sessionId: string,
    epicId: string | null,
    agentId: string,
    tmuxSessionName: string,
    providerName: string,
    now: string,
  ): void {
    this.sqlite
      .prepare(
        `INSERT INTO sessions (id, epic_id, agent_id, tmux_session_id, status, started_at, provider_name_at_launch, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sessionId,
        epicId,
        agentId,
        tmuxSessionName,
        'running',
        now,
        providerName.toLowerCase(),
        now,
        now,
      );
  }

  private async launchCliAndPastePrompt(
    sessionId: string,
    tmuxSessionName: string,
    config: LaunchConfig,
    context: {
      agent: Agent;
      project: Project;
      epic: Epic | null;
      profile: AgentProfile;
      provider: Provider;
    },
  ): Promise<void> {
    await this.terminalIO.typeCommand({ name: tmuxSessionName }, config.commandArgs);

    const launchTimestamp = Date.now();
    await this.terminalIO.waitForOutput(
      { name: tmuxSessionName },
      (output) => output.trim().length > 0,
      { pollIntervalMs: 500, timeoutMs: 30_000, settleMs: 1_000 },
    );

    const MIN_LAUNCH_DELAY_MS = 7_000;
    const elapsed = Date.now() - launchTimestamp;
    if (elapsed < MIN_LAUNCH_DELAY_MS) {
      await new Promise((resolve) => setTimeout(resolve, MIN_LAUNCH_DELAY_MS - elapsed));
    }

    await this.renderAndPasteInitialPrompt({
      sessionId,
      tmuxSessionName,
      agentId: context.agent.id,
      project: { id: context.project.id, name: context.project.name },
      agent: context.agent,
      epic: context.epic,
      profile: context.profile,
      provider: context.provider,
      launchHandshake: config.promptHandshake,
    });
  }

  private async renderAndPasteInitialPrompt(params: {
    sessionId: string;
    tmuxSessionName: string;
    agentId: string;
    project: { id: string; name: string };
    agent: Agent;
    epic: Epic | null;
    profile: AgentProfile;
    provider: Provider;
    launchHandshake?: { preKeys?: string[]; preDelayMs?: number };
  }): Promise<void> {
    const initialPrompt = await this.storage.getInitialSessionPrompt(params.project.id);
    if (!initialPrompt) return;

    let renderResult: {
      vars: Record<string, unknown>;
      recipientLegacyVariables: readonly string[];
    };
    try {
      renderResult = await buildPromptRenderContext({
        recipientAgentId: params.agent.id,
        teams: this.teamsStore,
        extras: {
          agent_name: params.agent.name,
          project_name: params.project.name,
          epic_title: params.epic?.title ?? '',
          provider_name: params.provider.name,
          profile_name: params.profile.name,
          session_id: params.sessionId,
          session_id_short: params.sessionId.slice(0, 8),
        },
      });
    } catch (err) {
      logger.warn(
        { err, agentId: params.agent.id },
        'Team lookup failed during initial-prompt render; continuing with empty team context',
      );
      renderResult = {
        vars: {
          team_name: '',
          team_names: '',
          is_team_lead: false,
          agent_name: params.agent.name,
          project_name: params.project.name,
          epic_title: params.epic?.title ?? '',
          provider_name: params.provider.name,
          profile_name: params.profile.name,
          session_id: params.sessionId,
          session_id_short: params.sessionId.slice(0, 8),
        },
        recipientLegacyVariables: ['team_name', 'team_names', 'is_team_lead'],
      };
    }

    const rendered = renderTemplate(
      initialPrompt.content,
      renderResult.vars,
      Object.keys(renderResult.vars),
    );
    if (!rendered.trim()) return;

    await this.terminalIO.deliver({ name: params.tmuxSessionName }, rendered, {
      agentId: params.agentId,
      preKeys: params.launchHandshake?.preKeys,
      preDelayMs: params.launchHandshake?.preDelayMs,
    });
  }

  private buildSessionDetail(
    sessionId: string,
    epicId: string | null,
    agentId: string,
    tmuxSessionName: string,
    now: string,
    agent: Agent,
    project: Project,
    epic: Epic | null,
  ): SessionDetailDto {
    return {
      id: sessionId,
      epicId,
      agentId,
      tmuxSessionId: tmuxSessionName,
      status: 'running',
      startedAt: now,
      endedAt: null,
      transcriptPath: null,
      createdAt: now,
      updatedAt: now,
      epic: epic ? { id: epic.id, title: epic.title, projectId: epic.projectId } : null,
      agent: { id: agent.id, name: agent.name, profileId: agent.profileId },
      project: { id: project.id, name: project.name, rootPath: project.rootPath },
    };
  }
}
