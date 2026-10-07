import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  AddCommentButton,
  CommentIndicator,
  InlineCommentWidget,
  NewCommentForm,
} from './InlineComment';
import type { ReviewComment } from '@/ui/lib/reviews';

// Test wrapper for components that need QueryClient
function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

// Mock ResizeObserver
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
  lineEnd: 10,
  side: 'new',
  content: 'This needs improvement',
  commentType: 'issue',
  status: 'open',
  authorType: 'user',
  authorAgentId: null,
  authorAgentName: null,
  targetAgents: [],
  version: 1,
  editedAt: null,
  createdAt: new Date(Date.now() - 60000).toISOString(),
  updatedAt: new Date().toISOString(),
};

const replyComment: ReviewComment = {
  ...baseComment,
  id: 'reply-1',
  parentId: 'comment-1',
  content: 'I will fix this',
  authorType: 'agent',
  authorAgentId: 'agent-abc123',
  authorAgentName: null, // Test fallback to truncated ID
  createdAt: new Date(Date.now() - 30000).toISOString(),
};

describe('AddCommentButton', () => {
  it('calls onAddComment with line number when clicked', async () => {
    const onAddComment = jest.fn();
    render(<AddCommentButton lineNumber={10} side="new" onAddComment={onAddComment} />);

    await userEvent.click(screen.getByTitle('Add comment'));

    expect(onAddComment).toHaveBeenCalledWith(10, 10, 'new');
  });

  it('calls onAddComment with selection range when in selection', async () => {
    const onAddComment = jest.fn();
    render(
      <AddCommentButton
        lineNumber={12}
        side="new"
        onAddComment={onAddComment}
        lineSelection={{ lineStart: 10, lineEnd: 15, side: 'new' }}
      />,
    );

    await userEvent.click(screen.getByTitle('Add comment'));

    expect(onAddComment).toHaveBeenCalledWith(10, 15, 'new');
  });
});

describe('CommentIndicator', () => {
  it('renders comment count indicator', () => {
    const onClick = jest.fn();
    render(<CommentIndicator commentCount={3} hasUnresolved={false} onClick={onClick} />);

    expect(screen.getByTitle('3 comments')).toBeInTheDocument();
  });

  it('renders singular comment text for 1 comment', () => {
    const onClick = jest.fn();
    render(<CommentIndicator commentCount={1} hasUnresolved={false} onClick={onClick} />);

    expect(screen.getByTitle('1 comment')).toBeInTheDocument();
  });

  it('calls onClick when clicked', async () => {
    const onClick = jest.fn();
    render(<CommentIndicator commentCount={2} hasUnresolved={false} onClick={onClick} />);

    await userEvent.click(screen.getByTitle('2 comments'));

    expect(onClick).toHaveBeenCalled();
  });

  it('has warning tokens when hasUnresolved is true', () => {
    const onClick = jest.fn();
    render(<CommentIndicator commentCount={1} hasUnresolved={true} onClick={onClick} />);

    const button = screen.getByTitle('1 comment');
    expect(button).toHaveClass('bg-status-warn/10', 'text-status-warn', 'border-status-warn/40');
  });
});

