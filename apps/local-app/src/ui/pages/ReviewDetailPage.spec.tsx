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
  readonly root: Element | Document | null = null;
  readonly rootMargin = '0px';
  readonly thresholds: ReadonlyArray<number> = [0];
  callback: IntersectionObserverCallback;
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
  }
  observe(target: Element) {
    // Immediately trigger as visible
    this.callback([{ isIntersecting: true, target } as IntersectionObserverEntry], this);
  }
  unobserve() {}
  disconnect() {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
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
  mode: 'commit',
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

    {
      await waitFor(() => {
        expect(screen.getByText('Back to Reviews')).toBeInTheDocument();
      });
      await userEvent.click(screen.getByText('Back to Reviews'));
      expect(navigateMock).toHaveBeenCalledWith('/reviews');
    }
  });

  it('renders review header with title and status', async () => {
    global.fetch = buildFetchMock();
    const { Wrapper } = createWrapper();

    render(<ReviewDetailPage />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getByText('Fix authentication bug')).toBeInTheDocument();
    });

    expect(screen.getByText('Pending')).toBeInTheDocument();

    {
      await waitFor(() => {
        expect(screen.getByText('main...feature/auth-fix')).toBeInTheDocument();
      });
      expect(screen.getByText('(abc123d...def456g)')).toBeInTheDocument();
    }
    {
      await waitFor(() => {
        expect(screen.getByText('Fix authentication bug')).toBeInTheDocument();
      });
      expect(screen.getAllByText('Files').length).toBeGreaterThan(0);
      expect(screen.getByText('Comments')).toBeInTheDocument();
      expect(screen.getByText('Select a file to view diff')).toBeInTheDocument();
    }
    {
      await waitFor(() => {
        expect(screen.getByText('3 files')).toBeInTheDocument();
      });
    }
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

    {
      await waitFor(() => {
        expect(screen.getByText('Fix authentication bug')).toBeInTheDocument();
      });
      const gridContainer = document.querySelector('.grid');
      expect(gridContainer).toBeInTheDocument();
      expect(gridContainer).toHaveClass('grid-cols-[1fr_320px]');
    }
    {
      await waitFor(() => {
        expect(screen.getByText('Fix authentication bug')).toBeInTheDocument();
      });
      await waitFor(() => {
        expect(screen.getByText('auth.ts')).toBeInTheDocument();
      });
      await userEvent.click(screen.getByText('auth.ts'));
      await waitFor(() => {
        expect(screen.getByTitle('Side-by-side view')).toBeInTheDocument();
      });
      await userEvent.click(screen.getByTitle('Side-by-side view'));
      const gridContainer = document.querySelector('.grid');
      expect(gridContainer).toBeNull();
      const commentPanelContainer = document.querySelector('.border-t.bg-card');
      expect(commentPanelContainer).toBeInTheDocument();
    }
    {
      await waitFor(() => {
        expect(screen.getByText('auth.ts')).toBeInTheDocument();
      });
      await userEvent.click(screen.getByText('auth.ts'));
      await waitFor(() => {
        expect(screen.getByTitle('Side-by-side view')).toBeInTheDocument();
      });
      await userEvent.click(screen.getByTitle('Side-by-side view'));
      let gridContainer = document.querySelector('.grid');
      expect(gridContainer).toBeNull();
      expect(document.querySelector('.border-t.bg-card')).toBeInTheDocument();
      await userEvent.click(screen.getByTitle('Unified view'));
      gridContainer = document.querySelector('.grid');
      expect(gridContainer).toHaveClass('grid-cols-[1fr_320px]');
    }
    {
      await waitFor(() => {
        expect(screen.getByText('auth.ts')).toBeInTheDocument();
      });
      await userEvent.click(screen.getByText('auth.ts'));
      await waitFor(() => {
        expect(screen.getAllByText('src/auth.ts').length).toBeGreaterThan(0);
      });
      await userEvent.click(screen.getByTitle('Side-by-side view'));
      expect(screen.getAllByText('src/auth.ts').length).toBeGreaterThan(0);
      await userEvent.click(screen.getByTitle('Unified view'));
      expect(screen.getAllByText('src/auth.ts').length).toBeGreaterThan(0);
    }
  });

  it('shows empty state when no files changed', async () => {
    global.fetch = buildFetchMock(baseReview, []);
    const { Wrapper } = createWrapper();

    render(<ReviewDetailPage />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getByText('No files changed')).toBeInTheDocument();
    });
  });

  it.each([
    ['draft', 'Draft'],
    ['pending', 'Pending'],
    ['changes_requested', 'Changes Requested'],
    ['approved', 'Approved'],
    ['closed', 'Closed'],
  ] as const)('renders %s status badge', async (status, label) => {
    const review = { ...baseReview, id: 'review-' + status, status };
    global.fetch = buildFetchMock(review);
    const { Wrapper } = createWrapper('review-' + status);
    render(<ReviewDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(label)).toBeInTheDocument());
  });
});
