import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mockSetSelectedWorkspaceId = jest.fn();
let mockProjectSelection: Record<string, unknown> = {};

// Polyfill window.matchMedia
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: jest.fn().mockImplementation((query: string) => ({
    matches: true,
    media: query,
    onchange: null,
    addListener: jest.fn(),
    removeListener: jest.fn(),
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    dispatchEvent: jest.fn(),
  })),
});

jest.mock('../hooks/useAppSocket', () => ({
  useAppSocket: jest.fn(),
}));

jest.mock('../lib/socket', () => ({
  getAppSocket: jest.fn(() => ({
    connected: true,
    on: jest.fn(),
    off: jest.fn(),
    emit: jest.fn(),
  })),
  releaseAppSocket: jest.fn(),
}));

jest.mock('../terminal-windows', () => ({
  TerminalWindowsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TerminalWindowsLayer: () => null,
  useTerminalWindowManager: () => jest.fn(),
  useTerminalWindows: () => ({
    windows: [],
    closeWindow: jest.fn(),
    focusedWindowId: null,
    focusWindow: jest.fn(),
    minimizeWindow: jest.fn(),
    restoreWindow: jest.fn(),
  }),
}));

jest.mock('./terminal-dock', () => ({
  TerminalDock: () => null,
  OPEN_TERMINAL_DOCK_EVENT: 'devchain:terminal-dock:open',
}));

jest.mock('../hooks/useProjectSelection', () => ({
  useSelectedProject: () => ({
    workspaces: [],
    selectedWorkspaceId: undefined,
    setSelectedWorkspaceId: mockSetSelectedWorkspaceId,
    selectedProjectId: null,
    selectedProject: null,
    projects: [],
    projectsLoading: false,
    projectsError: null,
    refetchProjects: jest.fn(),
    setSelectedProjectId: jest.fn(),
    ...mockProjectSelection,
  }),
}));

jest.mock('../hooks/use-toast', () => ({
  useToast: () => ({ toasts: [], toast: jest.fn(), dismiss: jest.fn() }),
}));

jest.mock('../lib/preflight', () => ({
  fetchPreflightChecks: jest.fn().mockResolvedValue({
    overall: 'pass',
    checks: [],
    providers: [],
    timestamp: new Date().toISOString(),
  }),
}));

jest.mock('./cloud/CloudStatusIndicator', () => ({
  CloudStatusIndicator: () => null,
}));

jest.mock('@/ui/components/ThemeSelect', () => ({
  ThemeSelect: () => null,
  getStoredTheme: () => 'ocean',
}));

jest.mock('./shared', () => ({
  ToastHost: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Breadcrumbs: () => null,
  EpicSearchInput: () => null,
}));

jest.mock('./shared/AutoCompactEnableModal', () => ({
  AutoCompactEnableModal: () => null,
}));

jest.mock('../pages/ReviewsPage.lazy', () => ({
  preloadReviewsPage: jest.fn(),
}));

jest.mock('../hooks/useBreadcrumbs', () => ({
  BreadcrumbsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useBreadcrumbs: () => ({ items: [] }),
}));

jest.mock('../hooks/useRuntime', () => ({
  useRuntime: () => ({ cloudUiEnabled: true }),
}));

import { Layout } from './Layout';

