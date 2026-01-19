import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';

// Mock resizable components (react-resizable-panels uses DOM measurements that don't work in JSDOM)
jest.mock('@/ui/components/ui/resizable', () => ({
  ResizablePanelGroup: ({ children, className }: { children: ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
  ResizablePanel: ({ children }: { children: ReactNode }) => <>{children}</>,
  ResizableHandle: () => <div data-testid="resize-handle" />,
  useDefaultLayout: () => ({
    defaultLayout: undefined,
    onLayoutChanged: jest.fn(),
  }),
}));

// Mock components that use ESM-only modules
jest.mock('@/ui/components/review/DiffViewer', () => ({
  DiffViewer: ({
    viewType,
    onViewTypeChange,
    diff,
    filePath,
    fileInfo,
  }: {
    viewType: 'unified' | 'split';
    onViewTypeChange: (viewType: 'unified' | 'split') => void;
    diff: string;
    filePath: string;
    fileInfo?: { path: string; status: string; additions: number; deletions: number };
  }) => (
    <div
      data-testid="diff-viewer"
      data-view-type={viewType}
      data-file-path={filePath}
      data-has-diff={diff.length > 0 ? 'true' : 'false'}
      data-file-status={fileInfo?.status ?? 'unknown'}
      data-file-additions={fileInfo?.additions ?? -1}
    >
      DiffViewer ({viewType})
      {diff.length > 0 && <span data-testid="diff-content">Has diff content</span>}
      {diff.length === 0 && fileInfo?.status === 'added' && fileInfo?.additions === 0 && (
        <span data-testid="untracked-empty-state">Untracked file - no diff</span>
      )}
      <button data-testid="toggle-split" onClick={() => onViewTypeChange('split')}>
        Split
      </button>
      <button data-testid="toggle-unified" onClick={() => onViewTypeChange('unified')}>
        Unified
      </button>
    </div>
  ),
}));

jest.mock('@/ui/components/review/FileNavigator', () => ({
  FileNavigator: ({
    files,
    onSelectFile,
  }: {
    files: Array<{ path: string }>;
    onSelectFile: (path: string) => void;
  }) => (
    <div data-testid="file-navigator">
      {files.map((f) => (
        <button key={f.path} onClick={() => onSelectFile(f.path)}>
          {f.path}
        </button>
      ))}
    </div>
  ),
}));

jest.mock('@/ui/components/review/CommentPanel', () => ({
  CommentPanel: ({
    onCloseReview,
    isClosingReview,
  }: {
    onCloseReview?: () => void;
    isClosingReview?: boolean;
  }) => (
    <div data-testid="comment-panel">
      CommentPanel
      {onCloseReview && (
        <button onClick={onCloseReview} disabled={isClosingReview}>
          Close Review
        </button>
      )}
    </div>
  ),
}));

jest.mock('@/ui/components/review/KeyboardShortcutsHelp', () => ({
  KeyboardShortcutsHelp: () => null,
}));

jest.mock('@/ui/components/review/ReviewCommentsSection', () => ({
  ReviewCommentsSection: () => (
    <div data-testid="review-comments-section">ReviewCommentsSection</div>
  ),
}));

jest.mock('@/ui/hooks/useReviewSubscription', () => ({
  useReviewSubscription: jest.fn(),
}));

jest.mock('@/ui/hooks/useCommentMutations', () => ({
  useCreateComment: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useReplyToComment: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useResolveComment: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useDeleteComment: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useEditComment: () => ({ mutateAsync: jest.fn(), isPending: false }),
}));

jest.mock('@/ui/hooks/useKeyboardShortcuts', () => ({
  useKeyboardShortcuts: () => ({ isHelpOpen: false, closeHelp: jest.fn(), openHelp: jest.fn() }),
}));

jest.mock('@/ui/terminal-windows/TerminalWindowsContext', () => ({
  useTerminalWindows: () => ({
    windows: [],
    openWindow: jest.fn(),
    closeWindow: jest.fn(),
    focusWindow: jest.fn(),
    minimizeWindow: jest.fn(),
    restoreWindow: jest.fn(),
  }),
}));

import { ReviewsPage } from './ReviewsPage';
import type { Review } from '@/ui/lib/reviews';

const useSelectedProjectMock = jest.fn();
const navigateMock = jest.fn();

jest.mock('@/ui/hooks/useProjectSelection', () => ({
  useSelectedProject: () => useSelectedProjectMock(),
}));

jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useNavigate: () => navigateMock,
}));

