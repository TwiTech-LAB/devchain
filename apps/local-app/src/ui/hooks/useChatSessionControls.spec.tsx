import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import {
  useChatSessionControls,
  type UseChatSessionControlsOptions,
} from './useChatSessionControls';

// ============================================
// Mocks
// ============================================

const mockToast = jest.fn();
jest.mock('@/ui/hooks/use-toast', () => ({
  useToast: () => ({ toast: mockToast }),
}));

jest.mock('@/ui/lib/sessions', () => {
  const actual = jest.requireActual('@/ui/lib/sessions');
  return {
    ...actual,
    launchSession: jest.fn(),
    restartSession: jest.fn(),
    terminateSession: jest.fn().mockResolvedValue(undefined),
    restoreSession: jest.fn(),
  };
});

import { launchSession, restartSession, restoreSession, SessionApiError } from '@/ui/lib/sessions';

const mockLaunch = launchSession as jest.MockedFunction<typeof launchSession>;
const mockRestart = restartSession as jest.MockedFunction<typeof restartSession>;
const mockRestore = restoreSession as jest.MockedFunction<typeof restoreSession>;

// ============================================
// Helpers
// ============================================

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { wrapper, queryClient };
}

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sess-1',
    epicId: null,
    agentId: 'agent-1',
    tmuxSessionId: 'tmux-1',
    status: 'running' as const,
    startedAt: '2026-01-01T00:00:00Z',
    endedAt: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function buildOptions(
  overrides: Partial<UseChatSessionControlsOptions> = {},
): UseChatSessionControlsOptions {
  return {
    projectId: 'proj-1',
    selectedThreadId: 'thread-1',
    agentPresence: {
      'agent-1': { online: true, sessionId: 'sess-old' },
      'agent-2': { online: true, sessionId: 'sess-2-old' },
    },
    agents: [
      { id: 'agent-1', name: 'Agent One', type: 'agent' as const },
      { id: 'agent-2', name: 'Agent Two', type: 'agent' as const },
    ],
    presenceReady: true,
    ...overrides,
  };
}

// ============================================
// Tests
// ============================================