function renderLayout(initialPath: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({}),
  }) as jest.Mock;

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Layout>
          <div>page content</div>
        </Layout>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Layout nav-item active state', () => {
  beforeEach(() => {
    mockProjectSelection = {};
    mockSetSelectedWorkspaceId.mockReset();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('marks Notifications nav item active when on /cloud?section=notifications', async () => {
    renderLayout('/cloud?section=notifications');

    await waitFor(() => {
      const notificationsLink = screen.getByRole('link', { name: /notifications/i });
      expect(notificationsLink).toHaveAttribute('aria-current', 'page');
    });
  });

  it('does not mark Notifications nav item active when on /cloud?section=account', async () => {
    renderLayout('/cloud?section=account');

    await waitFor(() => {
      const notificationsLink = screen.getByRole('link', { name: /notifications/i });
      expect(notificationsLink).not.toHaveAttribute('aria-current', 'page');
    });
  });

  it('does not mark Cloud nav item active when on /cloud?section=notifications', async () => {
    renderLayout('/cloud?section=notifications');

    // Cloud lives in the collapsible System section, which no longer auto-expands.
    // Expand it manually to inspect the Cloud link's active state.
    fireEvent.click(screen.getByRole('button', { name: /^system/i }));

    await waitFor(() => {
      // Cloud nav item has title="Cloud" — match by title since label alone is ambiguous
      const cloudLink = screen
        .getAllByRole('link')
        .find((el) => el.getAttribute('title') === 'Cloud');
      expect(cloudLink).toBeDefined();
      expect(cloudLink).not.toHaveAttribute('aria-current', 'page');
    });
  });

  it('marks Cloud nav item active when on /cloud (no section)', async () => {
    renderLayout('/cloud');

    // System section no longer auto-expands; expand it manually to reach the Cloud link.
    fireEvent.click(screen.getByRole('button', { name: /^system/i }));

    await waitFor(() => {
      const cloudLink = screen
        .getAllByRole('link')
        .find((el) => el.getAttribute('title') === 'Cloud');
      expect(cloudLink).toBeDefined();
      expect(cloudLink).toHaveAttribute('aria-current', 'page');
    });
  });

  it('marks Board nav item active when on /board (pathname-only regression)', async () => {
    renderLayout('/board');

    await waitFor(() => {
      const boardLink = screen.getByRole('link', { name: /board/i });
      expect(boardLink).toHaveAttribute('aria-current', 'page');
    });
  });

  it('marks Board nav item active when on /epics/:id (special Board logic regression)', async () => {
    renderLayout('/epics/some-epic-id');

    await waitFor(() => {
      const boardLink = screen.getByRole('link', { name: /board/i });
      expect(boardLink).toHaveAttribute('aria-current', 'page');
    });
  });

  it('marks Projects nav item active when on /projects (pathname-only regression)', async () => {
    renderLayout('/projects');

    await waitFor(() => {
      // Use exact name to avoid matching "No projects yet? Create one" link
      const projectsLink = screen.getByRole('link', { name: 'Projects' });
      expect(projectsLink).toHaveAttribute('aria-current', 'page');
    });
  });
});

describe('Layout workspace switcher', () => {
  beforeEach(() => {
    mockSetSelectedWorkspaceId.mockReset();
    mockProjectSelection = {
      workspaces: [
        {
          id: 'workspace-alpha',
          name: 'Alpha',
          isDefault: true,
          position: 0,
          projectCount: 1,
          deviceGrantCount: 0,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
        {
          id: 'workspace-archive',
          name: 'Archive',
          isDefault: false,
          position: 1,
          projectCount: 1,
          deviceGrantCount: 0,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      selectedWorkspaceId: 'workspace-alpha',
    };
  });

  afterEach(() => {
    mockProjectSelection = {};
    jest.clearAllMocks();
  });

  it('selects a workspace while preserving the current route', async () => {
    const user = userEvent.setup();
    renderLayout('/board');

    await user.click(screen.getByRole('button', { name: 'Switch to workspace Archive' }));

    expect(mockSetSelectedWorkspaceId).toHaveBeenCalledWith('workspace-archive');
    expect(screen.getByRole('link', { name: /board/i })).toHaveAttribute('aria-current', 'page');
  });
});

describe('Layout keyboard shortcut g n', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('navigates to /cloud?section=notifications on g then n keystrokes', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    }) as jest.Mock;

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/projects']}>
          <Layout>
            <div data-testid="page">page content</div>
          </Layout>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('page')).toBeInTheDocument();
    });

    // Fire 'g' then 'n' on the document
    fireEvent.keyDown(document, { key: 'g', code: 'KeyG' });
    fireEvent.keyDown(document, { key: 'n', code: 'KeyN' });

    // After g+n the navigation link to /cloud?section=notifications should exist in sidebar
    await waitFor(() => {
      const notificationsLink = screen.getByRole('link', { name: /notifications/i });
      expect(notificationsLink).toHaveAttribute('href', '/cloud?section=notifications');
    });
  });
});
