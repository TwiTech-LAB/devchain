import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

// Mock refractor (ESM module that Jest can't transform) - must be before imports that use it
jest.mock('refractor', () => ({
  refractor: {
    registered: jest.fn(() => false),
    highlight: jest.fn(),
  },
}));

// Mock react-diff-view CSS import
jest.mock('react-diff-view/style/index.css', () => ({}));

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

import { ReviewDetailPage } from './ReviewDetailPage';
import type { Review, ChangedFile } from '@/ui/lib/reviews';

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

const navigateMock = jest.fn();

jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useNavigate: () => navigateMock,
}));

const baseReview: Review = {
  id: 'review-1',
  projectId: 'project-1',
  epicId: null,
  title: 'Fix authentication bug',
  description: 'Fixes the login issue',
  status: 'pending',
  baseRef: 'main',
  headRef: 'feature/auth-fix',
  baseSha: 'abc123def456',
  headSha: 'def456ghi789',
  createdBy: 'user',
  createdByAgentId: null,
  version: 1,
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-02T00:00:00.000Z',
};

const mockChangedFiles: ChangedFile[] = [
  { path: 'src/auth.ts', status: 'modified', additions: 10, deletions: 5 },
  { path: 'src/utils.ts', status: 'added', additions: 20, deletions: 0 },
  { path: 'src/old.ts', status: 'deleted', additions: 0, deletions: 15 },
];

