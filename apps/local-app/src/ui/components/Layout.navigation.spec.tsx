import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { Layout } from './Layout';
import { RuntimeProvider } from '../hooks/useRuntime';
import userEvent from '@testing-library/user-event';
// Layer: UI component unit. Mocking project selection and the activity hook is the cheapest
// reliable proof that Layout owns the wiring without duplicating the hook's event matrix.
const useSelectedProjectMock = jest.fn();
const mockUseProjectActivityReporter = jest.fn();
let cloudUiEnabled = false;

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

describe('Board navigation', () => {
  async function renderLayoutAt(initialEntry: string) {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    const result = render(
      <QueryClientProvider client={queryClient}>
        <RuntimeProvider>
          <MemoryRouter initialEntries={[initialEntry]}>
            <Layout>
              <div>Layout Test Content</div>
            </Layout>
          </MemoryRouter>
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

    it.each([
      { label: 'marks the Board item active on the native board route', path: '/board' },
      {
        label: 'marks the Board item active on a provider work-area route',
        path: '/board/clickup/space-901',
      },
      { label: 'keeps the Board item active on epic detail routes', path: '/epics/epic-1' },
    ] as const)('$label', async ({ path }) => {
      await renderLayoutAt(path);

      expect(boardLink()).toHaveAttribute('aria-current', 'page');
    });

    it.each(['/board/clickup'])(
      'marks the Board item active on the %s provider route',
      async (path) => {
        await renderLayoutAt(path);

        expect(boardLink()).toHaveAttribute('aria-current', 'page');
      },
    );

    it('leaves the Board item inactive outside board routes', async () => {
      await renderLayoutAt('/projects');

      expect(boardLink()).not.toHaveAttribute('aria-current');
    });
  });
});
function LocationProbe() {
  const location = useLocation();
  return <div data-testid="current-location">{`${location.pathname}${location.search}`}</div>;
}

async function renderLayout(initialEntries: string[] = ['/projects']) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  const result = render(
    <QueryClientProvider client={queryClient}>
      <RuntimeProvider>
        <MemoryRouter initialEntries={initialEntries}>
          <Layout>
            <div>Layout Test Content</div>
            <LocationProbe />
          </Layout>
        </MemoryRouter>
      </RuntimeProvider>
    </QueryClientProvider>,
  );

  await act(async () => {
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
    }
  });

  // Expand the System collapsible section so Cloud/Settings links render
  const systemToggle = screen.queryByRole('button', { name: /system/i });
  if (systemToggle) {
    await userEvent.click(systemToggle);
  }

  return result;
}

describe('Cloud sidebar navigation', () => {
  beforeEach(() => {
    cloudUiEnabled = false;
    mockUseProjectActivityReporter.mockClear();
    useSelectedProjectMock.mockReturnValue({
      projects: [{ id: 'project-1', name: 'Project One', rootPath: '/tmp/project-one' }],
      projectsLoading: false,
      projectsError: false,
      refetchProjects: jest.fn(),
      selectedProjectId: 'project-1',
      selectedProject: { id: 'project-1', name: 'Project One', rootPath: '/tmp/project-one' },
      setSelectedProjectId: jest.fn(),
    });

    // Override default fetch mock with Layout-aware responses
    (global.fetch as jest.Mock).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/preflight')) {
        return {
          ok: true,
          json: async () => ({
            overall: 'pass',
            checks: [],
            providers: [],
            supportedMcpProviders: [],
          }),
        } as Response;
      }
      if (url === '/health') {
        return { ok: true, json: async () => ({ version: '1.0.0' }) } as Response;
      }
      if (url === '/api/runtime') {
        return {
          ok: true,
          json: async () => ({
            mode: 'normal',
            version: '1.0.0',
            dockerAvailable: false,
            features: { cloudUi: cloudUiEnabled },
          }),
        } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    });
  });

  afterEach(() => {
    cloudUiEnabled = false;
    cleanup();
  });

  it('hides Cloud and Notifications nav items when cloud UI is disabled', async () => {
    await renderLayout();
    expect(screen.queryByRole('link', { name: 'Cloud' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Notifications' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Settings' })).toBeInTheDocument();
  });

  it('mounts the activity reporter with the effective selected project', async () => {
    await renderLayout();

    expect(mockUseProjectActivityReporter).toHaveBeenCalledWith('project-1');
  });

  it('shows Cloud and Notifications nav items when Cloud UI is enabled', async () => {
    cloudUiEnabled = true;

    await renderLayout();

    expect(await screen.findByRole('link', { name: 'Cloud' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Notifications' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Cloud' })).toHaveAttribute('href', '/cloud');
    expect(screen.getByRole('link', { name: 'Settings' })).toBeInTheDocument();
  });

  it.each([
    ['l', '/cloud'],
    ['n', '/cloud?section=notifications'],
  ])(
    'keyboard shortcut g %s navigates to %s when Cloud UI is enabled',
    async (key, destination) => {
      cloudUiEnabled = true;

      await renderLayout(['/projects']);

      fireEvent.keyDown(document, { key: 'g', code: 'KeyG' });
      fireEvent.keyDown(document, { key, code: key === 'l' ? 'KeyL' : 'KeyN' });

      expect(screen.getByTestId('current-location').textContent).toBe(destination);
    },
  );

  it('keyboard shortcut g l is ignored when Cloud UI is disabled', async () => {
    await renderLayout(['/projects']);

    await userEvent.keyboard('g');
    await userEvent.keyboard('l');

    expect(screen.getByTestId('current-location')).toHaveTextContent('/projects');
  });
});
