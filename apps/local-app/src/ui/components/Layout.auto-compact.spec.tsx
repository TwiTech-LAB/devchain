import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Layout } from './Layout';
import { RuntimeProvider } from '../hooks/useRuntime';
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

jest.mock('./shared', () => ({
  Breadcrumbs: () => null,
  ToastHost: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  EpicSearchInput: () => null,
}));

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
  AutoCompactEnableModal: (props: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    providerId: string;
    providerName: string;
    onEnabled?: () => void;
    onSkipped?: () => void;
  }) =>
    props.open ? (
      <div
        data-testid="auto-compact-modal"
        data-provider-id={props.providerId}
        data-provider-name={props.providerName}
      >
        <button data-testid="modal-enable" onClick={props.onEnabled}>
          Enable &amp; Continue
        </button>
        <button data-testid="modal-skip" onClick={props.onSkipped}>
          Skip
        </button>
      </div>
    ) : null,
}));

jest.mock('../pages/ReviewsPage.lazy', () => ({
  preloadReviewsPage: jest.fn(),
}));

(global as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

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

if (!HTMLElement.prototype.hasPointerCapture) {
  HTMLElement.prototype.hasPointerCapture = () => false;
}
if (!HTMLElement.prototype.setPointerCapture) {
  HTMLElement.prototype.setPointerCapture = () => {};
}
if (!HTMLElement.prototype.releasePointerCapture) {
  HTMLElement.prototype.releasePointerCapture = () => {};
}
if (!HTMLElement.prototype.scrollIntoView) {
  HTMLElement.prototype.scrollIntoView = () => {};
}

async function renderLayout(initialEntries: string[] = ['/projects']) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  const result = render(
    <QueryClientProvider client={queryClient}>
      <RuntimeProvider>
        <MemoryRouter initialEntries={initialEntries}>
          <Layout>
            <div>Layout Test Content</div>
          </Layout>
        </MemoryRouter>
      </RuntimeProvider>
    </QueryClientProvider>,
  );

  // Drain RuntimeProvider's initial runtime fetch. The mocked fetch resolves via
  // microtasks; enough Promise.resolve() ticks let the runtime query settle.
  await act(async () => {
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
    }
  });

  return result;
}