describe('InlineCommentWidget', () => {
  it('shows comment context and controls: renders comment content', () => {
    render(<InlineCommentWidget comments={[baseComment]} />);
    {
      expect(screen.getByText('This needs improvement')).toBeInTheDocument();
    }
    {
      expect(screen.getByText('1 comment')).toBeInTheDocument();
    }
    {
      expect(screen.getByText('1 open')).toBeInTheDocument();
    }
    {
      expect(screen.queryByRole('button', { name: /reply/i })).not.toBeInTheDocument();
    }
    {
      expect(screen.getByText('You')).toBeInTheDocument();
    }
  });

  it('shows comment context and controls: renders plural count for multiple comments', () => {
    render(<InlineCommentWidget comments={[baseComment, replyComment]} />);
    {
      expect(screen.getByText('2 comments')).toBeInTheDocument();
    }
    {
      expect(screen.getByText('This needs improvement')).toBeInTheDocument();
      expect(screen.getByText('I will fix this')).toBeInTheDocument();
    }
  });

  it('can collapse comments', async () => {
    const onToggle = jest.fn();
    render(
      <InlineCommentWidget comments={[baseComment]} isExpanded={true} onToggleExpand={onToggle} />,
    );

    // Click the header to collapse
    await userEvent.click(screen.getByText('1 comment'));

    expect(onToggle).toHaveBeenCalled();
  });

  it('shows only header when collapsed', () => {
    render(<InlineCommentWidget comments={[baseComment]} isExpanded={false} />);

    expect(screen.getByText('1 comment')).toBeInTheDocument();
    expect(screen.queryByText('This needs improvement')).not.toBeInTheDocument();
  });

  it('calls onReply when submitting reply', async () => {
    const onReply = jest.fn().mockResolvedValue(undefined);
    render(<InlineCommentWidget comments={[baseComment]} onReply={onReply} />);

    await userEvent.click(screen.getByRole('button', { name: /reply/i }));
    await userEvent.type(screen.getByPlaceholderText('Write a reply...'), 'My reply');

    // Find and click the submit Reply button (not the one that opens input)
    const buttons = screen.getAllByRole('button', { name: /reply/i });
    await userEvent.click(buttons[buttons.length - 1]);

    await waitFor(() => {
      expect(onReply).toHaveBeenCalledWith('My reply');
    });
  });

  it.each([
    {
      label: 'agent name',
      comment: { ...replyComment, authorAgentName: 'Brainstormer' },
      expected: 'Brainstormer',
    },
    { label: 'truncated ID', comment: replyComment, expected: 'agent-ab' },
  ] as const)('$label', ({ comment, expected }) => {
    render(<InlineCommentWidget comments={[comment]} isExpanded={true} />);
    expect(screen.getByText(expected)).toBeInTheDocument();
  });
});

describe('NewCommentForm', () => {
  const defaultProps = {
    lineStart: 10,
    lineEnd: 10,
    side: 'new' as const,
    projectId: 'test-project-id',
    onSubmit: jest.fn(),
    onCancel: jest.fn(),
  };

  it('shows comment context and controls: renders form with line info', () => {
    render(<NewCommentForm {...defaultProps} />, { wrapper: createWrapper() });
    {
      expect(screen.getByText('Line 10 (new)')).toBeInTheDocument();
    }
    {
      expect(screen.getByRole('button', { name: /comment/i })).toBeDisabled();
    }
  });

  it('renders line range for multi-line', () => {
    render(<NewCommentForm {...defaultProps} lineStart={10} lineEnd={15} side="old" />, {
      wrapper: createWrapper(),
    });

    expect(screen.getByText('Lines 10-15 (old)')).toBeInTheDocument();
  });

  it('calls onCancel when Cancel clicked', async () => {
    const onCancel = jest.fn();
    render(<NewCommentForm {...defaultProps} onCancel={onCancel} />, { wrapper: createWrapper() });

    await userEvent.click(screen.getByRole('button', { name: /cancel/i }));

    expect(onCancel).toHaveBeenCalled();
  });

  it('calls onSubmit with content, type, and empty targetAgentIds when Comment clicked', async () => {
    const onSubmit = jest.fn().mockResolvedValue(undefined);
    render(<NewCommentForm {...defaultProps} onSubmit={onSubmit} />, { wrapper: createWrapper() });

    await userEvent.type(
      screen.getByPlaceholderText('Write a comment... (type @ to mention agents)'),
      'My comment',
    );
    await userEvent.click(screen.getByRole('button', { name: /comment/i }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith('My comment', 'comment', []);
    });
  });

  it('can select different comment types', async () => {
    const onSubmit = jest.fn().mockResolvedValue(undefined);
    render(<NewCommentForm {...defaultProps} onSubmit={onSubmit} />, { wrapper: createWrapper() });

    // Change to suggestion
    await userEvent.selectOptions(screen.getByRole('combobox'), 'suggestion');
    await userEvent.type(
      screen.getByPlaceholderText('Write a comment... (type @ to mention agents)'),
      'A suggestion',
    );
    await userEvent.click(screen.getByRole('button', { name: /comment/i }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith('A suggestion', 'suggestion', []);
    });
  });

  it('disables inputs when isSubmitting', () => {
    render(<NewCommentForm {...defaultProps} isSubmitting={true} />, { wrapper: createWrapper() });

    expect(
      screen.getByPlaceholderText('Write a comment... (type @ to mention agents)'),
    ).toBeDisabled();
    expect(screen.getByRole('combobox')).toBeDisabled();
  });
});
