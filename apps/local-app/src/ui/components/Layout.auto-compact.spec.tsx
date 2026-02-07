import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Layout } from './Layout';
import type { WsEnvelope } from '../lib/socket';

const toastSpy = jest.fn();
const useSelectedProjectMock = jest.fn();
let wsMessageHandler: ((envelope: WsEnvelope) => void) | null = null;

jest.mock('../hooks/useProjectSelection', () => ({
  useSelectedProject: () => useSelectedProjectMock(),
}));

jest.mock('../hooks/use-toast', () => ({
  useToast: () => ({ toast: toastSpy, toasts: [], dismiss: jest.fn() }),
}));

jest.mock('../hooks/useBreadcrumbs', () => ({
  BreadcrumbsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useBreadcrumbs: () => ({ items: [] }),
}));

jest.mock('./shared', () => {
  const { AutoCompactWarningModal } = jest.requireActual('./shared/AutoCompactWarningModal');
  return {
    AutoCompactWarningModal,
    Breadcrumbs: () => null,
    ToastHost: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    EpicSearchInput: () => null,
  };
});

jest.mock('../hooks/useAppSocket', () => ({
  useAppSocket: (handlers: Record<string, (...args: unknown[]) => void>) => {
    wsMessageHandler =
      typeof handlers.message === 'function'
        ? (handlers.message as (envelope: WsEnvelope) => void)
        : null;
    return {} as never;
  },
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

jest.mock('../pages/ReviewsPage.lazy', () => ({
  preloadReviewsPage: jest.fn(),
}));

jest.mock('../lib/registry-updates', () => ({
  fetchCachedTemplates: jest.fn().mockResolvedValue([]),
  hasAnyTemplateUpdates: jest.fn().mockResolvedValue(false),
}));

(global as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

function renderLayout() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/projects']}>
        <Layout>
          <div>Layout Test Content</div>
        </Layout>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function emitSystemSessionBlocked(payload: Record<string, unknown>) {
  expect(wsMessageHandler).toBeTruthy();
  wsMessageHandler?.({
    topic: 'system',
    type: 'session_blocked',
    payload,
    ts: new Date().toISOString(),
  });

  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('Layout auto-compact global modal', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    toastSpy.mockReset();
    wsMessageHandler = null;
    useSelectedProjectMock.mockReturnValue({
      projects: [{ id: 'project-1', name: 'Project One', rootPath: '/tmp/project-one' }],
      projectsLoading: false,
      projectsError: false,
      refetchProjects: jest.fn(),
      selectedProjectId: 'project-1',
      selectedProject: { id: 'project-1', name: 'Project One', rootPath: '/tmp/project-one' },
      setSelectedProjectId: jest.fn(),
    });

    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('/api/preflight')) {
        return {
          ok: true,
          json: async () => ({
            overall: 'pass',
            checks: [],
            providers: [],
            supportedMcpProviders: [],
            timestamp: new Date().toISOString(),
          }),
        } as Response;
      }
      if (url === '/health') {
        return {
          ok: true,
          json: async () => ({ version: '1.0.0' }),
        } as Response;
      }
      if (url === '/api/providers/provider-1/auto-compact/disable' && init?.method === 'POST') {
        return {
          ok: true,
          text: async () => '',
          json: async () => ({}),
        } as Response;
      }
      return {
        ok: true,
        json: async () => ({}),
      } as Response;
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    if (originalFetch) {
      global.fetch = originalFetch;
    }
  });

  it('shows modal for non-silent claude_auto_compact blocks', async () => {
    renderLayout();

    await emitSystemSessionBlocked({
      reason: 'claude_auto_compact',
      agentName: 'Builder Agent',
      providerId: 'provider-1',
      providerName: 'claude',
      silent: false,
    });

    expect(screen.getByText('Claude Auto-Compact Detected')).toBeInTheDocument();
    expect(screen.getByText('Blocked session: Builder Agent')).toBeInTheDocument();
  });

  it('ignores silent claude_auto_compact blocks', async () => {
    renderLayout();

    await emitSystemSessionBlocked({
      reason: 'claude_auto_compact',
      agentName: 'Silent Agent',
      providerId: 'provider-1',
      providerName: 'claude',
      silent: true,
    });

    await waitFor(() => {
      expect(screen.queryByText('Claude Auto-Compact Detected')).not.toBeInTheDocument();
    });
  });

  it('deduplicates repeated ws events while modal is already open', async () => {
    renderLayout();

    await emitSystemSessionBlocked({
      reason: 'claude_auto_compact',
      agentName: 'First Agent',
      providerId: 'provider-1',
      providerName: 'claude',
      silent: false,
    });

    expect(screen.getByText('Blocked session: First Agent')).toBeInTheDocument();

    await emitSystemSessionBlocked({
      reason: 'claude_auto_compact',
      agentName: 'Second Agent',
      providerId: 'provider-2',
      providerName: 'claude',
      silent: false,
    });

    expect(screen.getByText('Blocked session: First Agent')).toBeInTheDocument();
    expect(screen.queryByText('Blocked session: Second Agent')).not.toBeInTheDocument();
  });

  it('disables auto-compact and shows success toast', async () => {
    const fetchMock = global.fetch as jest.Mock;
    renderLayout();

    await emitSystemSessionBlocked({
      reason: 'claude_auto_compact',
      agentName: 'Builder Agent',
      providerId: 'provider-1',
      providerName: 'claude',
      silent: false,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Disable & Continue' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/providers/provider-1/auto-compact/disable', {
        method: 'POST',
      });
    });

    await waitFor(() => {
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Auto-compact disabled',
          description: 'Sessions can now launch normally.',
        }),
      );
    });
  });
});
