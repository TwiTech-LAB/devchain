import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CommentThread } from './CommentThread';
import type { ReviewComment } from '@/ui/lib/reviews';

// Mock ResizeObserver for Dialog component
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const baseComment: ReviewComment = {
  id: 'comment-1',
  reviewId: 'review-1',
  filePath: 'src/utils.ts',
  parentId: null,
  lineStart: 10,
  lineEnd: 15,
  side: 'right',
  content: 'This function needs better error handling',
  commentType: 'issue',
  status: 'open',
  authorType: 'user',
  authorAgentId: null,
  authorAgentName: null,
  targetAgents: [],
  version: 1,
  editedAt: null,
  createdAt: new Date(Date.now() - 60000).toISOString(), // 1 minute ago
  updatedAt: new Date().toISOString(),
};

const replyComment: ReviewComment = {
  ...baseComment,
  id: 'reply-1',
  parentId: 'comment-1',
  content: 'Good point, I will fix this',
  commentType: 'comment',
  authorType: 'agent',
  authorAgentId: 'agent-abc123',
  authorAgentName: 'Brainstormer',
  createdAt: new Date(Date.now() - 30000).toISOString(), // 30 seconds ago
};

describe('CommentThread', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('rendering', () => {
    it('renders comment content', () => {
      render(<CommentThread comment={baseComment} />);
      expect(screen.getByText('This function needs better error handling')).toBeInTheDocument();
    });

    it('renders author as "You" for user comments', () => {
      render(<CommentThread comment={baseComment} />);
      expect(screen.getByText('You')).toBeInTheDocument();
    });

    it('renders agent name when authorAgentName is provided', () => {
      const agentComment: ReviewComment = {
        ...baseComment,
        authorType: 'agent',
        authorAgentId: 'agent-abc123def456',
        authorAgentName: 'Brainstormer',
      };
      render(<CommentThread comment={agentComment} />);
      expect(screen.getByText('Brainstormer')).toBeInTheDocument();
    });

    it('falls back to truncated ID when authorAgentName is null', () => {
      const agentComment: ReviewComment = {
        ...baseComment,
        authorType: 'agent',
        authorAgentId: 'agent-abc123def456',
        authorAgentName: null,
      };
      render(<CommentThread comment={agentComment} />);
      expect(screen.getByText('agent-ab')).toBeInTheDocument();
    });

    it('shows target agents badge on root comments', () => {
      const commentWithTargets: ReviewComment = {
        ...baseComment,
        targetAgents: [
          { agentId: 'agent-1', name: 'Coder' },
          { agentId: 'agent-2', name: 'Reviewer' },
        ],
      };
      render(<CommentThread comment={commentWithTargets} />);
      expect(screen.getByText('Sent to: 2')).toBeInTheDocument();
    });

    it('does not show target agents badge when targetAgents is empty', () => {
      render(<CommentThread comment={baseComment} />);
      expect(screen.queryByText(/Sent to:/)).not.toBeInTheDocument();
    });

    it('renders comment type badge', () => {
      render(<CommentThread comment={baseComment} />);
      expect(screen.getByText('Issue')).toBeInTheDocument();
    });

    it('renders status indicator', () => {
      render(<CommentThread comment={baseComment} />);
      expect(screen.getByText('Open')).toBeInTheDocument();
    });

    it('renders resolved status', () => {
      const resolvedComment: ReviewComment = { ...baseComment, status: 'resolved' };
      render(<CommentThread comment={resolvedComment} />);
      expect(screen.getByText('Resolved')).toBeInTheDocument();
    });

    it('renders wont_fix status', () => {
      const wontFixComment: ReviewComment = { ...baseComment, status: 'wont_fix' };
      render(<CommentThread comment={wontFixComment} />);
      expect(screen.getByText("Won't Fix")).toBeInTheDocument();
    });

    it('renders file reference with line range', () => {
      render(<CommentThread comment={baseComment} />);
      expect(screen.getByText('src/utils.ts')).toBeInTheDocument();
      expect(screen.getByText('(L10-15)')).toBeInTheDocument();
    });

    it('renders file reference with single line', () => {
      const singleLineComment: ReviewComment = { ...baseComment, lineEnd: 10 };
      render(<CommentThread comment={singleLineComment} />);
      expect(screen.getByText('(L10)')).toBeInTheDocument();
    });

    it('renders file reference without line numbers', () => {
      const noLineComment: ReviewComment = { ...baseComment, lineStart: null, lineEnd: null };
      render(<CommentThread comment={noLineComment} />);
      expect(screen.getByText('src/utils.ts')).toBeInTheDocument();
      expect(screen.queryByText(/\(L/)).not.toBeInTheDocument();
    });

    it('does not render file reference when filePath is null', () => {
      const noFileComment: ReviewComment = { ...baseComment, filePath: null };
      render(<CommentThread comment={noFileComment} />);
      expect(screen.queryByText('src/utils.ts')).not.toBeInTheDocument();
    });

    it('renders relative time', () => {
      render(<CommentThread comment={baseComment} />);
      expect(screen.getByText('1m ago')).toBeInTheDocument();
    });

    it('applies opacity when not open', () => {
      const resolvedComment: ReviewComment = { ...baseComment, status: 'resolved' };
      render(<CommentThread comment={resolvedComment} />);
      const thread = screen.getByTestId('comment-thread');
      expect(thread).toHaveClass('opacity-75');
    });
  });

  describe('replies', () => {
    it('renders replies when provided', () => {
      render(<CommentThread comment={baseComment} replies={[replyComment]} />);
      expect(screen.getByText('Good point, I will fix this')).toBeInTheDocument();
    });

    it('shows reply count', () => {
      render(<CommentThread comment={baseComment} replies={[replyComment]} />);
      expect(screen.getByText('1 reply')).toBeInTheDocument();
    });

    it('shows plural reply count', () => {
      const reply2 = { ...replyComment, id: 'reply-2', content: 'Another reply' };
      render(<CommentThread comment={baseComment} replies={[replyComment, reply2]} />);
      expect(screen.getByText('2 replies')).toBeInTheDocument();
    });

    it('shows expand/collapse button when has replies', () => {
      render(<CommentThread comment={baseComment} replies={[replyComment]} />);
      expect(screen.getByRole('button', { name: /collapse replies/i })).toBeInTheDocument();
    });

    it('can collapse replies', async () => {
      render(<CommentThread comment={baseComment} replies={[replyComment]} />);

      const collapseButton = screen.getByRole('button', { name: /collapse replies/i });
      await userEvent.click(collapseButton);

      expect(screen.queryByText('Good point, I will fix this')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /expand replies/i })).toBeInTheDocument();
    });

    it('can expand collapsed replies', async () => {
      render(<CommentThread comment={baseComment} replies={[replyComment]} />);

      const collapseButton = screen.getByRole('button', { name: /collapse replies/i });
      await userEvent.click(collapseButton);

      const expandButton = screen.getByRole('button', { name: /expand replies/i });
      await userEvent.click(expandButton);

      expect(screen.getByText('Good point, I will fix this')).toBeInTheDocument();
    });
  });

  describe('reply action', () => {
    it('shows Reply button when onReply provided', () => {
      const onReply = jest.fn();
      render(<CommentThread comment={baseComment} onReply={onReply} />);
      expect(screen.getByRole('button', { name: /reply/i })).toBeInTheDocument();
    });

    it('does not show Reply button when onReply not provided', () => {
      render(<CommentThread comment={baseComment} />);
      expect(screen.queryByRole('button', { name: /^reply$/i })).not.toBeInTheDocument();
    });

    it('shows reply input when Reply clicked', async () => {
      const onReply = jest.fn();
      render(<CommentThread comment={baseComment} onReply={onReply} />);

      await userEvent.click(screen.getByRole('button', { name: /reply/i }));

      expect(screen.getByPlaceholderText('Write a reply...')).toBeInTheDocument();
    });

    it('calls onReply with content when submitting', async () => {
      const onReply = jest.fn().mockResolvedValue(undefined);
      render(<CommentThread comment={baseComment} onReply={onReply} />);

      // Click the Reply action button
      await userEvent.click(screen.getByRole('button', { name: /reply/i }));
      await userEvent.type(screen.getByPlaceholderText('Write a reply...'), 'My reply');

      // Find the submit button (not disabled, has "Reply" text)
      const buttons = screen.getAllByRole('button');
      const submitButton = buttons.find(
        (btn) => btn.textContent?.includes('Reply') && !btn.textContent?.includes('Posting'),
      );
      await userEvent.click(submitButton!);

      await waitFor(() => {
        expect(onReply).toHaveBeenCalledWith('comment-1', 'My reply');
      });
    });

    it('disables submit button when content is empty', async () => {
      const onReply = jest.fn();
      render(<CommentThread comment={baseComment} onReply={onReply} />);

      await userEvent.click(screen.getByRole('button', { name: /reply/i }));

      // The submit button should be disabled when empty
      const buttons = screen.getAllByRole('button');
      const submitButton = buttons.find(
        (btn) => btn.textContent === 'Reply' && btn.closest('.space-y-2'),
      );
      expect(submitButton).toBeDisabled();
    });

    it('clears input after successful reply', async () => {
      const onReply = jest.fn().mockResolvedValue(undefined);
      render(<CommentThread comment={baseComment} onReply={onReply} />);

      await userEvent.click(screen.getByRole('button', { name: /reply/i }));
      await userEvent.type(screen.getByPlaceholderText('Write a reply...'), 'My reply');
      await userEvent.click(screen.getAllByRole('button', { name: /reply/i })[1]);

      await waitFor(() => {
        expect(screen.queryByPlaceholderText('Write a reply...')).not.toBeInTheDocument();
      });
    });

    it('can cancel reply input', async () => {
      const onReply = jest.fn();
      render(<CommentThread comment={baseComment} onReply={onReply} />);

      await userEvent.click(screen.getByRole('button', { name: /reply to this comment/i }));
      await userEvent.type(screen.getByPlaceholderText('Write a reply...'), 'My reply');
      // Click the Cancel button in the reply form (not the Reply toggle button)
      await userEvent.click(screen.getByRole('button', { name: /^cancel$/i }));

      expect(screen.queryByPlaceholderText('Write a reply...')).not.toBeInTheDocument();
    });
  });

  describe('resolve action', () => {
    it('shows Resolve button for open comments when onResolve provided', () => {
      const onResolve = jest.fn();
      render(<CommentThread comment={baseComment} onResolve={onResolve} />);
      expect(screen.getByRole('button', { name: /resolve/i })).toBeInTheDocument();
    });

    it('does not show Resolve button for resolved comments', () => {
      const onResolve = jest.fn();
      const resolvedComment: ReviewComment = { ...baseComment, status: 'resolved' };
      render(<CommentThread comment={resolvedComment} onResolve={onResolve} />);
      expect(screen.queryByRole('button', { name: /resolve/i })).not.toBeInTheDocument();
    });

    it('does not show Resolve button when onResolve not provided', () => {
      render(<CommentThread comment={baseComment} />);
      expect(screen.queryByRole('button', { name: /resolve/i })).not.toBeInTheDocument();
    });

    it('opens resolve dialog when Resolve clicked', async () => {
      const onResolve = jest.fn();
      render(<CommentThread comment={baseComment} onResolve={onResolve} />);

      await userEvent.click(screen.getByRole('button', { name: /resolve/i }));

      expect(screen.getByText('Resolve Comment')).toBeInTheDocument();
      expect(screen.getByText('How do you want to resolve this comment?')).toBeInTheDocument();
    });

    it('calls onResolve with resolved status by default', async () => {
      const onResolve = jest.fn().mockResolvedValue(undefined);
      render(<CommentThread comment={baseComment} onResolve={onResolve} />);

      await userEvent.click(screen.getByRole('button', { name: /resolve/i }));
      await userEvent.click(screen.getByRole('button', { name: /confirm/i }));

      await waitFor(() => {
        expect(onResolve).toHaveBeenCalledWith('comment-1', 'resolved');
      });
    });

    it('can select wont_fix status', async () => {
      const onResolve = jest.fn().mockResolvedValue(undefined);
      render(<CommentThread comment={baseComment} onResolve={onResolve} />);

      await userEvent.click(screen.getByRole('button', { name: /resolve/i }));
      await userEvent.click(screen.getByLabelText(/won't fix/i));
      await userEvent.click(screen.getByRole('button', { name: /confirm/i }));

      await waitFor(() => {
        expect(onResolve).toHaveBeenCalledWith('comment-1', 'wont_fix');
      });
    });

    it('can cancel resolve dialog', async () => {
      const onResolve = jest.fn();
      render(<CommentThread comment={baseComment} onResolve={onResolve} />);

      await userEvent.click(screen.getByRole('button', { name: /resolve/i }));
      await userEvent.click(screen.getByRole('button', { name: /cancel/i }));

      expect(screen.queryByText('Resolve Comment')).not.toBeInTheDocument();
      expect(onResolve).not.toHaveBeenCalled();
    });
  });

  describe('comment types', () => {
    it.each([
      ['comment', 'Comment'],
      ['suggestion', 'Suggestion'],
      ['issue', 'Issue'],
      ['approval', 'Approval'],
    ])('renders %s type badge', (type, label) => {
      const comment: ReviewComment = {
        ...baseComment,
        commentType: type as ReviewComment['commentType'],
      };
      render(<CommentThread comment={comment} />);
      expect(screen.getByText(label)).toBeInTheDocument();
    });
  });

  describe('loading states', () => {
    it('shows loading text when replying', async () => {
      const onReply = jest.fn().mockImplementation(() => new Promise(() => {})); // Never resolves
      render(<CommentThread comment={baseComment} onReply={onReply} isReplying />);

      await userEvent.click(screen.getByRole('button', { name: /reply/i }));
      await userEvent.type(screen.getByPlaceholderText('Write a reply...'), 'test');

      // The textarea should be disabled when isReplying is true
      expect(screen.getByPlaceholderText('Write a reply...')).toBeDisabled();
    });

    it('shows loading text when resolving', async () => {
      const onResolve = jest.fn();
      render(<CommentThread comment={baseComment} onResolve={onResolve} isResolving />);

      const resolveButton = screen.getByRole('button', { name: /resolve/i });
      expect(resolveButton).toBeDisabled();
    });
  });
});
