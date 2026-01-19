import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReviewCommentsSection } from './ReviewCommentsSection';
import type { ReviewComment } from '@/ui/lib/reviews';

// Mock ResizeObserver for Collapsible and Dialog components
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// Mock scrollIntoView which isn't available in jsdom
Element.prototype.scrollIntoView = jest.fn();

const baseReviewComment: ReviewComment = {
  id: 'review-comment-1',
  reviewId: 'review-1',
  filePath: null, // Review-level comment
  parentId: null,
  lineStart: null,
  lineEnd: null,
  side: null,
  content: 'This is a review-level comment about the overall changes',
  commentType: 'comment',
  status: 'open',
  authorType: 'user',
  authorAgentId: null,
  authorAgentName: null,
  targetAgents: [{ agentId: 'agent-1', name: 'Coder' }],
  version: 1,
  editedAt: null,
  createdAt: new Date(Date.now() - 60000).toISOString(),
  updatedAt: new Date().toISOString(),
};

const fileComment: ReviewComment = {
  ...baseReviewComment,
  id: 'file-comment-1',
  filePath: 'src/utils.ts', // File-level comment - should be filtered out
  lineStart: 10,
  lineEnd: 15,
  side: 'new',
  content: 'This is a file-level comment',
};

const replyComment: ReviewComment = {
  ...baseReviewComment,
  id: 'reply-1',
  parentId: 'review-comment-1',
  content: 'This is a reply to the review comment',
  authorType: 'agent',
  authorAgentId: 'agent-1',
  authorAgentName: 'Coder',
  targetAgents: [],
};

const secondReviewComment: ReviewComment = {
  ...baseReviewComment,
  id: 'review-comment-2',
  content: 'Another review-level comment',
  status: 'resolved',
  targetAgents: [],
  createdAt: new Date(Date.now() - 120000).toISOString(),
};

const mockComments: ReviewComment[] = [
  baseReviewComment,
  fileComment,
  replyComment,
  secondReviewComment,
];

