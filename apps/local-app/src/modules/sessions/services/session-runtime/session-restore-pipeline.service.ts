import { SessionRowStore } from '../../../storage/sessions/session-row.store';
import { Injectable, Inject } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
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
  AgentDisabledError,
  AppError,
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
import type { RollbackSessionDto, SessionDetailDto } from '../../dtos/sessions.dto';
import {
  ProviderRuntimePreparationService,
  type ProviderRuntimePlan,
} from '../provider-runtime-preparation';
import type { ProviderAdapter } from '../../../providers/adapters/provider-adapter.interface';
import type { ProfileProviderConfig } from '../../../storage/models/domain.models';
import {
  expectedReplacement,
  runningSessionChanged,
  savePointNotOfSession,
  savePointsTeamMember,
  sessionLineageRunning,
  sessionNotRestorable,
  sessionOwnerChanged,
  sessionRunningOnOtherAgent,
  SessionSavePointsService,
  transcriptSize,
} from '../session-save-points.service';
import type { SessionSavePointCopy } from '../../../providers/adapters/capabilities/session-fork.capability';
import { SessionLaunchPipeline, type ForkLaunchProvider } from './session-launch-pipeline.service';
import { getTranscriptSourceKind } from '../../../session-reader/services/transcript-path-validator.service';
import type {
  RestoreClaim,
  RollbackRecordCopy,
  SwitchConfigRefusal,
} from '../../../storage/sessions/session-row.store';
import { HooksService } from '../../../hooks/services/hooks.service';
import { publishAgentsUpdated } from '../../../events/catalog/agent.updated';
import {
  configNotFound,
  configProfileMismatch,
  getProfileConfigOrThrow,
} from '../../../profiles/services/profile-config-ownership';

const logger = createLogger('SessionRestorePipeline');

interface RestoreSourceRow {
  id: string;
  kind: 'session' | 'save_point';
  parent_session_id: string | null;
  epic_id: string | null;
  agent_id: string;
  tmux_session_id: string | null;
  status: SessionDetailDto['status'];
  started_at: string;
  ended_at: string | null;
  transcript_path: string | null;
  provider_session_id: string | null;
  provider_name_at_launch: string | null;
  created_at: string;
  updated_at: string;
}

export interface RestoreRequest {
  sessionId: string;
  projectId: string;
  /** The agent that runs the restored session; omitted, the session's owner. */
  targetAgentId?: string;
  replaceRunningSessionId?: string;
  /**
   * A config of the target agent's profile whose provider is the session's launch provider. The
   * restore switches the agent to it, with no model or effort override, in the claim.
   */
  switchToProviderConfigId?: string;
  /** Project write admission, checked again after the replacement stops and inside the claim. */
  admit: () => void;
  /** Stops a running session of `agentId` while the caller holds that agent's lock. */
  stopReplacement: (sessionId: string, agentId: string) => Promise<void>;
}

export interface RollbackRequest extends RollbackSessionDto {
  sessionId: string;
  /** Project write admission, checked before provider writes and inside the commit. */
  admit: () => void;
}

interface CheckedRollback {
  session: RestoreSourceRow;
  savePoint: { providerSessionId: string; transcriptPath: string };
  /** The conversation to keep as the `Before rollback` record, when one is requested and exists. */
  current: { providerSessionId: string; transcriptPath: string } | null;
  target: Awaited<ReturnType<SessionRestorePipeline['resolveLaunchTarget']>>;
  fork: ForkLaunchProvider;
}

/** The switch config and the profile it must belong to. */
interface SwitchConfigRef {
  configId: string;
  profileId: string;
}

function sameProviderName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function switchConfigProviderMismatch(details: Record<string, unknown> = {}): ConflictError {
  return new ConflictError("The switch config's provider is not the session's launch provider", {
    code: 'SWITCH_CONFIG_PROVIDER_MISMATCH',
    ...details,
  });
}

function restoreClaimLost(
  claim: Exclude<RestoreClaim, { outcome: 'claimed' }>,
  switchConfig: SwitchConfigRef,
): AppError {
  switch (claim.outcome) {
    case 'lineageRunning':
      return sessionLineageRunning(claim.running);
    case 'runningOnOtherAgent':
      return sessionRunningOnOtherAgent(claim.agentId);
    case 'invalidState':
      return sessionNotRestorable();
    case 'switchConfigRefused':
      return switchConfigRefused(claim.reason, switchConfig);
  }
}

