import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { ConflictError, NotFoundError, ValidationError } from '../../../common/errors/error-types';
import { ProviderAdapterFactory } from '../../providers/adapters/provider-adapter.factory';
import { isSessionForkCapable } from '../../providers/adapters/capabilities/type-guards';
import type { SessionForkCapability } from '../../providers/adapters/capabilities/session-fork.capability';
import type { ProviderAdapter } from '../../providers/adapters/provider-adapter.interface';
import { ProviderCliVersionProbe } from '../../providers/services/provider-cli-version-probe.service';
import {
  getTranscriptSourceKind,
  TranscriptPathValidator,
} from '../../session-reader/services/transcript-path-validator.service';
import {
  STORAGE_SERVICE,
  type AgentStorage,
  type ProfileProviderConfigStorage,
  type ProjectStorage,
  type ProviderStorage,
} from '../../storage/interfaces/storage.interface';
import type { Agent } from '../../storage/models/domain.models';
import {
  isBeforeRollbackRecord,
  SessionRowStore,
  type RunningLineageSession,
  type SessionListScope,
  type SessionTreeCursor,
  type SessionTreeRow,
} from '../../storage/sessions/session-row.store';
import { ProjectWriteGate } from '../../storage/write-gate/project-write-gate';
import { TeamsStore } from '../../teams/storage/teams.store';
import type {
  SavePointAvailabilityDto,
  SessionDto,
  SessionTreeNodeDto,
  SessionTreeResponseDto,
} from '../dtos/sessions.dto';
import { buildForkHelperEnv } from './provider-launch-config/provider-launch-config.service';
import { SessionCoordinatorService } from './session-coordinator.service';
import { SessionsService } from './sessions.service';

export interface ForkProviderSupport {
  adapter: ProviderAdapter & SessionForkCapability;
  executable?: {
    providerBinPath: string;
    cliVersion: string;
    helperEnv: Readonly<Record<string, string>>;
  };
}

@Injectable()
export class SessionSavePointsService {
  constructor(
    @Inject(STORAGE_SERVICE)
    private readonly storage: AgentStorage &
      Pick<ProjectStorage, 'getProject'> &
      Pick<ProfileProviderConfigStorage, 'listProfileProviderConfigsByProfile'> &
      Pick<
        ProviderStorage,
        'getProvider' | 'listProviderSettingsSources' | 'getProviderEnvForProject'
      >,
    private readonly sessions: SessionsService,
    private readonly sessionRows: SessionRowStore,
    private readonly coordinator: SessionCoordinatorService,
    private readonly adapters: ProviderAdapterFactory,
    private readonly transcripts: TranscriptPathValidator,
    private readonly teams: TeamsStore,
    private readonly gate: ProjectWriteGate,
    private readonly cliVersionProbe: ProviderCliVersionProbe,
  ) {}

  async createSavePoint(sessionId: string, projectId: string): Promise<SessionTreeNodeDto> {
    const { agentId } = await this.sessions.validateSessionInProject(sessionId, projectId);
    return this.coordinator.withAgentLock(agentId, async () => {
      const source = await this.sessions.validateSessionInProject(sessionId, projectId);
      assertRunningIdle(source, agentId);
      if (!source.providerSessionId || !source.transcriptPath) {
        throw new ConflictError('The session has no provider session ID or transcript', {
          code: 'NO_PROVIDER_SESSION_ID',
        });
      }

      const providerName = source.providerNameAtLaunch?.toLowerCase();
      if (!providerName) throw savePointsUnsupportedProvider();
      const { providerBinPath: configuredBinPath, env } = await this.resolveSourceProvider(
        agentId,
        projectId,
        providerName,
      );
      const project = await this.storage.getProject(projectId);
      const support = await this.getForkSupport(
        providerName,
        configuredBinPath,
        env,
        project.rootPath,
      );
      if (!support) throw savePointsUnsupportedProvider();
      if (await this.isTeamMember(agentId, projectId)) throw savePointsTeamMember();
      const { adapter, executable } = support;
      const providerBinPath = executable?.providerBinPath ?? configuredBinPath;
      if (!providerBinPath) throw new ValidationError('The session provider binary is unavailable');

      const helperEnv = executable?.helperEnv ?? buildForkHelperEnv(adapter, env);
      const transcriptPath = await this.readableTranscript(source.transcriptPath, providerName);
      // Activity can change independently of the lifecycle lock during the transcript check.
      const current = this.sessionRows.getSession(sessionId);
      assertRunningIdle(current, agentId);
      // The provider may write a transcript before the session row is inserted.
      this.gate.assertWritable(projectId);
      const id = randomUUID();
      const copy = await adapter.createSavePoint({
        providerSessionId: source.providerSessionId,
        transcriptPath,
        projectId,
        projectPath: project.rootPath,
        providerBinPath,
        sessionId: id,
        cliVersion: executable?.cliVersion,
        env,
        helperEnv,
      });
      const copyPath = await this.readableTranscript(copy.transcriptPath, providerName);
      // The insert refuses a copy that a turn started under: such a copy can hold an unfinished turn.
      const outcome = await this.sessionRows.insertSavePoint({
        sessionId: id,
        sourceSessionId: sessionId,
        sourceBusySince: current?.busySince ?? null,
        providerSessionId: copy.providerSessionId,
        transcriptPath: copyPath,
        sizeBytes:
          getTranscriptSourceKind(providerName) === 'file' ? await transcriptSize(copyPath) : null,
        now: new Date().toISOString(),
        admit: () => this.gate.assertWritable(projectId),
      });
      if (outcome === 'busy') throw sessionBusy();
      if (outcome === 'notRunning') throw sessionNotRunning();

      const row = this.sessionRows.getSessionTreeRow(id);
      if (!row) throw new NotFoundError('Session', id);
      return toTreeNode(row);
    });
  }

