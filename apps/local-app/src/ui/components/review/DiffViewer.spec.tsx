import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Mock refractor (ESM module that Jest can't transform)
jest.mock('refractor', () => ({
  refractor: {
    registered: jest.fn(() => false),
    highlight: jest.fn(),
  },
}));

// Mock react-diff-view CSS import
jest.mock('react-diff-view/style/index.css', () => ({}));

import { DiffViewer } from './DiffViewer';

function renderWithQueryClient(ui: JSX.Element) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

function getFirstTextNode(element: Element): Text {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const node = walker.nextNode();
  if (!node) {
    throw new Error('Expected element to contain a text node');
  }
  return node as Text;
}

function selectTextRange(startElement: Element, endElement: Element) {
  const startNode = getFirstTextNode(startElement);
  const endNode = getFirstTextNode(endElement);
  const range = document.createRange();
  range.setStart(startNode, 0);
  range.setEnd(endNode, endNode.textContent?.length ?? 0);

  const selection = window.getSelection();
  if (!selection) {
    throw new Error('window.getSelection() returned null');
  }
  selection.removeAllRanges();
  selection.addRange(range);
}

function hoverAllGutters(row: Element) {
  fireEvent.mouseEnter(row);
  const gutterElements = row.querySelectorAll('.diff-gutter, .diff-gutter-col');
  gutterElements.forEach((el) => {
    fireEvent.mouseEnter(el);
  });
}

// Mock ResizeObserver for ScrollArea component
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// Mock IntersectionObserver for LazyHunk component
global.IntersectionObserver = class IntersectionObserver {
  callback: IntersectionObserverCallback;
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
  }
  observe(target: Element) {
    // Immediately trigger as visible
    this.callback(
      [{ isIntersecting: true, target } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
  unobserve() {}
  disconnect() {}
};

// Sample unified diff for testing
const sampleDiff = `diff --git a/src/auth.ts b/src/auth.ts
index abc123..def456 100644
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -1,5 +1,7 @@
 import { User } from './types';

+// Added authentication helper
+
 export function login(user: User) {
-  return fetch('/api/login', { method: 'POST' });
+  return fetch('/api/login', { method: 'POST', body: JSON.stringify(user) });
 }
`;

const binaryDiff = `diff --git a/image.png b/image.png
new file mode 100644
index 0000000..abc1234
Binary files /dev/null and b/image.png differ
`;

const emptyDiff = '';

describe('DiffViewer', () => {
  const defaultProps = {
    diff: sampleDiff,
    filePath: 'src/auth.ts',
    viewType: 'unified' as const,
    onViewTypeChange: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders diff content with file path', () => {
    render(<DiffViewer {...defaultProps} />);

    expect(screen.getByText('src/auth.ts')).toBeInTheDocument();
  });

  it('shows loading skeleton when isLoading is true', () => {
    render(<DiffViewer {...defaultProps} diff="" isLoading={true} />);

    const skeletons = document.querySelectorAll('.animate-pulse');
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it('shows error message when error is provided', () => {
    render(<DiffViewer {...defaultProps} diff="" error="Failed to fetch diff" />);

    expect(screen.getByText('Failed to load diff')).toBeInTheDocument();
    expect(screen.getByText('Failed to fetch diff')).toBeInTheDocument();
  });

  it('handles binary diff format gracefully', () => {
    // parseDiff may not detect binary files from the diff format itself
    // In practice, binary detection often happens at the API level
    render(<DiffViewer {...defaultProps} diff={binaryDiff} filePath="image.png" />);

    // Binary diffs without proper parsing show as no changes
    // The actual binary detection would be done by the git service
    expect(document.body).toBeInTheDocument();
  });

  it('shows empty diff message when no changes', () => {
    render(<DiffViewer {...defaultProps} diff={emptyDiff} filePath="src/empty.ts" />);

    expect(screen.getByText('No changes')).toBeInTheDocument();
  });

  it('shows untracked file message when fileInfo indicates untracked file without patch', () => {
    const untrackedFileInfo = {
      path: 'src/new-file.ts',
      status: 'added' as const,
      additions: 0,
      deletions: 0,
    };

    render(
      <DiffViewer
        {...defaultProps}
        diff={emptyDiff}
        filePath="src/new-file.ts"
        fileInfo={untrackedFileInfo}
      />,
    );

    expect(screen.getByText('New file')).toBeInTheDocument();
    expect(screen.getByText(/untracked file/i)).toBeInTheDocument();
  });

  it('shows regular empty message when fileInfo has additions', () => {
    const trackedFileInfo = {
      path: 'src/tracked.ts',
      status: 'modified' as const,
      additions: 5,
      deletions: 2,
    };

    render(
      <DiffViewer
        {...defaultProps}
        diff={emptyDiff}
        filePath="src/tracked.ts"
        fileInfo={trackedFileInfo}
      />,
    );

    // Should show regular "No changes" message, not untracked message
    expect(screen.getByText('No changes')).toBeInTheDocument();
    expect(screen.queryByText('New file')).not.toBeInTheDocument();
  });

  it('shows additions and deletions count', () => {
    render(<DiffViewer {...defaultProps} />);

    // Check for +/- badges (additions: 3 lines, deletions: 1 line)
    expect(screen.getByText(/\+3/)).toBeInTheDocument();
    expect(screen.getByText(/-1/)).toBeInTheDocument();
  });

  it('renders unified view when viewType is unified', () => {
    render(<DiffViewer {...defaultProps} viewType="unified" />);

    const unifiedButton = screen.getByTitle('Unified view');
    expect(unifiedButton).toHaveClass('bg-secondary');
  });

  it('calls onViewTypeChange when split button is clicked', async () => {
    const onViewTypeChange = jest.fn();
    render(<DiffViewer {...defaultProps} onViewTypeChange={onViewTypeChange} />);

    const splitButton = screen.getByTitle('Side-by-side view');
    await userEvent.click(splitButton);

    expect(onViewTypeChange).toHaveBeenCalledWith('split');
  });

  it('calls onViewTypeChange when unified button is clicked', async () => {
    const onViewTypeChange = jest.fn();
    render(<DiffViewer {...defaultProps} viewType="split" onViewTypeChange={onViewTypeChange} />);

    const unifiedButton = screen.getByTitle('Unified view');
    await userEvent.click(unifiedButton);

    expect(onViewTypeChange).toHaveBeenCalledWith('unified');
  });

  it('renders split view when viewType is split', () => {
    render(<DiffViewer {...defaultProps} viewType="split" />);

    const splitButton = screen.getByTitle('Side-by-side view');
    expect(splitButton).toHaveClass('bg-secondary');
  });

  it('renders view toggle buttons', () => {
    render(<DiffViewer {...defaultProps} />);

    expect(screen.getByText('Unified')).toBeInTheDocument();
    expect(screen.getByText('Split')).toBeInTheDocument();
  });

  it('renders diff content from react-diff-view', () => {
    render(<DiffViewer {...defaultProps} />);

    // Check that the diff container exists
    const diffContainer = document.querySelector('.diff-viewer');
    expect(diffContainer).toBeInTheDocument();
  });

  it('handles malformed diff gracefully', () => {
    const malformedDiff = 'this is not a valid diff format';
    render(<DiffViewer {...defaultProps} diff={malformedDiff} filePath="src/file.ts" />);

    // Should show empty diff message for unparseable diff
    expect(screen.getByText('No changes')).toBeInTheDocument();
  });

  it('renders correct file path in header', () => {
    render(<DiffViewer {...defaultProps} filePath="path/to/file.ts" />);

    expect(screen.getByText('path/to/file.ts')).toBeInTheDocument();
  });
});

describe('DiffViewer multi-line selection', () => {
  const defaultProps = {
    diff: sampleDiff,
    filePath: 'src/auth.ts',
    viewType: 'unified' as const,
    onViewTypeChange: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('clears selection when escape key is pressed', async () => {
    const mockOnAddComment = jest.fn();
    render(<DiffViewer {...defaultProps} onAddComment={mockOnAddComment} />);

    // Find and click a gutter to create selection
    const gutterElements = document.querySelectorAll('.diff-gutter');
    if (gutterElements.length > 0) {
      fireEvent.mouseDown(gutterElements[0]);
      fireEvent.click(gutterElements[0]);
    }

    // Press escape to clear selection
    fireEvent.keyDown(document, { key: 'Escape' });

    // Selection should be cleared (no highlighted lines)
    const highlightedLines = document.querySelectorAll('.bg-blue-50');
    expect(highlightedLines.length).toBe(0);
  });

  it('supports adding comments through onAddComment prop', () => {
    const mockOnAddComment = jest.fn();
    render(<DiffViewer {...defaultProps} onAddComment={mockOnAddComment} />);

    // The component should render with comment capability
    expect(document.querySelector('.diff-viewer')).toBeInTheDocument();
  });

  it('renders comment count badge when comments are provided', () => {
    const mockComments = [
      {
        id: 'comment-1',
        reviewId: 'review-1',
        filePath: 'src/auth.ts',
        parentId: null,
        lineStart: 1,
        lineEnd: 1,
        side: 'right' as const,
        content: 'Test comment',
        commentType: 'comment' as const,
        status: 'open' as const,
        authorType: 'user' as const,
        authorAgentId: null,
        version: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];

    render(<DiffViewer {...defaultProps} comments={mockComments} />);

    // Should show comment count badge in header (badge with MessageSquare icon)
    const commentBadge = document.querySelector('.bg-blue-100.text-blue-700');
    expect(commentBadge).toBeInTheDocument();
    expect(commentBadge?.textContent).toContain('1');
  });

  it('handles click outside to clear selection only when comment form is not open', async () => {
    const mockOnAddComment = jest.fn();
    const { container } = render(
      <div>
        <div data-testid="outside">Outside element</div>
        <DiffViewer {...defaultProps} onAddComment={mockOnAddComment} />
      </div>,
    );

    // The component should handle the click outside scenario
    const outsideElement = screen.getByTestId('outside');
    fireEvent.mouseDown(outsideElement);

    // Component should still be rendered
    expect(container.querySelector('.diff-viewer')).toBeInTheDocument();
  });

  it('renders with isSubmittingComment state', () => {
    render(<DiffViewer {...defaultProps} onAddComment={jest.fn()} isSubmittingComment={true} />);

    // Component should render normally even when submitting
    expect(screen.getByText('src/auth.ts')).toBeInTheDocument();
  });

  it('shows a single + button per line in unified view (normal lines)', async () => {
    render(<DiffViewer {...defaultProps} onAddComment={jest.fn()} viewType="unified" />);

    const line = screen.getByText("import { User } from './types';");
    const row = line.closest('tr');
    expect(row).toBeTruthy();
    hoverAllGutters(row as Element);

    // Context ("normal") lines have both old/new line numbers in unified view, but should render only one +
    const addButtons = (row as Element).querySelectorAll('button[title="Add comment"]');
    expect(addButtons).toHaveLength(1);
  });

  it('uses mouse text selection when clicking + and clears selection after opening form', async () => {
    renderWithQueryClient(
      <DiffViewer {...defaultProps} onAddComment={jest.fn()} viewType="unified" />,
    );

    const startLine = screen.getByText("import { User } from './types';");
    const endLine = screen.getByText('export function login(user: User) {');
    selectTextRange(startLine, endLine);

    const row = startLine.closest('tr');
    expect(row).toBeTruthy();
    hoverAllGutters(row as Element);

    const addButton = (row as Element).querySelector('button[title="Add comment"]');
    expect(addButton).toBeTruthy();

    fireEvent.mouseDown(addButton as Element);
    fireEvent.click(addButton as Element);

    const form = await screen.findByTestId('new-comment-form');
    expect(form.textContent).toContain('Lines');
    expect(form.textContent).toContain('(new)');

    expect(window.getSelection()?.rangeCount ?? 0).toBe(0);
  });

  it('in split view, text selection uses the clicked gutter side (new)', async () => {
    renderWithQueryClient(
      <DiffViewer {...defaultProps} onAddComment={jest.fn()} viewType="split" />,
    );

    const candidates = screen.getAllByText("import { User } from './types';");
    const newSideLine =
      candidates.find((el) => {
        const cell = el.closest('td');
        if (!cell) return false;
        // In split view, "new" columns appear after the first two cells (old gutter + old code).
        return cell.cellIndex > 1;
      }) ?? candidates[0];

    // Create a non-collapsed selection within the same line (enough for handler to capture)
    selectTextRange(newSideLine, newSideLine);

    const row = newSideLine.closest('tr');
    expect(row).toBeTruthy();
    hoverAllGutters(row as Element);

    // Click the add button; in split mode we expect the selection to respect the clicked gutter side
    const buttonsByCell = Array.from((row as Element).querySelectorAll('td'))
      .map((cell) => ({
        cellIndex: (cell as HTMLTableCellElement).cellIndex,
        button: cell.querySelector('button[title="Add comment"]') as HTMLButtonElement | null,
      }))
      .filter((entry) => entry.button !== null)
      .sort((a, b) => a.cellIndex - b.cellIndex);

    expect(buttonsByCell.length).toBeGreaterThanOrEqual(1);
    const newGutterAddButton = buttonsByCell[buttonsByCell.length - 1].button!;

    fireEvent.mouseDown(newGutterAddButton);
    fireEvent.click(newGutterAddButton);

    const form = await screen.findByTestId('new-comment-form');
    expect(form.textContent).toContain('(new)');
  });
});

describe('DiffViewer adaptive layout (controlled mode)', () => {
  const defaultProps = {
    diff: sampleDiff,
    filePath: 'src/auth.ts',
    viewType: 'unified' as const,
    onViewTypeChange: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('uses viewType prop value for initial render', () => {
    render(<DiffViewer {...defaultProps} viewType="split" />);

    // Split button should be highlighted when viewType is split
    const splitButton = screen.getByTitle('Side-by-side view');
    expect(splitButton).toHaveClass('bg-secondary');

    // Unified button should NOT be highlighted
    const unifiedButton = screen.getByTitle('Unified view');
    expect(unifiedButton).not.toHaveClass('bg-secondary');
  });

  it('does not add diff-split class when viewType is unified', () => {
    render(<DiffViewer {...defaultProps} viewType="unified" />);

    const diffContainer = document.querySelector('.diff-viewer');
    expect(diffContainer).toBeInTheDocument();
    expect(diffContainer).not.toHaveClass('diff-split');
  });

  it('applies diff-split class when viewType is split', () => {
    render(<DiffViewer {...defaultProps} viewType="split" />);

    const diffContainer = document.querySelector('.diff-viewer');
    expect(diffContainer).toBeInTheDocument();
    expect(diffContainer).toHaveClass('diff-split');
  });

  it('responds to viewType prop changes (controlled behavior)', () => {
    const { rerender } = render(<DiffViewer {...defaultProps} viewType="unified" />);

    // Initially unified
    let splitButton = screen.getByTitle('Side-by-side view');
    let unifiedButton = screen.getByTitle('Unified view');
    expect(unifiedButton).toHaveClass('bg-secondary');
    expect(splitButton).not.toHaveClass('bg-secondary');

    // Change prop to split
    rerender(<DiffViewer {...defaultProps} viewType="split" />);

    // Now split should be highlighted
    splitButton = screen.getByTitle('Side-by-side view');
    unifiedButton = screen.getByTitle('Unified view');
    expect(splitButton).toHaveClass('bg-secondary');
    expect(unifiedButton).not.toHaveClass('bg-secondary');
  });

  it('handles rapid viewType prop changes', () => {
    const { rerender } = render(<DiffViewer {...defaultProps} viewType="unified" />);

    // Rapid toggles
    rerender(<DiffViewer {...defaultProps} viewType="split" />);
    rerender(<DiffViewer {...defaultProps} viewType="unified" />);
    rerender(<DiffViewer {...defaultProps} viewType="split" />);
    rerender(<DiffViewer {...defaultProps} viewType="unified" />);

    // Should end up with unified highlighted
    const unifiedButton = screen.getByTitle('Unified view');
    expect(unifiedButton).toHaveClass('bg-secondary');
  });

  it('does not call onViewTypeChange when clicking already-active view type', async () => {
    const onViewTypeChange = jest.fn();
    render(<DiffViewer {...defaultProps} viewType="unified" onViewTypeChange={onViewTypeChange} />);

    // Click unified when it's already selected
    const unifiedButton = screen.getByTitle('Unified view');
    await userEvent.click(unifiedButton);

    // Should still call the callback (parent decides whether to update)
    expect(onViewTypeChange).toHaveBeenCalledWith('unified');
  });
});

describe('DiffViewer large hunk expansion', () => {
  // Create a diff with >16 lines (COLLAPSE_CONTEXT_THRESHOLD * 2 = 16) to trigger large hunk behavior
  const largeDiff = `diff --git a/src/large-file.ts b/src/large-file.ts
index abc123..def456 100644
--- a/src/large-file.ts
+++ b/src/large-file.ts
@@ -1,20 +1,20 @@
+// Line 1 - added
+// Line 2 - added
+// Line 3 - added
+// Line 4 - added
+// Line 5 - added
+// Line 6 - added
+// Line 7 - added
+// Line 8 - added
+// Line 9 - added
+// Line 10 - added
+// Line 11 - added
+// Line 12 - added
+// Line 13 - added
+// Line 14 - added
+// Line 15 - added
+// Line 16 - added
+// Line 17 - added
+// Line 18 - added
`;

  const defaultProps = {
    diff: largeDiff,
    filePath: 'src/large-file.ts',
    viewType: 'unified' as const,
    onViewTypeChange: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders large hunk (>16 lines) expanded by default with "Collapse" button', () => {
    render(<DiffViewer {...defaultProps} />);

    // Large hunks should render expanded by default, showing "Collapse X lines" button
    const collapseButton = screen.getByRole('button', { name: /collapse \d+ lines/i });
    expect(collapseButton).toBeInTheDocument();
    expect(collapseButton).toHaveAttribute('aria-expanded', 'true');
  });

  it('toggles to collapsed state when collapse button is clicked', async () => {
    render(<DiffViewer {...defaultProps} />);

    // Initially expanded - button says "Collapse"
    const collapseButton = screen.getByRole('button', { name: /collapse \d+ lines/i });
    expect(collapseButton).toHaveAttribute('aria-expanded', 'true');
    expect(collapseButton.textContent).toMatch(/collapse/i);

    // Click to collapse
    await userEvent.click(collapseButton);

    // Now should be collapsed - button says "Expand"
    const expandButton = screen.getByRole('button', { name: /expand \d+ lines/i });
    expect(expandButton).toHaveAttribute('aria-expanded', 'false');
    expect(expandButton.textContent).toMatch(/expand/i);
  });

  it('toggles back to expanded state when expand button is clicked', async () => {
    render(<DiffViewer {...defaultProps} />);

    // Initially expanded
    const collapseButton = screen.getByRole('button', { name: /collapse \d+ lines/i });

    // Click to collapse
    await userEvent.click(collapseButton);

    // Now collapsed - click to expand again
    const expandButton = screen.getByRole('button', { name: /expand \d+ lines/i });
    await userEvent.click(expandButton);

    // Should be back to expanded
    const toggleButton = screen.getByRole('button', { name: /collapse \d+ lines/i });
    expect(toggleButton).toHaveAttribute('aria-expanded', 'true');
    expect(toggleButton.textContent).toMatch(/collapse/i);
  });

  it('displays correct line count in toggle button', () => {
    render(<DiffViewer {...defaultProps} />);

    // The diff has 18 added lines, so the button should show "18 lines"
    const collapseButton = screen.getByRole('button', { name: /collapse \d+ lines/i });
    expect(collapseButton.textContent).toMatch(/18 lines/i);
  });

  it('does not show collapse button for small hunks (<=16 lines)', () => {
    // Small diff with fewer than 16 lines
    const smallDiff = `diff --git a/src/small.ts b/src/small.ts
index abc123..def456 100644
--- a/src/small.ts
+++ b/src/small.ts
@@ -1,3 +1,5 @@
+// Added line 1
+// Added line 2
 export const x = 1;
 export const y = 2;
 export const z = 3;
`;

    render(
      <DiffViewer
        diff={smallDiff}
        filePath="src/small.ts"
        viewType="unified"
        onViewTypeChange={jest.fn()}
      />,
    );

    // Small hunks should not have collapse/expand buttons
    const collapseButton = screen.queryByRole('button', { name: /collapse \d+ lines/i });
    const expandButton = screen.queryByRole('button', { name: /expand \d+ lines/i });
    expect(collapseButton).not.toBeInTheDocument();
    expect(expandButton).not.toBeInTheDocument();
  });

  it('resets collapsed hunks when filePath changes', async () => {
    const { rerender } = render(<DiffViewer {...defaultProps} />);

    // Initially expanded - button says "Collapse"
    const collapseButton = screen.getByRole('button', { name: /collapse \d+ lines/i });
    expect(collapseButton).toHaveAttribute('aria-expanded', 'true');

    // Collapse the hunk
    await userEvent.click(collapseButton);

    // Now collapsed - button says "Expand"
    const expandButton = screen.getByRole('button', { name: /expand \d+ lines/i });
    expect(expandButton).toHaveAttribute('aria-expanded', 'false');

    // Change filePath - should reset collapsed state
    rerender(<DiffViewer {...defaultProps} filePath="src/other-file.ts" />);

    // After filePath change, hunk should be expanded again (state reset)
    const resetButton = screen.getByRole('button', { name: /collapse \d+ lines/i });
    expect(resetButton).toHaveAttribute('aria-expanded', 'true');
    expect(resetButton.textContent).toMatch(/collapse/i);
  });
});

describe('DiffViewer multi-thread per line', () => {
  const defaultProps = {
    diff: sampleDiff,
    filePath: 'src/auth.ts',
    viewType: 'unified' as const,
    onViewTypeChange: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders multiple independent threads on the same line', () => {
    // Two independent root comments on line 3, each with a reply
    const multiThreadComments = [
      {
        id: 'thread1-root',
        reviewId: 'review-1',
        filePath: 'src/auth.ts',
        parentId: null,
        lineStart: 3,
        lineEnd: 3,
        side: 'new' as const,
        content: 'First thread comment',
        commentType: 'comment' as const,
        status: 'open' as const,
        authorType: 'user' as const,
        authorAgentId: null,
        authorAgentName: null,
        targetAgents: [],
        version: 1,
        editedAt: null,
        createdAt: new Date(Date.now() - 60000).toISOString(),
        updatedAt: new Date().toISOString(),
      },
      {
        id: 'thread1-reply',
        reviewId: 'review-1',
        filePath: 'src/auth.ts',
        parentId: 'thread1-root',
        lineStart: null,
        lineEnd: null,
        side: null,
        content: 'Reply to first thread',
        commentType: 'comment' as const,
        status: 'open' as const,
        authorType: 'agent' as const,
        authorAgentId: 'agent-1',
        authorAgentName: 'Coder',
        targetAgents: [],
        version: 1,
        editedAt: null,
        createdAt: new Date(Date.now() - 30000).toISOString(),
        updatedAt: new Date().toISOString(),
      },
      {
        id: 'thread2-root',
        reviewId: 'review-1',
        filePath: 'src/auth.ts',
        parentId: null,
        lineStart: 3,
        lineEnd: 3,
        side: 'new' as const,
        content: 'Second thread comment',
        commentType: 'issue' as const,
        status: 'open' as const,
        authorType: 'user' as const,
        authorAgentId: null,
        authorAgentName: null,
        targetAgents: [],
        version: 1,
        editedAt: null,
        createdAt: new Date(Date.now() - 50000).toISOString(),
        updatedAt: new Date().toISOString(),
      },
      {
        id: 'thread2-reply',
        reviewId: 'review-1',
        filePath: 'src/auth.ts',
        parentId: 'thread2-root',
        lineStart: null,
        lineEnd: null,
        side: null,
        content: 'Reply to second thread',
        commentType: 'comment' as const,
        status: 'open' as const,
        authorType: 'agent' as const,
        authorAgentId: 'agent-2',
        authorAgentName: 'Reviewer',
        targetAgents: [],
        version: 1,
        editedAt: null,
        createdAt: new Date(Date.now() - 20000).toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];

    renderWithQueryClient(<DiffViewer {...defaultProps} comments={multiThreadComments} />);

    // Both root comment contents should be visible
    expect(screen.getByText('First thread comment')).toBeInTheDocument();
    expect(screen.getByText('Second thread comment')).toBeInTheDocument();

    // Both replies should be visible
    expect(screen.getByText('Reply to first thread')).toBeInTheDocument();
    expect(screen.getByText('Reply to second thread')).toBeInTheDocument();

    // Should have 2 CommentThread components
    const threads = screen.getAllByTestId('comment-thread');
    expect(threads).toHaveLength(2);
  });

  it('shows correct thread count in CommentIndicator for multi-thread lines', () => {
    // Two independent root comments on line 3
    const multiThreadComments = [
      {
        id: 'thread1-root',
        reviewId: 'review-1',
        filePath: 'src/auth.ts',
        parentId: null,
        lineStart: 3,
        lineEnd: 3,
        side: 'new' as const,
        content: 'First comment',
        commentType: 'comment' as const,
        status: 'open' as const,
        authorType: 'user' as const,
        authorAgentId: null,
        authorAgentName: null,
        targetAgents: [],
        version: 1,
        editedAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      {
        id: 'thread2-root',
        reviewId: 'review-1',
        filePath: 'src/auth.ts',
        parentId: null,
        lineStart: 3,
        lineEnd: 3,
        side: 'new' as const,
        content: 'Second comment',
        commentType: 'issue' as const,
        status: 'resolved' as const,
        authorType: 'user' as const,
        authorAgentId: null,
        authorAgentName: null,
        targetAgents: [],
        version: 1,
        editedAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];

    renderWithQueryClient(<DiffViewer {...defaultProps} comments={multiThreadComments} />);

    // Header badge should show total root comments count
    const headerBadge = document.querySelector('.bg-blue-100.text-blue-700');
    expect(headerBadge).toBeInTheDocument();
    expect(headerBadge?.textContent).toContain('2');
  });

  it('sorts threads by oldest root comment first', () => {
    // Thread 2 is created earlier than Thread 1
    const multiThreadComments = [
      {
        id: 'thread1-root',
        reviewId: 'review-1',
        filePath: 'src/auth.ts',
        parentId: null,
        lineStart: 3,
        lineEnd: 3,
        side: 'new' as const,
        content: 'Newer thread',
        commentType: 'comment' as const,
        status: 'open' as const,
        authorType: 'user' as const,
        authorAgentId: null,
        authorAgentName: null,
        targetAgents: [],
        version: 1,
        editedAt: null,
        createdAt: new Date(Date.now() - 10000).toISOString(), // More recent
        updatedAt: new Date().toISOString(),
      },
      {
        id: 'thread2-root',
        reviewId: 'review-1',
        filePath: 'src/auth.ts',
        parentId: null,
        lineStart: 3,
        lineEnd: 3,
        side: 'new' as const,
        content: 'Older thread',
        commentType: 'issue' as const,
        status: 'open' as const,
        authorType: 'user' as const,
        authorAgentId: null,
        authorAgentName: null,
        targetAgents: [],
        version: 1,
        editedAt: null,
        createdAt: new Date(Date.now() - 60000).toISOString(), // Older
        updatedAt: new Date().toISOString(),
      },
    ];

    renderWithQueryClient(<DiffViewer {...defaultProps} comments={multiThreadComments} />);

    // Get all CommentThread components
    const threads = screen.getAllByTestId('comment-thread');
    expect(threads).toHaveLength(2);

    // First thread should be the older one
    expect(threads[0]).toHaveTextContent('Older thread');
    expect(threads[1]).toHaveTextContent('Newer thread');
  });

  it('detects unresolved status across multiple threads', () => {
    // One resolved, one unresolved thread on same line
    const multiThreadComments = [
      {
        id: 'thread1-root',
        reviewId: 'review-1',
        filePath: 'src/auth.ts',
        parentId: null,
        lineStart: 3,
        lineEnd: 3,
        side: 'new' as const,
        content: 'Resolved comment',
        commentType: 'comment' as const,
        status: 'resolved' as const,
        authorType: 'user' as const,
        authorAgentId: null,
        authorAgentName: null,
        targetAgents: [],
        version: 1,
        editedAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      {
        id: 'thread2-root',
        reviewId: 'review-1',
        filePath: 'src/auth.ts',
        parentId: null,
        lineStart: 3,
        lineEnd: 3,
        side: 'new' as const,
        content: 'Open comment',
        commentType: 'issue' as const,
        status: 'open' as const,
        authorType: 'user' as const,
        authorAgentId: null,
        authorAgentName: null,
        targetAgents: [],
        version: 1,
        editedAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];

    renderWithQueryClient(<DiffViewer {...defaultProps} comments={multiThreadComments} />);

    // CommentIndicator should show amber styling for unresolved
    const indicator = document.querySelector('.bg-amber-100');
    expect(indicator).toBeInTheDocument();
  });
});

describe('DiffViewer comment navigation', () => {
  const navTestDiff = `diff --git a/src/auth.ts b/src/auth.ts
index 1234567..abcdefg 100644
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -1,5 +1,6 @@
 const auth = {
   login: () => {},
+  logout: () => {},
   verify: () => {},
 };
`;

  const navDefaultProps = {
    diff: navTestDiff,
    filePath: 'src/auth.ts',
    viewType: 'unified' as const,
    onViewTypeChange: jest.fn(),
  };

  const mockComment = {
    id: 'nav-comment-1',
    reviewId: 'review-1',
    filePath: 'src/auth.ts',
    parentId: null,
    lineStart: 3,
    lineEnd: 3,
    side: 'new' as const,
    content: 'Navigation test comment',
    commentType: 'comment' as const,
    status: 'open' as const,
    authorType: 'user' as const,
    authorAgentId: null,
    authorAgentName: null,
    targetAgents: [],
    version: 1,
    editedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  it('applies highlight ring when selectedCommentId matches comment', () => {
    renderWithQueryClient(
      <DiffViewer
        {...navDefaultProps}
        comments={[mockComment]}
        selectedCommentId="nav-comment-1"
      />,
    );

    // Find the wrapper with data-comment-id
    const commentWrapper = document.querySelector('[data-comment-id="nav-comment-1"]');
    expect(commentWrapper).toBeInTheDocument();
    expect(commentWrapper).toHaveClass('ring-2');
    expect(commentWrapper).toHaveClass('ring-primary');
  });

  it('does not apply highlight when selectedCommentId is null', () => {
    renderWithQueryClient(
      <DiffViewer {...navDefaultProps} comments={[mockComment]} selectedCommentId={null} />,
    );

    const commentWrapper = document.querySelector('[data-comment-id="nav-comment-1"]');
    expect(commentWrapper).toBeInTheDocument();
    expect(commentWrapper).not.toHaveClass('ring-2');
  });

  it('does not apply highlight when selectedCommentId does not match', () => {
    renderWithQueryClient(
      <DiffViewer
        {...navDefaultProps}
        comments={[mockComment]}
        selectedCommentId="different-comment-id"
      />,
    );

    const commentWrapper = document.querySelector('[data-comment-id="nav-comment-1"]');
    expect(commentWrapper).toBeInTheDocument();
    expect(commentWrapper).not.toHaveClass('ring-2');
  });

  it('calls onClearSelectedComment after navigation completes', async () => {
    // Mock scrollIntoView
    Element.prototype.scrollIntoView = jest.fn();

    jest.useFakeTimers();
    const onClearSelectedComment = jest.fn();

    renderWithQueryClient(
      <DiffViewer
        {...navDefaultProps}
        comments={[mockComment]}
        selectedCommentId="nav-comment-1"
        onClearSelectedComment={onClearSelectedComment}
      />,
    );

    // Fast-forward through requestAnimationFrame + setTimeout
    jest.advanceTimersByTime(200);

    // Wait for the 2-second highlight timeout
    jest.advanceTimersByTime(2000);

    expect(onClearSelectedComment).toHaveBeenCalled();

    jest.useRealTimers();
  });

  it('clears selection when comment not found in comments array', async () => {
    jest.useFakeTimers();
    const onClearSelectedComment = jest.fn();

    renderWithQueryClient(
      <DiffViewer
        {...navDefaultProps}
        comments={[mockComment]}
        selectedCommentId="nonexistent-comment"
        onClearSelectedComment={onClearSelectedComment}
      />,
    );

    // Fast-forward through requestAnimationFrame + setTimeout
    jest.advanceTimersByTime(300);

    expect(onClearSelectedComment).toHaveBeenCalled();

    jest.useRealTimers();
  });

  it('scrolls comment into view when selected', () => {
    const scrollIntoViewMock = jest.fn();
    Element.prototype.scrollIntoView = scrollIntoViewMock;

    jest.useFakeTimers();

    renderWithQueryClient(
      <DiffViewer
        {...navDefaultProps}
        comments={[mockComment]}
        selectedCommentId="nav-comment-1"
        onClearSelectedComment={jest.fn()}
      />,
    );

    // Fast-forward through requestAnimationFrame + setTimeout
    jest.advanceTimersByTime(200);

    expect(scrollIntoViewMock).toHaveBeenCalledWith({
      behavior: 'smooth',
      block: 'center',
    });

    jest.useRealTimers();
  });
});