function switchConfigRefused(
  reason: SwitchConfigRefusal,
  { configId, profileId }: SwitchConfigRef,
): AppError {
  switch (reason) {
    case 'configNotFound':
      return configNotFound(configId);
    case 'configProfileMismatch':
      return configProfileMismatch(configId, profileId);
    case 'providerMismatch':
      return switchConfigProviderMismatch();
  }
}

function rollbackStartFailed(error: unknown): AppError {
  const message = error instanceof Error ? error.message : String(error);
  return new AppError(
    `The session rolled back but did not start: ${message}`,
    'rollback_start_failed',
    error instanceof AppError ? error.statusCode : 500,
    { code: 'ROLLBACK_START_FAILED' },
  );
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
    private readonly sessionRows: SessionRowStore,
    private readonly launchPipeline: SessionLaunchPipeline,
    private readonly savePoints: SessionSavePointsService,
    private readonly hooks: HooksService,
  ) {
    this.sqlite = getRawSqliteClient(db);
  }

  /**
   * Checks a restore of the session into `targetAgentId` (omitted: the owner), on
   * `switchConfigId` when given. With `observedOwnerId`, the session must still belong to that agent.
   */
  private async checkRestore(
    sessionId: string,
    projectId: string,
    targetAgentId: string | undefined,
    switchConfigId: string | undefined,
    observedOwnerId?: string,
  ) {
    const source = this.readSessionRow(sessionId);
    if (!source) throw new NotFoundError('Session', sessionId);
    const targetId = targetAgentId ?? source.agent_id;
    if (observedOwnerId !== undefined && source.agent_id !== observedOwnerId) {
      this.validateRestorableKind(source.kind);
      this.checkNotRunningElsewhere(source, targetId);
      throw sessionOwnerChanged();
    }

    await this.assertAgentInProject(source.agent_id, projectId);
    if (targetId !== source.agent_id) {
      await this.assertAgentInProject(targetId, projectId);
      if (!this.sessionRows.listFamilyAgentIds(targetId).includes(source.agent_id)) {
        throw new ForbiddenError('The session belongs to an agent outside the target family', {
          code: 'SESSION_FAMILY_MISMATCH',
          agentId: source.agent_id,
          targetAgentId: targetId,
        });
      }
    }

    this.validateRestorableKind(source.kind);
    this.checkNotRunningElsewhere(source, targetId);
    this.validateRestorable(source);

    const target = await this.resolveLaunchTarget(
      targetId,
      projectId,
      source.epic_id,
      switchConfigId,
    );
    if (switchConfigId === undefined) {
      this.checkProviderMismatch(source, target.provider.name);
    } else {
      this.checkSwitchProvider(source, target.provider.name);
    }
    return { source, targetId, target };
  }

  /**
   * Restores a stopped or failed session in place, under its owner or under another agent of the
   * owner's family. The owner's and the target's locks are held from the checks to the end, so
   * the destination checks, the replacement stop, the claim (with any agent switch), the runtime
   * start and any cleanup run as one operation. A failure after the claim puts the session row
   * and the agent back.
   */
  async restore(request: RestoreRequest): Promise<SessionDetailDto> {
    const { sessionId, projectId, replaceRunningSessionId } = request;
    const switchConfigId = request.switchToProviderConfigId;
    const replacing = replaceRunningSessionId !== undefined;
    const first = await this.checkRestore(
      sessionId,
      projectId,
      request.targetAgentId,
      switchConfigId,
    );
    const ownerId = first.source.agent_id;
    const targetId = first.targetId;
    if (replacing) expectedReplacement(this.sessionRows, targetId, replaceRunningSessionId);

    return this.sessionCoordinator.withAgentLocks([ownerId, targetId], async () => {
      const cleanup = new CleanupStack();

      try {
        const { source: locked, target } = await this.checkRestore(
          sessionId,
          projectId,
          targetId,
          switchConfigId,
          ownerId,
        );
        const { agent, project, epic, provider, options, configEnv } = target;
        const switching = switchConfigId !== undefined;

        // Synchronous: the second call must run with no await before the stop.
        const checkEligible = (): string | null => {
          const replacementId = replacing
            ? expectedReplacement(this.sessionRows, targetId, replaceRunningSessionId)
            : null;
          if (!replacing) this.checkNoRunningSession(targetId, false);
          this.assertNoRunningLineage(sessionId, replacementId);
          return replacementId;
        };
        // Before any provider write: a refused restore must not repair MCP or provision trust.
        checkEligible();

        // Destination checks: a running replacement must not stop for a restore that cannot start.
        if (!provider.binPath) {
          throw new ValidationError(`Provider ${provider.name} is missing a binary path`, {
            providerId: provider.id,
          });
        }

        const adapter = this.providerAdapterFactory.getAdapter(provider.name);
        // A restored session re-enters a live agent conversation; if the
        // devchain MCP registration drifted since launch, the restored agent
        // runs without DevChain tools. This repair is also the ONLY restore
        // path that may write provider trust — the full ensureMcp includes it.
        await ensureMcpReadiness({
          storage: this.storage,
          preflightService: this.preflightService,
          mcpEnsureService: this.mcpEnsureService,
          launchRules: adapter,
          provider,
          projectId: project.id,
          projectRootPath: project.rootPath,
          configEnv,
          // The switch destination may be a provider that no project agent uses yet.
          requireProviderCheck: switching,
        });

        // Phase 5: create the read-only restore runtime plan
        const tmuxSessionName = this.tmuxSessionNameFor(project.name, locked, agent.id);

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
          // The switch clears the agent's overrides, so the plan must not apply them.
          agentModelOverride: switching ? null : agent.modelOverride,
          agentEffortOverride: switching ? null : agent.effortOverride,
          configModel: target.configModel,
          configEffort: target.configEffort,
          profileOptions: options,
          configEnv,
          sessionId: locked.id,
          tmuxSessionName,
        });

        // Again: the state can change during the preflight, the repair and the plan.
        const replacementId = checkEligible();
        if (replacementId) {
          // Checked under the held locks with no await before the stop starts: a freeze that
          // lands during the stop itself is caught by the admit after it, once the stop is done.
          request.admit();
          await request.stopReplacement(replacementId, targetId);
          request.admit();
          this.checkNoRunningSession(targetId, replacing);
        }
        const lockedAgent = await this.storage.getAgent(targetId);
        if (lockedAgent.disabled) {
          throw new AgentDisabledError(lockedAgent);
        }

        // Re-arms a replay clear only after this restore cancelled it, so it runs last on
        // rollback, after the row is put back. A lost claim never touches the winner's buffer.
        let cancelledRetentionMs: number | null = null;
        cleanup.push('rearmReplayRetention', async () => {
          if (cancelledRetentionMs !== null) {
            this.streamService.scheduleClear(locked.id, cancelledRetentionMs);
          }
        });

        // Phase 6: claim the row (BEFORE createTmuxSession)
        const now = new Date().toISOString();
        const claim = await this.sessionRows.claimRestore({
          sessionId: locked.id,
          ownerId,
          targetId,
          tmuxSessionName,
          now,
          admit: request.admit,
          agentSwitch: switching
            ? { providerConfigId: target.configId, providerId: provider.id }
            : undefined,
        });
        if (claim.outcome !== 'claimed') {
          throw restoreClaimLost(claim, {
            configId: target.configId,
            profileId: target.profile.id,
          });
        }
        const { agentRevert } = claim;
        cleanup.push('flipToRunning', async () => {
          const { agentReverted } = await this.sessionRows.rollbackRestore(
            locked,
            new Date().toISOString(),
            claim.movedSavePointIds,
            agentRevert ?? undefined,
          );
          if (agentReverted) await publishAgentsUpdated(this.eventsService, projectId, [targetId]);
        });
        // Synchronously after the claim and before the first buffer-producing await: a
        // retention deadline that passes during the start would clear the restored session.
        cancelledRetentionMs = this.streamService.cancelScheduledClear(locked.id);

        await this.startRuntime(
          locked,
          adapter,
          providerRuntimePlan,
          tmuxSessionName,
          project.rootPath,
          provider.name,
          cleanup,
        );
        if (agentRevert) await publishAgentsUpdated(this.eventsService, projectId, [targetId]);
        await this.publishRestored({
          sessionId: locked.id,
          epicId: locked.epic_id,
          agentId: agent.id,
          projectId,
          tmuxSessionName,
          providerName: provider.name,
          transcriptPath: locked.transcript_path,
          providerSessionId: locked.provider_session_id,
        });

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

  /** Preflight with no side effects. The session can still be the running session here. */
  async validateRollback(request: RollbackRequest) {
    const { session, target, fork } = await this.checkRollback(request);
    return {
      agentId: session.agent_id,
      project: target.project,
      configEnv: target.configEnv,
      provider: { ...target.provider, binPath: fork.providerBinPath },
    };
  }

  /**
   * Restarts a stopped or failed session at one of its save points on the same row. A failure
   * before the commit leaves the old binding. After the commit the row stays at the save point
   * even when the start fails; that error carries `ROLLBACK_START_FAILED`.
   */
  async rollback(request: RollbackRequest): Promise<SessionDetailDto> {
    const session = this.readSessionRow(request.sessionId);
    if (!session) throw new NotFoundError('Session', request.sessionId);
    const ownerId = session.agent_id;
    return this.sessionCoordinator.withAgentLock(ownerId, () =>
      this.rollbackUnderLock(request, ownerId),
    );
  }

  /** A rollback while the caller holds the lock of `ownerId`, the session's expected owner. */
  async rollbackUnderLock(request: RollbackRequest, ownerId: string): Promise<SessionDetailDto> {
    const cleanup = new CleanupStack();
    let committed = false;

    try {
      const checked = await this.checkRollback(request, ownerId);
      const { session: locked, target, fork } = checked;
      // The check passed, so the old runtime is stopped. From here its hooks are dropped at the
      // hook entry and again at the transcript bind (see `HooksService.firedBeforeFence`), so
      // none of them rebinds the row after the commit below.
      this.hooks.fenceRuntime(locked.id);
      const cancelledRetentionMs = this.streamService.cancelScheduledClear(locked.id);
      if (cancelledRetentionMs !== null) {
        cleanup.push('rearmReplayRetention', async () => {
          if (!committed) this.streamService.scheduleClear(locked.id, cancelledRetentionMs);
        });
      }
      const { agent, project, epic, provider, options, configEnv } = target;
      // The target resolved under the lock can be another config than the one checked before
      // the stop, so it gets its own provider and MCP readiness check before any provider write.
      await this.launchPipeline.verifyProvider(
        { ...provider, binPath: fork.providerBinPath },
        project.rootPath,
        project.id,
        configEnv,
      );

      // Must run before the plan: a Devin plan replaces the export that this copy reads.
      request.admit();
      const copy = checked.current
        ? await this.copyCurrentConversation(checked.current, checked)
        : null;
      const record = copy?.record ?? null;
      // The commit stores the copy as the `Before rollback` record; until then it is unbound.
      cleanup.push('discardRecordCopy', async () => {
        if (!committed) await copy?.discardUnboundTranscript?.();
      });

      const adapter = fork.adapter;
      const tmuxSessionName = this.tmuxSessionNameFor(project.name, locked, agent.id);
      const providerRuntimePlan = await this.providerRuntimePreparation.createPlan({
        mode: 'fork',
        adapter,
        savePoint: checked.savePoint,
        cliVersion: fork.cliVersion,
        helperEnv: fork.helperEnv,
        provider,
        providerBinPath: fork.providerBinPath,
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
      const binding = providerRuntimePlan.fork;
      // Best effort, as every cleanup step: a failed discard is logged and never replaces the
      // error that refused the commit.
      cleanup.push('discardRuntimeCopy', async () => {
        if (!committed) await providerRuntimePlan.discardUnboundTranscript?.();
      });

      const now = new Date().toISOString();
      if (!binding) {
        throw new ValidationError('Provider runtime plan is missing the fork binding');
      }
      const commit = await this.sessionRows.commitRollback({
        ...binding,
        sessionId: locked.id,
        ownerId,
        tmuxSessionName,
        now,
        record,
        admit: request.admit,
      });
      if (commit.outcome === 'lineageRunning') throw sessionLineageRunning(commit.running);
      if (commit.outcome === 'invalidState') {
        throw sessionNotRestorable();
      }
      committed = true;
      await providerRuntimePlan.commitBoundTranscript?.();
      cleanup.push('flipToRunning', async () => {
        await this.sessionRows.rollbackRestore(locked, new Date().toISOString());
      });

      // The old conversation's frames must not replay into the restarted session.
      this.streamService.retireReplay(locked.id);
      await this.launchPipeline.setupHooksConfig(provider, project.rootPath);

      await this.startRuntime(
        locked,
        adapter,
        providerRuntimePlan,
        tmuxSessionName,
        project.rootPath,
        provider.name,
        cleanup,
      );
      await this.publishRestored({
        sessionId: locked.id,
        epicId: locked.epic_id,
        agentId: agent.id,
        projectId: project.id,
        tmuxSessionName,
        providerName: provider.name,
        ...binding,
      });

      return {
        id: locked.id,
        epicId: locked.epic_id,
        agentId: agent.id,
        tmuxSessionId: tmuxSessionName,
        status: 'running' as const,
        startedAt: locked.started_at,
        endedAt: null,
        transcriptPath: binding.transcriptPath,
        createdAt: locked.created_at,
        updatedAt: now,
        epic: epic ? { id: epic.id, title: epic.title, projectId: epic.projectId } : null,
        agent: { id: agent.id, name: agent.name, profileId: agent.profileId },
        project: { id: project.id, name: project.name, rootPath: project.rootPath },
      };
    } catch (error) {
      await cleanup.rollback({ sessionId: request.sessionId });
      throw committed ? rollbackStartFailed(error) : error;
    }
  }

  /**
   * With `lockedOwnerId`, the checks run under that agent's lock, after any replacement stopped:
   * the session must then still belong to it, be stopped or failed, and no session of the agent
   * may run.
   */
  private async checkRollback(
    request: RollbackRequest,
    lockedOwnerId?: string,
  ): Promise<CheckedRollback> {
    const session = this.readSessionRow(request.sessionId);
    if (!session || session.kind !== 'session') {
      throw new NotFoundError('Session', request.sessionId);
    }
    for (const owner of [request.expectedAgentId, lockedOwnerId]) {
      if (owner !== undefined && session.agent_id !== owner) throw sessionOwnerChanged();
    }
    const agent = await this.storage.getAgent(session.agent_id);
    if (agent.projectId !== request.projectId) {
      throw new ForbiddenError('Agent does not belong to the specified project', {
        agentId: session.agent_id,
        projectId: request.projectId,
      });
    }
    const savePoint = this.readSessionRow(request.savePointId);
    if (
      savePoint?.kind !== 'save_point' ||
      savePoint.parent_session_id !== session.id ||
      savePoint.agent_id !== session.agent_id
    ) {
      throw savePointNotOfSession();
    }
    if (!savePoint.provider_session_id || !savePoint.transcript_path) {
      throw new ConflictError('Save point has no provider session ID', {
        code: 'NO_PROVIDER_SESSION_ID',
      });
    }
    if (lockedOwnerId !== undefined) {
      if (session.status !== 'stopped' && session.status !== 'failed') {
        throw sessionNotRestorable();
      }
      this.checkNoRunningSession(session.agent_id, request.replaceRunningSessionId !== undefined);
      // Again after the replacement stopped, before the provider writes its copies.
      this.assertNoRunningLineage(session.id, null);
    }

    const target = await this.resolveLaunchTarget(
      session.agent_id,
      request.projectId,
      session.epic_id,
    );
    const providerName = target.provider.name;
    this.checkProviderMismatch(session, providerName);
    this.checkProviderMismatch(savePoint, providerName);
    const fork = await this.launchPipeline.requireForkSupport(target);
    if (await this.savePoints.isTeamMember(session.agent_id, request.projectId)) {
      throw savePointsTeamMember();
    }
    const source = await this.launchPipeline.readableForkSource(
      {
        providerSessionId: savePoint.provider_session_id,
        transcriptPath: savePoint.transcript_path,
      },
      fork.adapter,
      providerName,
    );
    const current =
      request.keepCurrent && session.provider_session_id && session.transcript_path
        ? {
            providerSessionId: session.provider_session_id,
            transcriptPath: await this.savePoints.readableTranscript(
              session.transcript_path,
              providerName,
            ),
          }
        : null;
    return { session, savePoint: source, current, target, fork };
  }

  private async copyCurrentConversation(
    current: NonNullable<CheckedRollback['current']>,
    { target, fork }: CheckedRollback,
  ): Promise<
    { record: RollbackRecordCopy } & Pick<SessionSavePointCopy, 'discardUnboundTranscript'>
  > {
    const { provider, project, configEnv } = target;
    const copy = await fork.adapter.createSavePoint({
      ...current,
      projectId: project.id,
      projectPath: project.rootPath,
      providerBinPath: fork.providerBinPath,
      // A fresh ID: the adapter names provider files after it, and replaced records keep theirs.
      sessionId: randomUUID(),
      cliVersion: fork.cliVersion,
      env: { ...this.storage.getProviderEnvForProject(provider.id, project.id), ...configEnv },
      helperEnv: fork.helperEnv,
    });
    try {
      const transcriptPath = await this.savePoints.readableTranscript(
        copy.transcriptPath,
        provider.name,
      );
      const sizeBytes =
        getTranscriptSourceKind(provider.name) === 'file'
          ? await transcriptSize(transcriptPath)
          : null;
      return {
        record: { providerSessionId: copy.providerSessionId, transcriptPath, sizeBytes },
        discardUnboundTranscript: copy.discardUnboundTranscript,
      };
    } catch (error) {
      await copy.discardUnboundTranscript?.().catch(() => undefined);
      throw error;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────────────────

  private tmuxSessionNameFor(
    projectName: string,
    row: Pick<RestoreSourceRow, 'id' | 'epic_id'>,
    agentId: string,
  ): string {
    const projectSlug = projectName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');
    return buildTmuxSessionName(projectSlug, row.epic_id ?? 'independent', agentId, row.id);
  }

  /** Phases 7 and 8 of a restore, after the row is running: materialize, tmux, stream, type. */
  private async startRuntime(
    row: Pick<RestoreSourceRow, 'id' | 'provider_name_at_launch'>,
    adapter: ProviderAdapter,
    providerRuntimePlan: ProviderRuntimePlan,
    tmuxSessionName: string,
    projectRootPath: string,
    providerName: string,
    cleanup: CleanupStack,
  ): Promise<void> {
    const providerRuntime = await this.providerRuntimePreparation.materialize(providerRuntimePlan);
    cleanup.push('providerRuntime', providerRuntime.rollback);

    // Phase 7: createTmuxSession
    await this.terminalIO.createEmptySession(tmuxSessionName, { cwd: projectRootPath });
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
    this.terminalIO.startHealthCheck(tmuxSessionName, row.id);

    // Phase 8: bindStreaming (BEFORE issuing the restore command)
    // The row was stopped/failed (validated under the agent lock), so any
    // surviving registry entry is stale — dispose it instead of failing
    // with "TerminalSession already exists".
    if (this.terminalSessionRegistry.get(row.id)) {
      logger.warn(
        { sessionId: row.id },
        'Stale TerminalSession registry entry found during restore — disposing',
      );
      this.ptyService.stopStreaming(row.id);
      this.terminalSessionRegistry.dispose(row.id);
    }
    this.terminalSessionRegistry.create(row.id, tmuxSessionName, {
      normalizeCapturedLineEndings: true,
    });
    cleanup.push('bindStreaming', async () => {
      this.terminalSessionRegistry.dispose(row.id);
    });

    await this.ptyService.startStreaming(row.id, tmuxSessionName);
    this.terminalSessionRegistry.bind(row.id, this.terminalIO);

    // Issue the restore command — streaming is bound, output is captured
    await this.terminalIO.typeCommand({ name: tmuxSessionName }, providerRuntime.typedArgs);
    await providerRuntime.afterCommand();
    if (row.provider_name_at_launch === null) {
      this.sessionRows.bindRestoredProvider(row.id, providerName);
    }
  }

  /** Phase 9: emit session.restored (NOT session.started), the transcript, and presence. */
  private async publishRestored(input: {
    sessionId: string;
    epicId: string | null;
    agentId: string;
    projectId: string;
    tmuxSessionName: string;
    providerName: string;
    transcriptPath: string | null;
    providerSessionId: string | null;
  }): Promise<void> {
    const providerName = input.providerName.toLowerCase();
    await this.eventsService.publish('session.restored', {
      sessionId: input.sessionId,
      epicId: input.epicId,
      agentId: input.agentId,
      tmuxSessionName: input.tmuxSessionName,
      providerName,
    });

    if (input.transcriptPath) {
      await this.eventsService.publish('session.transcript.discovered', {
        sessionId: input.sessionId,
        agentId: input.agentId,
        projectId: input.projectId,
        transcriptPath: input.transcriptPath,
        providerName,
        // Re-emit the provider session id so DB-source watchers (agy/opencode) start.
        // Without it the watcher skips (`transcript-watcher.service.ts` DB branch) and a
        // restored DB conversation never receives live updates. Mirrors the launch path.
        providerSessionId: input.providerSessionId ?? undefined,
      });
    }

    try {
      await this.eventsService.publish('session.presence.changed', {
        agentId: input.agentId,
        online: true,
        sessionId: input.sessionId,
      });
    } catch {
      // Non-fatal
    }
  }

  private readSessionRow(sessionId: string): RestoreSourceRow | undefined {
    return this.sqlite
      .prepare(
        `SELECT id, kind, parent_session_id, epic_id, agent_id, tmux_session_id, status, started_at, ended_at,
                transcript_path, provider_session_id, provider_name_at_launch, created_at, updated_at
         FROM sessions WHERE id = ?`,
      )
      .get(sessionId) as RestoreSourceRow | undefined;
  }

  /** Refuses to set the session running while a row other than `replacementId` shares its identity. */
  assertNoRunningLineage(sessionId: string, replacementId: string | null): void {
    const running = this.sessionRows.findRunningLineage(sessionId, replacementId);
    if (running) throw sessionLineageRunning(running);
  }

  assertRestorableKind(sessionId: string): void {
    const row = this.readSessionRow(sessionId);
    if (!row) throw new NotFoundError('Session', sessionId);
    this.validateRestorableKind(row.kind);
  }

  private validateRestorableKind(kind: RestoreSourceRow['kind']): void {
    if (kind === 'save_point') {
      throw new ConflictError('Save points cannot be restored', {
        code: 'SAVE_POINT_NOT_RESTORABLE',
      });
    }
  }

  /** A row that runs on another agent than the restore target is that agent's lease. */
  private checkNotRunningElsewhere(row: RestoreSourceRow, targetId: string): void {
    if (row.status === 'running' && row.agent_id !== targetId) {
      throw sessionRunningOnOtherAgent(row.agent_id);
    }
  }

  private async assertAgentInProject(agentId: string, projectId: string): Promise<void> {
    const agent = await this.storage.getAgent(agentId);
    if (agent.projectId !== projectId) {
      throw new ForbiddenError('Agent does not belong to the specified project', {
        agentId,
        projectId,
      });
    }
  }

  private validateRestorable(row: RestoreSourceRow): void {
    this.validateRestorableKind(row.kind);
    if (row.status !== 'stopped' && row.status !== 'failed') {
      throw sessionNotRestorable();
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
      !sameProviderName(currentProviderName, row.provider_name_at_launch)
    ) {
      throw new ConflictError('Current provider differs from launch-time provider', {
        code: 'PROVIDER_MISMATCH',
      });
    }
  }

  private checkSwitchProvider(row: RestoreSourceRow, switchProviderName: string): void {
    if (
      !row.provider_name_at_launch ||
      !sameProviderName(switchProviderName, row.provider_name_at_launch)
    ) {
      throw switchConfigProviderMismatch({
        launchProvider: row.provider_name_at_launch,
        switchProvider: switchProviderName,
      });
    }
  }

  private checkNoRunningSession(agentId: string, replacing: boolean): void {
    const running = this.sqlite
      .prepare(`SELECT id FROM sessions WHERE agent_id = ? AND status = 'running' LIMIT 1`)
      .get(agentId);
    if (running) {
      if (replacing) throw runningSessionChanged();
      throw new ConflictError('Agent already has a running session', {
        code: 'INVALID_SESSION_STATE',
      });
    }
  }

  /** With `switchConfigId`, launches on that config of the agent's profile and never another. */
  private async resolveLaunchTarget(
    agentId: string,
    projectId: string,
    epicId: string | null,
    switchConfigId?: string,
  ) {
    const agent = await this.storage.getAgent(agentId);
    if (agent.disabled) {
      throw new AgentDisabledError(agent);
    }
    const project = await this.storage.getProject(projectId);
    const epic = epicId ? await this.storage.getEpic(epicId).catch(() => null) : null;
    const profile = await this.storage.getAgentProfile(agent.profileId);

    let config: ProfileProviderConfig | undefined;
    if (switchConfigId !== undefined) {
      config = await getProfileConfigOrThrow(this.storage, switchConfigId, profile.id);
    } else {
      const configs = await this.storage.listProfileProviderConfigsByProfile(profile.id);
      config = agent.providerConfigId
        ? (configs.find((c) => c.id === agent.providerConfigId) ?? configs[0])
        : configs[0];
    }

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
      configId: config.id,
      options: config.options,
      configEnv: config.env,
      // Structured model/effort defaults remain separate so runtime planning
      // applies the same precedence contract as a fresh launch.
      configModel: config.model,
      configEffort: config.effort,
    };
  }
}