  async isTeamMember(agentId: string, projectId: string): Promise<boolean> {
    const projectTeams = (await this.teams.listTeamsByAgent(agentId)).filter(
      (team) => team.projectId === projectId,
    );
    return (
      projectTeams.length > 0 && !projectTeams.some((team) => team.teamLeadAgentId === agentId)
    );
  }

  async getAgentSessionTree(
    agentId: string,
    projectId: string,
    cursor: string | undefined,
    limit: number,
    scope: SessionListScope = 'agent',
  ): Promise<SessionTreeResponseDto> {
    const agent = await this.storage.getAgent(agentId);
    if (agent.projectId !== projectId) throw new ForbiddenException('PROJECT_MISMATCH');

    const savePoints = await this.getAvailability(agent, projectId);
    const { rows, total, next } = this.sessionRows.getSessionTreePage(
      agentId,
      decodeTreeCursor(cursor),
      limit,
      scope,
    );
    return {
      items: await Promise.all(rows.map(withResolvedSize)),
      total,
      hasMore: next !== null,
      nextCursor: next ? Buffer.from(JSON.stringify(next)).toString('base64url') : null,
      savePoints,
    };
  }

  private async getAvailability(
    agent: Agent,
    projectId: string,
  ): Promise<SavePointAvailabilityDto> {
    if (await this.isTeamMember(agent.id, projectId)) {
      return { available: false, reason: 'TEAM_MEMBER' };
    }
    const config = await this.getCurrentProviderConfig(agent);
    const provider = config ? await this.storage.getProvider(config.providerId) : null;
    const project = await this.storage.getProject(projectId);
    const support = provider
      ? await this.getForkSupport(
          provider.name,
          provider.binPath,
          { ...this.storage.getProviderEnvForProject(provider.id, projectId), ...config?.env },
          project.rootPath,
        ).catch(() => null)
      : null;
    if (!support) {
      return { available: false, reason: 'PROVIDER_UNSUPPORTED' };
    }
    return { available: true };
  }

  async getForkSupport(
    providerName: string,
    binPath: string | null,
    env: Readonly<Record<string, string>>,
    projectPath: string,
  ): Promise<ForkProviderSupport | null> {
    if (!this.adapters.isSupported(providerName)) return null;
    const adapter = this.adapters.getAdapter(providerName);
    if (!isSessionForkCapable(adapter)) return null;
    if (!adapter.requiresCliVersion && !adapter.supportsForkForVersion) return { adapter };
    if (!binPath) return null;

    const helperEnv = buildForkHelperEnv(adapter, env);
    const executable = await this.cliVersionProbe.probeForFork(
      providerName.toLowerCase(),
      binPath,
      helperEnv,
      projectPath,
    );
    if (!executable || adapter.supportsForkForVersion?.(executable.cliVersion) === false) {
      return null;
    }
    return { adapter, executable: { ...executable, helperEnv } };
  }

  private async getCurrentProviderConfig(agent: Agent) {
    const configs = await this.storage.listProfileProviderConfigsByProfile(agent.profileId);
    return configs.find((config) => config.id === agent.providerConfigId) ?? configs[0];
  }

  private async resolveSourceProvider(agentId: string, projectId: string, providerName: string) {
    const agent = await this.storage.getAgent(agentId);
    const config = await this.getCurrentProviderConfig(agent);
    let provider = config ? await this.storage.getProvider(config.providerId) : null;
    const matches = provider?.name.toLowerCase() === providerName;
    if (!matches) {
      const historical = this.storage
        .listProviderSettingsSources()
        .find(({ name }) => name.toLowerCase() === providerName);
      provider = historical ? await this.storage.getProvider(historical.id) : null;
    }
    return {
      providerBinPath: provider?.binPath ?? null,
      env: {
        ...(provider && this.storage.getProviderEnvForProject(provider.id, projectId)),
        ...(matches ? config?.env : null),
      },
    };
  }

