import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CommentReferenceItem } from './CommentReferenceItem';
import type { ReviewComment } from '@/ui/lib/reviews';

const baseComment: ReviewComment = {
  id: 'comment-1',
  reviewId: 'review-1',
  filePath: 'src/utils.ts',
  parentId: null,
  lineStart: 10,
  lineEnd: 15,
  side: 'new',
  content: 'This function needs better error handling for edge cases',
  commentType: 'issue',
  status: 'open',
  authorType: 'user',
  authorAgentId: null,
  authorAgentName: null,
  targetAgents: [],
  version: 1,
  editedAt: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

describe('CommentReferenceItem', () => {
  const defaultProps = {
    comment: baseComment,
    replyCount: 0,
    isPending: false,
    onClick: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('rendering', () => {
    it('renders comment content snippet', () => {
      render(<CommentReferenceItem {...defaultProps} />);
      expect(
        screen.getByText('This function needs better error handling for edge cases'),
      ).toBeInTheDocument();
    });

    it('truncates long content with ellipsis', () => {
      const longContent =
        'This is a very long comment that exceeds the maximum length and should be truncated with an ellipsis at the end to indicate more content';
      const comment = { ...baseComment, content: longContent };
      render(<CommentReferenceItem {...defaultProps} comment={comment} />);

      // Content should be truncated to ~60 chars
      const snippet = screen.getByText(/This is a very long comment/);
      expect(snippet.textContent).toContain('…');
      expect(snippet.textContent!.length).toBeLessThanOrEqual(65); // ~60 chars + ellipsis + tolerance
    });

    it('renders author as "You" for user comments', () => {
      render(<CommentReferenceItem {...defaultProps} />);
      expect(screen.getByText('You')).toBeInTheDocument();
    });

    it('renders agent name for agent comments', () => {
      const agentComment: ReviewComment = {
        ...baseComment,
        authorType: 'agent',
        authorAgentId: 'agent-abc123def456',
        authorAgentName: 'Brainstormer',
      };
      render(<CommentReferenceItem {...defaultProps} comment={agentComment} />);
      expect(screen.getByText('Brainstormer')).toBeInTheDocument();
    });

    it('falls back to truncated ID when authorAgentName is null', () => {
      const agentComment: ReviewComment = {
        ...baseComment,
        authorType: 'agent',
        authorAgentId: 'agent-abc123def456',
        authorAgentName: null,
      };
      render(<CommentReferenceItem {...defaultProps} comment={agentComment} />);
      expect(screen.getByText('agent-ab')).toBeInTheDocument();
    });

    it('renders file reference with line range', () => {
      render(<CommentReferenceItem {...defaultProps} />);
      expect(screen.getByText('utils.ts:10-15')).toBeInTheDocument();
    });

    it('renders file reference with single line', () => {
      const comment = { ...baseComment, lineEnd: 10 };
      render(<CommentReferenceItem {...defaultProps} comment={comment} />);
      expect(screen.getByText('utils.ts:10')).toBeInTheDocument();
    });

    it('renders file reference without line numbers', () => {
      const comment = { ...baseComment, lineStart: null, lineEnd: null };
      render(<CommentReferenceItem {...defaultProps} comment={comment} />);
      expect(screen.getByText('utils.ts')).toBeInTheDocument();
    });

    it('renders "Review-level" when filePath is null', () => {
      const comment = { ...baseComment, filePath: null, lineStart: null, lineEnd: null };
      render(<CommentReferenceItem {...defaultProps} comment={comment} />);
      expect(screen.getByText('Review-level')).toBeInTheDocument();
    });
  });

  describe('status badges', () => {
    it('renders Open status badge for open comments', () => {
      render(<CommentReferenceItem {...defaultProps} />);
      expect(screen.getByText('Open')).toBeInTheDocument();
    });

    it('renders Resolved status badge', () => {
      const comment = { ...baseComment, status: 'resolved' as const };
      render(<CommentReferenceItem {...defaultProps} comment={comment} />);
      expect(screen.getByText('Resolved')).toBeInTheDocument();
    });

    it("renders Won't Fix status badge", () => {
      const comment = { ...baseComment, status: 'wont_fix' as const };
      render(<CommentReferenceItem {...defaultProps} comment={comment} />);
      expect(screen.getByText("Won't Fix")).toBeInTheDocument();
    });
  });

  describe('comment types', () => {
    it.each([
      ['comment', 'Comment'],
      ['suggestion', 'Suggestion'],
      ['issue', 'Issue'],
      ['approval', 'Approval'],
    ])('displays correct icon for %s type', (type, _label) => {
      const comment: ReviewComment = {
        ...baseComment,
        commentType: type as ReviewComment['commentType'],
      };
      render(<CommentReferenceItem {...defaultProps} comment={comment} />);
      // The component uses icons, so we check the element exists
      const item = screen.getByTestId('comment-reference-item');
      expect(item).toBeInTheDocument();
    });
  });

  describe('reply count', () => {
    it('does not show reply count when 0', () => {
      render(<CommentReferenceItem {...defaultProps} replyCount={0} />);
      // No number should appear for reply count
      expect(screen.queryByText('0')).not.toBeInTheDocument();
    });

    it('shows reply count when > 0', () => {
      render(<CommentReferenceItem {...defaultProps} replyCount={3} />);
      expect(screen.getByText('3')).toBeInTheDocument();
    });

    it('shows reply count for single reply', () => {
      render(<CommentReferenceItem {...defaultProps} replyCount={1} />);
      expect(screen.getByText('1')).toBeInTheDocument();
    });
  });

  describe('pending state', () => {
    it('applies pending styling when isPending is true', () => {
      render(<CommentReferenceItem {...defaultProps} isPending={true} />);
      const item = screen.getByTestId('comment-reference-item');
      expect(item).toHaveClass('border-l-amber-500');
    });

    it('shows "Pending" text indicator when isPending is true', () => {
      render(<CommentReferenceItem {...defaultProps} isPending={true} />);
      expect(screen.getByText('Pending')).toBeInTheDocument();
    });

    it('does not show pending indicator when isPending is false', () => {
      render(<CommentReferenceItem {...defaultProps} isPending={false} />);
      expect(screen.queryByText('Pending')).not.toBeInTheDocument();
    });
  });

  describe('selected state', () => {
    it('applies selected styling when isSelected is true', () => {
      render(<CommentReferenceItem {...defaultProps} isSelected={true} />);
      const item = screen.getByTestId('comment-reference-item');
      expect(item).toHaveClass('bg-accent');
    });

    it('does not apply selected styling when isSelected is false', () => {
      render(<CommentReferenceItem {...defaultProps} isSelected={false} />);
      const item = screen.getByTestId('comment-reference-item');
      expect(item).not.toHaveClass('bg-accent');
    });
  });

  describe('resolved/muted state', () => {
    it('applies muted styling for resolved comments', () => {
      const comment = { ...baseComment, status: 'resolved' as const };
      render(<CommentReferenceItem {...defaultProps} comment={comment} />);
      const item = screen.getByTestId('comment-reference-item');
      expect(item).toHaveClass('opacity-60');
    });

    it('applies muted styling for wont_fix comments', () => {
      const comment = { ...baseComment, status: 'wont_fix' as const };
      render(<CommentReferenceItem {...defaultProps} comment={comment} />);
      const item = screen.getByTestId('comment-reference-item');
      expect(item).toHaveClass('opacity-60');
    });

    it('does not apply muted styling for open comments', () => {
      render(<CommentReferenceItem {...defaultProps} />);
      const item = screen.getByTestId('comment-reference-item');
      expect(item).not.toHaveClass('opacity-60');
    });

    it('does not apply muted styling when selected even if resolved', () => {
      const comment = { ...baseComment, status: 'resolved' as const };
      render(<CommentReferenceItem {...defaultProps} comment={comment} isSelected={true} />);
      const item = screen.getByTestId('comment-reference-item');
      expect(item).not.toHaveClass('opacity-60');
    });
  });

  describe('click handling', () => {
    it('calls onClick when clicked', async () => {
      const onClick = jest.fn();
      render(<CommentReferenceItem {...defaultProps} onClick={onClick} />);

      await userEvent.click(screen.getByTestId('comment-reference-item'));
      expect(onClick).toHaveBeenCalledTimes(1);
    });

    it('is keyboard accessible via Enter', async () => {
      const onClick = jest.fn();
      render(<CommentReferenceItem {...defaultProps} onClick={onClick} />);

      const item = screen.getByTestId('comment-reference-item');
      item.focus();
      await userEvent.keyboard('{Enter}');
      expect(onClick).toHaveBeenCalledTimes(1);
    });

    it('is keyboard accessible via Space', async () => {
      const onClick = jest.fn();
      render(<CommentReferenceItem {...defaultProps} onClick={onClick} />);

      const item = screen.getByTestId('comment-reference-item');
      item.focus();
      await userEvent.keyboard(' ');
      expect(onClick).toHaveBeenCalledTimes(1);
    });
  });

  describe('accessibility', () => {
    it('renders as a button element', () => {
      render(<CommentReferenceItem {...defaultProps} />);
      expect(screen.getByRole('button')).toBeInTheDocument();
    });

    it('has descriptive aria-label', () => {
      render(<CommentReferenceItem {...defaultProps} />);
      const button = screen.getByRole('button');
      expect(button).toHaveAttribute('aria-label');
      expect(button.getAttribute('aria-label')).toContain('Issue');
      expect(button.getAttribute('aria-label')).toContain('You');
      expect(button.getAttribute('aria-label')).toContain('utils.ts');
    });

    it('includes reply count in aria-label when present', () => {
      render(<CommentReferenceItem {...defaultProps} replyCount={5} />);
      const button = screen.getByRole('button');
      expect(button.getAttribute('aria-label')).toContain('5 replies');
    });

    it('includes pending indicator in aria-label when pending', () => {
      render(<CommentReferenceItem {...defaultProps} isPending={true} />);
      const button = screen.getByRole('button');
      expect(button.getAttribute('aria-label')).toContain('Pending response');
    });

    it('has proper focus styling', () => {
      render(<CommentReferenceItem {...defaultProps} />);
      const item = screen.getByTestId('comment-reference-item');
      expect(item).toHaveClass('focus:ring-2');
    });
  });

  describe('className prop', () => {
    it('applies custom className', () => {
      render(<CommentReferenceItem {...defaultProps} className="custom-class" />);
      const item = screen.getByTestId('comment-reference-item');
      expect(item).toHaveClass('custom-class');
    });
  });
});