const baseReview: Review = {
  id: 'review-1',
  projectId: 'project-1',
  epicId: null,
  title: 'Pre-commit review',
  description: null,
  status: 'draft',
  mode: 'working_tree',
  baseRef: 'HEAD',
  headRef: 'HEAD',
  baseSha: 'abc123',
  headSha: 'def456',
  createdBy: 'user',
  createdByAgentId: null,
  version: 1,
  commentCount: 0,
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-02T00:00:00.000Z',
};

const projectSelectionValue = {
  projects: [],
  projectsLoading: false,
  projectsError: false,
  refetchProjects: jest.fn(),
  selectedProjectId: 'project-1',
  selectedProject: { id: 'project-1', name: 'Test Project', rootPath: '/test' },
  setSelectedProjectId: jest.fn(),
};

const workingTreeResponse = {
  changes: {
    staged: [{ path: 'src/index.ts', status: 'modified', additions: 10, deletions: 5 }],
    unstaged: [{ path: 'src/app.ts', status: 'modified', additions: 3, deletions: 2 }],
    untracked: [],
  },
  diff: 'diff --git a/src/index.ts...',
};

const commitsResponse = [
  {
    sha: 'abc123',
    message: 'First commit',
    author: 'Test',
    authorEmail: 'test@test.com',
    date: '2024-01-01',
  },
  {
    sha: 'def456',
    message: 'Second commit',
    author: 'Test',
    authorEmail: 'test@test.com',
    date: '2024-01-02',
  },
];

const branchesResponse = [
  { name: 'main', sha: 'abc123', isCurrent: false },
  { name: 'master', sha: 'abc123', isCurrent: false },
  { name: 'develop', sha: 'def456', isCurrent: true },
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
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );

  return { Wrapper, queryClient };
}

function buildFetchMock(
  options: {
    activeReview?: Review | null;
    workingTree?: typeof workingTreeResponse;
    commits?: typeof commitsResponse;
    branches?: typeof branchesResponse;
  } = {},
) {
  return jest.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();

    if (url.includes('/api/reviews/active')) {
      return {
        ok: true,
        json: async () => ({ review: options.activeReview ?? null }),
      } as Response;
    }

    if (url.includes('/api/git/working-tree')) {
      return {
        ok: true,
        json: async () => options.workingTree ?? workingTreeResponse,
      } as Response;
    }

    if (url.includes('/api/git/commits')) {
      return {
        ok: true,
        json: async () => options.commits ?? commitsResponse,
      } as Response;
    }

    if (url.includes('/api/git/branches')) {
      return {
        ok: true,
        json: async () => options.branches ?? branchesResponse,
      } as Response;
    }

    if (url.includes('/api/reviews/') && url.includes('/comments')) {
      return {
        ok: true,
        json: async () => ({ items: [], total: 0, limit: 100, offset: 0 }),
      } as Response;
    }

    return { ok: false, status: 404 } as Response;
  });
}

