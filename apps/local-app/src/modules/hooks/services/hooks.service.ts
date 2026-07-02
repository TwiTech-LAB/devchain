import { Inject, Injectable } from '@nestjs/common';
import { STORAGE_SERVICE, type AgentStorage } from '../../storage/interfaces/storage.interface';
import { EventsService } from '../../events/services/events.service';
import type {
  HookEventData,
  HookEventResponse,
  PostToolUseHookEvent,
  PreToolUseHookEvent,
  SessionStartHookEvent,
  StopHookEvent,
} from '../dtos/hook-event.dto';
import { ASK_USER_QUESTION_TOOL, normalizeAskUserQuestions } from '../dtos/ask-user-question.dto';
import { PendingAskUserQuestionService } from './pending-ask-user-question.service';
import { createLogger } from '../../../common/logging/logger';

const logger = createLogger('HooksService');

/** Max length for string fields before truncation warning. */
const FIELD_WARN_LENGTH = 2000;

@Injectable()
export class HooksService {
  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: AgentStorage,
    private readonly events: EventsService,
    private readonly pendingAskQuestions: PendingAskUserQuestionService,
  ) {}

  /**
   * Process an incoming hook event from the relay script.
   * Transforms the payload, resolves context, publishes an internal event,
   * and returns an extensible response.
   *
   * Errors during event publishing are logged but do NOT fail the response
   * — the relay script must always get a response to avoid blocking Claude.
   */
  async handleHookEvent(data: HookEventData): Promise<HookEventResponse> {
    const { hookEventName } = data;
    logger.info(
      { hookEventName, projectId: data.projectId, tmuxSessionName: data.tmuxSessionName },
      'Processing hook event',
    );

    this.warnOversizedFields(data);

    switch (hookEventName) {
      case 'SessionStart':
        return this.handleSessionStart(data);
      case 'Stop':
        return this.handleStop(data);
      case 'PreToolUse':
        return this.handlePreToolUse(data);
      case 'PostToolUse':
        return this.handlePostToolUse(data);
      default:
        logger.info({ hookEventName }, 'Unhandled hook event type — returning ok');
        return { ok: true, handled: false, data: {} };
    }
  }

  /**
   * Stop (Copilot `agentStop`): the agent finished a turn. Accepted + dispatched
   * here so the ingestion path tolerates the 2nd provider; the final-metrics
   * capture listener lands in a later phase (P3-4). No-op for now.
   */
  private async handleStop(data: StopHookEvent): Promise<HookEventResponse> {
    logger.debug(
      {
        providerName: data.providerName ?? 'claude',
        sessionId: data.sessionId,
        stopReason: data.stopReason,
      },
      'Stop hook received — final-metrics handling deferred to a later phase',
    );
    return { ok: true, handled: false, data: {} };
  }

  /**
   * PreToolUse(AskUserQuestion): capture the pending question server-side so
   * mobile can fetch it. Notification-only — always responds ok, never blocks
   * the picker.
   */
  private async handlePreToolUse(data: PreToolUseHookEvent): Promise<HookEventResponse> {
    if (data.toolName !== ASK_USER_QUESTION_TOOL) {
      return { ok: true, handled: false, data: {} };
    }
    if (!data.sessionId) {
      logger.warn(
        { toolUseId: data.toolUseId },
        'PreToolUse AskUserQuestion without a DevChain sessionId — cannot store pending',
      );
      return { ok: true, handled: false, data: {} };
    }

    const questions = normalizeAskUserQuestions(data.toolInput);
    if (!questions) {
      logger.warn(
        { toolUseId: data.toolUseId },
        'PreToolUse AskUserQuestion has malformed questions — skipping store',
      );
      return { ok: true, handled: false, data: {} };
    }

    const entry = this.pendingAskQuestions.set({
      projectId: data.projectId,
      agentId: data.agentId,
      sessionId: data.sessionId,
      claudeSessionId: data.claudeSessionId,
      toolUseId: data.toolUseId,
      questions,
    });

    try {
      await this.events.publish('claude.hooks.ask_user_question.pending', {
        projectId: entry.projectId,
        agentId: entry.agentId,
        sessionId: entry.sessionId,
        claudeSessionId: entry.claudeSessionId,
        toolUseId: entry.toolUseId,
        questions: entry.questions,
        createdAt: entry.createdAt,
        expiresAt: entry.expiresAt,
      });
    } catch (error) {
      logger.error(
        { error, hookEventName: 'PreToolUse' },
        'Failed to publish ask_user_question.pending — responding ok anyway',
      );
    }

    return { ok: true, handled: true, data: {} };
  }

  /**
   * PostToolUse(AskUserQuestion): the terminal "answered in the TUI" path.
   * Clears the pending entry and publishes the resolved event.
   */
  private async handlePostToolUse(data: PostToolUseHookEvent): Promise<HookEventResponse> {
    if (data.toolName !== ASK_USER_QUESTION_TOOL) {
      return { ok: true, handled: false, data: {} };
    }
    if (!data.sessionId) {
      return { ok: true, handled: false, data: {} };
    }

    const cleared = this.pendingAskQuestions.clearByToolUseId(data.sessionId, data.toolUseId);

    try {
      await this.events.publish('claude.hooks.ask_user_question.resolved', {
        projectId: data.projectId,
        sessionId: data.sessionId,
        toolUseId: data.toolUseId,
      });
    } catch (error) {
      logger.error(
        { error, hookEventName: 'PostToolUse' },
        'Failed to publish ask_user_question.resolved — responding ok anyway',
      );
    }

    return { ok: true, handled: true, data: { cleared } };
  }

  private async handleSessionStart(data: SessionStartHookEvent): Promise<HookEventResponse> {
    // Resolve agentName from agentId if available
    let agentName: string | null = null;
    if (data.agentId) {
      try {
        const agent = await this.storage.getAgent(data.agentId);
        agentName = agent.name;
      } catch (error) {
        logger.warn(
          { agentId: data.agentId, error },
          'Failed to resolve agent name — continuing without it',
        );
      }
    }

    // Provider-neutral session identity: Claude relays send `claudeSessionId`,
    // provider-neutral relays (Copilot) send `providerSessionId`. The downstream
    // event still keys on `claudeSessionId`, so resolve it from whichever the
    // relay provided (Claude is unchanged — it always sets `claudeSessionId`).
    const providerSessionId = data.claudeSessionId ?? data.providerSessionId;
    if (!providerSessionId) {
      logger.warn(
        { projectId: data.projectId, providerName: data.providerName ?? 'claude' },
        'SessionStart hook missing both claudeSessionId and providerSessionId — skipping publish',
      );
      return { ok: true, handled: true, data: {} };
    }

    // Publish the internal event — errors must not fail the response
    try {
      await this.events.publish('claude.hooks.session.started', {
        claudeSessionId: providerSessionId,
        // Provider-aware fields (additive; absent ⇒ Claude). These let the
        // transcript-persistence listener branch by provider without the
        // "claude id" semantic confusion of the resolved `claudeSessionId`.
        providerName: data.providerName,
        providerSessionId: data.providerSessionId,
        source: data.source,
        model: data.model,
        permissionMode: data.permissionMode,
        transcriptPath: data.transcriptPath,
        tmuxSessionName: data.tmuxSessionName,
        projectId: data.projectId,
        agentId: data.agentId,
        agentName,
        sessionId: data.sessionId,
      });
    } catch (error) {
      logger.error(
        { error, hookEventName: 'SessionStart' },
        'Failed to publish hook event — responding ok anyway',
      );
    }

    return { ok: true, handled: true, data: {} };
  }

  /**
   * Log warnings for unexpectedly large field values.
   * Does not truncate — just alerts for monitoring.
   */
  private warnOversizedFields(data: HookEventData): void {
    for (const [key, value] of Object.entries(data)) {
      if (typeof value === 'string' && value.length > FIELD_WARN_LENGTH) {
        logger.warn(
          { field: key, length: value.length },
          'Hook event field exceeds size threshold',
        );
      }
    }
  }
}