  /** The validated real path. Save point and Fork both read a stored transcript path. */
  async readableTranscript(transcriptPath: string, providerName: string): Promise<string> {
    try {
      const file = await this.transcripts.validateForRead(transcriptPath, providerName);
      await access(file, constants.R_OK);
      return file;
    } catch {
      throw new ValidationError(
        'The session transcript is missing, unreadable, or outside provider roots',
      );
    }
  }
}

export function savePointsUnsupportedProvider(): ConflictError {
  return new ConflictError('The session provider does not support save points', {
    code: 'SAVE_POINTS_UNSUPPORTED_PROVIDER',
  });
}

export function savePointNotOfSession(): ConflictError {
  return new ConflictError('The save point does not belong to this session', {
    code: 'SAVE_POINT_NOT_OF_SESSION',
  });
}

export function savePointsTeamMember(): ConflictError {
  return new ConflictError('Save points are unavailable for team members', {
    code: 'SAVE_POINTS_TEAM_MEMBER',
  });
}

/** A replacement was confirmed for a session that is no longer the agent's running session. */
export function runningSessionChanged(): ConflictError {
  return new ConflictError('The running session changed', { code: 'RUNNING_SESSION_CHANGED' });
}

/** A running row shares an id of the identity set the request would set running. */
export function sessionLineageRunning(running: RunningLineageSession): ConflictError {
  const agent = running.agentName ?? running.agentId ?? 'unknown';
  return new ConflictError(`A related session is running on agent "${agent}"`, {
    code: 'SESSION_LINEAGE_RUNNING',
    sessionId: running.sessionId,
    agentId: running.agentId,
    agentName: running.agentName,
  });
}

/** The session is not stopped or failed, so restore and roll back cannot set it running. */
export function sessionNotRestorable(): ConflictError {
  return new ConflictError('Session is not in a restorable state', {
    code: 'INVALID_SESSION_STATE',
  });
}

/** The session runs on another agent: that agent holds its lease. */
export function sessionRunningOnOtherAgent(agentId: string | null): ConflictError {
  return new ConflictError('The session is running on another agent', {
    code: 'SESSION_RUNNING_ON_OTHER_AGENT',
    agentId,
  });
}

/** The agent's running session, which must be the confirmed replacement when there is one. */
export function expectedReplacement(
  sessions: { getActiveSessionForAgent(agentId: string): { id: string } | null },
  agentId: string,
  expectedSessionId: string | undefined,
): string | null {
  const running = sessions.getActiveSessionForAgent(agentId);
  if (running && running.id !== expectedSessionId) throw runningSessionChanged();
  return running?.id ?? null;
}

/** The session belongs to another agent than the one the request expected or locked. */
export function sessionOwnerChanged(): ConflictError {
  return new ConflictError('The session belongs to another agent', {
    code: 'SESSION_OWNER_CHANGED',
  });
}

function sessionNotRunning(): ConflictError {
  return new ConflictError('The session is not running', { code: 'SESSION_NOT_RUNNING' });
}

export function sessionBusy(): ConflictError {
  return new ConflictError('The session is busy', { code: 'SESSION_BUSY' });
}

function assertRunningIdle(session: SessionDto | null, agentId: string): void {
  if (session?.agentId !== agentId || session.status !== 'running') throw sessionNotRunning();
  if (session.activityState === 'busy') throw sessionBusy();
}

/** Best-effort: a missing or unreadable file leaves the size unknown. */
export async function transcriptSize(transcriptPath: string): Promise<number | null> {
  try {
    return (await stat(transcriptPath)).size;
  } catch {
    return null;
  }
}

function toTreeNode(row: SessionTreeRow): SessionTreeNodeDto {
  return {
    id: row.id,
    agentId: row.agentId,
    agentName: row.agentName,
    kind: row.kind,
    parentSessionId: row.parentSessionId,
    status: row.status,
    providerSessionId: row.providerSessionId,
    providerNameAtLaunch: row.providerNameAtLaunch,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    lastActivityAt: row.lastActivityAt,
    sizeBytes: row.sizeBytes,
    transcriptAvailable: row.transcriptPath !== null,
    name: row.name,
    beforeRollback: isBeforeRollbackRecord(row),
  };
}

async function withResolvedSize(row: SessionTreeRow): Promise<SessionTreeNodeDto> {
  const node = toTreeNode(row);
  if (
    node.sizeBytes === null &&
    row.transcriptPath !== null &&
    row.status !== 'running' &&
    getTranscriptSourceKind(row.providerNameAtLaunch) === 'file'
  ) {
    node.sizeBytes = await transcriptSize(row.transcriptPath);
  }
  return node;
}

function decodeTreeCursor(cursor: string | undefined): SessionTreeCursor | null {
  if (!cursor) return null;
  try {
    const pair = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    ) as Partial<SessionTreeCursor> | null;
    return typeof pair?.s === 'string' && typeof pair.i === 'string'
      ? { s: pair.s, i: pair.i }
      : null;
  } catch {
    return null;
  }
}
