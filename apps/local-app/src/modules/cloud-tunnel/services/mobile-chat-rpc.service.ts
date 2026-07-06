import { Inject, Injectable } from '@nestjs/common';
import { StorageService, STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import type { Agent } from '../../storage/models/domain.models';
import {
  AppError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../../../common/errors/error-types';
import { ActiveSessionLookup } from '../../sessions/services/active-session-lookup.service';
import { SessionLifecycleFacade } from '../../sessions/services/session-lifecycle-facade.service';
import type { SessionDto, SessionHistoryResponseDto } from '../../sessions/dtos/sessions.dto';
import {
  SessionReaderService,
  type TranscriptSummaryWithCursor,
  type UnifiedChunkedResponse,
  type TranscriptTailResponse,
} from '../../session-reader/services/session-reader.service';
import { TranscriptWatcherService } from '../../session-reader/services/transcript-watcher.service';
import { AgentMessageDeliveryService } from '../../agent-message-delivery/agent-message-delivery.service';
import {
  SessionsMessageLogReadFacade,
  type PendingMobileMessage,
} from '../../sessions/services/sessions-message-log-read.facade';
import { TeamsService } from '../../teams/services/teams.service';
import { PendingAskUserQuestionService } from '../../hooks/services/pending-ask-user-question.service';
import type { NormalizedAskUserQuestion } from '../../events/catalog/claude.hooks.ask_user_question.pending';
import { LifecycleOperationTracker, type LifecycleOperation } from './lifecycle-operation-tracker';

/** Per-agent item returned by `chat.listAgents` (serialized over the tunnel). */
export interface MobileChatAgent {
  id: string;
  name: string;
  /** Discriminator so Task 9 can exclude non-agents from lifecycle. Always 'agent' here. */
  type: 'agent';
  /** Profile (role) display name, resolved from the agent's profileId. */
  profileName?: string;
  /** Provider display name (e.g. 'claude'), resolved via the provider config. */
  providerName?: string;
  /** Provider CONFIGURATION name (the user-named config), resolved via the provider config. */
  providerConfigName?: string;
  /** True when the agent currently has a running session. */
  online: boolean;
  /** Running session id, when online. */
  sessionId?: string;
  /** Persisted activity state of the running session. */
  activityState?: 'idle' | 'busy' | null;
  /**
   * Latest transcript `messageCount` for the agent's running session, sourced
   * O(1) from the {@link TranscriptWatcherService} watcher cache. Present only
   * for online agents and only when the watcher has a cached count; mobile
   * derives `unread = latestMessageCount − lastReadMessageCount`. Best-effort:
   * omitted (no badge) when the watcher has no entry or its lookup throws.
   */
  latestMessageCount?: number;
}

/**
 * Per-team item returned by `chat.listTeams` (serialized over the tunnel). The
 * client groups chat agents by team using this; `memberAgentIds` is in
 * `teamMembers` insertion order (same as `getTeam` member order) so the lead can
 * be rendered first + members in backend order.
 */
export interface MobileChatTeam {
  id: string;
  name: string;
  /** Team lead agent UUID, or null when the team has no lead. */
  teamLeadAgentId: string | null;
  /** Member agent UUIDs in teamMembers insertion order. */
  memberAgentIds: string[];
  /** Convenience count = memberAgentIds.length. */
  memberCount?: number;
}

/**
 * Per-profile item returned by `chat.listProfiles` (serialized over the tunnel) — powers the
 * create-agent modal's profile picker. `familySlug` lets the client group equivalent profiles
 * across providers.
 */
export interface MobileChatProfile {
  id: string;
  name: string;
  familySlug?: string | null;
}

/**
 * Per-config item returned by `chat.listProfileConfigs` (serialized over the tunnel) — the
 * provider-config picker for a chosen profile. `providerName` drives the provider icon;
 * `position` is the profile-local ordering. DEC-1 (v1): ALL of the profile's configs (no team
 * narrowing).
 */
export interface MobileChatProviderConfig {
  id: string;
  profileId: string;
  providerId: string;
  /** Provider display name (e.g. 'claude'), resolved via the config's provider. */
  providerName?: string;
  /** The user-named configuration (unique per profile). */
  name: string;
  /** Order within the profile (0, 1, 2, ...). */
  position: number;
}

/**
 * The created-agent payload returned by `chat.createTeamAgent` / `chat.createIndependentAgent`
 * (serialized over the tunnel) — enough for the mobile client to optimistically insert the new
 * row. `teamId` is the team it was created in (team create) or `null` (independent/standalone).
 */
export interface MobileChatCreatedAgent {
  id: string;
  name: string;
  profileId: string;
  providerConfigId: string;
  description: string | null;
  teamId: string | null;
}

interface AgentPresence {
  online: boolean;
  sessionId?: string;
  activityState?: 'idle' | 'busy' | null;
}

/** Result of `chat.sendMessage`. */
export interface SendMessageResult {
  status: 'queued' | 'delivered';
  /** Server log-entry id of the send — mobile's stable messageId for reconciliation. */
  messageId?: string;
  /** Echoed idempotency key when the caller supplied one, so mobile can correlate. */
  clientMessageId?: string;
}

/** Immediate result of an async lifecycle RPC — the client polls getOperationStatus next. */
export interface LifecycleStartResult {
  operationId: string;
  status: 'launching' | 'restarting' | 'restoring';
}

/** Result of the synchronous `chat.terminateSession`. */
export interface TerminateResult {
  status: 'terminated';
}

/**
 * One pending AskUserQuestion for a session — the serialized
 * `chat.listPendingAskQuestions` poll payload. The `questions` are the backend's
 * canonical normalized shape (the ONLY representation that leaves the backend);
 * `toolUseId` is the tool_use id (mobile maps it to its transcript `toolCallId`).
 * Timestamps are epoch ms (created + ~30min TTL expiry).
 */
export interface PendingAskUserQuestionItem {
  toolUseId: string;
  questions: NormalizedAskUserQuestion[];
  createdAt: number;
  expiresAt: number;
}

/** Display label for mobile-originated user messages (senderName on the mcp.direct delivery). */
const MOBILE_SENDER_NAME = 'Mobile User';

/**
 * Delay (ms) after the ESC that dismisses an open AskUserQuestion picker and
 * before the answer paste, so the TUI returns to its normal input first.
 */
const ASK_QUESTION_DISMISS_DELAY_MS = 120;

/**
 * Extract the most specific domain code for a failed lifecycle op. Prefers
 * `AppError.details.code` (e.g. ConflictError's PROVIDER_MISMATCH /
 * NO_PROVIDER_SESSION_ID / INVALID_SESSION_STATE), then the AppError `code`,
 * else a generic internal code.
 */
function lifecycleErrorCode(err: unknown): string {
  if (err instanceof AppError) {
    const detailCode = err.details?.['code'];
    if (typeof detailCode === 'string' && detailCode.length > 0) return detailCode;
    return err.code;
  }
  return 'INTERNAL_ERROR';
}

function lifecycleErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Lifecycle operation failed';
}

/**
 * Single composition point for the mobile `chat.*` RPCs.
 *
 * `TunnelHandlerService` delegates each `chat.*` method here (the same pattern
 * it uses for `board.*` → storage today), keeping heavy session/terminal
 * dependencies out of the tunnel handler itself. The DI wiring goes through the
 * narrow facade modules only (no HTTP controllers, no `ChatModule`).
 *
 * Registration recipe for each new `chat.*` method:
 *   (a) allow-list it in `devchain-bridge` `relay/allowed-methods.ts`,
 *   (b) add a Zod schema to `METHOD_SCHEMAS` + a `handlers` entry in
 *       `tunnel-handler.service.ts` delegating to a method on this service,
 *   (c) add a mobile `bridge-client.ts` wrapper.
 *
 * Errors thrown from these methods are translated to JSON-RPC via
 * `toJsonRpcError`, preserving the domain code under `error.data.code`.
 */
@Injectable()
export class MobileChatRpcService {
  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    private readonly activeSessions: ActiveSessionLookup,
    private readonly sessionReader: SessionReaderService,
    private readonly transcriptWatcher: TranscriptWatcherService,
    private readonly agentMessageDelivery: AgentMessageDeliveryService,
    private readonly messageLogRead: SessionsMessageLogReadFacade,
    private readonly sessionLifecycle: SessionLifecycleFacade,
    private readonly operationTracker: LifecycleOperationTracker,
    private readonly teamsService: TeamsService,
    private readonly pendingAskUserQuestion: PendingAskUserQuestionService,
  ) {}

  /**
   * `chat.listAgents({ projectId })` — the project's agents enriched with
   * provider display + live presence (online / sessionId / activityState) in a
   * single call, so mobile does not stitch separate agent + presence requests.
   *
   * Project scoping is intrinsic: `storage.listAgents(projectId)` only returns
   * agents owned by `projectId`, and `ActiveSessionLookup.listActiveSessions`
   * joins `sessions → agents` on `project_id`, so an agent (or session) from
   * another project can never appear in the result.
   *
   * Presence source: `ActiveSessionLookup` reads the persisted session row
   * (`activity_state`) via the narrow `SessionsReadModule` facade, which carries
   * exactly the three fields mobile needs. This deliberately avoids importing
   * the heavy `SessionsModule`/`SessionsService` into the tunnel (the seam's
   * whole purpose, per Task 1). Live PTY-registry refinement of busy/idle is a
   * Phase 2 (SSE) concern, not needed for request/response polling.
   *
   * Provider resolution is fully batched (no N+1): one
   * `listProfileProviderConfigsByIds` + one `listProvidersByIds` for the whole
   * page. Profiles are resolved deduplicated (one fetch per distinct profile).
   */
  async listAgents(params: Record<string, unknown>): Promise<MobileChatAgent[]> {
    const projectId = params['projectId'] as string;

    const [agentsResult, activeSessions] = await Promise.all([
      this.storage.listAgents(projectId),
      this.activeSessions.listActiveSessions(projectId),
    ]);
    const agents = agentsResult.items;

    const presenceByAgent = new Map<string, AgentPresence>();
    for (const session of activeSessions) {
      // One running session per agent (enforced by a partial unique index);
      // keep the first (most recent — listActiveSessions orders by started_at).
      if (!presenceByAgent.has(session.agentId)) {
        presenceByAgent.set(session.agentId, {
          online: true,
          sessionId: session.sessionId,
          activityState: session.activityState ?? null,
        });
      }
    }

    const [providerInfoByConfigId, profileNameById] = await Promise.all([
      this.resolveProviderConfigInfo(agents.map((agent) => agent.providerConfigId)),
      this.resolveProfileNames(agents.map((agent) => agent.profileId)),
    ]);

    return agents.map((agent) => {
      const presence = presenceByAgent.get(agent.id);
      const item: MobileChatAgent = {
        id: agent.id,
        name: agent.name,
        type: 'agent',
        online: presence?.online ?? false,
      };

      const profileName = agent.profileId ? profileNameById.get(agent.profileId) : undefined;
      if (profileName) item.profileName = profileName;

      const providerInfo = agent.providerConfigId
        ? providerInfoByConfigId.get(agent.providerConfigId)
        : undefined;
      if (providerInfo?.providerName) item.providerName = providerInfo.providerName;
      if (providerInfo?.configName) item.providerConfigName = providerInfo.configName;

      if (presence?.sessionId) {
        item.sessionId = presence.sessionId;
        // Best-effort: surface the watcher's cached message count so mobile can
        // derive an unread badge WITHOUT parsing the transcript. A missing entry
        // (null) or a thrown error → omit the field entirely (no badge); a
        // genuine 0 → latestMessageCount: 0. This must never fail listAgents.
        try {
          const count = this.transcriptWatcher.getLastKnownMessageCount(presence.sessionId);
          if (count !== null) item.latestMessageCount = count;
        } catch {
          // Watcher lookup threw — omit the field; listAgents still succeeds.
        }
      }
      if (presence) item.activityState = presence.activityState ?? null;

      return item;
    });
  }

  /**
   * `chat.listTeams({ projectId })` — the project's teams with lead + ordered
   * member agent IDs, so the mobile client can group chat agents by team
   * (mirroring the web chat sidebar). Teams are returned in `listTeams`
   * insertion order; `memberAgentIds` in `teamMembers` insertion order.
   *
   * Returns ALL teams (including empty ones — `memberAgentIds: []`); the client
   * omits empty/unresolved teams. Project scoping is intrinsic:
   * `TeamsService.listTeamsWithMemberIds(projectId)` keys both the teams query
   * and the batched members query on this projectId, so a team (or member) from
   * another project can never appear. Membership is resolved with a SINGLE
   * batched `teamMembers` query (no per-team N+1).
   */
  async listTeams(params: Record<string, unknown>): Promise<MobileChatTeam[]> {
    const projectId = params['projectId'] as string;
    const teams = await this.teamsService.listTeamsWithMemberIds(projectId);
    return teams.map((team) => ({
      id: team.id,
      name: team.name,
      teamLeadAgentId: team.teamLeadAgentId,
      memberAgentIds: team.memberAgentIds,
      memberCount: team.memberAgentIds.length,
    }));
  }

  /**
   * `chat.listProfiles({ projectId, teamId? })` — the profile picker for the create-agent
   * modal. With a `teamId`: that team's LINKED profiles (the facade asserts the team belongs
   * to `projectId`, rejecting a cross-project team). Without a `teamId`: the "standalone" set —
   * profiles NOT linked to any of the project's teams.
   *
   * Data access goes through the {@link TeamsService} facade (the tunnel module never imports
   * `TeamsStore`). The id list is resolved to profile objects via the project-scoped
   * `storage.listAgentProfiles({ projectId })`, which both supplies the display fields and
   * acts as a second project guard — a profile id outside `projectId` can never resolve to an
   * object and is dropped. The facade's id order is preserved.
   */
  async listProfiles(params: Record<string, unknown>): Promise<MobileChatProfile[]> {
    const projectId = params['projectId'] as string;
    const teamId = (params['teamId'] as string | null | undefined) ?? null;

    const profileIds = teamId
      ? await this.teamsService.listLinkedProfileIdsForTeam(projectId, teamId)
      : await this.teamsService.listUnlinkedProfileIds(projectId);
    if (profileIds.length === 0) return [];

    const profilesResult = await this.storage.listAgentProfiles({ projectId, limit: 1000 });
    const byId = new Map(profilesResult.items.map((profile) => [profile.id, profile]));
    return profileIds.flatMap((id) => {
      const profile = byId.get(id);
      return profile
        ? [{ id: profile.id, name: profile.name, familySlug: profile.familySlug ?? null }]
        : [];
    });
  }

  /**
   * `chat.listProfileConfigs({ projectId, profileId })` — the provider-config picker for a
   * chosen profile. DEC-1 (v1): returns ALL of the profile's configs (no team narrowing — the
   * optional `teamId`-narrowed variant is BACKLOG #1, hence the signature stays easy to extend).
   *
   * MANDATORY project guard FIRST: the `profileId` is id-addressed (not intrinsically
   * project-scoped like a list), so without this a caller could enumerate another project's
   * configs. {@link assertProfileInProject} rejects a cross-project profile before any config
   * is read.
   */
  async listProfileConfigs(params: Record<string, unknown>): Promise<MobileChatProviderConfig[]> {
    const projectId = params['projectId'] as string;
    const profileId = params['profileId'] as string;

    await this.assertProfileInProject(profileId, projectId);

    const configs = await this.storage.listProfileProviderConfigsByProfile(profileId);
    return configs.map((config) => ({
      id: config.id,
      profileId: config.profileId,
      providerId: config.providerId,
      providerName: config.providerName,
      name: config.name,
      position: config.position,
    }));
  }

  /**
   * `chat.createTeamAgent({ projectId, teamId, name, providerConfigId, description? })` — create
   * a TEAM agent. Delegates to the `TeamsService` facade, which asserts the team belongs to the
   * project (rejects a cross-project / lead-less team), validates profile-linked-to-team +
   * per-project name-uniqueness, and creates atomically under the member cap (emitting
   * `agent.created` + `team.member.added`). DEC-2: NOT gated on `allowTeamLeadCreateAgents`.
   */
  async createTeamAgent(params: Record<string, unknown>): Promise<MobileChatCreatedAgent> {
    const teamId = params['teamId'] as string;
    const agent = await this.teamsService.createTeamAgentForChat({
      projectId: params['projectId'] as string,
      teamId,
      name: params['name'] as string,
      providerConfigId: params['providerConfigId'] as string,
      description: params['description'] as string | undefined,
    });
    return this.toCreatedAgent(agent, teamId);
  }

  /**
   * `chat.createIndependentAgent({ projectId, name, profileId, providerConfigId, description? })`
   * — create a STANDALONE (team-less) agent. The facade validates config ownership + profile
   * project scoping, applies the NEW per-project name-uniqueness guard (intentional desktop/mobile
   * asymmetry — the REST path does not dedupe names), creates the agent, and emits `agent.created`.
   */
  async createIndependentAgent(params: Record<string, unknown>): Promise<MobileChatCreatedAgent> {
    const agent = await this.teamsService.createIndependentAgentForChat({
      projectId: params['projectId'] as string,
      name: params['name'] as string,
      profileId: params['profileId'] as string,
      providerConfigId: params['providerConfigId'] as string,
      description: params['description'] as string | undefined,
    });
    return this.toCreatedAgent(agent, null);
  }

  /**
   * `chat.deleteAgent({ projectId, agentId })` — remove a non-lead agent. Project guard FIRST
   * (`assertAgentInProject` → `AGENT_PROJECT_MISMATCH`), then the explicit delete contract in the
   * `TeamsService` facade: all-teams lead guard (`AGENT_IS_TEAM_LEAD`), transactional delete
   * (running session → `AGENT_HAS_RUNNING_SESSIONS` with count, no deletion), best-effort preset
   * cleanup, and `agent.deleted` (+ `team.member.removed` when the agent was a team member).
   */
  async deleteAgent(params: Record<string, unknown>): Promise<{ deleted: true }> {
    const projectId = params['projectId'] as string;
    const agentId = params['agentId'] as string;
    await this.assertAgentInProject(agentId, projectId);
    await this.teamsService.deleteAgentForChat({ projectId, agentId });
    return { deleted: true };
  }

  private toCreatedAgent(agent: Agent, teamId: string | null): MobileChatCreatedAgent {
    return {
      id: agent.id,
      name: agent.name,
      profileId: agent.profileId,
      providerConfigId: agent.providerConfigId,
      description: agent.description,
      teamId,
    };
  }

  /**
   * `chat.getTranscriptSummary({ sessionId, projectId })` — metrics header data
   * (model / context % / cost; the Claude-1M opus read-time override is applied
   * server-side) plus the opaque tail cursor for bootstrapping polling.
   * Ownership-checked first.
   */
  async getTranscriptSummary(
    params: Record<string, unknown>,
  ): Promise<TranscriptSummaryWithCursor> {
    const sessionId = params['sessionId'] as string;
    await this.assertSessionInProject(sessionId, params['projectId'] as string);
    return this.sessionReader.getTranscriptSummaryWithCursor(sessionId);
  }

  /**
   * `chat.getTranscriptChunks({ sessionId, projectId, cursor?, limit?, direction })`
   * — paged transcript. `direction:'backward'` with no cursor returns the last N
   * chunks (the chat-open default); `prevCursor` loads older history.
   * Ownership-checked first.
   */
  async getTranscriptChunks(params: Record<string, unknown>): Promise<UnifiedChunkedResponse> {
    const sessionId = params['sessionId'] as string;
    await this.assertSessionInProject(sessionId, params['projectId'] as string);

    const cursor = params['cursor'] as string | undefined;
    const limit = params['limit'] as number | undefined;
    const direction = (params['direction'] as 'forward' | 'backward' | undefined) ?? 'backward';

    return this.sessionReader.getUnifiedTranscriptChunks(sessionId, cursor, limit, direction);
  }

  /**
   * `chat.getTranscriptTail({ sessionId, projectId, since })` — delta recovery
   * for cursor-tail polling. Returns null when the cursor is expired (client
   * should re-bootstrap via the summary). Ownership-checked first.
   */
  async getTranscriptTail(params: Record<string, unknown>): Promise<TranscriptTailResponse | null> {
    const sessionId = params['sessionId'] as string;
    await this.assertSessionInProject(sessionId, params['projectId'] as string);
    return this.sessionReader.getTranscriptTail(sessionId, params['since'] as string);
  }

  /**
   * `chat.sendMessage({ agentId, projectId, text, clientMessageId? })` — deliver a
   * user message to the agent's running tmux session via the thread-free
   * `mcp.direct` path. An optional `clientMessageId` makes the send idempotent: a
   * relay-timeout retry with the same key returns the original ledger entry
   * instead of double-delivering. The result echoes `messageId` (the server
   * log-entry id) + `clientMessageId` so mobile can track true send state.
   *
   * Deliver-only: hard-errors with `SESSION_NOT_RUNNING` when the agent has no
   * active session and never auto-launches (launching would exceed the relay
   * timeout, and launch is an explicit user action — see lifecycle RPCs).
   *
   * The recipient is the agent **UUID** (`agentId`), not the name: the AMD
   * recipient resolver is passthrough and downstream `getActiveSession` /
   * `enqueue` key on `agentId`, matching the canonical MCP send-to-tmux path.
   */
  async sendMessage(params: Record<string, unknown>): Promise<SendMessageResult> {
    const agentId = params['agentId'] as string;
    const projectId = params['projectId'] as string;
    const text = params['text'] as string;
    // Optional idempotency key: threaded into the pool so a relay-timeout retry
    // with the same key dedups instead of double-delivering. Absent for older
    // clients (additive-optional); echoed back so mobile can correlate.
    const clientMessageId = params['clientMessageId'] as string | undefined;

    // Ownership: the agent must belong to the requested project.
    const agent = await this.storage.getAgent(agentId);
    if (agent.projectId !== projectId) {
      throw new ForbiddenError('Agent does not belong to the requested project', {
        code: 'AGENT_PROJECT_MISMATCH',
        agentId,
        projectId,
      });
    }

    // Pre-check: a running session must exist; we never auto-launch on send.
    const active = await this.activeSessions.getActiveSession(agentId, projectId);
    if (!active) {
      throw new AppError(
        'No running session for this agent. Launch the agent first.',
        'SESSION_NOT_RUNNING',
        409,
        { agentId, projectId },
      );
    }

    // If this send is answering an open AskUserQuestion picker, dismiss it with
    // ESC before the paste. A bracketed paste + Enter alone does NOT cancel the
    // picker — Enter just selects the highlighted option — so the typed answer
    // would be lost. ESC returns the TUI to its normal prompt; the paste then
    // lands as a plain user turn. (≤1 pending per session; cleared on success.)
    const answersPendingQuestion =
      this.pendingAskUserQuestion.getBySession(active.sessionId).length > 0;

    const outcome = await this.agentMessageDelivery.deliver(
      [agentId],
      {
        kind: 'mcp.direct',
        body: text,
        source: 'mobile',
        projectId,
        senderName: MOBILE_SENDER_NAME,
        senderType: 'user',
        clientMessageId,
        // Plain framing: a human user's turn lands in the agent's tmux as raw
        // text — no agent-oriented banner (devchain_send_message can't address a
        // human and would pollute the agent's context). The formatter default
        // stays 'agent-banner'; mobile opts into 'plain' explicitly here.
        framing: 'plain',
      },
      {
        immediate: true,
        requireActiveSession: true,
        ...(answersPendingQuestion
          ? { preKeys: ['Escape'], preDelayMs: ASK_QUESTION_DISMISS_DELAY_MS }
          : {}),
      },
    );

    const result = outcome.results[0];
    if (!result || result.status === 'failed') {
      // requireActiveSession caught a session that died between pre-check and
      // delivery (the race the policy exists to close), or enqueue failed.
      if (result?.error === 'SESSION_NOT_RUNNING') {
        throw new AppError(
          'No running session for this agent. Launch the agent first.',
          'SESSION_NOT_RUNNING',
          409,
          { agentId, projectId },
        );
      }
      throw new AppError(result?.error ?? 'Message delivery failed', 'SEND_FAILED', 502);
    }

    // Clear-on-send: a successfully delivered message resolves the session's
    // pending question (the ESC pre-key above cancelled the picker, and the
    // paste landed as the answer), so we drop it regardless of the text — ≤1
    // pending per session makes this unambiguous. Best-effort: a clear failure
    // must never fail an otherwise-successful send (the outcome is already
    // determined above). NOT cleared on the failed paths, which throw before
    // reaching here.
    try {
      this.pendingAskUserQuestion.clearBySession(active.sessionId);
    } catch {
      // In-memory clear; swallow so the send result stays clean.
    }

    // 'unconfirmed' is still in-flight (enqueued) → report as queued. messageId
    // (the server log-entry id) + the echoed clientMessageId let mobile track true
    // send state via chat.getPendingMessages until the message lands in the transcript.
    return {
      status: result.status === 'delivered' ? 'delivered' : 'queued',
      ...(result.messageId ? { messageId: result.messageId } : {}),
      ...(clientMessageId ? { clientMessageId } : {}),
    };
  }

  /**
   * `chat.getPendingMessages({ agentId, projectId, clientMessageIds })` — the
   * mobile send-state reconciliation read. Returns the server ledger rows for the
   * requested `clientMessageIds` that belong to this agent and originated from
   * mobile (`source==='mobile'`), so the outbox can render true send state
   * (queued/delivered/failed) until each message appears in the canonical
   * transcript. Source-side auth is identical to `sendMessage` — the agent must
   * belong to `projectId` (cross-project → `AGENT_PROJECT_MISMATCH`) — enforced
   * BEFORE any log read. `delivered` here means the tmux paste succeeded, NOT
   * transcript presence (mobile's 'confirmed' comes only from a transcript match).
   */
  async getPendingMessages(params: Record<string, unknown>): Promise<PendingMobileMessage[]> {
    const agentId = params['agentId'] as string;
    const projectId = params['projectId'] as string;
    const clientMessageIds = params['clientMessageIds'] as string[];

    await this.assertAgentInProject(agentId, projectId);
    return this.messageLogRead.queryPendingMobile(agentId, projectId, clientMessageIds);
  }

  /**
   * `chat.launchAgent({ agentId, projectId })` — async. Synchronously validates
   * (agent exists + in project + no active session), then fires the launch
   * pipeline without awaiting it (would exceed the relay timeout). Returns an
   * `operationId` the client polls via `chat.getOperationStatus`.
   */
  async launchAgent(params: Record<string, unknown>): Promise<LifecycleStartResult> {
    const agentId = params['agentId'] as string;
    const projectId = params['projectId'] as string;

    await this.assertAgentInProject(agentId, projectId);
    const active = await this.activeSessions.getActiveSession(agentId, projectId);
    if (active) {
      throw new ConflictError('Agent already has a running session', {
        code: 'SESSION_ALREADY_RUNNING',
        agentId,
        sessionId: active.sessionId,
      });
    }

    const op = this.operationTracker.create({ type: 'launch', agentId, projectId });
    this.runOperation(op.operationId, () => this.sessionLifecycle.launch(agentId, projectId));
    return { operationId: op.operationId, status: 'launching' };
  }

  /**
   * `chat.restartAgent({ agentId, projectId })` — async (atomic terminate+launch
   * can exceed the relay timeout). Returns an `operationId` to poll.
   */
  async restartAgent(params: Record<string, unknown>): Promise<LifecycleStartResult> {
    const agentId = params['agentId'] as string;
    const projectId = params['projectId'] as string;

    await this.assertAgentInProject(agentId, projectId);

    const op = this.operationTracker.create({ type: 'restart', agentId, projectId });
    this.runOperation(op.operationId, () => this.sessionLifecycle.restart(agentId, projectId));
    return { operationId: op.operationId, status: 'restarting' };
  }

  /**
   * `chat.restoreSession({ sessionId, projectId })` — async. If the agent already
   * has a running session, that is treated as success (the STATUS_RUNNING case).
   * Otherwise the restore pipeline runs; its `ConflictError.details.code`
   * (PROVIDER_MISMATCH / NO_PROVIDER_SESSION_ID / INVALID_SESSION_STATE, and the
   * OpenCode null-providerSessionId → NO_PROVIDER_SESSION_ID case) is recorded on
   * the operation for the client to read.
   */
  async restoreSession(params: Record<string, unknown>): Promise<LifecycleStartResult> {
    const sessionId = params['sessionId'] as string;
    const projectId = params['projectId'] as string;

    const scope = await this.activeSessions.getSessionProjectScope(sessionId);
    if (!scope) {
      throw new NotFoundError('Session', sessionId);
    }
    if (scope.projectId !== projectId) {
      throw new ForbiddenError('Session does not belong to the requested project', {
        code: 'SESSION_PROJECT_MISMATCH',
        sessionId,
        projectId,
      });
    }

    const op = this.operationTracker.create({
      type: 'restore',
      agentId: scope.agentId,
      sessionId,
      projectId,
    });
    this.runOperation(op.operationId, async () => {
      if (scope.agentId) {
        const active = await this.activeSessions.getActiveSession(scope.agentId, projectId);
        if (active) {
          // Already running → restore is a no-op success with the current session.
          return { id: active.sessionId };
        }
      }
      return this.sessionLifecycle.restore(sessionId, projectId);
    });
    return { operationId: op.operationId, status: 'restoring' };
  }

  /**
   * `chat.terminateSession({ sessionId, projectId })` — synchronous + idempotent
   * (fast). A missing session is treated as already-terminated; a cross-project
   * session is rejected.
   */
  async terminateSession(params: Record<string, unknown>): Promise<TerminateResult> {
    const sessionId = params['sessionId'] as string;
    const projectId = params['projectId'] as string;

    const scope = await this.activeSessions.getSessionProjectScope(sessionId);
    if (!scope) {
      // Unknown session → nothing to terminate; idempotent success.
      return { status: 'terminated' };
    }
    if (scope.projectId !== projectId) {
      throw new ForbiddenError('Session does not belong to the requested project', {
        code: 'SESSION_PROJECT_MISMATCH',
        sessionId,
        projectId,
      });
    }

    await this.sessionLifecycle.terminate(sessionId);
    return { status: 'terminated' };
  }

  /**
   * `chat.getOperationStatus({ operationId, projectId })` — poll an async
   * lifecycle op, including its terminal status and failure code (so the client
   * learns *why* a launch/restart/restore failed, which presence alone cannot
   * reveal). Project-scoped: an operation owned by another project is rejected
   * with `OPERATION_PROJECT_MISMATCH` (the record is never leaked); an unknown id
   * remains `NotFoundError`.
   */
  async getOperationStatus(params: Record<string, unknown>): Promise<LifecycleOperation> {
    const operationId = params['operationId'] as string;
    const projectId = params['projectId'] as string;
    const op = this.operationTracker.get(operationId);
    if (!op) {
      throw new NotFoundError('Operation', operationId);
    }
    if (op.projectId !== projectId) {
      throw new ForbiddenError('Operation does not belong to the requested project', {
        code: 'OPERATION_PROJECT_MISMATCH',
        operationId,
        projectId,
      });
    }
    return op;
  }

  /**
   * `chat.getAgentStatus({ agentId, projectId })` — the most recent tracked
   * lifecycle operation for an in-project agent (same shape as
   * `getOperationStatus`), or `null` when none is tracked. Project-scoped via
   * `assertAgentInProject` (cross-project → `AGENT_PROJECT_MISMATCH`), so the
   * menu can surface a launch-failure reason without holding an `operationId`.
   */
  async getAgentStatus(params: Record<string, unknown>): Promise<LifecycleOperation | null> {
    const agentId = params['agentId'] as string;
    const projectId = params['projectId'] as string;
    await this.assertAgentInProject(agentId, projectId);
    return this.operationTracker.latestForAgent(agentId) ?? null;
  }

  /**
   * `chat.listPendingAskQuestions({ sessionId, projectId })` — the mobile poll
   * source for an unresolved AskUserQuestion. Returns the session's non-expired
   * pending entries from the in-memory store (Task 1), serialized to the wire
   * item shape. Project-scoped via `assertSessionInProject` (cross-project →
   * `SESSION_PROJECT_MISMATCH`), so a caller cannot read another project's
   * pending question by guessing a sessionId.
   *
   * Runtime cardinality is ≤1 (the agent is blocked single-threaded while the
   * picker is open); the array shape is future-proof and matches `getBySession`.
   */
  async listPendingAskQuestions(
    params: Record<string, unknown>,
  ): Promise<PendingAskUserQuestionItem[]> {
    const sessionId = params['sessionId'] as string;
    await this.assertSessionInProject(sessionId, params['projectId'] as string);
    const entries = this.pendingAskUserQuestion.getBySession(sessionId);
    return entries.map((entry) => ({
      toolUseId: entry.toolUseId,
      questions: entry.questions,
      createdAt: entry.createdAt,
      expiresAt: entry.expiresAt,
    }));
  }

  /**
   * `chat.listSessions({ agentId, projectId, cursor?, limit? })` — the mobile
   * offline-agent session list: a paginated page of the agent's stopped/failed
   * sessions (keyset cursor, default page 20, max 100), returning the existing
   * `SessionHistoryResponseDto` ({ items, nextCursor, hasMore, total }). Project
   * scoping is enforced by `getAgentSessionHistory` (cross-project agent → throws
   * Forbidden), so a caller cannot page another project's agent.
   */
  async listSessions(params: Record<string, unknown>): Promise<SessionHistoryResponseDto> {
    const agentId = params['agentId'] as string;
    const projectId = params['projectId'] as string;
    const cursor = params['cursor'] as string | undefined;
    const limit = (params['limit'] as number | undefined) ?? 20;
    return this.sessionLifecycle.listAgentHistory(agentId, projectId, cursor, limit);
  }

  /**
   * `chat.deleteSessionRecord({ sessionId, projectId })` — record-only delete
   * (DB row + chat invites; the transcript FILE stays on disk). Rejects unknown
   * (NotFound), cross-project (Forbidden `SESSION_PROJECT_MISMATCH`), and running
   * (Conflict `STATUS_RUNNING`) via the shared facade guard before deleting.
   */
  async deleteSessionRecord(params: Record<string, unknown>): Promise<{ deleted: boolean }> {
    const sessionId = params['sessionId'] as string;
    const projectId = params['projectId'] as string;
    return this.sessionLifecycle.deleteSessionRecord(sessionId, projectId);
  }

  /**
   * `chat.renameSession({ sessionId, projectId, name })` — rename, or clear on
   * null/empty/whitespace, a session's name. `name` is nullable (not optional):
   * null preserves the explicit clear semantics. The shared guard rejects
   * unknown/cross-project first; `updateName` trims + enforces the 120-char cap.
   */
  async renameSession(params: Record<string, unknown>): Promise<SessionDto> {
    const sessionId = params['sessionId'] as string;
    const projectId = params['projectId'] as string;
    const name = params['name'] as string | null;
    return this.sessionLifecycle.renameSession(sessionId, projectId, name);
  }

  /** Pre-validate an agent belongs to the requested project. */
  private async assertAgentInProject(agentId: string, projectId: string): Promise<void> {
    const agent = await this.storage.getAgent(agentId);
    if (agent.projectId !== projectId) {
      throw new ForbiddenError('Agent does not belong to the requested project', {
        code: 'AGENT_PROJECT_MISMATCH',
        agentId,
        projectId,
      });
    }
  }

  /**
   * Pre-validate a profile belongs to the requested project — the security boundary for the
   * id-addressed `chat.listProfileConfigs`. `storage.getAgentProfile` throws `NotFoundError`
   * for an unknown id; a known profile in a different project is rejected as `ForbiddenError`
   * (mirrors {@link assertAgentInProject}).
   */
  private async assertProfileInProject(profileId: string, projectId: string): Promise<void> {
    const profile = await this.storage.getAgentProfile(profileId);
    if (profile.projectId !== projectId) {
      throw new ForbiddenError('Profile does not belong to the requested project', {
        code: 'PROFILE_PROJECT_MISMATCH',
        profileId,
        projectId,
      });
    }
  }

  /**
   * Fire-and-forget an async lifecycle operation: mark it running, then resolve
   * the tracker on success/failure. Deliberately NOT awaited by the caller so the
   * RPC returns before the pipeline finishes (relay-timeout safe).
   */
  private runOperation(
    operationId: string,
    fn: () => Promise<{ id?: string | null } | void>,
  ): void {
    this.operationTracker.markRunning(operationId);
    void fn().then(
      (result) => this.operationTracker.succeed(operationId, result?.id ?? undefined),
      (err: unknown) =>
        this.operationTracker.fail(
          operationId,
          lifecycleErrorCode(err),
          lifecycleErrorMessage(err),
        ),
    );
  }

  /**
   * Enforce `session → agent → project` ownership before any session-ID-centric
   * read. The session-reader APIs take a bare sessionId, so without this a
   * caller could read another project's session by guessing its id.
   *
   * - unknown session → `NotFoundError` (`not_found`)
   * - session owned by a different project → `ForbiddenError`
   *   (`forbidden`, `data.details.code = 'SESSION_PROJECT_MISMATCH'`)
   */
  private async assertSessionInProject(sessionId: string, projectId: string): Promise<void> {
    const scope = await this.activeSessions.getSessionProjectScope(sessionId);
    if (!scope) {
      throw new NotFoundError('Session', sessionId);
    }
    if (scope.projectId !== projectId) {
      throw new ForbiddenError('Session does not belong to the requested project', {
        code: 'SESSION_PROJECT_MISMATCH',
        sessionId,
        projectId,
      });
    }
  }

  /**
   * Batch-resolve providerConfigId → { provider display name, config name } with no N+1:
   * one configs-by-ids fetch, then one providers-by-ids fetch for the distinct providers
   * those configs reference. `providerName` is the PROVIDER's display name (e.g. 'claude',
   * drives the row icon); `configName` is the user-named CONFIGURATION (shown as the row
   * subtitle). Both come from the single configs fetch.
   */
  private async resolveProviderConfigInfo(
    rawConfigIds: ReadonlyArray<string | null | undefined>,
  ): Promise<Map<string, { providerName?: string; configName?: string }>> {
    const configIds = this.distinct(rawConfigIds);
    if (configIds.length === 0) return new Map();

    const configs = await this.storage.listProfileProviderConfigsByIds(configIds);
    const providerIds = this.distinct(configs.map((config) => config.providerId));
    const providers =
      providerIds.length > 0 ? await this.storage.listProvidersByIds(providerIds) : [];
    const providerNameById = new Map(providers.map((provider) => [provider.id, provider.name]));

    const byConfigId = new Map<string, { providerName?: string; configName?: string }>();
    for (const config of configs) {
      byConfigId.set(config.id, {
        providerName: providerNameById.get(config.providerId) ?? config.providerName,
        configName: config.name,
      });
    }
    return byConfigId;
  }

  /**
   * Resolve profileId → profile name. Deduplicated (one fetch per distinct
   * profile, run in parallel); missing profiles are skipped, not fatal.
   */
  private async resolveProfileNames(
    rawProfileIds: ReadonlyArray<string | null | undefined>,
  ): Promise<Map<string, string>> {
    const profileIds = this.distinct(rawProfileIds);
    if (profileIds.length === 0) return new Map();

    const profiles = await Promise.all(
      profileIds.map((id) => this.storage.getAgentProfile(id).catch(() => null)),
    );

    const byId = new Map<string, string>();
    for (const profile of profiles) {
      if (profile?.id && profile.name) byId.set(profile.id, profile.name);
    }
    return byId;
  }

  private distinct(values: ReadonlyArray<string | null | undefined>): string[] {
    return [...new Set(values.filter((value): value is string => !!value))];
  }
}
