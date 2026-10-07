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
  side: 'new',
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
    it('shows comment metadata and available reply controls: renders comment content', () => {
      render(<CommentThread comment={baseComment} />);
      {
        expect(screen.getByText('This function needs better error handling')).toBeInTheDocument();
      }
      {
        expect(screen.getByText('You')).toBeInTheDocument();
      }
      {
        expect(screen.queryByText(/Sent to:/)).not.toBeInTheDocument();
      }
      {
        expect(screen.getByText('Issue')).toBeInTheDocument();
      }
      {
        expect(screen.getByText('Open')).toBeInTheDocument();
      }
      {
        expect(screen.getByText('src/utils.ts')).toBeInTheDocument();
        expect(screen.getByText('(L10-15)')).toBeInTheDocument();
      }
      {
        expect(screen.getByText('1m ago')).toBeInTheDocument();
      }
      {
        expect(screen.queryByRole('button', { name: /^reply$/i })).not.toBeInTheDocument();
      }
      {
        expect(screen.queryByRole('button', { name: /resolve/i })).not.toBeInTheDocument();
      }
    });

    it.each([
      {
        label: 'renders agent name when authorAgentName is provided',
        authorAgentName: 'Brainstormer',
        expectedName: 'Brainstormer',
      },
      {
        label: 'falls back to truncated ID when authorAgentName is null',
        authorAgentName: null,
        expectedName: 'agent-ab',
      },
    ] as const)('$label', ({ authorAgentName, expectedName }) => {
      const agentComment: ReviewComment = {
        ...baseComment,
        authorType: 'agent',
        authorAgentId: 'agent-abc123def456',
        authorAgentName: authorAgentName,
      };
      render(<CommentThread comment={agentComment} />);
      expect(screen.getByText(expectedName)).toBeInTheDocument();
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

    it.each([
      { status: 'resolved', text: 'Resolved' },
      { status: 'wont_fix', text: "Won't Fix" },
    ] as const)('renders $status state', ({ status, text }) => {
      render(<CommentThread comment={{ ...baseComment, status }} />);
      expect(screen.getByText(text)).toBeInTheDocument();
    });

    it.each([
      { label: 'single line', overrides: { lineEnd: 10 }, text: '(L10)', hasLines: true },
      {
        label: 'file without lines',
        overrides: { lineStart: null, lineEnd: null },
        text: 'src/utils.ts',
        hasLines: false,
      },
    ] as const)('$label', ({ overrides, text, hasLines }) => {
      render(<CommentThread comment={{ ...baseComment, ...overrides }} />);
      expect(screen.getByText(text)).toBeInTheDocument();
      expect(screen.queryByText(/\(L/) !== null).toBe(hasLines);
    });

    it('does not render file reference when filePath is null', () => {
      const noFileComment: ReviewComment = { ...baseComment, filePath: null };
      render(<CommentThread comment={noFileComment} />);
      expect(screen.queryByText('src/utils.ts')).not.toBeInTheDocument();
    });

    it('uses readable muted text when not open', () => {
      const resolvedComment: ReviewComment = { ...baseComment, status: 'resolved' };
      render(<CommentThread comment={resolvedComment} />);
      const thread = screen.getByTestId('comment-thread');
      expect(thread).toHaveClass('text-muted-foreground');
      expect(thread).not.toHaveClass('opacity-75');
    });
  });

  describe('replies', () => {
    it('shows comment metadata and available reply controls: renders replies when provided', () => {
      render(<CommentThread comment={baseComment} replies={[replyComment]} />);
      {
        expect(screen.getByText('Good point, I will fix this')).toBeInTheDocument();
      }
      {
        expect(screen.getByText('1 reply')).toBeInTheDocument();
      }
      {
        expect(screen.getByRole('button', { name: /collapse replies/i })).toBeInTheDocument();
      }
    });

    it('shows plural reply count', () => {
      const reply2 = { ...replyComment, id: 'reply-2', content: 'Another reply' };
      render(<CommentThread comment={baseComment} replies={[replyComment, reply2]} />);
      expect(screen.getByText('2 replies')).toBeInTheDocument();
    });

    it('can expand collapsed replies', async () => {
      render(<CommentThread comment={baseComment} replies={[replyComment]} />);

      const collapseButton = screen.getByRole('button', { name: /collapse replies/i });
      await userEvent.click(collapseButton);

      expect(screen.queryByText('Good point, I will fix this')).not.toBeInTheDocument();
      const expandButton = screen.getByRole('button', { name: /expand replies/i });
      await userEvent.click(expandButton);

      expect(screen.getByText('Good point, I will fix this')).toBeInTheDocument();
    });
  });

  describe('reply action', () => {
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
    it('does not show Resolve button for resolved comments', () => {
      const onResolve = jest.fn();
      const resolvedComment: ReviewComment = { ...baseComment, status: 'resolved' };
      render(<CommentThread comment={resolvedComment} onResolve={onResolve} />);
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