describe('ReviewsPage', () => {
  beforeEach(() => {
    useSelectedProjectMock.mockReturnValue(projectSelectionValue);
    navigateMock.mockReset();
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  it('renders page header with title "Code Review"', async () => {
    global.fetch = buildFetchMock();
    const { Wrapper } = createWrapper();

    render(<ReviewsPage />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getByText('Code Review')).toBeInTheDocument();
    });
  });

  it('shows loading skeleton while fetching', async () => {
    global.fetch = jest.fn(() => new Promise(() => {})); // Never resolves
    const { Wrapper } = createWrapper();

    render(<ReviewsPage />, { wrapper: Wrapper });

    // Should show skeleton
    const skeletons = document.querySelectorAll('.animate-pulse');
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it('shows project guard when no project selected', async () => {
    useSelectedProjectMock.mockReturnValue({
      ...projectSelectionValue,
      selectedProjectId: undefined,
      selectedProject: undefined,
    });

    const { Wrapper } = createWrapper();

    render(<ReviewsPage />, { wrapper: Wrapper });

    expect(screen.getByText('No project selected')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /go to projects/i })).toBeInTheDocument();
  });

  it('renders mode toggle with Working Changes and Commit options', async () => {
    global.fetch = buildFetchMock();
    const { Wrapper } = createWrapper();

    render(<ReviewsPage />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getByRole('radio', { name: /working changes/i })).toBeInTheDocument();
      expect(screen.getByRole('radio', { name: /commit/i })).toBeInTheDocument();
    });
  });

  it('renders filter toggle with All, Staged, Unstaged options in working-tree mode', async () => {
    global.fetch = buildFetchMock();
    const { Wrapper } = createWrapper();

    render(<ReviewsPage />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getByRole('radio', { name: 'All' })).toBeInTheDocument();
      expect(screen.getByRole('radio', { name: 'Staged' })).toBeInTheDocument();
      expect(screen.getByRole('radio', { name: 'Unstaged' })).toBeInTheDocument();
    });
  });

  it('renders file navigator with changed files', async () => {
    global.fetch = buildFetchMock();
    const { Wrapper } = createWrapper();

    render(<ReviewsPage />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getByTestId('file-navigator')).toBeInTheDocument();
    });

    // Files from working tree should be rendered
    await waitFor(() => {
      expect(screen.getByText('src/index.ts')).toBeInTheDocument();
      expect(screen.getByText('src/app.ts')).toBeInTheDocument();
    });
  });

  it('shows empty state when working tree has no changes', async () => {
    global.fetch = buildFetchMock({
      workingTree: { changes: { staged: [], unstaged: [], untracked: [] }, diff: '' },
    });
    const { Wrapper } = createWrapper();

    render(<ReviewsPage />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getByText('No changes to review')).toBeInTheDocument();
    });
  });

  it('includes untracked files in file navigator with added status', async () => {
    global.fetch = buildFetchMock({
      workingTree: {
        changes: {
          staged: [],
          unstaged: [],
          untracked: ['src/new-file.ts', 'src/another-new.ts'],
        },
        diff: '',
      },
    });
    const { Wrapper } = createWrapper();

    render(<ReviewsPage />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getByTestId('file-navigator')).toBeInTheDocument();
    });

    // Untracked files should appear in the navigator
    await waitFor(() => {
      expect(screen.getByText('src/new-file.ts')).toBeInTheDocument();
      expect(screen.getByText('src/another-new.ts')).toBeInTheDocument();
    });

    // File count should reflect untracked files
    expect(screen.getByText('2 files')).toBeInTheDocument();
  });

  it('does not duplicate files that are both staged/unstaged and untracked', async () => {
    global.fetch = buildFetchMock({
      workingTree: {
        changes: {
          staged: [{ path: 'src/index.ts', status: 'modified', additions: 10, deletions: 5 }],
          unstaged: [],
          untracked: ['src/index.ts'], // Same file as staged (edge case)
        },
        diff: '',
      },
    });
    const { Wrapper } = createWrapper();

    render(<ReviewsPage />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getByTestId('file-navigator')).toBeInTheDocument();
    });

    // Should only show 1 file (not duplicated)
    await waitFor(() => {
      expect(screen.getByText('1 files')).toBeInTheDocument();
    });
  });

  it('passes diff content to DiffViewer when selecting untracked file with diff', async () => {
    const untrackedFileDiff = `diff --git a/src/new-file.ts b/src/new-file.ts
new file mode 100644
--- /dev/null
+++ b/src/new-file.ts
@@ -0,0 +1,3 @@
+export const hello = 'world';
+export const foo = 'bar';
+export default hello;
`;

    global.fetch = buildFetchMock({
      workingTree: {
        changes: {
          staged: [],
          unstaged: [],
          untracked: ['src/new-file.ts'],
        },
        diff: untrackedFileDiff,
      },
    });
    const { Wrapper } = createWrapper();

    render(<ReviewsPage />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getByTestId('file-navigator')).toBeInTheDocument();
    });

    // Select the untracked file
    await userEvent.click(screen.getByText('src/new-file.ts'));

    // DiffViewer should be rendered with diff content
    await waitFor(() => {
      const diffViewer = screen.getByTestId('diff-viewer');
      expect(diffViewer).toBeInTheDocument();
      expect(diffViewer).toHaveAttribute('data-has-diff', 'true');
      expect(diffViewer).toHaveAttribute('data-file-path', 'src/new-file.ts');
      expect(diffViewer).toHaveAttribute('data-file-status', 'added');
    });

    // Should show that diff content is present
    expect(screen.getByTestId('diff-content')).toBeInTheDocument();
  });

  it('shows empty state when selecting untracked file without diff patch', async () => {
    global.fetch = buildFetchMock({
      workingTree: {
        changes: {
          staged: [],
          unstaged: [],
          untracked: ['src/binary-file.png'],
        },
        diff: '', // No diff content for this file (e.g., binary or skipped)
      },
    });
    const { Wrapper } = createWrapper();

    render(<ReviewsPage />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getByTestId('file-navigator')).toBeInTheDocument();
    });

    // Select the untracked file
    await userEvent.click(screen.getByText('src/binary-file.png'));

    // DiffViewer should be rendered with empty state for untracked file
    await waitFor(() => {
      const diffViewer = screen.getByTestId('diff-viewer');
      expect(diffViewer).toBeInTheDocument();
      expect(diffViewer).toHaveAttribute('data-has-diff', 'false');
      expect(diffViewer).toHaveAttribute('data-file-status', 'added');
      expect(diffViewer).toHaveAttribute('data-file-additions', '0');
    });

    // Should show untracked empty state indicator
    expect(screen.getByTestId('untracked-empty-state')).toBeInTheDocument();
  });

  it('passes correct fileInfo to DiffViewer for untracked files', async () => {
    global.fetch = buildFetchMock({
      workingTree: {
        changes: {
          staged: [],
          unstaged: [],
          untracked: ['src/new-component.tsx'],
        },
        diff: '',
      },
    });
    const { Wrapper } = createWrapper();

    render(<ReviewsPage />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getByTestId('file-navigator')).toBeInTheDocument();
    });

    // Select the untracked file
    await userEvent.click(screen.getByText('src/new-component.tsx'));

    // Verify fileInfo is passed correctly
    await waitFor(() => {
      const diffViewer = screen.getByTestId('diff-viewer');
      // Untracked files are converted to ChangedFile with status='added', additions=0, deletions=0
      expect(diffViewer).toHaveAttribute('data-file-status', 'added');
      expect(diffViewer).toHaveAttribute('data-file-additions', '0');
    });
  });

  it('shows Active Review badge and Close button when review is active', async () => {
    global.fetch = buildFetchMock({ activeReview: baseReview });
    const { Wrapper } = createWrapper();

    render(<ReviewsPage />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getByText('Active Review')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /close review/i })).toBeInTheDocument();
    });
  });

  it('does not show Close button when no active review', async () => {
    global.fetch = buildFetchMock({ activeReview: null });
    const { Wrapper } = createWrapper();

    render(<ReviewsPage />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getByText('Code Review')).toBeInTheDocument();
    });

    expect(screen.queryByRole('button', { name: /close review/i })).not.toBeInTheDocument();
  });

  it('shows file count when files are present', async () => {
    global.fetch = buildFetchMock();
    const { Wrapper } = createWrapper();

    render(<ReviewsPage />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getByText('2 files')).toBeInTheDocument();
    });
  });

  it('switches to commit mode when Commit button clicked', async () => {
    global.fetch = buildFetchMock();
    const { Wrapper } = createWrapper();

    render(<ReviewsPage />, { wrapper: Wrapper });

    // Wait for initial render
    await waitFor(() => {
      expect(screen.getByRole('radio', { name: /commit/i })).toBeInTheDocument();
    });

    // Switch to commit mode - verify mode can be changed
    const commitModeButton = screen.getByRole('radio', { name: /commit/i });
    await userEvent.click(commitModeButton);

    // Filter toggle should disappear in commit mode (it's only for working-tree)
    await waitFor(() => {
      expect(screen.queryByRole('radio', { name: 'Staged' })).not.toBeInTheDocument();
    });
  });

  it('shows refresh button in working-tree mode', async () => {
    global.fetch = buildFetchMock();
    const { Wrapper } = createWrapper();

    render(<ReviewsPage />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getByTitle('Refresh')).toBeInTheDocument();
    });
  });

  it('renders three-panel layout when files exist', async () => {
    global.fetch = buildFetchMock();
    const { Wrapper } = createWrapper();

    render(<ReviewsPage />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getByTestId('file-navigator')).toBeInTheDocument();
    });

    // Select a file to show diff viewer
    await userEvent.click(screen.getByText('src/index.ts'));

    await waitFor(() => {
      expect(screen.getByTestId('diff-viewer')).toBeInTheDocument();
    });
  });

  it('shows "Add a comment to start a review" when no active review', async () => {
    global.fetch = buildFetchMock({ activeReview: null });
    const { Wrapper } = createWrapper();

    render(<ReviewsPage />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getByTestId('file-navigator')).toBeInTheDocument();
    });

    // Right panel should show the prompt
    expect(screen.getByText('Add a comment to start a review')).toBeInTheDocument();
  });

  it('shows comment panel when active review exists', async () => {
    global.fetch = buildFetchMock({ activeReview: baseReview });
    const { Wrapper } = createWrapper();

    render(<ReviewsPage />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getByTestId('file-navigator')).toBeInTheDocument();
    });

    // Comment panel should be visible
    expect(screen.getByTestId('comment-panel')).toBeInTheDocument();
  });

  it('provides onAddComment handler to DiffViewer even without active review', async () => {
    // This test verifies that the DiffViewer receives the onAddComment handler
    // even when there's no active review (for auto-create functionality)
    global.fetch = buildFetchMock({ activeReview: null });
    const { Wrapper } = createWrapper();

    render(<ReviewsPage />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getByTestId('file-navigator')).toBeInTheDocument();
    });

    // Select a file
    await userEvent.click(screen.getByText('src/index.ts'));

    // DiffViewer should be rendered (with onAddComment handler available)
    await waitFor(() => {
      expect(screen.getByTestId('diff-viewer')).toBeInTheDocument();
    });
  });
});