function createWrapper(reviewId = 'review-1') {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/reviews/${reviewId}`]}>
        <Routes>
          <Route path="/reviews/:reviewId" element={children} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );

  return { Wrapper, queryClient };
}

function buildFetchMock(
  review: Review | null = baseReview,
  files: ChangedFile[] = mockChangedFiles,
) {
  return jest.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();

    // Single review fetch
    if (url.match(/\/api\/reviews\/[^/]+$/) && !url.includes('/comments')) {
      if (!review) {
        return { ok: false, status: 404 } as Response;
      }
      return {
        ok: true,
        json: async () => review,
      } as Response;
    }

    // Comments fetch
    if (url.includes('/comments')) {
      return {
        ok: true,
        json: async () => ({ items: [], total: 0, limit: 100, offset: 0 }),
      } as Response;
    }

    // Changed files fetch
    if (url.includes('/api/git/changed-files')) {
      return {
        ok: true,
        json: async () => files,
      } as Response;
    }

    // Diff fetch
    if (url.includes('/api/git/diff')) {
      return {
        ok: true,
        json: async () => ({
          diff: `diff --git a/src/auth.ts b/src/auth.ts
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
`,
        }),
      } as Response;
    }

    return { ok: false, status: 404 } as Response;
  });
}

describe('ReviewDetailPage', () => {
  beforeEach(() => {
    navigateMock.mockReset();
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  it('shows loading skeleton while fetching', () => {
    global.fetch = jest.fn(() => new Promise(() => {})); // Never resolves
    const { Wrapper } = createWrapper();

    render(<ReviewDetailPage />, { wrapper: Wrapper });

    // Should show skeleton elements
    const skeletons = document.querySelectorAll('.animate-pulse');
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it('shows error state when review not found', async () => {
    global.fetch = buildFetchMock(null);
    const { Wrapper } = createWrapper();

    render(<ReviewDetailPage />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getByText('Failed to load review')).toBeInTheDocument();
    });

    expect(screen.getByText('Back to Reviews')).toBeInTheDocument();
  });

  it('renders review header with title and status', async () => {
    global.fetch = buildFetchMock();
    const { Wrapper } = createWrapper();

    render(<ReviewDetailPage />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getByText('Fix authentication bug')).toBeInTheDocument();
    });

    expect(screen.getByText('Pending')).toBeInTheDocument();
  });

  it('renders base and head refs in header', async () => {
    global.fetch = buildFetchMock();
    const { Wrapper } = createWrapper();

    render(<ReviewDetailPage />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getByText('main...feature/auth-fix')).toBeInTheDocument();
    });

    // Also check SHA references
    expect(screen.getByText('(abc123d...def456g)')).toBeInTheDocument();
  });

  it('renders back button that navigates to reviews list', async () => {
    global.fetch = buildFetchMock();
    const { Wrapper } = createWrapper();

    render(<ReviewDetailPage />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getByText('Fix authentication bug')).toBeInTheDocument();
    });

    const backButton = screen.getByTitle('Back to reviews');
    await userEvent.click(backButton);

    expect(navigateMock).toHaveBeenCalledWith('/reviews');
  });

  it('renders three-panel layout with Files, Diff, and Comments sections', async () => {
    global.fetch = buildFetchMock();
    const { Wrapper } = createWrapper();

    render(<ReviewDetailPage />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getByText('Fix authentication bug')).toBeInTheDocument();
    });

    // Check for panel headers (use getAllByText for Files since CommentPanel also has "Files" filter)
    expect(screen.getAllByText('Files').length).toBeGreaterThan(0);
    expect(screen.getByText('Comments')).toBeInTheDocument();
    expect(screen.getByText('Select a file to view diff')).toBeInTheDocument();
  });

  it('displays file count in header', async () => {
    global.fetch = buildFetchMock();
    const { Wrapper } = createWrapper();

    render(<ReviewDetailPage />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getByText('3 files')).toBeInTheDocument();
    });
  });

  it('renders file list with additions and deletions', async () => {
    global.fetch = buildFetchMock();
    const { Wrapper } = createWrapper();

    render(<ReviewDetailPage />, { wrapper: Wrapper });

    await waitFor(() => {
      // FileNavigator uses tree view, showing file names not full paths
      expect(screen.getByText('auth.ts')).toBeInTheDocument();
    });

    expect(screen.getByText('utils.ts')).toBeInTheDocument();
    expect(screen.getByText('old.ts')).toBeInTheDocument();

    // Check for additions/deletions display
    expect(screen.getByText('+10')).toBeInTheDocument();
    expect(screen.getByText('-5')).toBeInTheDocument();
  });

  it('selects file when clicked', async () => {
    global.fetch = buildFetchMock();
    const { Wrapper } = createWrapper();

    render(<ReviewDetailPage />, { wrapper: Wrapper });

    await waitFor(() => {
      // FileNavigator uses tree view, showing file names not full paths
      expect(screen.getByText('auth.ts')).toBeInTheDocument();
    });

    // Click on a file (shown as just the filename in tree view)
    await userEvent.click(screen.getByText('auth.ts'));

    // The diff viewer should now show the selected file with full path
    // The path appears in both diff viewer and comments panel
    await waitFor(() => {
      expect(screen.getAllByText('src/auth.ts').length).toBeGreaterThan(0);
    });
  });

  it('shows empty state when no files changed', async () => {
    global.fetch = buildFetchMock(baseReview, []);
    const { Wrapper } = createWrapper();

    render(<ReviewDetailPage />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getByText('No files changed')).toBeInTheDocument();
    });
  });

  it('renders all status badges correctly', async () => {
    const statuses = ['draft', 'pending', 'changes_requested', 'approved', 'closed'] as const;
    const statusLabels = {
      draft: 'Draft',
      pending: 'Pending',
      changes_requested: 'Changes Requested',
      approved: 'Approved',
      closed: 'Closed',
    };

    for (const status of statuses) {
      jest.resetAllMocks();
      const review = { ...baseReview, id: `review-${status}`, status };
      global.fetch = buildFetchMock(review);
      const { Wrapper } = createWrapper(`review-${status}`);

      const { unmount } = render(<ReviewDetailPage />, { wrapper: Wrapper });

      await waitFor(() => {
        expect(screen.getByText(statusLabels[status])).toBeInTheDocument();
      });

      unmount();
    }
  });

  it('navigates back when error state button is clicked', async () => {
    global.fetch = buildFetchMock(null);
    const { Wrapper } = createWrapper();

    render(<ReviewDetailPage />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getByText('Back to Reviews')).toBeInTheDocument();
    });

    await userEvent.click(screen.getByText('Back to Reviews'));

    expect(navigateMock).toHaveBeenCalledWith('/reviews');
  });
});

describe('ReviewDetailPage adaptive layout', () => {
  beforeEach(() => {
    navigateMock.mockReset();
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  it('renders with unified grid layout by default', async () => {
    global.fetch = buildFetchMock();
    const { Wrapper } = createWrapper();

    render(<ReviewDetailPage />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getByText('Fix authentication bug')).toBeInTheDocument();
    });

    // Grid container should have unified layout classes (inside right resizable panel)
    const gridContainer = document.querySelector('.grid');
    expect(gridContainer).toBeInTheDocument();
    expect(gridContainer).toHaveClass('grid-cols-[1fr_320px]');
  });

  it('uses nested resizable panels when view type is changed to split', async () => {
    global.fetch = buildFetchMock();
    const { Wrapper } = createWrapper();

    render(<ReviewDetailPage />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getByText('Fix authentication bug')).toBeInTheDocument();
    });

    // Select a file first to show the DiffViewer with toggle buttons
    await waitFor(() => {
      expect(screen.getByText('auth.ts')).toBeInTheDocument();
    });

    await userEvent.click(screen.getByText('auth.ts'));

    // Wait for DiffViewer to render with toggle buttons
    await waitFor(() => {
      expect(screen.getByTitle('Side-by-side view')).toBeInTheDocument();
    });

    // Click split view toggle
    await userEvent.click(screen.getByTitle('Side-by-side view'));

    // Split view uses nested ResizablePanelGroup instead of grid
    // No grid container in split mode - it uses vertical resizable panels
    const gridContainer = document.querySelector('.grid');
    expect(gridContainer).toBeNull();

    // CommentPanel should have border-t (top border) in split mode
    const commentPanelContainer = document.querySelector('.border-t.bg-card');
    expect(commentPanelContainer).toBeInTheDocument();
  });

  it('FileNavigator is in separate resizable panel', async () => {
    global.fetch = buildFetchMock();
    const { Wrapper } = createWrapper();

    render(<ReviewDetailPage />, { wrapper: Wrapper });

    // Wait for page to load
    await waitFor(() => {
      expect(screen.getByText('auth.ts')).toBeInTheDocument();
    });

    // FileNavigator should be rendered inside a resizable panel structure
    // The panel contains a div with the Files header (use getAllByText since CommentPanel also has "Files" filter)
    const filesHeaders = screen.getAllByText('Files');
    expect(filesHeaders.length).toBeGreaterThan(0);
    // Find the one inside a panel with border-r class (FileNavigator header)
    const fileNavigatorHeader = filesHeaders.find((el) => el.closest('.border-r'));
    expect(fileNavigatorHeader).toBeInTheDocument();
  });

  it('switches back to unified layout when unified button is clicked', async () => {
    global.fetch = buildFetchMock();
    const { Wrapper } = createWrapper();

    render(<ReviewDetailPage />, { wrapper: Wrapper });

    // Wait and select file
    await waitFor(() => {
      expect(screen.getByText('auth.ts')).toBeInTheDocument();
    });

    await userEvent.click(screen.getByText('auth.ts'));

    await waitFor(() => {
      expect(screen.getByTitle('Side-by-side view')).toBeInTheDocument();
    });

    // Switch to split
    await userEvent.click(screen.getByTitle('Side-by-side view'));

    // Verify split (no grid, uses nested resizable panels)
    let gridContainer = document.querySelector('.grid');
    expect(gridContainer).toBeNull();
    expect(document.querySelector('.border-t.bg-card')).toBeInTheDocument();

    // Switch back to unified
    await userEvent.click(screen.getByTitle('Unified view'));

    // Verify unified (grid is inside right resizable panel)
    gridContainer = document.querySelector('.grid');
    expect(gridContainer).toHaveClass('grid-cols-[1fr_320px]');
  });

  it('preserves file selection when toggling view modes', async () => {
    global.fetch = buildFetchMock();
    const { Wrapper } = createWrapper();

    render(<ReviewDetailPage />, { wrapper: Wrapper });

    // Wait and select file
    await waitFor(() => {
      expect(screen.getByText('auth.ts')).toBeInTheDocument();
    });

    await userEvent.click(screen.getByText('auth.ts'));

    // Wait for DiffViewer to show the file path
    await waitFor(() => {
      expect(screen.getAllByText('src/auth.ts').length).toBeGreaterThan(0);
    });

    // Toggle to split view
    await userEvent.click(screen.getByTitle('Side-by-side view'));

    // File selection should still be there
    expect(screen.getAllByText('src/auth.ts').length).toBeGreaterThan(0);

    // Toggle back to unified
    await userEvent.click(screen.getByTitle('Unified view'));

    // File selection should still be preserved
    expect(screen.getAllByText('src/auth.ts').length).toBeGreaterThan(0);
  });
});
