import { Injectable, Logger } from '@nestjs/common';
import { ConflictError } from '../../../common/errors/error-types';
import { SessionRuntime } from './session-runtime';
import type { RestoreOptions } from './session-runtime/session-runtime.service';
import { SessionsService } from './sessions.service';
import { SessionCoordinatorService } from './session-coordinator.service';
import { SessionsMessagePoolService } from './sessions-message-pool.service';
import type { SessionDetailDto, SessionDto, SessionHistoryResponseDto } from '../dtos/sessions.dto';
import { ProjectWriteGate } from '../../storage/write-gate/project-write-gate';
import type { SessionListScope } from '../../storage/sessions/session-row.store';
import type {
  SessionStoppedSource,
  SessionTerminationContext,
} from '../../events/catalog/session.stopped';

/**
 * Narrow facade over the session lifecycle primitives needed by mobile chat and teams:
 * explicit launch, sequential terminate-then-launch restart, restore, and terminate.
 *
 * Exists so the cloud tunnel can drive lifecycle without importing the broad
 * `SessionsModule` (heavy session/terminal graph) — the same narrow-facade
 * pattern the seam uses for reads/delivery. Per-agent serialization is preserved
 * by each underlying lifecycle operation's internal `withAgentLock`.
 */
@Injectable()
export class SessionLifecycleFacade {
  private readonly logger = new Logger(SessionLifecycleFacade.name);

  constructor(
    private readonly sessionRuntime: SessionRuntime,
    private readonly sessionsService: SessionsService,
    private readonly gate: ProjectWriteGate,
    private readonly sessionCoordinator: SessionCoordinatorService,
    private readonly messagePool: SessionsMessagePoolService,
  ) {}

  /** Launch a new independent session for an agent. */
  async launch(agentId: string, projectId: string): Promise<SessionDetailDto> {
    return this.sessionRuntime.launch({ agentId, projectId });
  }

  /**
   * Restart acquires the per-agent lock twice in sequence: termination releases
   * its internal acquisition before launch takes its own. There is deliberately
   * no outer/composite lock because the coordinator is non-reentrant.
   */
  async restart(
    agentId: string,
    projectId: string,
    options?: { source?: SessionStoppedSource },
  ): Promise<SessionDetailDto> {
    // Refuse before the terminate so a refused launch never leaves the agent stopped. This also
    // checks write admission first.
    await this.sessionRuntime.verifyAgentProvider(agentId, projectId);
    const activeSessions = await this.sessionsService.listActiveSessions(projectId);
    const existing = activeSessions.find((s) => s.agentId === agentId);
    if (existing) {
      try {
        await this.sessionsService.terminateSession(
          existing.id,
          { source: options?.source ?? 'mobile-rpc', reason: 'restart' },
          // A project frozen since the check above refuses the stop, and the launch refuses too.
          { expectedAgentId: agentId, admit: () => this.gate.assertWritable(projectId) },
        );
      } catch (error) {
        // Non-fatal: launch below will surface a hard failure if the stale
        // session blocks it; we don't want a terminate hiccup to abort restart.
        this.logger.warn(
          {
            agentId,
            sessionId: existing.id,
            error: error instanceof Error ? error.message : error,
          },
          'Restart: failed to terminate existing session before relaunch',
        );
      }
    }
    return this.sessionRuntime.launch({ agentId, projectId });
  }

  /**
   * Stop a disabled agent's running session, if any, and fail its pending messages. Call it after
   * the flag is set. Advancing the fence refuses messages whose delivery began before Disable.
   * The read queues behind the agent lock, so a launch or restore in progress publishes its
   * session first and is stopped here. Terminate and the discard take the same non-reentrant
   * lock, so they run after the read releases it.
   */
  async stopDisabledAgent(agentId: string, termination: SessionTerminationContext): Promise<void> {
    this.messagePool.advanceDisableFence(agentId);
    const active = await this.sessionCoordinator.withAgentLock(agentId, async () =>
      this.sessionsService.getActiveSessionForAgent(agentId),
    );
    if (active) {
      await this.sessionsService.terminateSession(active.id, termination, {
        expectedAgentId: agentId,
      });
    }
    await this.messagePool.discardPooledMessages(agentId);
  }

  /**
   * Restore a stopped/failed session (provider-session-id replay). With `targetAgentId`, restores
   * into that family agent; omitted, into the session's owner. With `switchToProviderConfigId`,
   * the agent switches to that config.
   */
  async restore(
    sessionId: string,
    projectId: string,
    options: Pick<RestoreOptions, 'targetAgentId' | 'switchToProviderConfigId'> = {},
  ): Promise<SessionDetailDto> {
    return this.sessionRuntime.restore(sessionId, projectId, options);
  }

  assertRestorableKind(sessionId: string): void {
    this.sessionRuntime.assertRestorableKind(sessionId);
  }

  /**
   * Terminate a session. Idempotent: missing/already-stopped is treated as success. With
   * `expectedAgentId`, stops nothing when another agent owns the session by then.
   */
  async terminate(
    sessionId: string,
    options?: { source?: SessionStoppedSource; expectedAgentId?: string },
  ): Promise<void> {
    return this.sessionsService.terminateSession(
      sessionId,
      { source: options?.source ?? 'mobile-rpc', reason: 'user-requested' },
      { expectedAgentId: options?.expectedAgentId },
    );
  }

  /**
   * Paginated history of an agent's stopped/failed sessions. Project scoping is
   * enforced inside `getAgentSessionHistory` (agent.projectId mismatch → throws).
   */
  async listAgentHistory(
    agentId: string,
    projectId: string,
    cursor: string | undefined,
    limit: number,
    scope: SessionListScope = 'agent',
  ): Promise<SessionHistoryResponseDto> {
    return this.sessionsService.getAgentSessionHistory(agentId, projectId, cursor, limit, scope);
  }

  /**
   * Record-only delete (DB row + chat invites; transcript file preserved). Runs
   * the shared `validateSessionInProject` guard (NotFound / Forbidden), then adds
   * the running-status check on top so a live session is never dropped
   * (ConflictError code `STATUS_RUNNING`).
   */
  async deleteSessionRecord(sessionId: string, projectId: string): Promise<{ deleted: boolean }> {
    const session = await this.sessionsService.validateSessionInProject(sessionId, projectId);
    // Admit before deleting raw session SQL records.
    this.gate.assertWritable(projectId);
    if (session.status === 'running') {
      throw new ConflictError('Cannot delete a running session', {
        code: 'STATUS_RUNNING',
        sessionId,
      });
    }
    return this.sessionsService.hardDeleteRecord(sessionId);
  }

  /**
   * Rename (or clear, on null/empty) a session name after the shared
   * `validateSessionInProject` guard. `updateName` trims + enforces max 120.
   */
  async renameSession(
    sessionId: string,
    projectId: string,
    name: string | null,
  ): Promise<SessionDto> {
    await this.sessionsService.validateSessionInProject(sessionId, projectId);
    // Admit before renaming raw session SQL records.
    this.gate.assertWritable(projectId);
    return this.sessionsService.updateName(sessionId, name);
  }
}
