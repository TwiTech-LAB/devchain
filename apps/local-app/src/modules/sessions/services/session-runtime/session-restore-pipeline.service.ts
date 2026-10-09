import { Injectable, Inject } from '@nestjs/common';
import type Database from 'better-sqlite3';
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { DB_CONNECTION } from '../../../storage/db/db.provider';
import { getRawSqliteClient } from '../../../storage/db/sqlite-raw';
import {
  STORAGE_SERVICE,
  type StorageService,
  type AgentProfileStorage,
  type AgentStorage,
  type ProfileProviderConfigStorage,
  type ProjectStorage,
} from '../../../storage/interfaces/storage.interface';
import {
  ValidationError,
  NotFoundError,
  ConflictError,
  ForbiddenError,
} from '../../../../common/errors/error-types';
import { createLogger } from '../../../../common/logging/logger';
import { SessionCoordinatorService } from '../session-coordinator.service';
import { ProviderAdapterFactory } from '../../../providers/adapters/provider-adapter.factory';
import { TerminalIOService } from '../../../terminal/services/terminal-io/terminal-io.service';
import { PtyService } from '../../../terminal/services/pty.service';
import { TerminalSessionRegistry } from '../../../terminal/services/terminal-session/terminal-session-registry';
import { TerminalStreamService } from '../../../terminal/services/terminal-stream.service';
import { EventsService } from '../../../events/services/events.service';
import { PreflightService } from '../../../core/services/preflight.service';
import { ProviderMcpEnsureService } from '../../../providers/services/provider-mcp-ensure.service';
import { buildTmuxSessionName } from '../../utils/tmux-naming.util';
import { CleanupStack } from './cleanup-stack';
import { ensureMcpReadiness } from './ensure-mcp-readiness';
import type { SessionDetailDto } from '../../dtos/sessions.dto';
import { ProviderRuntimePreparationService } from '../provider-runtime-preparation';

const logger = createLogger('SessionRestorePipeline');

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

@Injectable()
export class SessionRestorePipeline {
  private readonly sqlite: Database.Database;

  constructor(
    @Inject(DB_CONNECTION) db: BetterSQLite3Database,
    @Inject(STORAGE_SERVICE)
    private readonly storage: AgentProfileStorage &
      AgentStorage &
      ProfileProviderConfigStorage &
      ProjectStorage &
      Pick<StorageService, 'getEpic' | 'getProvider' | 'getProviderEnvForProject'>,
    private readonly sessionCoordinator: SessionCoordinatorService,
    private readonly providerAdapterFactory: ProviderAdapterFactory,
    private readonly terminalIO: TerminalIOService,
    private readonly ptyService: PtyService,
    private readonly terminalSessionRegistry: TerminalSessionRegistry,
    private readonly eventsService: EventsService,
    private readonly streamService: TerminalStreamService,
    private readonly providerRuntimePreparation: ProviderRuntimePreparationService,
    private readonly preflightService: PreflightService,
    private readonly mcpEnsureService: ProviderMcpEnsureService,
  ) {
    this.sqlite = getRawSqliteClient(db);
  }

