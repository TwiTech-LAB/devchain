import React from 'react';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mockSetSelectedWorkspaceId = jest.fn();
let mockProjectSelection: Record<string, unknown> = {};
let mockTerminalWindows: Array<{ id: string; sessionId: string }> = [];
const mockCloseWindow = jest.fn();
let mockDockProps: { onSessionsChange: (sessions: unknown[]) => void } | undefined;

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
    windows: mockTerminalWindows,
    closeWindow: mockCloseWindow,
    focusedWindowId: null,
    focusWindow: jest.fn(),
    minimizeWindow: jest.fn(),
    restoreWindow: jest.fn(),
  }),
}));

jest.mock('./terminal-dock', () => ({
  TerminalDock: (props: NonNullable<typeof mockDockProps>) => {
    mockDockProps = props;
    return null;
  },
  OPEN_TERMINAL_DOCK_EVENT: 'devchain:terminal-dock:open',
  TERMINAL_SESSIONS_QUERY_KEY: ['terminal-dock', 'sessions'],
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
  useRuntimeSync: jest.fn(),
  useRuntime: () => ({ cloudUiEnabled: true }),
}));

import { Layout } from './Layout';
import { holdRollback } from '../lib/rollback-holds';

// The agent-request modal has its own spec; these suites mock fetch with other shapes.
jest.mock('@/ui/pages/vault/VaultRequestModal', () => ({ VaultRequestModal: () => null }));

function renderLayout(initialPath: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({}),
  }) as jest.Mock;

  const tree = () => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Layout>
          <div>page content</div>
        </Layout>
      </MemoryRouter>
    </QueryClientProvider>
  );
  const view = render(tree());
  return { ...view, rerenderLayout: () => view.rerender(tree()) };
}

describe('Layout nav-item active state', () => {
  beforeEach(() => {
    mockProjectSelection = {};
    mockSetSelectedWorkspaceId.mockReset();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it.each([
    { route: '/cloud?section=notifications', active: true },
    { route: '/cloud?section=account', active: false },
  ] as const)('Notifications active=$active on $route', async ({ route, active }) => {
    renderLayout(route);
    await waitFor(() =>
      expect(
        screen.getByRole('link', { name: /notifications/i }).getAttribute('aria-current') ===
          'page',
      ).toBe(active),
    );
  });

  it.each([
    { route: '/cloud?section=notifications', active: false },
    { route: '/cloud', active: true },
  ] as const)('Cloud active=$active on $route', async ({ route, active }) => {
    renderLayout(route);
    fireEvent.click(screen.getByRole('button', { name: /^system/i }));
    await waitFor(() => {
      const link = screen.getAllByRole('link').find((el) => el.getAttribute('title') === 'Cloud');
      expect(link).toBeDefined();
      expect(link?.getAttribute('aria-current') === 'page').toBe(active);
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

// The dock stub hands Layout its lists; the collapsed-dock case gets the last list from Layout itself.
describe('Layout floating windows during a rollback', () => {
  afterEach(() => {
    mockProjectSelection = {};
    mockTerminalWindows = [];
    mockDockProps = undefined;
    jest.clearAllMocks();
  });

  it.each([
    { outcome: 'succeeds', running: ['rolled-back'], closed: false },
    { outcome: 'fails', running: [], closed: true },
    { outcome: 'fails after the user left the project', running: [], closed: false, leave: true },
  ])(
    'keeps the window of a session open during its rollback and applies a fresh list when it $outcome',
    async ({ running, closed, leave }) => {
      mockProjectSelection = { selectedProjectId: 'project-a' };
      mockTerminalWindows = [
        { id: 'rolled-back-window', sessionId: 'rolled-back' },
        { id: 'other-window', sessionId: 'other' },
      ];
      const { rerenderLayout } = renderLayout('/chat');
      let respond!: () => void;
      const sessionsFetch = jest.fn(
        () =>
          new Promise((resolve) => {
            respond = () =>
              resolve({
                ok: true,
                json: async () => running.map((id) => ({ id, status: 'running' })),
              });
          }),
      );
      global.fetch = jest.fn(async (input: RequestInfo | URL) =>
        /\/api\/sessions\?projectId=project-a$/.test(String(input))
          ? sessionsFetch()
          : { ok: true, json: async () => ({}) },
      ) as jest.Mock;
      const otherCloses = () => mockCloseWindow.mock.calls.filter(([id]) => id === 'other-window');
      const release = holdRollback('rolled-back');

      // A poll while the server copies the save point: the row is stopped.
      act(() => mockDockProps!.onSessionsChange([]));
      expect(otherCloses()).toHaveLength(1);
      expect(mockCloseWindow).not.toHaveBeenCalledWith('rolled-back-window');

      act(() => release());
      await waitFor(() => expect(sessionsFetch).toHaveBeenCalledTimes(1));
      // The dock sends its cached list from the stopped state again before the fresh list.
      act(() => mockDockProps!.onSessionsChange([]));
      expect(otherCloses()).toHaveLength(2);
      expect(mockCloseWindow).not.toHaveBeenCalledWith('rolled-back-window');

      if (leave) {
        mockProjectSelection = { selectedProjectId: 'project-b' };
        rerenderLayout();
      }
      await act(async () => respond());
      // The fresh list also lacks the other session, so a third close marks it as applied.
      if (leave) {
        await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
        expect(otherCloses()).toHaveLength(2);
      } else {
        await waitFor(() => expect(otherCloses()).toHaveLength(3));
      }
      expect(mockCloseWindow.mock.calls.some(([id]) => id === 'rolled-back-window')).toBe(closed);
    },
  );
});
