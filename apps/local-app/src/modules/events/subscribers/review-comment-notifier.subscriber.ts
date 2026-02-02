import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { OnEvent } from '@nestjs/event-emitter';
import { getEventMetadata } from '../services/events.service';
import { EventLogService } from '../services/event-log.service';
import { SessionsService } from '../../sessions/services/sessions.service';
import { SessionCoordinatorService } from '../../sessions/services/session-coordinator.service';
import { SessionsMessagePoolService } from '../../sessions/services/sessions-message-pool.service';
import { STORAGE_SERVICE, type StorageService } from '../../storage/interfaces/storage.interface';
import type { ReviewCommentCreatedEventPayload } from '../catalog/review.comment.created';

const DEFAULT_TEMPLATE = `[Review Comment]
New {comment_type} on "{review_title}" by {author_name}.

File: {file_path}{line_info}
Context: {context_info}
Content: {content}

Actions:
• Reply: devchain_reply_comment(sessionId="<your-session-id>", reviewId="{review_id}", parentCommentId="{comment_id}", content="Your reply")
• Resolve: devchain_resolve_comment(sessionId="<your-session-id>", commentId="{comment_id}", version=<comment-version>)
  (Fetch comment first with devchain_get_review_comments to get current version)
• View review: devchain_get_review(sessionId="<your-session-id>", reviewId="{review_id}")`;

@Injectable()
export class ReviewCommentNotifierSubscriber {
  private readonly logger = new Logger(ReviewCommentNotifierSubscriber.name);
  private sessionsServiceRef?: SessionsService;

  constructor(
    private readonly eventLogService: EventLogService,
    private readonly moduleRef: ModuleRef,
    @Inject(forwardRef(() => SessionCoordinatorService))
    private readonly sessionCoordinator: SessionCoordinatorService,
    @Inject(forwardRef(() => SessionsMessagePoolService))
    private readonly messagePoolService: SessionsMessagePoolService,
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
  ) {}

  @OnEvent('review.comment.created', { async: true })
  async handleReviewCommentCreated(payload: ReviewCommentCreatedEventPayload): Promise<void> {
    // Only process if there are target agents
    if (!payload.targetAgentIds || payload.targetAgentIds.length === 0) {
      return;
    }

    // Defense-in-depth: de-duplicate and filter out author (prevents bad payloads from causing duplicates)
    let targetAgentIds = [...new Set(payload.targetAgentIds)];
    // Filter out author agent when author is an agent to prevent self-notifications
    if (payload.authorType === 'agent' && payload.authorAgentId) {
      targetAgentIds = targetAgentIds.filter((id) => id !== payload.authorAgentId);
    }

    // Early exit if no targets after filtering
    if (targetAgentIds.length === 0) {
      return;
    }

    const metadata = getEventMetadata(payload);
    const eventId = metadata?.id;
    const handler = 'ReviewCommentNotifier';
    const startedAt = new Date().toISOString();

    // Process each target agent
    const results: Array<{ agentId: string; success: boolean; error?: string }> = [];

    for (const agentId of targetAgentIds) {
      try {
        await this.notifyAgent(agentId, payload);
        results.push({ agentId, success: true });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger.error(
          { error, agentId, payload },
          'Failed to notify agent about review comment',
        );
        results.push({ agentId, success: false, error: errorMessage });
      }
    }

    // Record overall result
    const allSuccess = results.every((r) => r.success);
    const endedAt = new Date().toISOString();

    if (eventId) {
      if (allSuccess) {
        await this.eventLogService.recordHandledOk({
          eventId,
          handler,
          detail: {
            targetAgentIds,
            results,
          },
          startedAt,
          endedAt,
        });
      } else {
        await this.eventLogService.recordHandledFail({
          eventId,
          handler,
          detail: {
            targetAgentIds,
            results,
          },
          startedAt,
          endedAt,
        });
      }
    }

    this.logger.log(
      { eventId, targetCount: targetAgentIds.length, results },
      'Review comment notification processing complete',
    );
  }

