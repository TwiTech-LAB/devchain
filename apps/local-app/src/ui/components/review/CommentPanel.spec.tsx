import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { CommentPanel } from './CommentPanel';
import type { ReviewComment, CommentsListResponse } from '@/ui/lib/reviews';

// Mock ResizeObserver for ScrollArea and Dialog components
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const baseComments: ReviewComment[] = [
  {
    id: 'comment-1',
    reviewId: 'review-1',
    filePath: 'src/utils.ts',
    parentId: null,
    lineStart: 10,
    lineEnd: 15,
    side: 'new',
    content: 'File-level comment on utils.ts',
    commentType: 'issue',
    status: 'open',
    authorType: 'user',
    authorAgentId: null,
    authorAgentName: null,
    targetAgents: [
      { agentId: 'agent-1', name: 'Coder' },
      { agentId: 'agent-2', name: 'Reviewer' },
    ],
    version: 1,
    editedAt: null,
    createdAt: new Date(Date.now() - 60000).toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'comment-2',
    reviewId: 'review-1',
    filePath: null,
    parentId: null,
    lineStart: null,
    lineEnd: null,
    side: null,
    content: 'Review-level comment',
    commentType: 'comment',
    status: 'open',
    authorType: 'agent',
    authorAgentId: 'agent-abc',
    authorAgentName: 'Brainstormer',
    targetAgents: [],
    version: 1,
    editedAt: null,
    createdAt: new Date(Date.now() - 120000).toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'reply-1',
    reviewId: 'review-1',
    filePath: 'src/utils.ts',
    parentId: 'comment-1',
    lineStart: null,
    lineEnd: null,
    side: null,
    content: 'Reply to file comment',
    commentType: 'comment',
    status: 'open',
    authorType: 'agent',
    authorAgentId: 'agent-xyz',
    authorAgentName: null, // Test fallback to truncated ID
    targetAgents: [],
    version: 1,
    editedAt: null,
    createdAt: new Date(Date.now() - 30000).toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'comment-3',
    reviewId: 'review-1',
    filePath: 'src/other.ts',
    parentId: null,
    lineStart: 5,
    lineEnd: 5,
    side: 'new',
    content: 'Comment on other file',
    commentType: 'suggestion',
    status: 'resolved',
    authorType: 'user',
    authorAgentId: null,
    authorAgentName: null,
    targetAgents: [],
    version: 2,
    editedAt: null,
    createdAt: new Date(Date.now() - 180000).toISOString(),
    updatedAt: new Date().toISOString(),
  },
];

const mockCommentsResponse: CommentsListResponse = {
  items: baseComments,
  total: baseComments.length,
  limit: 100,
  offset: 0,
};

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

  return { Wrapper, queryClient };
}

function buildFetchMock(response: CommentsListResponse = mockCommentsResponse, shouldFail = false) {
  return jest.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();

    // Comments fetch
    if (url.includes('/api/reviews/') && url.includes('/comments')) {
      if (shouldFail) {
        return { ok: false, status: 500 } as Response;
      }
      return {
        ok: true,
        json: async () => response,
      } as Response;
    }

    return { ok: false, status: 404 } as Response;
  });
}