async function emitSessionRecommendation(payload: Record<string, unknown>) {
  expect(wsMessageHandler).toBeTruthy();
  await act(async () => {
    wsMessageHandler?.({
      topic: 'system',
      type: 'session_recommendation',
      payload,
      ts: new Date().toISOString(),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('Layout auto-compact recommendation modal', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    window.history.replaceState({}, '', '/projects');
    toastSpy.mockReset();
    wsMessageHandler = null;
    localStorage.clear();
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
      if (url === '/api/runtime') {
        return {
          ok: true,
          json: async () => ({ version: '1.0.0' }),
        } as Response;
      }
      if (url === '/api/providers/provider-1/auto-compact/enable' && init?.method === 'POST') {
        return {
          ok: true,
          text: async () => '',
          json: async () => ({ success: true }),
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

  it('opens modal for non-silent auto-compact recommendation', async () => {
    await renderLayout();

    await emitSessionRecommendation({
      reason: 'claude_auto_compact_disabled',
      agentName: 'Builder Agent',
      providerId: 'provider-1',
      providerName: 'claude',
      silent: false,
      bootId: 'test-boot-id-123',
    });

    const modal = screen.getByTestId('auto-compact-modal');
    expect(modal).toBeInTheDocument();
    expect(modal).toHaveAttribute('data-provider-id', 'provider-1');
    expect(modal).toHaveAttribute('data-provider-name', 'claude');
  });

  it('does not open modal for silent auto-compact recommendations', async () => {
    await renderLayout();

    await emitSessionRecommendation({
      reason: 'claude_auto_compact_disabled',
      agentName: 'Silent Agent',
      providerId: 'provider-1',
      providerName: 'claude',
      silent: true,
      bootId: 'test-boot-id-123',
    });

    expect(screen.queryByTestId('auto-compact-modal')).not.toBeInTheDocument();
  });

  it('does not open modal when localStorage bootId matches current bootId', async () => {
    localStorage.setItem('devchain:autoCompact:recommended:provider-1', 'test-boot-id-123');
    await renderLayout();

    await emitSessionRecommendation({
      reason: 'claude_auto_compact_disabled',
      agentName: 'Builder Agent',
      providerId: 'provider-1',
      providerName: 'claude',
      silent: false,
      bootId: 'test-boot-id-123',
    });

    expect(screen.queryByTestId('auto-compact-modal')).not.toBeInTheDocument();
  });

  it('writes localStorage and shows success toast when Enable is clicked', async () => {
    await renderLayout();

    await emitSessionRecommendation({
      reason: 'claude_auto_compact_disabled',
      agentName: 'Builder Agent',
      providerId: 'provider-1',
      providerName: 'claude',
      silent: false,
      bootId: 'test-boot-id-123',
    });

    expect(screen.getByTestId('auto-compact-modal')).toBeInTheDocument();

    await act(async () => {
      screen.getByTestId('modal-enable').click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(localStorage.getItem('devchain:autoCompact:recommended:provider-1')).toBe(
      'test-boot-id-123',
    );
    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Auto-compact enabled' }),
    );
    expect(screen.queryByTestId('auto-compact-modal')).not.toBeInTheDocument();
  });

  it('writes localStorage and closes modal when Skip is clicked', async () => {
    await renderLayout();

    await emitSessionRecommendation({
      reason: 'claude_auto_compact_disabled',
      agentName: 'Builder Agent',
      providerId: 'provider-1',
      providerName: 'claude',
      silent: false,
      bootId: 'test-boot-id-123',
    });

    expect(screen.getByTestId('auto-compact-modal')).toBeInTheDocument();

    await act(async () => {
      screen.getByTestId('modal-skip').click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(localStorage.getItem('devchain:autoCompact:recommended:provider-1')).toBe(
      'test-boot-id-123',
    );
    expect(screen.queryByTestId('auto-compact-modal')).not.toBeInTheDocument();
    // No success toast for skip
    expect(toastSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Auto-compact enabled' }),
    );
  });

  it('does not reopen modal for same provider after Skip (same bootId)', async () => {
    await renderLayout();

    await emitSessionRecommendation({
      reason: 'claude_auto_compact_disabled',
      agentName: 'First Agent',
      providerId: 'provider-1',
      providerName: 'claude',
      silent: false,
      bootId: 'test-boot-id-123',
    });

    await act(async () => {
      screen.getByTestId('modal-skip').click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(screen.queryByTestId('auto-compact-modal')).not.toBeInTheDocument();

    // Second recommendation for same provider with same bootId — blocked by localStorage
    await emitSessionRecommendation({
      reason: 'claude_auto_compact_disabled',
      agentName: 'Second Agent',
      providerId: 'provider-1',
      providerName: 'claude',
      silent: false,
      bootId: 'test-boot-id-123',
    });

    expect(screen.queryByTestId('auto-compact-modal')).not.toBeInTheDocument();
  });

  it('reopens modal when bootId changes (simulating server restart)', async () => {
    // Previous boot dismissed with old bootId
    localStorage.setItem('devchain:autoCompact:recommended:provider-1', 'old-boot-id-999');
    await renderLayout();

    // New server boot sends a different bootId
    await emitSessionRecommendation({
      reason: 'claude_auto_compact_disabled',
      agentName: 'Builder Agent',
      providerId: 'provider-1',
      providerName: 'claude',
      silent: false,
      bootId: 'new-boot-id-456',
    });

    // Modal should appear because bootId changed
    expect(screen.getByTestId('auto-compact-modal')).toBeInTheDocument();
  });

  it('falls back to any-truthy suppression when bootId is absent from payload', async () => {
    localStorage.setItem('devchain:autoCompact:recommended:provider-1', 'true');
    await renderLayout();

    // Payload without bootId (backward compat with old server)
    await emitSessionRecommendation({
      reason: 'claude_auto_compact_disabled',
      agentName: 'Builder Agent',
      providerId: 'provider-1',
      providerName: 'claude',
      silent: false,
    });

    // Modal should be suppressed (fallback: any truthy value in localStorage)
    expect(screen.queryByTestId('auto-compact-modal')).not.toBeInTheDocument();
  });

  it('stores "true" when payload lacks bootId and user dismisses', async () => {
    await renderLayout();

    // Payload without bootId
    await emitSessionRecommendation({
      reason: 'claude_auto_compact_disabled',
      agentName: 'Builder Agent',
      providerId: 'provider-1',
      providerName: 'claude',
      silent: false,
    });

    expect(screen.getByTestId('auto-compact-modal')).toBeInTheDocument();

    await act(async () => {
      screen.getByTestId('modal-skip').click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // Falls back to 'true' when no bootId
    expect(localStorage.getItem('devchain:autoCompact:recommended:provider-1')).toBe('true');
  });
});