describe('useChatSessionControls', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('handleRestartSession predicate gating', () => {
    it('does NOT call onInlineTerminalAttach when canAttachInlineTerminal returns false', async () => {
      const onInlineTerminalAttach = jest.fn();
      const canAttachInlineTerminal = jest.fn().mockReturnValue(false);

      mockRestart.mockResolvedValue({
        session: makeSession({ id: 'new-sess', agentId: 'agent-2' }),
      });

      const { wrapper } = createWrapper();
      const { result } = renderHook(
        () =>
          useChatSessionControls(buildOptions({ canAttachInlineTerminal, onInlineTerminalAttach })),
        { wrapper },
      );

      await act(async () => {
        await result.current.handleRestartSession('agent-2');
      });

      expect(canAttachInlineTerminal).toHaveBeenCalledWith('agent-2');
      expect(onInlineTerminalAttach).not.toHaveBeenCalled();
    });

    it('calls onInlineTerminalAttach when canAttachInlineTerminal returns true', async () => {
      const onInlineTerminalAttach = jest.fn();
      const canAttachInlineTerminal = jest.fn().mockReturnValue(true);

      mockRestart.mockResolvedValue({
        session: makeSession({ id: 'new-sess', agentId: 'agent-1' }),
      });

      const { wrapper } = createWrapper();
      const { result } = renderHook(
        () =>
          useChatSessionControls(buildOptions({ canAttachInlineTerminal, onInlineTerminalAttach })),
        { wrapper },
      );

      await act(async () => {
        await result.current.handleRestartSession('agent-1');
      });

      expect(canAttachInlineTerminal).toHaveBeenCalledWith('agent-1');
      expect(onInlineTerminalAttach).toHaveBeenCalledWith('agent-1', 'new-sess');
    });
  });

  describe('handleLaunchSession predicate gating', () => {
    it('does NOT call onInlineTerminalAttach when canAttachInlineTerminal returns false', async () => {
      const onInlineTerminalAttach = jest.fn();
      const canAttachInlineTerminal = jest.fn().mockReturnValue(false);

      mockLaunch.mockResolvedValue(makeSession({ id: 'launched-sess', agentId: 'agent-2' }));

      const { wrapper } = createWrapper();
      const { result } = renderHook(
        () =>
          useChatSessionControls(buildOptions({ canAttachInlineTerminal, onInlineTerminalAttach })),
        { wrapper },
      );

      await act(async () => {
        await result.current.handleLaunchSession('agent-2', { attach: true });
      });

      expect(canAttachInlineTerminal).toHaveBeenCalledWith('agent-2');
      expect(onInlineTerminalAttach).not.toHaveBeenCalled();
    });

    it('calls onInlineTerminalAttach when canAttachInlineTerminal returns true', async () => {
      const onInlineTerminalAttach = jest.fn();
      const onTerminalMenuClose = jest.fn();
      const canAttachInlineTerminal = jest.fn().mockReturnValue(true);

      mockLaunch.mockResolvedValue(makeSession({ id: 'launched-sess', agentId: 'agent-1' }));

      const { wrapper } = createWrapper();
      const { result } = renderHook(
        () =>
          useChatSessionControls(
            buildOptions({
              canAttachInlineTerminal,
              onInlineTerminalAttach,
              onTerminalMenuClose,
            }),
          ),
        { wrapper },
      );

      await act(async () => {
        await result.current.handleLaunchSession('agent-1', { attach: true });
      });

      expect(canAttachInlineTerminal).toHaveBeenCalledWith('agent-1');
      expect(onInlineTerminalAttach).toHaveBeenCalledWith('agent-1', 'launched-sess');
      expect(onTerminalMenuClose).toHaveBeenCalled();
    });
  });

  describe('MCP modal deferred launch race coverage', () => {
    it('does NOT attach when thread changes between MCP modal open and configured', async () => {
      const onInlineTerminalAttach = jest.fn();
      let predicateResult = true;
      const canAttachInlineTerminal = jest.fn().mockImplementation(() => predicateResult);

      mockLaunch
        .mockRejectedValueOnce(
          new SessionApiError('MCP not configured', 400, {
            statusCode: 400,
            code: 'MCP_NOT_CONFIGURED',
            message: 'MCP not configured',
            details: {
              code: 'MCP_NOT_CONFIGURED',
              providerId: 'prov-1',
              providerName: 'TestProvider',
            },
            timestamp: new Date().toISOString(),
            path: '/api/sessions',
          }),
        )
        .mockResolvedValueOnce(makeSession({ id: 'deferred-sess', agentId: 'agent-2' }));

      const { wrapper } = createWrapper();
      const { result } = renderHook(
        () =>
          useChatSessionControls(buildOptions({ canAttachInlineTerminal, onInlineTerminalAttach })),
        { wrapper },
      );

      await act(async () => {
        await result.current.handleLaunchSession('agent-2', { attach: true });
      });

      expect(result.current.mcpModalOpen).toBe(true);
      expect(onInlineTerminalAttach).not.toHaveBeenCalled();

      predicateResult = false;

      await act(async () => {
        await result.current.handleMcpConfigured();
      });

      expect(onInlineTerminalAttach).not.toHaveBeenCalled();
    });

    it('attaches when thread stays the same between MCP modal open and configured', async () => {
      const onInlineTerminalAttach = jest.fn();
      const canAttachInlineTerminal = jest.fn().mockReturnValue(true);

      mockLaunch
        .mockRejectedValueOnce(
          new SessionApiError('MCP not configured', 400, {
            statusCode: 400,
            code: 'MCP_NOT_CONFIGURED',
            message: 'MCP not configured',
            details: {
              code: 'MCP_NOT_CONFIGURED',
              providerId: 'prov-1',
              providerName: 'TestProvider',
            },
            timestamp: new Date().toISOString(),
            path: '/api/sessions',
          }),
        )
        .mockResolvedValueOnce(makeSession({ id: 'deferred-sess', agentId: 'agent-2' }));

      const { wrapper } = createWrapper();
      const { result } = renderHook(
        () =>
          useChatSessionControls(buildOptions({ canAttachInlineTerminal, onInlineTerminalAttach })),
        { wrapper },
      );

      await act(async () => {
        await result.current.handleLaunchSession('agent-2', { attach: true });
      });

      expect(result.current.mcpModalOpen).toBe(true);

      await act(async () => {
        await result.current.handleMcpConfigured();
      });

      expect(onInlineTerminalAttach).toHaveBeenCalledWith('agent-2', 'deferred-sess');
    });
  });

  describe('handleRestoreSession', () => {
    const sessionId = 'stopped-sess-1';
    const agentId = 'agent-1';

    it('calls restoreSession with sessionId and projectId', async () => {
      mockRestore.mockResolvedValue(makeSession({ id: sessionId, agentId }));

      const { wrapper } = createWrapper();
      const { result } = renderHook(() => useChatSessionControls(buildOptions()), { wrapper });

      await act(async () => {
        await result.current.handleRestoreSession(sessionId, agentId);
      });

      expect(mockRestore).toHaveBeenCalledWith(sessionId, 'proj-1');
    });

    it('shows success toast after restore', async () => {
      mockRestore.mockResolvedValue(makeSession({ id: sessionId, agentId }));

      const { wrapper } = createWrapper();
      const { result } = renderHook(() => useChatSessionControls(buildOptions()), { wrapper });

      await act(async () => {
        await result.current.handleRestoreSession(sessionId, agentId);
      });

      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Session restored' }),
      );
    });

    it('calls onInlineTerminalAttach when canAttachInlineTerminal returns true', async () => {
      const onInlineTerminalAttach = jest.fn();
      const canAttachInlineTerminal = jest.fn().mockReturnValue(true);
      const restoredSess = makeSession({ id: sessionId, agentId });
      mockRestore.mockResolvedValue(restoredSess);

      const { wrapper } = createWrapper();
      const { result } = renderHook(
        () =>
          useChatSessionControls(buildOptions({ canAttachInlineTerminal, onInlineTerminalAttach })),
        { wrapper },
      );

      await act(async () => {
        await result.current.handleRestoreSession(sessionId, agentId);
      });

      expect(canAttachInlineTerminal).toHaveBeenCalledWith(agentId);
      expect(onInlineTerminalAttach).toHaveBeenCalledWith(agentId, sessionId);
    });

    it('does NOT call onInlineTerminalAttach when canAttachInlineTerminal returns false', async () => {
      const onInlineTerminalAttach = jest.fn();
      const canAttachInlineTerminal = jest.fn().mockReturnValue(false);
      mockRestore.mockResolvedValue(makeSession({ id: sessionId, agentId }));

      const { wrapper } = createWrapper();
      const { result } = renderHook(
        () =>
          useChatSessionControls(buildOptions({ canAttachInlineTerminal, onInlineTerminalAttach })),
        { wrapper },
      );

      await act(async () => {
        await result.current.handleRestoreSession(sessionId, agentId);
      });

      expect(onInlineTerminalAttach).not.toHaveBeenCalled();
    });

    it('shows PROVIDER_MISMATCH toast with specific title on 409', async () => {
      mockRestore.mockRejectedValue(
        new SessionApiError('Current provider differs from launch-time provider', 409, {
          statusCode: 409,
          code: 'http_exception',
          message: 'Current provider differs from launch-time provider',
          details: {
            message: 'Current provider differs from launch-time provider',
            code: 'PROVIDER_MISMATCH',
          },
          timestamp: new Date().toISOString(),
          path: '/api/sessions/x/restore',
        }),
      );

      const { wrapper } = createWrapper();
      const { result } = renderHook(() => useChatSessionControls(buildOptions()), { wrapper });

      await act(async () => {
        await result.current.handleRestoreSession(sessionId, agentId);
      });

      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Provider mismatch', variant: 'destructive' }),
      );
    });

    it('shows NO_PROVIDER_SESSION_ID toast with specific title on 409', async () => {
      mockRestore.mockRejectedValue(
        new SessionApiError('Session has no provider session ID', 409, {
          statusCode: 409,
          code: 'http_exception',
          message: 'Session has no provider session ID',
          details: {
            message: 'Session has no provider session ID',
            code: 'NO_PROVIDER_SESSION_ID',
          },
          timestamp: new Date().toISOString(),
          path: '/api/sessions/x/restore',
        }),
      );

      const { wrapper } = createWrapper();
      const { result } = renderHook(() => useChatSessionControls(buildOptions()), { wrapper });

      await act(async () => {
        await result.current.handleRestoreSession(sessionId, agentId);
      });

      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Cannot restore', variant: 'destructive' }),
      );
    });

    it('clears restoringSessionIds after restore completes', async () => {
      mockRestore.mockResolvedValue(makeSession({ id: sessionId, agentId }));

      const { wrapper } = createWrapper();
      const { result } = renderHook(() => useChatSessionControls(buildOptions()), { wrapper });

      await act(async () => {
        await result.current.handleRestoreSession(sessionId, agentId);
      });

      // After completion, the id should be cleared from the map
      expect(result.current.restoringSessionIds[sessionId]).toBeUndefined();
    });
  });
});
