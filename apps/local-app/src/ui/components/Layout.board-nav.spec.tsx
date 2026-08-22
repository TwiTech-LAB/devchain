import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Layout } from './Layout';
import { RuntimeProvider } from '../hooks/useRuntime';
import { WorktreeTabProvider } from '../hooks/useWorktreeTab';

// Layer: UI component unit. Mocking project selection and the activity hook is the cheapest
// reliable proof that Layout owns the Board active-state wiring without re-testing those hooks.
const useSelectedProjectMock = jest.fn();
const mockUseProjectActivityReporter = jest.fn();

jest.mock('../hooks/useProjectSelection', () => ({
  useSelectedProject: () => useSelectedProjectMock(),
}));

jest.mock('../hooks/useProjectActivityReporter', () => ({
  useProjectActivityReporter: (projectId: string | null | undefined) =>
    mockUseProjectActivityReporter(projectId),
}));

jest.mock('../hooks/use-toast', () => ({
  useToast: () => ({ toast: jest.fn(), toasts: [], dismiss: jest.fn() }),
}));

jest.mock('../hooks/useBreadcrumbs', () => ({
  BreadcrumbsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useBreadcrumbs: () => ({ items: [] }),
}));

jest.mock('./shared', () => ({
  Breadcrumbs: () => null,
  ToastHost: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  EpicSearchInput: () => null,
}));

jest.mock('../hooks/useAppSocket', () => ({
  useAppSocket: () => ({}) as never,
}));

jest.mock('../terminal-windows', () => ({
  TerminalWindowsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TerminalWindowsLayer: () => <div data-testid="terminal-layer" />,
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
  TerminalDock: () => <div data-testid="terminal-dock" />,
  OPEN_TERMINAL_DOCK_EVENT: 'devchain:terminal-dock:open',
}));

jest.mock('./cloud/CloudStatusIndicator', () => ({
  CloudStatusIndicator: () => null,
}));

jest.mock('./shared/AutoCompactEnableModal', () => ({
  AutoCompactEnableModal: () => null,
}));

jest.mock('../pages/ReviewsPage.lazy', () => ({
  preloadReviewsPage: jest.fn(),
}));

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: jest.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: jest.fn(),
    removeListener: jest.fn(),
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    dispatchEvent: jest.fn(),
  })),
});

async function renderLayoutAt(initialEntry: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  const result = render(
    <QueryClientProvider client={queryClient}>
      <RuntimeProvider>
        <WorktreeTabProvider>
          <MemoryRouter initialEntries={[initialEntry]}>
            <Layout>
              <div>Layout Test Content</div>
            </Layout>
          </MemoryRouter>
        </WorktreeTabProvider>
      </RuntimeProvider>
    </QueryClientProvider>,
  );

  await act(async () => {
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
    }
  });

  return result;
}

function boardLink(): HTMLElement {
  return screen.getByRole('link', { name: 'Board' });
}

describe('Board sidebar active state', () => {
  beforeEach(() => {
    useSelectedProjectMock.mockReturnValue({
      projects: [{ id: 'project-1', name: 'Project One', rootPath: '/tmp/project-one' }],
      projectsLoading: false,
      projectsError: false,
      refetchProjects: jest.fn(),
      selectedProjectId: 'project-1',
      selectedProject: { id: 'project-1', name: 'Project One', rootPath: '/tmp/project-one' },
      setSelectedProjectId: jest.fn(),
    });

    global.fetch = jest.fn(async () => {
      return { ok: true, json: async () => ({}) } as Response;
    }) as jest.Mock;
  });

  afterEach(() => {
    cleanup();
  });

  it('marks the Board item active on the native board route', async () => {
    await renderLayoutAt('/board');

    expect(boardLink()).toHaveAttribute('aria-current', 'page');
  });

  it.each(['/board/clickup', '/board/jira'])(
    'marks the Board item active on the %s provider route',
    async (path) => {
      await renderLayoutAt(path);

      expect(boardLink()).toHaveAttribute('aria-current', 'page');
    },
  );

  it('marks the Board item active on a provider work-area route', async () => {
    await renderLayoutAt('/board/clickup/space-901');

    expect(boardLink()).toHaveAttribute('aria-current', 'page');
  });

  it('keeps the Board item active on epic detail routes', async () => {
    await renderLayoutAt('/epics/epic-1');

    expect(boardLink()).toHaveAttribute('aria-current', 'page');
  });

  it('leaves the Board item inactive outside board routes', async () => {
    await renderLayoutAt('/projects');

    expect(boardLink()).not.toHaveAttribute('aria-current');
  });
});
