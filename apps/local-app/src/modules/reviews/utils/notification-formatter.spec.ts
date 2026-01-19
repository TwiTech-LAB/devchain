import {
  formatReviewCommentNotification,
  type CommentNotificationInput,
} from './notification-formatter';

describe('formatReviewCommentNotification', () => {
  const baseInput: CommentNotificationInput = {
    commentId: 'comment-123',
    reviewId: 'review-456',
    content: 'Please fix this code style issue.',
    commentType: 'issue',
    authorName: 'Reviewer',
    filePath: 'src/utils.ts',
    lineStart: 42,
    lineEnd: 45,
    reviewTitle: 'Fix authentication bug',
  };

  it('formats notification with all fields', () => {
    const result = formatReviewCommentNotification(baseInput);

    expect(result).toContain('## [Issue] Review Comment');
    expect(result).toContain('**Review:** Fix authentication bug');
    expect(result).toContain('**From:** Reviewer');
    expect(result).toContain('**File:** `src/utils.ts` (L42-45)');
    expect(result).toContain('### Content');
    expect(result).toContain('Please fix this code style issue.');
    expect(result).toContain('### Actions');
  });

  it('includes MCP tool hints with correct IDs', () => {
    const result = formatReviewCommentNotification(baseInput);

    // Reply hint should use parentCommentId for threading
    expect(result).toContain('devchain_reply_comment(sessionId="<your-session-id>"');
    expect(result).toContain('reviewId="review-456"');
    expect(result).toContain('parentCommentId="comment-123"');

    // Resolve hint should include version placeholder
    expect(result).toContain('devchain_resolve_comment(sessionId="<your-session-id>"');
    expect(result).toContain('commentId="comment-123"');
    expect(result).toContain('version=<comment-version>');

    // Get review hint
    expect(result).toContain('devchain_get_review(sessionId="<your-session-id>"');
    expect(result).toContain('reviewId="review-456"');
  });

  describe('comment type badges', () => {
    it('shows [Comment] badge for comment type', () => {
      const result = formatReviewCommentNotification({ ...baseInput, commentType: 'comment' });
      expect(result).toContain('## [Comment] Review Comment');
    });

    it('shows [Suggestion] badge for suggestion type', () => {
      const result = formatReviewCommentNotification({ ...baseInput, commentType: 'suggestion' });
      expect(result).toContain('## [Suggestion] Review Comment');
    });

    it('shows [Issue] badge for issue type', () => {
      const result = formatReviewCommentNotification({ ...baseInput, commentType: 'issue' });
      expect(result).toContain('## [Issue] Review Comment');
    });

    it('shows [Approval] badge for approval type', () => {
      const result = formatReviewCommentNotification({ ...baseInput, commentType: 'approval' });
      expect(result).toContain('## [Approval] Review Comment');
    });
  });

  describe('file location formatting', () => {
    it('formats single line correctly', () => {
      const input = { ...baseInput, lineStart: 42, lineEnd: 42 };
      const result = formatReviewCommentNotification(input);
      expect(result).toContain('**File:** `src/utils.ts` (L42)');
    });

    it('formats line range correctly', () => {
      const input = { ...baseInput, lineStart: 42, lineEnd: 50 };
      const result = formatReviewCommentNotification(input);
      expect(result).toContain('**File:** `src/utils.ts` (L42-50)');
    });

    it('formats file without line info when lineStart is null', () => {
      const input = { ...baseInput, lineStart: null, lineEnd: null };
      const result = formatReviewCommentNotification(input);
      expect(result).toContain('**File:** `src/utils.ts`');
      expect(result).not.toContain('(L');
    });

    it('omits file line when filePath is null', () => {
      const input = { ...baseInput, filePath: null };
      const result = formatReviewCommentNotification(input);
      expect(result).not.toContain('**File:**');
    });
  });

  describe('content truncation', () => {
    it('preserves short content', () => {
      const input = { ...baseInput, content: 'Short content.' };
      const result = formatReviewCommentNotification(input);
      expect(result).toContain('Short content.');
      expect(result).not.toContain('...');
    });

    it('truncates content exceeding 500 characters', () => {
      const longContent = 'x'.repeat(600);
      const input = { ...baseInput, content: longContent };
      const result = formatReviewCommentNotification(input);
      expect(result).toContain('x'.repeat(497) + '...');
      expect(result).not.toContain('x'.repeat(500));
    });

    it('handles content exactly at 500 characters', () => {
      const exactContent = 'x'.repeat(500);
      const input = { ...baseInput, content: exactContent };
      const result = formatReviewCommentNotification(input);
      expect(result).toContain(exactContent);
      expect(result).not.toContain('...');
    });
  });

  it('produces valid markdown structure', () => {
    const result = formatReviewCommentNotification(baseInput);

    // Check markdown structure
    const lines = result.split('\n');

    // Should start with H2 header
    expect(lines[0]).toMatch(/^## /);

    // Should have Actions section
    expect(result).toContain('### Actions');
    expect(result).toContain('### Content');

    // Code blocks should be properly formatted
    expect(result).toContain('```');
    const codeBlockCount = (result.match(/```/g) || []).length;
    expect(codeBlockCount).toBe(6); // 3 opening + 3 closing
  });

  it('handles special characters in content', () => {
    const input = {
      ...baseInput,
      content: 'Code: `const x = 1;` and **bold** text with "quotes"',
    };
    const result = formatReviewCommentNotification(input);
    expect(result).toContain('Code: `const x = 1;` and **bold** text with "quotes"');
  });

  it('handles multi-line content', () => {
    const input = {
      ...baseInput,
      content: 'Line 1\nLine 2\nLine 3',
    };
    const result = formatReviewCommentNotification(input);
    expect(result).toContain('Line 1\nLine 2\nLine 3');
  });
});
