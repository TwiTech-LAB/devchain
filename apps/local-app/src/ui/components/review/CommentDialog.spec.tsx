import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { CommentDialog } from './CommentDialog';

// Mock ResizeObserver
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// Mock pointer capture and scroll methods for Radix UI Select
beforeAll(() => {
  Element.prototype.hasPointerCapture = jest.fn(() => false);
  Element.prototype.setPointerCapture = jest.fn();
  Element.prototype.releasePointerCapture = jest.fn();
  Element.prototype.scrollIntoView = jest.fn();
});

const mockAgents = [
  { id: 'agent-1', name: 'Coder' },
  { id: 'agent-2', name: 'Reviewer' },
  { id: 'agent-3', name: 'Tester' },
  { id: 'agent-4', name: 'Planner' },
  { id: 'agent-5', name: 'Architect' },
  { id: 'agent-6', name: 'Debugger' },
  { id: 'agent-7', name: 'Docs' },
  { id: 'agent-8', name: 'QA' },
  { id: 'agent-9', name: 'Brainstormer' },
  { id: 'agent-10', name: 'ReviewBot' },
];

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

function buildFetchMock() {
  return jest.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();

    if (url.includes('/api/agents')) {
      return {
        ok: true,
        json: async () => ({ items: mockAgents }),
      } as Response;
    }

    return { ok: false, status: 404 } as Response;
  });
}