describe('CommentPanel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  describe('loading and error states', () => {
    it('shows loading skeleton while fetching', () => {
      global.fetch = jest.fn(() => new Promise(() => {})); // Never resolves
      const { Wrapper } = createWrapper();

      render(<CommentPanel reviewId="review-1" selectedFile={null} />, { wrapper: Wrapper });

      const skeletons = document.querySelectorAll('.animate-pulse');
      expect(skeletons.length).toBeGreaterThan(0);
    });

    it('shows error state when fetch fails', async () => {
      global.fetch = buildFetchMock(mockCommentsResponse, true);
      const { Wrapper } = createWrapper();

      render(<CommentPanel reviewId="review-1" selectedFile={null} />, { wrapper: Wrapper });

      await waitFor(() => {
        expect(screen.getByText('Failed to load comments')).toBeInTheDocument();
      });
    });
  });

  describe('rendering comments', () => {
    it('renders Comments header with count', async () => {
      global.fetch = buildFetchMock();
      const { Wrapper } = createWrapper();

      render(<CommentPanel reviewId="review-1" selectedFile={null} />, { wrapper: Wrapper });

      await waitFor(() => {
        expect(screen.getByText('Comments')).toBeInTheDocument();
      });

      // Root comments count (3 root comments: comment-1, comment-2, comment-3)
      await waitFor(() => {
        const threes = screen.getAllByText('3');
        expect(threes.length).toBeGreaterThan(0);
      });
    });

    it('renders CommentReferenceItem for each root comment', async () => {
      global.fetch = buildFetchMock();
      const { Wrapper } = createWrapper();

      render(<CommentPanel reviewId="review-1" selectedFile={null} />, { wrapper: Wrapper });

      await waitFor(() => {
        const items = screen.getAllByTestId('comment-reference-item');
        expect(items).toHaveLength(3); // 3 root comments
      });
    });

    it('shows content snippets for all root comments', async () => {
      global.fetch = buildFetchMock();
      const { Wrapper } = createWrapper();

      render(<CommentPanel reviewId="review-1" selectedFile={null} />, { wrapper: Wrapper });

      await waitFor(() => {
        expect(screen.getByText('File-level comment on utils.ts')).toBeInTheDocument();
      });

      expect(screen.getByText('Review-level comment')).toBeInTheDocument();
      expect(screen.getByText('Comment on other file')).toBeInTheDocument();
    });

    it('shows reply count for comments with replies', async () => {
      global.fetch = buildFetchMock();
      const { Wrapper } = createWrapper();

      render(<CommentPanel reviewId="review-1" selectedFile={null} />, { wrapper: Wrapper });

      await waitFor(() => {
        expect(screen.getByText('File-level comment on utils.ts')).toBeInTheDocument();
      });

      // comment-1 has 1 reply (reply-1) - multiple "1"s may appear (reply count + filter badge)
      const ones = screen.getAllByText('1');
      expect(ones.length).toBeGreaterThan(0);
    });

    it('does not show reply content in sidebar (compact view)', async () => {
      global.fetch = buildFetchMock();
      const { Wrapper } = createWrapper();

      render(<CommentPanel reviewId="review-1" selectedFile={null} />, { wrapper: Wrapper });

      await waitFor(() => {
        expect(screen.getByText('File-level comment on utils.ts')).toBeInTheDocument();
      });

      // Reply content should not be visible (only reply count)
      expect(screen.queryByText('Reply to file comment')).not.toBeInTheDocument();
    });
  });

  describe('filter functionality', () => {
    it('renders filter buttons', async () => {
      global.fetch = buildFetchMock();
      const { Wrapper } = createWrapper();

      render(<CommentPanel reviewId="review-1" selectedFile={null} />, { wrapper: Wrapper });

      await waitFor(() => {
        // Use more specific queries - filter buttons have aria-label with "filter"
        expect(screen.getByRole('button', { name: /all filter/i })).toBeInTheDocument();
      });

      expect(screen.getByRole('button', { name: /files filter/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /review filter/i })).toBeInTheDocument();
    });

    it('shows review-level comments when Review filter clicked', async () => {
      global.fetch = buildFetchMock();
      const { Wrapper } = createWrapper();

      render(<CommentPanel reviewId="review-1" selectedFile={null} />, { wrapper: Wrapper });

      await waitFor(() => {
        expect(screen.getByText('File-level comment on utils.ts')).toBeInTheDocument();
      });

      await userEvent.click(screen.getByRole('button', { name: /review filter/i }));

      // Should only show review-level comment
      expect(screen.getByText('Review-level comment')).toBeInTheDocument();
      expect(screen.queryByText('File-level comment on utils.ts')).not.toBeInTheDocument();
      expect(screen.queryByText('Comment on other file')).not.toBeInTheDocument();
    });

    it('auto-switches to File filter when selectedFile changes', async () => {
      global.fetch = buildFetchMock();
      const { Wrapper } = createWrapper();

      const { rerender } = render(<CommentPanel reviewId="review-1" selectedFile={null} />, {
        wrapper: Wrapper,
      });

      await waitFor(() => {
        expect(screen.getByText('File-level comment on utils.ts')).toBeInTheDocument();
      });

      // Initially shows all comments
      expect(screen.getByText('Review-level comment')).toBeInTheDocument();

      // Rerender with selectedFile
      rerender(
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <CommentPanel reviewId="review-1" selectedFile="src/utils.ts" />
        </QueryClientProvider>,
      );

      await waitFor(() => {
        expect(screen.getByText('File-level comment on utils.ts')).toBeInTheDocument();
      });
    });

    it('shows Files filter button with correct label', async () => {
      global.fetch = buildFetchMock();
      const { Wrapper } = createWrapper();

      render(<CommentPanel reviewId="review-1" selectedFile="src/utils.ts" />, {
        wrapper: Wrapper,
      });

      await waitFor(() => {
        expect(screen.getByText('File-level comment on utils.ts')).toBeInTheDocument();
      });

      // Files filter button should be present with label "Files"
      expect(screen.getByRole('button', { name: /files filter/i })).toBeInTheDocument();
    });
  });

  describe('empty states', () => {
    it('shows empty state when no comments', async () => {
      global.fetch = buildFetchMock({ items: [], total: 0, limit: 100, offset: 0 });
      const { Wrapper } = createWrapper();

      render(<CommentPanel reviewId="review-1" selectedFile={null} />, { wrapper: Wrapper });

      await waitFor(() => {
        expect(screen.getByText('No comments yet')).toBeInTheDocument();
      });
    });

    it('shows empty state when no file comments exist', async () => {
      // Only review-level comments (no file comments)
      const onlyReviewComments = baseComments.filter((c) => c.filePath === null);
      global.fetch = buildFetchMock({
        items: onlyReviewComments,
        total: onlyReviewComments.length,
        limit: 100,
        offset: 0,
      });
      const { Wrapper } = createWrapper();

      render(<CommentPanel reviewId="review-1" selectedFile={null} />, {
        wrapper: Wrapper,
      });

      await waitFor(() => {
        expect(screen.getByText('Review-level comment')).toBeInTheDocument();
      });

      // Switch to Files filter
      await userEvent.click(screen.getByRole('button', { name: /files filter/i }));

      expect(screen.getByText('No file comments yet')).toBeInTheDocument();
    });

    it('shows empty state for review-level when none exist', async () => {
      const noReviewComments = baseComments.filter((c) => c.filePath !== null);
      global.fetch = buildFetchMock({
        items: noReviewComments,
        total: noReviewComments.length,
        limit: 100,
        offset: 0,
      });
      const { Wrapper } = createWrapper();

      render(<CommentPanel reviewId="review-1" selectedFile={null} />, { wrapper: Wrapper });

      await waitFor(() => {
        expect(screen.getByText('File-level comment on utils.ts')).toBeInTheDocument();
      });

      await userEvent.click(screen.getByRole('button', { name: /review filter/i }));

      expect(screen.getByText('No review-level comments')).toBeInTheDocument();
    });
  });

  describe('filter counts', () => {
    it('shows count badges on filter buttons', async () => {
      global.fetch = buildFetchMock();
      const { Wrapper } = createWrapper();

      render(<CommentPanel reviewId="review-1" selectedFile="src/utils.ts" />, {
        wrapper: Wrapper,
      });

      await waitFor(() => {
        expect(screen.getByText('File-level comment on utils.ts')).toBeInTheDocument();
      });

      // Check that count badges exist
      const threes = screen.getAllByText('3');
      expect(threes.length).toBeGreaterThan(0);
    });
  });

  describe('interactions', () => {
    it('calls onCommentSelect when comment is clicked (legacy callback)', async () => {
      global.fetch = buildFetchMock();
      const { Wrapper } = createWrapper();
      const onCommentSelect = jest.fn();

      render(
        <CommentPanel reviewId="review-1" selectedFile={null} onCommentSelect={onCommentSelect} />,
        { wrapper: Wrapper },
      );

      await waitFor(() => {
        expect(screen.getByText('File-level comment on utils.ts')).toBeInTheDocument();
      });

      // Click on the first comment reference item
      const commentItems = screen.getAllByTestId('comment-reference-item');
      await userEvent.click(commentItems[0]);

      expect(onCommentSelect).toHaveBeenCalled();
    });

    it('calls onNavigateToComment with navigation target when clicked', async () => {
      global.fetch = buildFetchMock();
      const { Wrapper } = createWrapper();
      const onNavigateToComment = jest.fn();

      render(
        <CommentPanel
          reviewId="review-1"
          selectedFile={null}
          onNavigateToComment={onNavigateToComment}
        />,
        { wrapper: Wrapper },
      );

      await waitFor(() => {
        expect(screen.getByText('File-level comment on utils.ts')).toBeInTheDocument();
      });

      // Click on the first comment reference item (comment-1)
      const commentItems = screen.getAllByTestId('comment-reference-item');
      await userEvent.click(commentItems[0]);

      expect(onNavigateToComment).toHaveBeenCalledWith({
        commentId: 'comment-1',
        filePath: 'src/utils.ts',
        lineStart: 10,
        side: 'new',
      });
    });

    it('highlights selected comment when selectedCommentId is set', async () => {
      global.fetch = buildFetchMock();
      const { Wrapper } = createWrapper();

      render(
        <CommentPanel reviewId="review-1" selectedFile={null} selectedCommentId="comment-1" />,
        { wrapper: Wrapper },
      );

      await waitFor(() => {
        expect(screen.getByText('File-level comment on utils.ts')).toBeInTheDocument();
      });

      // The selected comment should have the selected styling
      const commentItems = screen.getAllByTestId('comment-reference-item');
      // First item (comment-1 is pending so it's sorted first) should have bg-accent class
      expect(commentItems[0]).toHaveClass('bg-accent');
    });
  });

  describe('pending state', () => {
    it('shows pending indicator for comments waiting on agent response', async () => {
      global.fetch = buildFetchMock();
      const { Wrapper } = createWrapper();

      render(<CommentPanel reviewId="review-1" selectedFile={null} />, { wrapper: Wrapper });

      await waitFor(() => {
        expect(screen.getByText('File-level comment on utils.ts')).toBeInTheDocument();
      });

      // comment-1 is pending (has target agents and no target agent has replied)
      expect(screen.getByText('Pending')).toBeInTheDocument();
    });

    it('applies pending styling to pending comments', async () => {
      global.fetch = buildFetchMock();
      const { Wrapper } = createWrapper();

      render(<CommentPanel reviewId="review-1" selectedFile={null} />, { wrapper: Wrapper });

      await waitFor(() => {
        expect(screen.getByText('File-level comment on utils.ts')).toBeInTheDocument();
      });

      // The pending comment should have amber border styling
      const commentItems = screen.getAllByTestId('comment-reference-item');
      // Find the pending one (comment-1)
      const pendingItem = commentItems.find((item) =>
        item.classList.contains('border-l-amber-500'),
      );
      expect(pendingItem).toBeDefined();
    });
  });

  describe('agent name display', () => {
    it('renders agent name when authorAgentName is provided', async () => {
      global.fetch = buildFetchMock();
      const { Wrapper } = createWrapper();

      render(<CommentPanel reviewId="review-1" selectedFile={null} />, { wrapper: Wrapper });

      await waitFor(() => {
        // comment-2 has authorAgentName: 'Brainstormer'
        expect(screen.getByText('Brainstormer')).toBeInTheDocument();
      });
    });

    it('renders "You" for user-authored comments', async () => {
      global.fetch = buildFetchMock();
      const { Wrapper } = createWrapper();

      render(<CommentPanel reviewId="review-1" selectedFile={null} />, { wrapper: Wrapper });

      await waitFor(() => {
        expect(screen.getByText('File-level comment on utils.ts')).toBeInTheDocument();
      });

      // User comments show "You" as author
      const youLabels = screen.getAllByText('You');
      expect(youLabels.length).toBeGreaterThan(0);
    });
  });

  describe('accessibility', () => {
    it('should have no accessibility violations', async () => {
      global.fetch = buildFetchMock();
      const { Wrapper } = createWrapper();
      const { container } = render(<CommentPanel reviewId="review-1" selectedFile={null} />, {
        wrapper: Wrapper,
      });

      // Wait for comments to load
      await waitFor(() => {
        expect(screen.getByText('File-level comment on utils.ts')).toBeInTheDocument();
      });

      const results = await axe(container);
      expect(results).toHaveNoViolations();
    });

    it('uses proper region role with aria-label', async () => {
      global.fetch = buildFetchMock();
      const { Wrapper } = createWrapper();

      render(<CommentPanel reviewId="review-1" selectedFile={null} />, { wrapper: Wrapper });

      await waitFor(() => {
        expect(screen.getByText('File-level comment on utils.ts')).toBeInTheDocument();
      });

      expect(screen.getByRole('region', { name: /comments panel/i })).toBeInTheDocument();
    });
  });

  describe('file grouping', () => {
    it('groups file comments by file path when Files filter is active', async () => {
      global.fetch = buildFetchMock();
      const { Wrapper } = createWrapper();

      render(<CommentPanel reviewId="review-1" selectedFile={null} />, { wrapper: Wrapper });

      await waitFor(() => {
        expect(screen.getByText('File-level comment on utils.ts')).toBeInTheDocument();
      });

      // Click Files filter
      await userEvent.click(screen.getByRole('button', { name: /files filter/i }));

      // Should show file group headers
      await waitFor(() => {
        const fileGroups = screen.getAllByTestId('file-group');
        expect(fileGroups.length).toBe(2); // utils.ts and other.ts
      });
    });

    it('renders collapsible file group headers with aria-expanded', async () => {
      global.fetch = buildFetchMock();
      const { Wrapper } = createWrapper();

      render(<CommentPanel reviewId="review-1" selectedFile={null} />, { wrapper: Wrapper });

      await waitFor(() => {
        expect(screen.getByText('File-level comment on utils.ts')).toBeInTheDocument();
      });

      // Click Files filter
      await userEvent.click(screen.getByRole('button', { name: /files filter/i }));

      // File group headers should have aria-expanded attribute
      await waitFor(() => {
        const groupHeaders = screen.getAllByTestId('file-group-header');
        expect(groupHeaders.length).toBeGreaterThan(0);
        // All should be expanded by default
        groupHeaders.forEach((header) => {
          expect(header).toHaveAttribute('aria-expanded', 'true');
        });
      });
    });

    it('collapses and expands file group when chevron is clicked', async () => {
      global.fetch = buildFetchMock();
      const { Wrapper } = createWrapper();

      render(<CommentPanel reviewId="review-1" selectedFile={null} />, { wrapper: Wrapper });

      await waitFor(() => {
        expect(screen.getByText('File-level comment on utils.ts')).toBeInTheDocument();
      });

      // Click Files filter
      await userEvent.click(screen.getByRole('button', { name: /files filter/i }));

      await waitFor(() => {
        const groupHeaders = screen.getAllByTestId('file-group-header');
        expect(groupHeaders.length).toBeGreaterThan(0);
      });

      // Comment should be visible initially
      expect(screen.getByText('File-level comment on utils.ts')).toBeInTheDocument();

      // Click the chevron (collapse button) to collapse - NOT the whole header
      const collapseButtons = screen.getAllByRole('button', { name: /collapse/i });
      await userEvent.click(collapseButtons[0]);

      // The header should now be collapsed
      const groupHeaders = screen.getAllByTestId('file-group-header');
      expect(groupHeaders[0]).toHaveAttribute('aria-expanded', 'false');
    });

    it('calls onSelectFile when file group header is clicked', async () => {
      global.fetch = buildFetchMock();
      const { Wrapper } = createWrapper();
      const onSelectFile = jest.fn();

      render(<CommentPanel reviewId="review-1" selectedFile={null} onSelectFile={onSelectFile} />, {
        wrapper: Wrapper,
      });

      await waitFor(() => {
        expect(screen.getByText('File-level comment on utils.ts')).toBeInTheDocument();
      });

      // Click Files filter
      await userEvent.click(screen.getByRole('button', { name: /files filter/i }));

      await waitFor(() => {
        const groupHeaders = screen.getAllByTestId('file-group-header');
        expect(groupHeaders.length).toBeGreaterThan(0);
      });

      // Click on the file name (the selection button, not the chevron toggle)
      // The first file group is utils.ts based on recent activity sorting
      await userEvent.click(screen.getByText('utils.ts'));

      // onSelectFile should have been called with the file path
      expect(onSelectFile).toHaveBeenCalledWith('src/utils.ts');
    });

    it('highlights selected file group with indicator', async () => {
      global.fetch = buildFetchMock();
      const { Wrapper } = createWrapper();

      render(<CommentPanel reviewId="review-1" selectedFile="src/utils.ts" />, {
        wrapper: Wrapper,
      });

      // Files filter should auto-activate when selectedFile is set
      await waitFor(() => {
        const groupHeaders = screen.getAllByTestId('file-group-header');
        expect(groupHeaders.length).toBeGreaterThan(0);
      });

      // The selected file group should have the selected styling class
      const groupHeaders = screen.getAllByTestId('file-group-header');
      const selectedHeader = groupHeaders.find((h) => h.textContent?.includes('utils.ts'));
      expect(selectedHeader).toHaveClass('border-l-primary');
    });

    it('shows comment count badge on file group headers', async () => {
      global.fetch = buildFetchMock();
      const { Wrapper } = createWrapper();

      render(<CommentPanel reviewId="review-1" selectedFile={null} />, { wrapper: Wrapper });

      await waitFor(() => {
        expect(screen.getByText('File-level comment on utils.ts')).toBeInTheDocument();
      });

      // Click Files filter
      await userEvent.click(screen.getByRole('button', { name: /files filter/i }));

      await waitFor(() => {
        // utils.ts has 1 root comment, other.ts has 1 root comment
        // The badges should show these counts
        const badges = screen.getAllByText('1');
        expect(badges.length).toBeGreaterThan(0);
      });
    });

    it('sorts file groups by most recent activity', async () => {
      global.fetch = buildFetchMock();
      const { Wrapper } = createWrapper();

      render(<CommentPanel reviewId="review-1" selectedFile={null} />, { wrapper: Wrapper });

      await waitFor(() => {
        expect(screen.getByText('File-level comment on utils.ts')).toBeInTheDocument();
      });

      // Click Files filter
      await userEvent.click(screen.getByRole('button', { name: /files filter/i }));

      await waitFor(() => {
        const groupHeaders = screen.getAllByTestId('file-group-header');
        expect(groupHeaders.length).toBe(2);
        // utils.ts has more recent activity (reply at -30000ms) than other.ts (-180000ms)
        expect(groupHeaders[0].textContent).toContain('utils.ts');
        expect(groupHeaders[1].textContent).toContain('other.ts');
      });
    });

    it('Files filter count includes ALL file comments regardless of selectedFile', async () => {
      global.fetch = buildFetchMock();
      const { Wrapper } = createWrapper();

      // Render with NO selectedFile - count should still include all file comments
      render(<CommentPanel reviewId="review-1" selectedFile={null} />, { wrapper: Wrapper });

      await waitFor(() => {
        expect(screen.getByText('File-level comment on utils.ts')).toBeInTheDocument();
      });

      // Files filter button should show count of ALL file-level root comments (2: utils.ts + other.ts)
      const filesButton = screen.getByRole('button', { name: /files filter/i });
      expect(filesButton).toHaveTextContent('2');
    });

    it('auto-expands selectedFile group when selectedFile changes', async () => {
      global.fetch = buildFetchMock();
      const { Wrapper } = createWrapper();

      const { rerender } = render(<CommentPanel reviewId="review-1" selectedFile={null} />, {
        wrapper: Wrapper,
      });

      await waitFor(() => {
        expect(screen.getByText('File-level comment on utils.ts')).toBeInTheDocument();
      });

      // Click Files filter to switch to grouped view
      await userEvent.click(screen.getByRole('button', { name: /files filter/i }));

      await waitFor(() => {
        const groupHeaders = screen.getAllByTestId('file-group-header');
        expect(groupHeaders.length).toBe(2);
      });

      // Collapse the other.ts group by clicking its chevron
      const collapseButtons = screen.getAllByRole('button', { name: /collapse/i });
      // Find the one for other.ts (second group)
      await userEvent.click(collapseButtons[1]);

      // Verify other.ts group is collapsed
      let groupHeaders = screen.getAllByTestId('file-group-header');
      const otherHeader = groupHeaders.find((h) => h.textContent?.includes('other.ts'));
      expect(otherHeader).toHaveAttribute('aria-expanded', 'false');

      // Rerender with selectedFile set to other.ts
      rerender(
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <CommentPanel reviewId="review-1" selectedFile="src/other.ts" />
        </QueryClientProvider>,
      );

      // The other.ts group should now be expanded
      await waitFor(() => {
        groupHeaders = screen.getAllByTestId('file-group-header');
        const expandedHeader = groupHeaders.find((h) => h.textContent?.includes('other.ts'));
        expect(expandedHeader).toHaveAttribute('aria-expanded', 'true');
      });
    });
  });
});