  private async notifyAgent(
    agentId: string,
    payload: ReviewCommentCreatedEventPayload,
  ): Promise<void> {
    // Resolve author name if available
    let authorName = 'User';
    if (payload.authorType === 'agent' && payload.authorAgentId) {
      try {
        const author = await this.storage.getAgent(payload.authorAgentId);
        authorName = author.name;
      } catch {
        authorName = 'Agent';
      }
    }

    // Build line info string
    let lineInfo = '';
    if (payload.lineStart !== null) {
      lineInfo =
        payload.lineEnd !== null && payload.lineEnd !== payload.lineStart
          ? ` (L${payload.lineStart}-${payload.lineEnd})`
          : ` (L${payload.lineStart})`;
    }

    // Build context info string for agents to locate the code
    let contextInfo = '';
    if (payload.reviewMode === 'working_tree') {
      contextInfo = 'Working tree changes vs HEAD';
    } else if (payload.reviewMode === 'commit') {
      const sha = payload.headSha ? payload.headSha.slice(0, 7) : 'unknown';
      const branch = payload.headRef ?? 'unknown';
      contextInfo = `Commit ${sha} on ${branch}`;
    } else {
      contextInfo = 'unknown';
    }

    const message = this.renderTemplate(DEFAULT_TEMPLATE, {
      comment_type: payload.commentType,
      review_title: payload.reviewTitle ?? payload.reviewId,
      author_name: authorName,
      file_path: payload.filePath ?? '(general)',
      line_info: lineInfo,
      context_info: contextInfo,
      content: this.truncateContent(payload.content, 500),
      review_id: payload.reviewId,
      comment_id: payload.commentId,
    });

    // Ensure agent has an active session (launch if needed)
    // Note: ensureAgentSession calls launchSession() which has internal withAgentLock.
    // No outer lock needed here - it would cause deadlock (nested non-reentrant locks).
    const { sessionId, launched } = await this.ensureAgentSession(agentId, payload.projectId);

    // Enqueue message to pool for batched delivery
    const result = await this.messagePoolService.enqueue(agentId, message, {
      source: 'review.comment.created',
      submitKeys: ['Enter'],
      projectId: payload.projectId,
    });

    this.logger.debug(
      { agentId, sessionId, launched, status: result.status },
      'ReviewCommentNotifier: message enqueued to pool',
    );
  }

  private renderTemplate(template: string, context: Record<string, string>): string {
    return Object.entries(context).reduce((acc, [key, value]) => {
      const placeholder = `{${key}}`;
      return acc.split(placeholder).join(value);
    }, template);
  }

  private truncateContent(content: string, maxLength: number): string {
    if (content.length <= maxLength) {
      return content;
    }
    return content.slice(0, maxLength - 3) + '...';
  }

  private async ensureAgentSession(
    agentId: string,
    projectId: string,
  ): Promise<{
    sessionId: string;
    tmuxSessionId: string;
    launched: boolean;
  }> {
    const activeSessions = await this.getSessionsService().listActiveSessions();
    const existing = activeSessions.find((session) => session.agentId === agentId);

    if (existing?.tmuxSessionId) {
      return {
        sessionId: existing.id,
        tmuxSessionId: existing.tmuxSessionId,
        launched: false,
      };
    }

    // Launch new session for this agent
    const session = await this.getSessionsService().launchSession({
      projectId,
      agentId,
    });

    if (!session.tmuxSessionId) {
      throw new Error('Launched session missing tmuxSessionId');
    }

    return {
      sessionId: session.id,
      tmuxSessionId: session.tmuxSessionId,
      launched: true,
    };
  }

  private getSessionsService(): SessionsService {
    if (!this.sessionsServiceRef) {
      this.sessionsServiceRef = this.moduleRef.get(SessionsService, { strict: false });
      if (!this.sessionsServiceRef) {
        throw new Error('SessionsService is not available in the current module context');
      }
    }
    return this.sessionsServiceRef;
  }

  private formatLineRange(lineStart: number | null, lineEnd: number | null): string {
    if (lineStart === null) {
      return '';
    }
    if (lineEnd !== null && lineEnd !== lineStart) {
      return `:${lineStart}-${lineEnd}`;
    }
    return `:${lineStart}`;
  }
}
