import { Injectable, Inject } from '@nestjs/common';
import type Database from 'better-sqlite3';
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { DB_CONNECTION } from '../../../storage/db/db.provider';
import { getRawSqliteClient } from '../../../storage/db/sqlite-raw';
import {
  STORAGE_SERVICE,
  type StorageService,
} from '../../../storage/interfaces/storage.interface';
import {
  ValidationError,
  NotFoundError,
  ConflictError,
  ForbiddenError,
} from '../../../../common/errors/error-types';
import { createLogger } from '../../../../common/logging/logger';
import { getEnvConfig } from '../../../../common/config/env.config';
import { HostResolver } from '@devchain/shared';
import { SessionCoordinatorService } from '../session-coordinator.service';
import { ProviderAdapterFactory } from '../../../providers/adapters/provider-adapter.factory';
import { isHookCapable } from '../../../providers/adapters/capabilities';
import { TerminalIOService } from '../../../terminal/services/terminal-io/terminal-io.service';
import { PtyService } from '../../../terminal/services/pty.service';
import { TerminalSessionRegistry } from '../../../terminal/services/terminal-session/terminal-session-registry';
import { EventsService } from '../../../events/services/events.service';
import { resolve as resolveLaunchConfig } from '../provider-launch-config';
import { buildTmuxSessionName } from '../../utils/tmux-naming.util';
import { CleanupStack } from './cleanup-stack';
import type { SessionDetailDto } from '../../dtos/sessions.dto';

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
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    private readonly sessionCoordinator: SessionCoordinatorService,
    private readonly providerAdapterFactory: ProviderAdapterFactory,
    private readonly terminalIO: TerminalIOService,
    private readonly ptyService: PtyService,
    private readonly terminalSessionRegistry: TerminalSessionRegistry,
    private readonly eventsService: EventsService,
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

        const { agent, project, epic, provider, options, configEnv } = target;
        if (!provider.binPath) {
          throw new ValidationError(`Provider ${provider.name} is missing a binary path`, {
            providerId: provider.id,
          });
        }

        // In-lock provider re-validation (defeats TOCTOU on agent provider reconfiguration)
        this.checkProviderMismatch(locked, provider.name);

        // Phase 5: resolveLaunchConfig (mode='restore')
        const adapter = this.providerAdapterFactory.getAdapter(provider.name);
        const env = getEnvConfig();
        const projectSlug = project.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/(^-|-$)/g, '');
        const epicSegment = locked.epic_id ?? 'independent';
        const tmuxSessionName = buildTmuxSessionName(projectSlug, epicSegment, agent.id, locked.id);

        const config = resolveLaunchConfig({
          mode: 'restore',
          providerSessionId: locked.provider_session_id!,
          adapter,
          profileOptions: options,
          modelOverride: agent.modelOverride,
          providerBinPath: provider.binPath,
          providerEnv: provider.env,
          configEnv,
          provider,
          hookContext: isHookCapable(adapter)
            ? {
                apiUrl: HostResolver.buildInternalBaseUrl({ host: env.HOST, port: env.PORT }),
                projectId,
                agentId: agent.id,
                sessionId: locked.id,
                tmuxSessionName,
              }
            : undefined,
        });

        if (!config.argv.includes(locked.provider_session_id!)) {
          throw new ValidationError(
            'Restore argv does not include provider session ID — adapter contract violation',
            { providerName: provider.name, providerSessionId: locked.provider_session_id },
          );
        }

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

        // Phase 7: createTmuxSession
        await this.terminalIO.createEmptySession(tmuxSessionName, { cwd: project.rootPath });
        cleanup.push('createTmuxSession', async () => {
          try {
            await this.terminalIO.destroySession({ name: tmuxSessionName });
          } catch (e) {
            logger.warn({ tmuxSessionName, error: e }, 'Failed to destroy tmux during rollback');
          }
        });

        await this.terminalIO.disableAlternateScreen({ name: tmuxSessionName });
        this.terminalIO.startHealthCheck(tmuxSessionName, locked.id);

        // Phase 8: bindStreaming (BEFORE issuing the restore command)
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
    };
  }
}
