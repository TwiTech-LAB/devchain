import { Inject, Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { getEventMetadata } from '../../events/services/events.service';
import { EventLogService } from '../../events/services/event-log.service';
import { AgentMessageDeliveryService } from '../../agent-message-delivery/agent-message-delivery.service';
import { STORAGE_SERVICE, type AgentStorage } from '../../storage/interfaces/storage.interface';
import { TeamsService } from '../../teams/services/teams.service';
import { renderTemplate } from '../../../common/template/handlebars-renderer';
import type { ReviewCommentCreatedEventPayload } from '../../events/catalog/review.comment.created';

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

const LEGACY_VARIABLES = [
  'comment_type',
  'review_title',
  'author_name',
  'file_path',
  'line_info',
  'context_info',
  'content',
  'review_id',
  'comment_id',
  'team_name',
  'team_names',
  'is_team_lead',
];

@Injectable()
export class ReviewCommentNotifierSubscriber {
  private readonly logger = new Logger(ReviewCommentNotifierSubscriber.name);

  constructor(
    private readonly eventLogService: EventLogService,
    private readonly messageDelivery: AgentMessageDeliveryService,
    private readonly teamsService: TeamsService,
    @Inject(STORAGE_SERVICE) private readonly storage: AgentStorage,
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

    const recipientContext = await this.teamsService.getRecipientContext(
      agentId,
      payload.projectId,
    );

    const message = renderTemplate(
      DEFAULT_TEMPLATE,
      {
        comment_type: payload.commentType,
        review_title: payload.reviewTitle ?? payload.reviewId,
        author_name: authorName,
        file_path: payload.filePath ?? '(general)',
        line_info: lineInfo,
        context_info: contextInfo,
        content: this.truncateContent(payload.content, 500),
        review_id: payload.reviewId,
        comment_id: payload.commentId,
        team_name: recipientContext.teamNames.length === 1 ? recipientContext.teamNames[0] : '',
        team_names: recipientContext.teamNames.join(', '),
        is_team_lead: recipientContext.isTeamLead,
      },
      LEGACY_VARIABLES,
    );

    const result = await this.messageDelivery.deliver(
      [agentId],
      {
        kind: 'pooled',
        body: message,
        source: 'review.comment.created',
        projectId: payload.projectId,
        senderName: authorName,
        senderType: payload.authorType,
        messageId: payload.commentId,
        senderAgentId: payload.authorAgentId ?? undefined,
      },
      { submitKeys: ['Enter'] },
    );

    const failed = result.results.find((recipientResult) => recipientResult.status === 'failed');
    if (failed) {
      throw new Error(failed.error ?? `Delivery failed for ${failed.agentId}`);
    }

    this.logger.debug(
      { agentId, status: result.status },
      'ReviewCommentNotifier: message delivered through AgentMessageDelivery',
    );
  }

  private truncateContent(content: string, maxLength: number): string {
    if (content.length <= maxLength) {
      return content;
    }
    return content.slice(0, maxLength - 3) + '...';
  }
}
