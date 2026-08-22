import { Injectable } from '@nestjs/common';
import type { EpicCreatedEventPayload } from '../../events/catalog/epic.created';
import type { EpicDeletedEventPayload } from '../../events/catalog/epic.deleted';
import type { EpicUpdatedEventPayload } from '../../events/catalog/epic.updated';
import type { EpicCommentCreatedEventPayload } from '../../events/catalog/epic.comment.created';
import type { SessionCrashedEventPayload } from '../../events/catalog/session.crashed';
import type { SessionStoppedEventPayload } from '../../events/catalog/session.stopped';
import type { ClaudeHooksAskUserQuestionPendingEventPayload } from '../../events/catalog/claude.hooks.ask_user_question.pending';

export interface IngestPayload {
  source: 'workflow';
  sourceEventId: string;
  sourceEventType: string;
  forwardingUserId: string;
  recipientMode: 'self';
  /** Reserved; intentionally unused. */
  recipientHints: never[];
  /**
   * Event-time recipient routing kids (deduplicated). Present ONLY on multi-workspace
   * project events with at least one authorized paired device; absent means the event
   * is account-wide (single-workspace mode). Frozen at enqueue — later grant changes
   * never rewrite it.
   */
  recipientDeviceKids?: string[];
  occurredAt: string;
  payload: Record<string, unknown>;
  projectId: string | null;
  orgId: null;
}

type AllowlistedEvent =
  | { name: 'epic.created'; payload: EpicCreatedEventPayload }
  | { name: 'epic.updated'; payload: EpicUpdatedEventPayload }
  | { name: 'epic.deleted'; payload: EpicDeletedEventPayload }
  | { name: 'epic.comment.created'; payload: EpicCommentCreatedEventPayload }
  | { name: 'session.crashed'; payload: SessionCrashedEventPayload }
  | { name: 'session.stopped'; payload: SessionStoppedEventPayload }
  | {
      name: 'claude.hooks.ask_user_question.pending';
      payload: ClaudeHooksAskUserQuestionPendingEventPayload;
    };

/** Caller-supplied context that isn't on the event payload itself. */
export interface MapToIngestOptions {
  /** Bridge instance id (from the tunnel `ready` frame), for AUQ gating/deep-link. */
  instanceId?: string | null;
}

@Injectable()
export class EventMapperService {
  mapToGenericAskUserQuestionNotice(
    sourceEventId: string,
    forwardingUserId: string,
  ): IngestPayload {
    return {
      source: 'workflow',
      sourceEventId,
      sourceEventType: 'claude.hooks.ask_user_question.pending',
      forwardingUserId,
      recipientMode: 'self',
      recipientHints: [],
      occurredAt: new Date().toISOString(),
      payload: { accountLevel: true },
      projectId: null,
      orgId: null,
    };
  }

  mapToIngestPayload(
    event: AllowlistedEvent,
    sourceEventId: string,
    forwardingUserId: string,
    options?: MapToIngestOptions,
  ): IngestPayload {
    const projectId = this.extractProjectId(event);

    return {
      source: 'workflow',
      sourceEventId,
      sourceEventType: event.name,
      forwardingUserId,
      recipientMode: 'self',
      recipientHints: [],
      occurredAt: new Date().toISOString(),
      payload: this.projectPayload(event, options),
      projectId,
      orgId: null,
    };
  }

  /**
   * Project the wire payload. Most events forward their payload verbatim. AskUserQuestion
   * is REDUCED to identifiers only — the normalized `questions` (prompt text/options) are
   * stripped so no question content leaves the device in the native-push pipeline. The
   * mobile client treats the push as a HINT and fetches the authoritative question set via
   * `listPendingAskQuestions` keyed by `toolUseId`.
   */
  private projectPayload(
    event: AllowlistedEvent,
    options?: MapToIngestOptions,
  ): Record<string, unknown> {
    if (event.name === 'claude.hooks.ask_user_question.pending') {
      const p = event.payload;
      return {
        sessionId: p.sessionId,
        agentId: p.agentId,
        toolUseId: p.toolUseId,
        projectId: p.projectId,
        claudeSessionId: p.claudeSessionId,
        ...(options?.instanceId ? { instanceId: options.instanceId } : {}),
      };
    }
    return event.payload as unknown as Record<string, unknown>;
  }

  private extractProjectId(event: AllowlistedEvent): string | null {
    switch (event.name) {
      case 'epic.created':
      case 'epic.updated':
      case 'epic.deleted':
      case 'epic.comment.created':
        return event.payload.projectId;
      case 'claude.hooks.ask_user_question.pending':
        return event.payload.projectId;
      case 'session.crashed':
      case 'session.stopped':
        return null;
    }
  }
}