describe('CommentDialog', () => {
  const defaultProps = {
    open: true,
    onOpenChange: jest.fn(),
    filePath: 'src/utils.ts',
    lineStart: 10,
    lineEnd: 15,
    side: 'new' as const,
    projectId: 'project-1',
    reviewId: 'review-1',
    onSubmit: jest.fn().mockResolvedValue(undefined),
    isSubmitting: false,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = buildFetchMock();
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  describe('rendering', () => {
    it('renders dialog with title', async () => {
      const { Wrapper } = createWrapper();
      render(<CommentDialog {...defaultProps} />, { wrapper: Wrapper });

      expect(screen.getByText('New Comment')).toBeInTheDocument();
    });

    it('renders file path and line range', async () => {
      const { Wrapper } = createWrapper();
      render(<CommentDialog {...defaultProps} />, { wrapper: Wrapper });

      expect(screen.getByText('src/utils.ts:10-15 (new)')).toBeInTheDocument();
    });

    it('renders single line reference', async () => {
      const { Wrapper } = createWrapper();
      render(<CommentDialog {...defaultProps} lineStart={10} lineEnd={10} />, { wrapper: Wrapper });

      expect(screen.getByText('src/utils.ts:10 (new)')).toBeInTheDocument();
    });

    it('renders review-level comment when no file', async () => {
      const { Wrapper } = createWrapper();
      render(
        <CommentDialog
          {...defaultProps}
          filePath={null}
          lineStart={null}
          lineEnd={null}
          side={null}
        />,
        { wrapper: Wrapper },
      );

      expect(screen.getByText('Review-level comment')).toBeInTheDocument();
    });

    it('renders comment type selector', async () => {
      const { Wrapper } = createWrapper();
      render(<CommentDialog {...defaultProps} />, { wrapper: Wrapper });

      expect(screen.getByText('Comment Type')).toBeInTheDocument();
      expect(screen.getByRole('combobox')).toBeInTheDocument();
    });

    it('renders Write and Preview tabs', async () => {
      const { Wrapper } = createWrapper();
      render(<CommentDialog {...defaultProps} />, { wrapper: Wrapper });

      expect(screen.getByRole('tab', { name: /write/i })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: /preview/i })).toBeInTheDocument();
    });

    it('renders textarea for content', async () => {
      const { Wrapper } = createWrapper();
      render(<CommentDialog {...defaultProps} />, { wrapper: Wrapper });

      expect(screen.getByPlaceholderText(/write your comment/i)).toBeInTheDocument();
    });

    it('renders agent assignment section', async () => {
      const { Wrapper } = createWrapper();
      render(<CommentDialog {...defaultProps} />, { wrapper: Wrapper });

      expect(screen.getByText(/assign to agents/i)).toBeInTheDocument();
      expect(await screen.findByRole('button', { name: 'Assign to Coder' })).toBeInTheDocument();
      expect(screen.queryByPlaceholderText(/search agents/i)).not.toBeInTheDocument();
    });

    it('renders Cancel and Post Comment buttons', async () => {
      const { Wrapper } = createWrapper();
      render(<CommentDialog {...defaultProps} />, { wrapper: Wrapper });

      expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /post comment/i })).toBeInTheDocument();
    });
  });

  describe('comment type selection', () => {
    it('can change comment type', async () => {
      const { Wrapper } = createWrapper();
      render(<CommentDialog {...defaultProps} />, { wrapper: Wrapper });

      const combobox = screen.getByRole('combobox');
      await userEvent.click(combobox);

      // Select Issue
      await userEvent.click(screen.getByText('Issue'));

      // Combobox should now show Issue
      expect(combobox).toHaveTextContent('Issue');
    });
  });

  describe('markdown editor', () => {
    it('can type content in textarea', async () => {
      const { Wrapper } = createWrapper();
      render(<CommentDialog {...defaultProps} />, { wrapper: Wrapper });

      const textarea = screen.getByPlaceholderText(/write your comment/i);
      await userEvent.type(textarea, 'Test comment');

      expect(textarea).toHaveValue('Test comment');
    });

    it('shows preview when Preview tab clicked', async () => {
      const { Wrapper } = createWrapper();
      render(<CommentDialog {...defaultProps} />, { wrapper: Wrapper });

      // Type some content
      const textarea = screen.getByPlaceholderText(/write your comment/i);
      await userEvent.type(textarea, 'Test preview content');

      // Click Preview tab
      await userEvent.click(screen.getByRole('tab', { name: /preview/i }));

      // Should show content in preview (textarea should not be visible)
      expect(screen.queryByPlaceholderText(/write your comment/i)).not.toBeInTheDocument();
      expect(screen.getByText(/Test preview content/)).toBeInTheDocument();
    });

    it('shows nothing to preview when empty', async () => {
      const { Wrapper } = createWrapper();
      render(<CommentDialog {...defaultProps} />, { wrapper: Wrapper });

      await userEvent.click(screen.getByRole('tab', { name: /preview/i }));

      expect(screen.getByText('Nothing to preview')).toBeInTheDocument();
    });

    it('can switch back to write mode', async () => {
      const { Wrapper } = createWrapper();
      render(<CommentDialog {...defaultProps} />, { wrapper: Wrapper });

      await userEvent.click(screen.getByRole('tab', { name: /preview/i }));
      await userEvent.click(screen.getByRole('tab', { name: /write/i }));

      expect(screen.getByPlaceholderText(/write your comment/i)).toBeInTheDocument();
    });
  });

  describe('agent selection', () => {
    it('loads and displays agents', async () => {
      const { Wrapper } = createWrapper();
      render(<CommentDialog {...defaultProps} />, { wrapper: Wrapper });

      await waitFor(() => {
        expect(screen.getByText('Coder')).toBeInTheDocument();
      });

      expect(screen.getByText('Reviewer')).toBeInTheDocument();
      expect(screen.getByText('Tester')).toBeInTheDocument();
    });

    it('can select an agent', async () => {
      const { Wrapper } = createWrapper();
      render(<CommentDialog {...defaultProps} />, { wrapper: Wrapper });

      const coderPill = await screen.findByRole('button', { name: 'Assign to Coder' });
      await userEvent.click(coderPill);
      expect(coderPill).toHaveAttribute('data-state', 'on');
    });

    it('can deselect an agent by clicking checkbox again', async () => {
      const { Wrapper } = createWrapper();
      render(<CommentDialog {...defaultProps} />, { wrapper: Wrapper });

      const coderPill = await screen.findByRole('button', { name: 'Assign to Coder' });
      await userEvent.click(coderPill);
      expect(coderPill).toHaveAttribute('data-state', 'on');
      await userEvent.click(coderPill);
      expect(coderPill).toHaveAttribute('data-state', 'off');
    });

    it('can filter agents by search', async () => {
      const { Wrapper } = createWrapper();
      render(<CommentDialog {...defaultProps} />, { wrapper: Wrapper });

      // Expand agent list to show search input
      const showMoreButton = await screen.findByRole('button', { name: /\+\d+ more/i });
      await userEvent.click(showMoreButton);

      const searchInput = screen.getByPlaceholderText(/search agents/i);
      await userEvent.type(searchInput, 'Review');

      // Should only show Reviewer
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Assign to Reviewer' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Assign to Coder' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Assign to Tester' })).not.toBeInTheDocument();
      });
    });

    it('shows no agents found when search has no matches', async () => {
      const { Wrapper } = createWrapper();
      render(<CommentDialog {...defaultProps} />, { wrapper: Wrapper });

      // Expand agent list to show search input
      const showMoreButton = await screen.findByRole('button', { name: /\+\d+ more/i });
      await userEvent.click(showMoreButton);
      const searchInput = screen.getByPlaceholderText(/search agents/i);
      await userEvent.type(searchInput, 'nonexistent');

      await waitFor(() => {
        expect(screen.getByText('No agents found')).toBeInTheDocument();
      });
    });
  });

  describe('warning when no agents selected', () => {
    it('shows warning when no agents are selected', async () => {
      const { Wrapper } = createWrapper();
      render(<CommentDialog {...defaultProps} />, { wrapper: Wrapper });

      await waitFor(() => {
        expect(
          screen.getByText('No agents selected — no notifications will be sent'),
        ).toBeInTheDocument();
      });
    });

    it('warning disappears when at least one agent is selected', async () => {
      const { Wrapper } = createWrapper();
      render(<CommentDialog {...defaultProps} />, { wrapper: Wrapper });

      const coderPill = await screen.findByRole('button', { name: 'Assign to Coder' });
      await userEvent.click(coderPill);

      await waitFor(() => {
        expect(
          screen.queryByText('No agents selected — no notifications will be sent'),
        ).not.toBeInTheDocument();
        expect(screen.getByText('1 agent selected')).toBeInTheDocument();
      });
    });

    it('keeps Post Comment button enabled when no agents selected', async () => {
      const { Wrapper } = createWrapper();
      render(<CommentDialog {...defaultProps} />, { wrapper: Wrapper });

      await waitFor(() => {
        expect(
          screen.getByText('No agents selected — no notifications will be sent'),
        ).toBeInTheDocument();
      });

      const textarea = screen.getByPlaceholderText(/write your comment/i);
      await userEvent.type(textarea, 'Test comment');

      // Submit button should still be enabled (not blocked by empty agent selection)
      expect(screen.getByRole('button', { name: /post comment/i })).not.toBeDisabled();
    });
  });

  describe('form submission', () => {
    it('disables Post Comment when content is empty', async () => {
      const { Wrapper } = createWrapper();
      render(<CommentDialog {...defaultProps} />, { wrapper: Wrapper });

      expect(screen.getByRole('button', { name: /post comment/i })).toBeDisabled();
    });

    it('enables Post Comment when content is entered', async () => {
      const { Wrapper } = createWrapper();
      render(<CommentDialog {...defaultProps} />, { wrapper: Wrapper });

      const textarea = screen.getByPlaceholderText(/write your comment/i);
      await userEvent.type(textarea, 'Test comment');

      expect(screen.getByRole('button', { name: /post comment/i })).not.toBeDisabled();
    });

    it('calls onSubmit with form data', async () => {
      const onSubmit = jest.fn().mockResolvedValue(undefined);
      const { Wrapper } = createWrapper();
      render(<CommentDialog {...defaultProps} onSubmit={onSubmit} />, { wrapper: Wrapper });

      // Wait for agents to load
      await waitFor(() => {
        expect(screen.getByText('Coder')).toBeInTheDocument();
      });

      // Fill form
      const textarea = screen.getByPlaceholderText(/write your comment/i);
      await userEvent.type(textarea, 'My test comment');

      // Select agent
      const coderPill = screen.getByRole('button', { name: 'Assign to Coder' });
      await userEvent.click(coderPill);

      // Submit
      await userEvent.click(screen.getByRole('button', { name: /post comment/i }));

      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledWith({
          content: 'My test comment',
          commentType: 'comment',
          assignedAgentIds: ['agent-1'],
          filePath: 'src/utils.ts',
          lineStart: 10,
          lineEnd: 15,
          side: 'new',
        });
      });
    });

    it('shows Posting... when isSubmitting', async () => {
      const { Wrapper } = createWrapper();
      render(<CommentDialog {...defaultProps} isSubmitting={true} />, { wrapper: Wrapper });

      expect(screen.getByText('Posting...')).toBeInTheDocument();
    });

    it('disables inputs when isSubmitting', async () => {
      const { Wrapper } = createWrapper();
      render(<CommentDialog {...defaultProps} isSubmitting={true} />, { wrapper: Wrapper });

      expect(screen.getByPlaceholderText(/write your comment/i)).toBeDisabled();
    });
  });

  describe('cancel behavior', () => {
    it('calls onOpenChange(false) when Cancel clicked', async () => {
      const onOpenChange = jest.fn();
      const { Wrapper } = createWrapper();
      render(<CommentDialog {...defaultProps} onOpenChange={onOpenChange} />, { wrapper: Wrapper });

      await userEvent.click(screen.getByRole('button', { name: /cancel/i }));

      expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it('resets form state when canceled', async () => {
      const onOpenChange = jest.fn();
      const { Wrapper } = createWrapper();
      const { rerender } = render(<CommentDialog {...defaultProps} onOpenChange={onOpenChange} />, {
        wrapper: Wrapper,
      });

      // Type something
      const textarea = screen.getByPlaceholderText(/write your comment/i);
      await userEvent.type(textarea, 'Test');

      // Cancel
      await userEvent.click(screen.getByRole('button', { name: /cancel/i }));

      // Re-open dialog
      rerender(
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <CommentDialog {...defaultProps} open={true} />
        </QueryClientProvider>,
      );

      // Textarea should be empty (form was reset)
      const newTextarea = screen.getByPlaceholderText(/write your comment/i);
      expect(newTextarea).toHaveValue('');
    });
  });

  // SECURITY: XSS protection tests for markdown preview
  describe('markdown sanitization (XSS protection)', () => {
    // Helper to set textarea value directly (avoids userEvent special char parsing)
    const setTextareaValue = (textarea: HTMLTextAreaElement, value: string) => {
      fireEvent.change(textarea, { target: { value } });
    };

    it('sanitizes script tags in content', async () => {
      const { Wrapper } = createWrapper();
      render(<CommentDialog {...defaultProps} />, { wrapper: Wrapper });

      // Set XSS payload directly
      const textarea = screen.getByPlaceholderText(/write your comment/i) as HTMLTextAreaElement;
      setTextareaValue(textarea, '<script>alert("xss")</script>');

      // Switch to preview
      await userEvent.click(screen.getByRole('tab', { name: /preview/i }));

      // Verify no actual script element exists (content should be escaped)
      expect(document.querySelector('script')).toBeNull();
      // The script tag should be visible as text (escaped)
      expect(screen.getByText(/script/)).toBeInTheDocument();
    });

    it('sanitizes img onerror XSS attacks', async () => {
      const { Wrapper } = createWrapper();
      render(<CommentDialog {...defaultProps} />, { wrapper: Wrapper });

      const textarea = screen.getByPlaceholderText(/write your comment/i) as HTMLTextAreaElement;
      setTextareaValue(textarea, '<img src=x onerror=alert("xss")>');

      await userEvent.click(screen.getByRole('tab', { name: /preview/i }));

      // Should not contain any img element (stripped by DOMPurify)
      expect(document.querySelector('img')).toBeNull();
    });

    it('blocks javascript: URLs in markdown links', async () => {
      const { Wrapper } = createWrapper();
      render(<CommentDialog {...defaultProps} />, { wrapper: Wrapper });

      const textarea = screen.getByPlaceholderText(/write your comment/i) as HTMLTextAreaElement;
      setTextareaValue(textarea, '[click me](javascript:alert(1))');

      await userEvent.click(screen.getByRole('tab', { name: /preview/i }));

      // Link should exist but href should be sanitized to '#'
      const link = document.querySelector('a');
      expect(link).toBeTruthy();
      expect(link?.getAttribute('href')).toBe('#');
    });

    it('allows safe https: URLs in markdown links', async () => {
      const { Wrapper } = createWrapper();
      render(<CommentDialog {...defaultProps} />, { wrapper: Wrapper });

      const textarea = screen.getByPlaceholderText(/write your comment/i) as HTMLTextAreaElement;
      setTextareaValue(textarea, '[safe link](https://example.com)');

      await userEvent.click(screen.getByRole('tab', { name: /preview/i }));

      const link = document.querySelector('a');
      expect(link).toBeTruthy();
      expect(link?.getAttribute('href')).toBe('https://example.com');
      expect(link?.textContent).toBe('safe link');
    });

    it('sanitizes event handlers in HTML', async () => {
      const { Wrapper } = createWrapper();
      render(<CommentDialog {...defaultProps} />, { wrapper: Wrapper });

      const textarea = screen.getByPlaceholderText(/write your comment/i) as HTMLTextAreaElement;
      setTextareaValue(textarea, '<div onclick=alert("xss")>click</div>');

      await userEvent.click(screen.getByRole('tab', { name: /preview/i }));

      // Should not have any onclick attribute (DOMPurify strips it)
      const elementWithHandler = document.querySelector('[onclick]');
      expect(elementWithHandler).toBeNull();
    });

    it('preserves normal markdown formatting', async () => {
      const { Wrapper } = createWrapper();
      render(<CommentDialog {...defaultProps} />, { wrapper: Wrapper });

      const textarea = screen.getByPlaceholderText(/write your comment/i) as HTMLTextAreaElement;
      setTextareaValue(textarea, '**bold** and *italic* and `code`');

      await userEvent.click(screen.getByRole('tab', { name: /preview/i }));

      // Verify markdown is rendered correctly
      expect(document.querySelector('strong')?.textContent).toBe('bold');
      expect(document.querySelector('em')?.textContent).toBe('italic');
      expect(document.querySelector('code')?.textContent).toBe('code');
    });

    it('sanitizes data: URLs in markdown links', async () => {
      const { Wrapper } = createWrapper();
      render(<CommentDialog {...defaultProps} />, { wrapper: Wrapper });

      const textarea = screen.getByPlaceholderText(/write your comment/i) as HTMLTextAreaElement;
      setTextareaValue(textarea, '[xss](data:text/html,<script>alert(1)</script>)');

      await userEvent.click(screen.getByRole('tab', { name: /preview/i }));

      // data: URL should be sanitized to '#'
      const link = document.querySelector('a');
      expect(link).toBeTruthy();
      expect(link?.getAttribute('href')).toBe('#');
    });

    it('sanitizes vbscript: URLs in markdown links', async () => {
      const { Wrapper } = createWrapper();
      render(<CommentDialog {...defaultProps} />, { wrapper: Wrapper });

      const textarea = screen.getByPlaceholderText(/write your comment/i) as HTMLTextAreaElement;
      setTextareaValue(textarea, '[xss](vbscript:msgbox(1))');

      await userEvent.click(screen.getByRole('tab', { name: /preview/i }));

      const link = document.querySelector('a');
      expect(link).toBeTruthy();
      expect(link?.getAttribute('href')).toBe('#');
    });
  });

  describe('accessibility', () => {
    it('should have no accessibility violations', async () => {
      const { Wrapper } = createWrapper();
      render(<CommentDialog {...defaultProps} />, { wrapper: Wrapper });

      // Wait for agents to load
      await waitFor(() => {
        expect(screen.getByText('Coder')).toBeInTheDocument();
      });

      // Use document.body instead of container because Radix Dialog renders
      // content in a portal outside the test container
      const results = await axe(document.body, {
        rules: {
          // Disable aria-valid-attr-value for Radix Tab components in tests.
          // Radix generates dynamic IDs (e.g., "radix-:xyz:-content-write") that
          // may not resolve correctly in jsdom - this is a known test environment
          // limitation, not a real accessibility issue in production.
          'aria-valid-attr-value': { enabled: false },
        },
      });
      expect(results).toHaveNoViolations();
    });
  });
});