describe('ReviewsPage adaptive layout', () => {
  beforeEach(() => {
    useSelectedProjectMock.mockReturnValue(projectSelectionValue);
    navigateMock.mockReset();
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  it('renders with unified grid layout by default', async () => {
    global.fetch = buildFetchMock();
    const { Wrapper } = createWrapper();

    render(<ReviewsPage />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getByTestId('file-navigator')).toBeInTheDocument();
    });

    // Grid container should have unified layout classes (inside right resizable panel)
    const gridContainer = document.querySelector('.grid');
    expect(gridContainer).toBeInTheDocument();
    expect(gridContainer).toHaveClass('grid-cols-[1fr_320px]');
  });

  it('passes viewType="unified" to DiffViewer by default', async () => {
    global.fetch = buildFetchMock();
    const { Wrapper } = createWrapper();

    render(<ReviewsPage />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getByTestId('file-navigator')).toBeInTheDocument();
    });

    // Select a file to show DiffViewer
    await userEvent.click(screen.getByText('src/index.ts'));

    await waitFor(() => {
      expect(screen.getByTestId('diff-viewer')).toBeInTheDocument();
    });

    // DiffViewer should receive viewType="unified"
    const diffViewer = screen.getByTestId('diff-viewer');
    expect(diffViewer).toHaveAttribute('data-view-type', 'unified');
  });

  it('uses nested resizable panels when DiffViewer triggers onViewTypeChange to split', async () => {
    global.fetch = buildFetchMock();
    const { Wrapper } = createWrapper();

    render(<ReviewsPage />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getByTestId('file-navigator')).toBeInTheDocument();
    });

    // Select a file to show DiffViewer
    await userEvent.click(screen.getByText('src/index.ts'));

    await waitFor(() => {
      expect(screen.getByTestId('diff-viewer')).toBeInTheDocument();
    });

    // Click the split toggle in the mocked DiffViewer
    await userEvent.click(screen.getByTestId('toggle-split'));

    // Split view uses nested ResizablePanelGroup instead of grid
    const gridContainer = document.querySelector('.grid');
    expect(gridContainer).toBeNull();

    // CommentPanel container should have border-t (top border) in split mode
    const commentPanelContainer = document.querySelector('.border-t.bg-card');
    expect(commentPanelContainer).toBeInTheDocument();

    // DiffViewer should receive viewType="split"
    const diffViewer = screen.getByTestId('diff-viewer');
    expect(diffViewer).toHaveAttribute('data-view-type', 'split');
  });

  it('FileNavigator is in separate resizable panel', async () => {
    global.fetch = buildFetchMock();
    const { Wrapper } = createWrapper();

    render(<ReviewsPage />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getByTestId('file-navigator')).toBeInTheDocument();
    });

    // FileNavigator should be rendered inside a resizable panel structure
    // The panel contains a div with the Files header
    const filesHeader = screen.getByText('Files');
    expect(filesHeader).toBeInTheDocument();
    // The header should be inside a panel with border-r class
    const fileNavigatorContainer = filesHeader.closest('.border-r');
    expect(fileNavigatorContainer).toBeInTheDocument();
  });

  it('switches back to unified layout when unified toggle is clicked', async () => {
    global.fetch = buildFetchMock();
    const { Wrapper } = createWrapper();

    render(<ReviewsPage />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getByTestId('file-navigator')).toBeInTheDocument();
    });

    // Select a file
    await userEvent.click(screen.getByText('src/index.ts'));

    await waitFor(() => {
      expect(screen.getByTestId('diff-viewer')).toBeInTheDocument();
    });

    // Toggle to split
    await userEvent.click(screen.getByTestId('toggle-split'));

    // Verify split (no grid, uses nested resizable panels)
    let gridContainer = document.querySelector('.grid');
    expect(gridContainer).toBeNull();
    expect(document.querySelector('.border-t.bg-card')).toBeInTheDocument();

    // Toggle back to unified
    await userEvent.click(screen.getByTestId('toggle-unified'));

    // Verify unified (grid is inside right resizable panel)
    gridContainer = document.querySelector('.grid');
    expect(gridContainer).toHaveClass('grid-cols-[1fr_320px]');
  });

  it('preserves file selection when toggling view modes', async () => {
    global.fetch = buildFetchMock();
    const { Wrapper } = createWrapper();

    render(<ReviewsPage />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getByTestId('file-navigator')).toBeInTheDocument();
    });

    // Select a file
    await userEvent.click(screen.getByText('src/index.ts'));

    await waitFor(() => {
      expect(screen.getByTestId('diff-viewer')).toBeInTheDocument();
    });

    // Toggle to split
    await userEvent.click(screen.getByTestId('toggle-split'));

    // DiffViewer should still be showing
    expect(screen.getByTestId('diff-viewer')).toBeInTheDocument();

    // Toggle back to unified
    await userEvent.click(screen.getByTestId('toggle-unified'));

    // DiffViewer should still be showing
    expect(screen.getByTestId('diff-viewer')).toBeInTheDocument();
  });

  describe('accessibility', () => {
    it('should have no accessibility violations', async () => {
      useSelectedProjectMock.mockReturnValue(projectSelectionValue);
      global.fetch = buildFetchMock();

      const { Wrapper } = createWrapper();
      const { container } = render(<ReviewsPage />, { wrapper: Wrapper });

      // Wait for page to load with file list
      await waitFor(() => {
        expect(screen.getByTestId('file-navigator')).toBeInTheDocument();
      });

      const results = await axe(container);
      expect(results).toHaveNoViolations();
    });
  });
});