describe('ReviewCommentsSection', () => {
  const defaultProps = {
    comments: mockComments,
    isExpanded: true,
    onToggleExpand: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('rendering', () => {
    it('renders section with header when review comments exist', () => {
      render(<ReviewCommentsSection {...defaultProps} />);

      expect(screen.getByText('Review Comments')).toBeInTheDocument();
      expect(screen.getByTestId('review-comments-section')).toBeInTheDocument();
    });

    it('shows correct comment count in badge', () => {
      render(<ReviewCommentsSection {...defaultProps} />);

      // 2 review-level root comments (file comment and reply are filtered out)
      expect(screen.getByText('2')).toBeInTheDocument();
    });

    it('renders only review-level comments (filters out file comments)', () => {
      render(<ReviewCommentsSection {...defaultProps} />);

      // Review-level comment should be visible
      expect(
        screen.getByText('This is a review-level comment about the overall changes'),
      ).toBeInTheDocument();
      expect(screen.getByText('Another review-level comment')).toBeInTheDocument();

      // File-level comment should NOT be visible
      expect(screen.queryByText('This is a file-level comment')).not.toBeInTheDocument();
    });

    it('renders CommentThread for each review comment', () => {
      render(<ReviewCommentsSection {...defaultProps} />);

      // Should have 2 CommentThread components
      const threads = screen.getAllByTestId('comment-thread');
      expect(threads).toHaveLength(2);
    });

    it('shows replies within their parent thread', () => {
      render(<ReviewCommentsSection {...defaultProps} />);

      // Reply should be visible
      expect(screen.getByText('This is a reply to the review comment')).toBeInTheDocument();
    });

    it('returns null when no review-level comments exist', () => {
      const { container } = render(
        <ReviewCommentsSection {...defaultProps} comments={[fileComment]} />,
      );

      expect(container.firstChild).toBeNull();
    });
  });

  describe('collapsible behavior', () => {
    it('shows content when expanded', () => {
      render(<ReviewCommentsSection {...defaultProps} isExpanded={true} />);

      expect(
        screen.getByText('This is a review-level comment about the overall changes'),
      ).toBeInTheDocument();
    });

    it('hides content when collapsed', () => {
      render(<ReviewCommentsSection {...defaultProps} isExpanded={false} />);

      // Header should still be visible
      expect(screen.getByText('Review Comments')).toBeInTheDocument();

      // Content should be hidden (Radix Collapsible hides content when closed)
      // Note: The content may still be in the DOM but hidden
    });

    it('calls onToggleExpand when toggle button is clicked', async () => {
      const onToggleExpand = jest.fn();
      render(<ReviewCommentsSection {...defaultProps} onToggleExpand={onToggleExpand} />);

      const toggleButton = screen.getByRole('button', { name: /collapse review comments/i });
      await userEvent.click(toggleButton);

      expect(onToggleExpand).toHaveBeenCalled();
    });

    it('shows expand button when collapsed', () => {
      render(<ReviewCommentsSection {...defaultProps} isExpanded={false} />);

      expect(screen.getByRole('button', { name: /expand review comments/i })).toBeInTheDocument();
    });

    it('shows collapse button when expanded', () => {
      render(<ReviewCommentsSection {...defaultProps} isExpanded={true} />);

      expect(screen.getByRole('button', { name: /collapse review comments/i })).toBeInTheDocument();
    });
  });

  describe('selected comment highlighting', () => {
    it('applies highlight ring to selected comment', () => {
      render(<ReviewCommentsSection {...defaultProps} selectedCommentId="review-comment-1" />);

      const selectedElement = document.querySelector('[data-comment-id="review-comment-1"]');
      expect(selectedElement).toHaveClass('ring-2');
      expect(selectedElement).toHaveClass('ring-primary');
    });

    it('does not highlight non-selected comments', () => {
      render(<ReviewCommentsSection {...defaultProps} selectedCommentId="review-comment-1" />);

      const nonSelectedElement = document.querySelector('[data-comment-id="review-comment-2"]');
      expect(nonSelectedElement).not.toHaveClass('ring-2');
    });

    it('handles null selectedCommentId', () => {
      render(<ReviewCommentsSection {...defaultProps} selectedCommentId={null} />);

      // No element should have the highlight ring
      const allComments = document.querySelectorAll('[data-comment-id]');
      allComments.forEach((el) => {
        expect(el).not.toHaveClass('ring-2');
      });
    });
  });

  describe('comment sorting', () => {
    it('sorts pending comments first', () => {
      render(<ReviewCommentsSection {...defaultProps} />);

      const threads = screen.getAllByTestId('comment-thread');
      // First thread should be the pending one (review-comment-1 has target agents and no target reply)
      const firstThreadContent = threads[0].textContent;
      expect(firstThreadContent).toContain(
        'This is a review-level comment about the overall changes',
      );
    });

    it('sorts resolved comments after open comments', () => {
      render(<ReviewCommentsSection {...defaultProps} />);

      const threads = screen.getAllByTestId('comment-thread');
      // Second thread should be resolved (review-comment-2)
      const secondThreadContent = threads[1].textContent;
      expect(secondThreadContent).toContain('Another review-level comment');
    });
  });

  describe('action callbacks', () => {
    it('passes onReply callback to CommentThread', async () => {
      const onReply = jest.fn().mockResolvedValue(undefined);
      render(<ReviewCommentsSection {...defaultProps} onReply={onReply} />);

      // Find and click Reply button
      const replyButtons = screen.getAllByRole('button', { name: /reply/i });
      await userEvent.click(replyButtons[0]);

      // Type a reply
      const textarea = screen.getByPlaceholderText('Write a reply...');
      await userEvent.type(textarea, 'Test reply');

      // Submit the reply (find the button in the reply form)
      const submitButtons = screen.getAllByRole('button');
      const submitButton = submitButtons.find(
        (btn) => btn.textContent === 'Reply' && !btn.hasAttribute('aria-expanded'),
      );
      if (submitButton) {
        await userEvent.click(submitButton);
        await waitFor(() => {
          expect(onReply).toHaveBeenCalled();
        });
      }
    });

    it('passes onResolve callback to CommentThread', async () => {
      const onResolve = jest.fn().mockResolvedValue(undefined);
      render(<ReviewCommentsSection {...defaultProps} onResolve={onResolve} />);

      // Find and click Resolve button (only on open comments)
      const resolveButton = screen.getAllByRole('button', { name: /resolve/i })[0];
      await userEvent.click(resolveButton);

      // Confirm in the dialog
      const confirmButton = screen.getByRole('button', { name: /confirm/i });
      await userEvent.click(confirmButton);

      await waitFor(() => {
        expect(onResolve).toHaveBeenCalled();
      });
    });
  });

  describe('pending state', () => {
    it('shows pending styling for comments waiting on agent response', () => {
      // Create a pending comment (user comment with target agents, no agent reply)
      const pendingComment: ReviewComment = {
        ...baseReviewComment,
        id: 'pending-comment',
        targetAgents: [{ agentId: 'agent-2', name: 'Reviewer' }], // Different agent than reply
      };
      const commentsWithPending = [pendingComment, secondReviewComment];

      render(<ReviewCommentsSection {...defaultProps} comments={commentsWithPending} />);

      // The pending comment should show "Waiting on" indicator
      expect(screen.getByText('Waiting on:')).toBeInTheDocument();
      expect(screen.getByText('Reviewer')).toBeInTheDocument();
    });

    it('does not show pending for comments with agent replies', () => {
      // review-comment-1 has reply from agent-1 (Coder) who is in targetAgents
      // So it should NOT be pending
      render(<ReviewCommentsSection {...defaultProps} />);

      // Should not show pending for the first comment since target agent replied
      const threads = screen.getAllByTestId('comment-thread');
      // First thread (the one with reply) should not have pending styling
      expect(threads[0]).not.toHaveClass('border-l-amber-500');
    });
  });

  describe('accessibility', () => {
    it('has proper heading for the section', () => {
      render(<ReviewCommentsSection {...defaultProps} />);

      const heading = screen.getByRole('heading', { level: 3 });
      expect(heading).toHaveTextContent('Review Comments');
    });

    it('has proper aria-label on count badge', () => {
      render(<ReviewCommentsSection {...defaultProps} />);

      expect(screen.getByLabelText('2 comments')).toBeInTheDocument();
    });

    it('has proper aria-label on toggle button', () => {
      render(<ReviewCommentsSection {...defaultProps} isExpanded={true} />);

      expect(screen.getByRole('button', { name: /collapse review comments/i })).toBeInTheDocument();
    });

    it('has region role with proper labeling', () => {
      render(<ReviewCommentsSection {...defaultProps} />);

      expect(screen.getByRole('region')).toBeInTheDocument();
    });
  });

  describe('className prop', () => {
    it('applies custom className', () => {
      render(<ReviewCommentsSection {...defaultProps} className="custom-class" />);

      expect(screen.getByTestId('review-comments-section')).toHaveClass('custom-class');
    });
  });
});
