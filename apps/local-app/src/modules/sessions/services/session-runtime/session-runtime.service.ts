import { Injectable } from '@nestjs/common';
import { SessionLaunchPipeline } from './session-launch-pipeline.service';
import { SessionRestorePipeline } from './session-restore-pipeline.service';
import type {
  LaunchSessionDto,
  RestoreSessionDto,
  RollbackSessionDto,
  SessionDetailDto,
  StartFromSavePointDto,
} from '../../dtos/sessions.dto';
import { ProjectWriteGate } from '../../../storage/write-gate/project-write-gate';
import { SessionsService } from '../sessions.service';
import { SessionCoordinatorService } from '../session-coordinator.service';
import { NotFoundError } from '../../../../common/errors/error-types';
import { expectedReplacement, sessionOwnerChanged } from '../session-save-points.service';

export type RestoreOptions = Pick<
  RestoreSessionDto,
  'replaceRunningSessionId' | 'targetAgentId' | 'switchToProviderConfigId'
>;

/** Every launch and restore, including automatic ones, enters here. */
@Injectable()
export class SessionRuntime {
  constructor(
    private readonly launchPipeline: SessionLaunchPipeline,
    private readonly restorePipeline: SessionRestorePipeline,
    private readonly gate: ProjectWriteGate,
    private readonly sessions: SessionsService,
    private readonly coordinator: SessionCoordinatorService,
  ) {}

  async launch(data: LaunchSessionDto): Promise<SessionDetailDto> {
    // Admit before launching tmux and provider processes.
    this.gate.assertWritable(data.projectId);
    return this.launchPipeline.launch(data);
  }

  /** Refuses with the launch's own provider error; a restart calls it before it terminates. */
  async verifyAgentProvider(agentId: string, projectId: string): Promise<void> {
    // Admit before the MCP repair and the trust writes.
    this.gate.assertWritable(projectId);
    return this.launchPipeline.verifyAgentProvider(agentId, projectId);
  }

  async startFromSavePoint(
    savePointId: string,
    request: StartFromSavePointDto,
  ): Promise<SessionDetailDto> {
    const { projectId, replaceRunningSessionId, expectedAgentId } = request;
    const admit = () => this.gate.assertWritable(projectId);
    // Admit before provider and MCP preflight.
    admit();
    const { agentId } = await this.sessions.validateSessionInProject(savePointId, projectId);
    if (expectedAgentId !== undefined && agentId !== expectedAgentId) throw sessionOwnerChanged();
    const data = { agentId, projectId };
    const { provider, project, configEnv } = await this.launchPipeline.validateFork(
      data,
      savePointId,
      replaceRunningSessionId,
    );
    this.getReplacement(agentId, replaceRunningSessionId);
    await this.launchPipeline.verifyProvider(provider, project.rootPath, projectId, configEnv);

    // One hold of the lock covers the owner check, the stop and the fork: the source cannot move
    // to another agent in between, and a source that moved before stops nothing.
    return this.coordinator.withAgentLock(agentId, async () => {
      this.assertOwner(savePointId, agentId);
      // Ends with the busy check of a running source; nothing awaits between it and the stop.
      const forkProvider = await this.launchPipeline.assertCurrentForkProvider(
        data,
        savePointId,
        replaceRunningSessionId,
      );
      await this.stopReplacementUnderLock(agentId, projectId, replaceRunningSessionId, (replaced) =>
        this.launchPipeline.assertNoRunningForkLineage(savePointId, replaced),
      );
      // Recheck after termination, before fork preparation calls the provider.
      admit();
      return this.launchPipeline.launchUnderLock(data, {
        savePointId,
        admit,
        provider: forkProvider,
      });
    });
  }

  async restore(
    sessionId: string,
    projectId: string,
    options: RestoreOptions = {},
  ): Promise<SessionDetailDto> {
    const admit = () => this.gate.assertWritable(projectId);
    // Admit before restoring tmux and provider processes.
    admit();
    return this.restorePipeline.restore({
      sessionId,
      projectId,
      ...options,
      admit,
      stopReplacement: (replacementId, agentId) => this.stopReplacement(replacementId, agentId),
    });
  }

  /** Restarts a session at one of its save points on the same row. */
  async rollback(sessionId: string, input: RollbackSessionDto): Promise<SessionDetailDto> {
    const admit = () => this.gate.assertWritable(input.projectId);
    // Admit before provider and MCP preflight.
    admit();
    const request = { ...input, sessionId, admit };
    const { agentId, provider, project, configEnv } =
      await this.restorePipeline.validateRollback(request);
    this.getReplacement(agentId, input.replaceRunningSessionId);
    await this.launchPipeline.verifyProvider(provider, project.rootPath, project.id, configEnv);

    // As for a fork, one hold of the lock covers the owner check, the stop and the rollback.
    return this.coordinator.withAgentLock(agentId, async () => {
      this.assertOwner(sessionId, agentId);
      await this.stopReplacementUnderLock(
        agentId,
        input.projectId,
        input.replaceRunningSessionId,
        (replaced) => this.restorePipeline.assertNoRunningLineage(sessionId, replaced),
      );
      // Recheck after termination, before the rollback calls the provider.
      admit();
      return this.restorePipeline.rollbackUnderLock(request, agentId);
    });
  }

  assertRestorableKind(sessionId: string): void {
    this.restorePipeline.assertRestorableKind(sessionId);
  }

  private getReplacement(agentId: string, expectedSessionId: string | undefined): string | null {
    return expectedReplacement(this.sessions, agentId, expectedSessionId);
  }

  /** Stops a confirmed replacement while the caller holds the lock of `agentId`. */
  private stopReplacement(sessionId: string, agentId: string): Promise<void> {
    return this.sessions.terminateSessionUnderLock(
      sessionId,
      { source: 'web-api', reason: 'restart' },
      agentId,
    );
  }

  private assertOwner(sessionId: string, agentId: string): void {
    const session = this.sessions.getSession(sessionId);
    if (!session) throw new NotFoundError('Session', sessionId);
    if (session.agentId !== agentId) throw sessionOwnerChanged();
  }

  /**
   * Stops the confirmed replacement after `assertMayRun` accepts it as the one running row the
   * request may share an identity with; a refused request stops nothing.
   */
  private async stopReplacementUnderLock(
    agentId: string,
    projectId: string,
    expectedSessionId: string | undefined,
    assertMayRun: (replacementId: string | null) => void,
  ): Promise<void> {
    this.gate.assertWritable(projectId);
    const sessionId = this.getReplacement(agentId, expectedSessionId);
    assertMayRun(sessionId);
    if (sessionId) await this.stopReplacement(sessionId, agentId);
  }
}
