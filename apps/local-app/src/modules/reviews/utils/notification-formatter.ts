/**
 * Notification formatter for review comments.
 * Produces terminal-friendly messages with MCP tool hints for agent interaction.
 */

export interface CommentNotificationInput {
  commentId: string;
  reviewId: string;
  content: string;
  commentType: 'comment' | 'suggestion' | 'issue' | 'approval';
  authorName: string;
  filePath: string | null;
  lineStart: number | null;
  lineEnd: number | null;
  reviewTitle: string;
}

const COMMENT_TYPE_BADGES: Record<CommentNotificationInput['commentType'], string> = {
  comment: '[Comment]',
  suggestion: '[Suggestion]',
  issue: '[Issue]',
  approval: '[Approval]',
};

/**
 * Formats a review comment notification for terminal display.
 * Includes structured information and MCP tool hints for agent actions.
 */
export function formatReviewCommentNotification(input: CommentNotificationInput): string {
  const lines: string[] = [];

  // Header with comment type badge
  const badge = COMMENT_TYPE_BADGES[input.commentType];
  lines.push(`## ${badge} Review Comment`);
  lines.push('');

  // Review context
  lines.push(`**Review:** ${input.reviewTitle}`);
  lines.push(`**From:** ${input.authorName}`);

  // File location (if applicable)
  if (input.filePath) {
    const lineInfo = formatLineRange(input.lineStart, input.lineEnd);
    lines.push(`**File:** \`${input.filePath}\`${lineInfo}`);
  }

  lines.push('');

  // Comment content
  lines.push('### Content');
  lines.push(truncateContent(input.content, 500));
  lines.push('');

  // MCP tool hints
  lines.push('### Actions');
  lines.push('Use these MCP tools to respond (use your session ID):');
  lines.push('');
  lines.push('**Reply to this comment:**');
  lines.push('```');
  lines.push(
    `devchain_reply_comment(sessionId="<your-session-id>", reviewId="${input.reviewId}", parentCommentId="${input.commentId}", content="Your response here")`,
  );
  lines.push('```');
  lines.push('');
  lines.push('**Resolve this comment:**');
  lines.push('```');
  lines.push(
    `devchain_resolve_comment(sessionId="<your-session-id>", commentId="${input.commentId}", version=<comment-version>)`,
  );
  lines.push('```');
  lines.push('(Fetch comment first with devchain_get_review_comments to get current version)');
  lines.push('');
  lines.push('**View full review context:**');
  lines.push('```');
  lines.push(`devchain_get_review(sessionId="<your-session-id>", reviewId="${input.reviewId}")`);
  lines.push('```');

  return lines.join('\n');
}

/**
 * Formats a line range for display.
 * Returns empty string if no line info, or formatted range like " (L42)" or " (L42-45)".
 */
function formatLineRange(lineStart: number | null, lineEnd: number | null): string {
  if (lineStart === null) {
    return '';
  }
  if (lineEnd !== null && lineEnd !== lineStart) {
    return ` (L${lineStart}-${lineEnd})`;
  }
  return ` (L${lineStart})`;
}

/**
 * Truncates content to a maximum length with ellipsis.
 */
function truncateContent(content: string, maxLength: number): string {
  if (content.length <= maxLength) {
    return content;
  }
  return content.slice(0, maxLength - 3) + '...';
}