  async restore(sessionId: string, projectId: string): Promise<SessionDetailDto> {
    // Phase 2: validateStopped (outside lock — to get agentId for lock acquisition)
    const source = this.readSessionRow(sessionId);
    if (!source) throw new NotFoundError('Session', sessionId);

    const sourceAgent = await this.storage.getAgent(source.agent_id);
    if (sourceAgent.projectId !== projectId) {
      throw new ForbiddenError('Agent does not belong to the specified project', {
        agentId: source.agent_id,
        projectId,
      });
    }

    this.validateRestorable(source);

    // Phase 3: providerMismatchGuard (BEFORE lock — zero side effects on 409)
    const target = await this.resolveLaunchTarget(source.agent_id, projectId, source.epic_id);
    this.checkProviderMismatch(source, target.provider.name);

    // Phase 1: acquireAgentLock
    return this.sessionCoordinator.withAgentLock(source.agent_id, async () => {
      const cleanup = new CleanupStack();

      try {
        // Phase 4: TOCTOU re-validate inside lock
        const locked = this.readSessionRow(sessionId);
        if (!locked) throw new NotFoundError('Session', sessionId);
        this.validateRestorable(locked);
        this.checkProviderMismatch(locked, target.provider.name);
        this.checkNoRunningSession(locked.agent_id);

        // Cancel any pending stopped-session replay-retention clear SYNCHRONOUSLY here — the true
        // start of restore execution for the locked session, before the first buffer-producing await
        // (createTmuxSession / startStreaming below). Waiting for the Phase 9 `session.restored`
        // event is too late: a retention deadline crossing mid-pipeline would clear the very domain
        // we are restoring into, losing the epoch. On rollback we re-arm the same retention (via the
        // cleanup stack, like every other phase effect) so a failed restore does not retain forever.
        const cancelledRetentionMs = this.streamService.cancelScheduledClear(locked.id);
        if (cancelledRetentionMs !== null) {
          cleanup.push('rearmReplayRetention', async () => {
            this.streamService.scheduleClear(locked.id, cancelledRetentionMs);
          });
        }

        const { agent, project, epic, provider, options, configEnv } = target;

        if (!provider.binPath) {
          throw new ValidationError(`Provider ${provider.name} is missing a binary path`, {
            providerId: provider.id,
          });
        }

        // In-lock provider re-validation (defeats TOCTOU on agent provider reconfiguration)
        this.checkProviderMismatch(locked, provider.name);

        // A restored session re-enters a live agent conversation; if the
        // devchain MCP registration drifted since launch, the restored agent
        // runs without DevChain tools. This repair is also the ONLY restore
        // path that may write provider trust — the full ensureMcp includes it.
        await ensureMcpReadiness({
          storage: this.storage,
          preflightService: this.preflightService,
          mcpEnsureService: this.mcpEnsureService,
          provider,
          projectId: project.id,
          projectRootPath: project.rootPath,
          configEnv,
        });

        // Phase 5: create the read-only restore runtime plan
        const adapter = this.providerAdapterFactory.getAdapter(provider.name);
        const projectSlug = project.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/(^-|-$)/g, '');
        const epicSegment = locked.epic_id ?? 'independent';
        const tmuxSessionName = buildTmuxSessionName(projectSlug, epicSegment, agent.id, locked.id);

        const providerRuntimePlan = await this.providerRuntimePreparation.createPlan({
          mode: 'restore',
          providerSessionId: locked.provider_session_id!,
          adapter,
          provider,
          providerBinPath: provider.binPath,
          projectId: project.id,
          projectName: project.name,
          projectRootPath: project.rootPath,
          agentId: agent.id,
          agentModelOverride: agent.modelOverride,
          agentEffortOverride: agent.effortOverride,
          configModel: target.configModel,
          configEffort: target.configEffort,
          profileOptions: options,
          configEnv,
          sessionId: locked.id,
          tmuxSessionName,
        });

        const prior = {
          status: locked.status,
          ended_at: locked.ended_at,
          tmux_session_id: locked.tmux_session_id,
        };

        // Phase 6: flipToRunning (BEFORE createTmuxSession)
        const now = new Date().toISOString();
        this.sqlite
          .prepare(
            `UPDATE sessions SET status = 'running', tmux_session_id = ?, ended_at = NULL,
             last_activity_at = ?, updated_at = ? WHERE id = ?`,
          )
          .run(tmuxSessionName, now, now, locked.id);
        cleanup.push('flipToRunning', async () => {
          this.sqlite
            .prepare(
              `UPDATE sessions SET status = ?, ended_at = ?, tmux_session_id = ?, updated_at = ? WHERE id = ?`,
            )
            .run(
              prior.status,
              prior.ended_at,
              prior.tmux_session_id,
              new Date().toISOString(),
              locked.id,
            );
        });
        const providerRuntime =
          await this.providerRuntimePreparation.materialize(providerRuntimePlan);
        cleanup.push('providerRuntime', providerRuntime.rollback);
        const config = providerRuntime.config;

        // Phase 7: createTmuxSession
        await this.terminalIO.createEmptySession(tmuxSessionName, { cwd: project.rootPath });
        cleanup.push('createTmuxSession', async () => {
          const result = await this.terminalIO.destroyExpectedSession(
            { name: tmuxSessionName },
            { onUnknownError: 'retire' },
          );
          if (result.outcome === 'unknown-error') {
            logger.warn(
              { tmuxSessionName, error: result.error },
              'Failed to destroy tmux during rollback',
            );
          }
        });

        await this.terminalIO.setAlternateScreen(
          { name: tmuxSessionName },
          adapter.terminalOutputBehavior?.usesAlternateScreen ?? false,
        );
        this.terminalIO.startHealthCheck(tmuxSessionName, locked.id);

        // Phase 8: bindStreaming (BEFORE issuing the restore command)
        // The row is stopped/failed (validated under the agent lock), so any
        // surviving registry entry is stale — dispose it instead of failing
        // with "TerminalSession already exists".
        if (this.terminalSessionRegistry.get(locked.id)) {
          logger.warn(
            { sessionId: locked.id },
            'Stale TerminalSession registry entry found during restore — disposing',
          );
          this.ptyService.stopStreaming(locked.id);
          this.terminalSessionRegistry.dispose(locked.id);
        }
        this.terminalSessionRegistry.create(locked.id, tmuxSessionName, {
          normalizeCapturedLineEndings: true,
        });
        cleanup.push('bindStreaming', async () => {
          this.terminalSessionRegistry.dispose(locked.id);
        });

        await this.ptyService.startStreaming(locked.id, tmuxSessionName);
        this.terminalSessionRegistry.bind(locked.id, this.terminalIO);

        // Issue the restore command — streaming is bound, output is captured
        await this.terminalIO.typeCommand({ name: tmuxSessionName }, config.commandArgs);
        await providerRuntime.afterCommand();

        // Phase 9: emit session.restored (NOT session.started)
        await this.eventsService.publish('session.restored', {
          sessionId: locked.id,
          epicId: locked.epic_id,
          agentId: agent.id,
          tmuxSessionName,
          providerName: provider.name.toLowerCase(),
        });

        if (locked.transcript_path) {
          await this.eventsService.publish('session.transcript.discovered', {
            sessionId: locked.id,
            agentId: agent.id,
            projectId,
            transcriptPath: locked.transcript_path,
            providerName: provider.name.toLowerCase(),
            // Re-emit the provider session id so DB-source watchers (agy/opencode) start.
            // Without it the watcher skips (`transcript-watcher.service.ts` DB branch) and a
            // restored DB conversation never receives live updates. Mirrors the launch path.
            providerSessionId: locked.provider_session_id ?? undefined,
          });
        }

        try {
          await this.eventsService.publish('session.presence.changed', {
            agentId: agent.id,
            online: true,
            sessionId: locked.id,
          });
        } catch {
          // Non-fatal
        }

        return {
          id: locked.id,
          epicId: locked.epic_id,
          agentId: agent.id,
          tmuxSessionId: tmuxSessionName,
          status: 'running' as const,
          startedAt: locked.started_at,
          endedAt: null,
          transcriptPath: locked.transcript_path,
          createdAt: locked.created_at,
          updatedAt: now,
          epic: epic ? { id: epic.id, title: epic.title, projectId: epic.projectId } : null,
          agent: { id: agent.id, name: agent.name, profileId: agent.profileId },
          project: { id: project.id, name: project.name, rootPath: project.rootPath },
        };
      } catch (error) {
        await cleanup.rollback({ sessionId });
        throw error;
      }
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────────────────

  private readSessionRow(sessionId: string): RestoreSourceRow | undefined {
    return this.sqlite
      .prepare(
        `SELECT id, epic_id, agent_id, tmux_session_id, status, started_at, ended_at,
                transcript_path, provider_session_id, provider_name_at_launch, created_at, updated_at
         FROM sessions WHERE id = ?`,
      )
      .get(sessionId) as RestoreSourceRow | undefined;
  }

  private validateRestorable(row: RestoreSourceRow): void {
    if (row.status !== 'stopped' && row.status !== 'failed') {
      throw new ConflictError('Session is not in a restorable state', {
        code: 'INVALID_SESSION_STATE',
      });
    }
    if (!row.provider_session_id) {
      throw new ConflictError('Session has no provider session ID', {
        code: 'NO_PROVIDER_SESSION_ID',
      });
    }
  }

  private checkProviderMismatch(row: RestoreSourceRow, currentProviderName: string): void {
    if (
      row.provider_name_at_launch &&
      currentProviderName.toLowerCase() !== row.provider_name_at_launch.toLowerCase()
    ) {
      throw new ConflictError('Current provider differs from launch-time provider', {
        code: 'PROVIDER_MISMATCH',
      });
    }
  }

  private checkNoRunningSession(agentId: string): void {
    const running = this.sqlite
      .prepare(`SELECT id FROM sessions WHERE agent_id = ? AND status = 'running' LIMIT 1`)
      .get(agentId);
    if (running) {
      throw new ConflictError('Agent already has a running session', {
        code: 'INVALID_SESSION_STATE',
      });
    }
  }

  private async resolveLaunchTarget(agentId: string, projectId: string, epicId: string | null) {
    const agent = await this.storage.getAgent(agentId);
    const project = await this.storage.getProject(projectId);
    const epic = epicId ? await this.storage.getEpic(epicId).catch(() => null) : null;
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
      // Structured model/effort defaults remain separate so runtime planning
      // applies the same precedence contract as a fresh launch.
      configModel: config.model,
      configEffort: config.effort,
    };
  }
}
