import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import {
  useChatSessionControls,
  type UseChatSessionControlsOptions,
} from './useChatSessionControls';
import { chatQueryKeys } from './useChatQueries';

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

import {
  launchSession,
  restartSession,
  restoreSession,
  terminateSession,
  SessionApiError,
} from '@/ui/lib/sessions';

const mockLaunch = launchSession as jest.MockedFunction<typeof launchSession>;
const mockRestart = restartSession as jest.MockedFunction<typeof restartSession>;
const mockRestore = restoreSession as jest.MockedFunction<typeof restoreSession>;
const mockTerminate = terminateSession as jest.MockedFunction<typeof terminateSession>;

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
    selectedAgentId: 'agent-1',
    agentPresence: {
      'agent-1': { online: true, sessionId: 'sess-old' },
      'agent-2': { online: true, sessionId: 'sess-2-old' },
    },
    agents: [
      {
        profileId: null,
        modelOverride: null,
        effortOverride: null,
        id: 'agent-1',
        name: 'Agent One',
        isProjectOwner: false,
        type: 'agent' as const,
      },
      {
        profileId: null,
        modelOverride: null,
        effortOverride: null,
        id: 'agent-2',
        name: 'Agent Two',
        isProjectOwner: false,
        type: 'agent' as const,
      },
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

  describe('handleRestartSession selected-agent gating', () => {
    it('does NOT attach a restarted session for an unselected agent', async () => {
      const onInlineTerminalAttach = jest.fn();

      mockRestart.mockResolvedValue({
        session: makeSession({ id: 'new-sess', agentId: 'agent-2' }),
      });

      const { wrapper } = createWrapper();
      const { result } = renderHook(
        () => useChatSessionControls(buildOptions({ onInlineTerminalAttach })),
        { wrapper },
      );

      await act(async () => {
        await result.current.handleRestartSession('agent-2');
      });

      expect(onInlineTerminalAttach).not.toHaveBeenCalled();
    });

    it('attaches a restarted session for the selected agent', async () => {
      const onInlineTerminalAttach = jest.fn();

      mockRestart.mockResolvedValue({
        session: makeSession({ id: 'new-sess', agentId: 'agent-1' }),
      });

      const { wrapper } = createWrapper();
      const { result } = renderHook(
        () => useChatSessionControls(buildOptions({ onInlineTerminalAttach })),
        { wrapper },
      );

      await act(async () => {
        await result.current.handleRestartSession('agent-1');
      });

      expect(onInlineTerminalAttach).toHaveBeenCalledWith('agent-1', 'new-sess');
    });
  });

  describe('handleLaunchSession selected-agent gating', () => {
    it('does NOT attach a launched session for an unselected agent', async () => {
      const onInlineTerminalAttach = jest.fn();

      mockLaunch.mockResolvedValue(makeSession({ id: 'launched-sess', agentId: 'agent-2' }));

      const { wrapper } = createWrapper();
      const { result } = renderHook(
        () => useChatSessionControls(buildOptions({ onInlineTerminalAttach })),
        { wrapper },
      );

      await act(async () => {
        await result.current.handleLaunchSession('agent-2', { attach: true });
      });

      expect(onInlineTerminalAttach).not.toHaveBeenCalled();
    });

    it('attaches a launched session for the selected agent', async () => {
      const onInlineTerminalAttach = jest.fn();
      const onTerminalMenuClose = jest.fn();

      mockLaunch.mockResolvedValue(makeSession({ id: 'launched-sess', agentId: 'agent-1' }));

      const { wrapper } = createWrapper();
      const { result } = renderHook(
        () =>
          useChatSessionControls(
            buildOptions({
              onInlineTerminalAttach,
              onTerminalMenuClose,
            }),
          ),
        { wrapper },
      );

      await act(async () => {
        await result.current.handleLaunchSession('agent-1', { attach: true });
      });

      expect(onInlineTerminalAttach).toHaveBeenCalledWith('agent-1', 'launched-sess');
      expect(onTerminalMenuClose).toHaveBeenCalled();
    });
  });

  describe('MCP modal deferred launch race coverage', () => {
    it('does NOT attach when agent selection changes while the MCP modal is open', async () => {
      const onInlineTerminalAttach = jest.fn();
      let selectedAgentId = 'agent-2';

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
      const { result, rerender } = renderHook(
        () => useChatSessionControls(buildOptions({ selectedAgentId, onInlineTerminalAttach })),
        { wrapper },
      );

      await act(async () => {
        await result.current.handleLaunchSession('agent-2', { attach: true });
      });

      expect(result.current.mcpModalOpen).toBe(true);
      expect(onInlineTerminalAttach).not.toHaveBeenCalled();

      selectedAgentId = 'agent-1';
      rerender();

      await act(async () => {
        await result.current.handleMcpConfigured();
      });

      expect(onInlineTerminalAttach).not.toHaveBeenCalled();
    });

    it('attaches when agent selection stays the same while the MCP modal is open', async () => {
      const onInlineTerminalAttach = jest.fn();

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
          useChatSessionControls(
            buildOptions({ selectedAgentId: 'agent-2', onInlineTerminalAttach }),
          ),
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

    it('restores the session, shows success and clears pending state', async () => {
      mockRestore.mockResolvedValue(makeSession({ id: sessionId, agentId }));
      const { wrapper } = createWrapper();
      const { result } = renderHook(() => useChatSessionControls(buildOptions()), { wrapper });
      await act(async () => {
        await result.current.handleRestoreSession(sessionId, agentId);
      });
      {
        expect(mockRestore).toHaveBeenCalledWith(sessionId, 'proj-1', expect.any(Function));
      }
      {
        expect(mockToast).toHaveBeenCalledWith(
          expect.objectContaining({ title: 'Session restored' }),
        );
      }
      {
        expect(result.current.restoringSessionIds[sessionId]).toBeUndefined();
      }
    });

    it('primes presence and active-session cache before attaching restored terminal', async () => {
      const onInlineTerminalAttach = jest.fn();
      const restoredSess = makeSession({ id: sessionId, agentId, tmuxSessionId: 'tmux-restored' });
      mockRestore.mockResolvedValue(restoredSess);

      const { wrapper, queryClient } = createWrapper();
      queryClient.setQueryData(chatQueryKeys.agentPresence('proj-1'), {
        [agentId]: { online: false, sessionId: undefined },
      });
      queryClient.setQueryData(chatQueryKeys.activeSessions('proj-1'), []);

      const attachOrder: string[] = [];
      onInlineTerminalAttach.mockImplementation(() => {
        const presence = queryClient.getQueryData(chatQueryKeys.agentPresence('proj-1'));
        const activeSessions = queryClient.getQueryData(chatQueryKeys.activeSessions('proj-1'));
        if (presence && activeSessions) {
          attachOrder.push('cache-primed');
        }
      });

      const { result } = renderHook(
        () =>
          useChatSessionControls(
            buildOptions({
              agentPresence: { [agentId]: { online: false, sessionId: undefined } },
              onInlineTerminalAttach,
            }),
          ),
        { wrapper },
      );

      await act(async () => {
        await result.current.handleRestoreSession(sessionId, agentId);
      });

      expect(queryClient.getQueryData(chatQueryKeys.agentPresence('proj-1'))).toMatchObject({
        [agentId]: { online: true, sessionId },
      });
      expect(queryClient.getQueryData(chatQueryKeys.activeSessions('proj-1'))).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: sessionId, agentId })]),
      );
      expect(attachOrder).toEqual(['cache-primed']);
      expect(onInlineTerminalAttach).toHaveBeenCalledWith(agentId, sessionId);
    });

    it('does NOT attach a restored session for an unselected agent', async () => {
      const onInlineTerminalAttach = jest.fn();
      mockRestore.mockResolvedValue(makeSession({ id: sessionId, agentId }));

      const { wrapper } = createWrapper();
      const { result } = renderHook(
        () =>
          useChatSessionControls(
            buildOptions({ selectedAgentId: 'agent-2', onInlineTerminalAttach }),
          ),
        { wrapper },
      );

      await act(async () => {
        await result.current.handleRestoreSession(sessionId, agentId);
      });

      expect(onInlineTerminalAttach).not.toHaveBeenCalled();
    });

    it.each([
      {
        label: 'shows PROVIDER_MISMATCH toast with specific title on 409',
        errorMessage: 'Current provider differs from launch-time provider',
        apiMessage: 'Current provider differs from launch-time provider',
        detailMessage: 'Current provider differs from launch-time provider',
        code: 'PROVIDER_MISMATCH',
        toastTitle: 'Provider mismatch',
      },
      {
        label: 'shows NO_PROVIDER_SESSION_ID toast with specific title on 409',
        errorMessage: 'Session has no provider session ID',
        apiMessage: 'Session has no provider session ID',
        detailMessage: 'Session has no provider session ID',
        code: 'NO_PROVIDER_SESSION_ID',
        toastTitle: 'Cannot restore',
      },
      {
        label: 'shows INVALID_SESSION_STATE toast with specific title on 409',
        errorMessage: 'Session is not in a restorable state',
        apiMessage: 'Session is not in a restorable state',
        detailMessage: 'Session is not in a restorable state',
        code: 'INVALID_SESSION_STATE',
        toastTitle: 'Invalid session state',
      },
    ] as const)('$label', async ({ errorMessage, apiMessage, detailMessage, code, toastTitle }) => {
      mockRestore.mockRejectedValue(
        new SessionApiError(errorMessage, 409, {
          statusCode: 409,
          code: 'http_exception',
          message: apiMessage,
          details: {
            message: detailMessage,
            code: code,
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
        expect.objectContaining({ title: toastTitle, variant: 'destructive' }),
      );
    });

    it('falls back to the default "Restore failed" title for non-409 errors', async () => {
      mockRestore.mockRejectedValue(new Error('network down'));

      const { wrapper } = createWrapper();
      const { result } = renderHook(() => useChatSessionControls(buildOptions()), { wrapper });

      await act(async () => {
        await result.current.handleRestoreSession(sessionId, agentId);
      });

      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Restore failed',
          description: 'network down',
          variant: 'destructive',
        }),
      );
    });
  });

  describe('handleTerminateSession (single)', () => {
    beforeEach(() => {
      mockTerminate.mockReset();
    });

    it('calls terminateSession and shows the chat success toast', async () => {
      mockTerminate.mockResolvedValue(undefined);

      const { wrapper } = createWrapper();
      const { result } = renderHook(() => useChatSessionControls(buildOptions()), { wrapper });

      await act(async () => {
        await result.current.handleTerminateSession('agent-1', 'sess-old');
      });

      expect(mockTerminate).toHaveBeenCalledWith('sess-old', expect.any(Function));
      expect(mockToast).toHaveBeenCalledWith({
        title: 'Session terminated',
        description: 'The session was terminated.',
      });
    });

    it('shows a destructive toast when terminate fails', async () => {
      mockTerminate.mockRejectedValue(new Error('cannot stop'));

      const { wrapper } = createWrapper();
      const { result } = renderHook(() => useChatSessionControls(buildOptions()), { wrapper });

      await act(async () => {
        await result.current.handleTerminateSession('agent-1', 'sess-old');
      });

      expect(mockToast).toHaveBeenCalledWith({
        title: 'Terminate failed',
        description: 'cannot stop',
        variant: 'destructive',
      });
    });
  });

  describe('handleStartAllAgents (batch)', () => {
    const offlinePresence = {
      'agent-1': { online: false, sessionId: undefined },
      'agent-2': { online: false, sessionId: undefined },
    };

    it('launches every offline agent and reports total success', async () => {
      mockLaunch.mockResolvedValue(makeSession());

      const { wrapper } = createWrapper();
      const { result } = renderHook(
        () => useChatSessionControls(buildOptions({ agentPresence: offlinePresence })),
        { wrapper },
      );

      await act(async () => {
        await result.current.handleStartAllAgents();
      });

      // Each offline agent launched silently, attach:false.
      expect(mockLaunch).toHaveBeenCalledTimes(2);
      expect(mockToast).toHaveBeenCalledWith({
        title: 'All agents started',
        description: '2 sessions launched successfully.',
      });
    });

    it('reports partial failure with a destructive toast', async () => {
      mockLaunch
        .mockResolvedValueOnce(makeSession())
        .mockRejectedValueOnce(new Error('launch blew up'));

      const { wrapper } = createWrapper();
      const { result } = renderHook(
        () => useChatSessionControls(buildOptions({ agentPresence: offlinePresence })),
        { wrapper },
      );

      await act(async () => {
        await result.current.handleStartAllAgents();
      });

      expect(mockToast).toHaveBeenCalledWith({
        title: 'Batch launch complete',
        description: '1 started, 1 failed.',
        variant: 'destructive',
      });
    });

    it('is a no-op when there are no offline agents', async () => {
      const { wrapper } = createWrapper();
      const { result } = renderHook(
        () =>
          useChatSessionControls(
            buildOptions({
              agentPresence: {
                'agent-1': { online: true, sessionId: 'a' },
                'agent-2': { online: true, sessionId: 'b' },
              },
            }),
          ),
        { wrapper },
      );

      await act(async () => {
        await result.current.handleStartAllAgents();
      });

      expect(mockLaunch).not.toHaveBeenCalled();
      expect(mockToast).not.toHaveBeenCalled();
    });
  });

  describe('handleTerminateAllAgents (batch)', () => {
    beforeEach(() => {
      mockTerminate.mockReset();
    });

    it('terminates every agent-with-session and reports total success', async () => {
      mockTerminate.mockResolvedValue(undefined);

      const { wrapper } = createWrapper();
      const { result } = renderHook(() => useChatSessionControls(buildOptions()), { wrapper });

      await act(async () => {
        await result.current.handleTerminateAllAgents();
      });

      expect(mockTerminate).toHaveBeenCalledTimes(2);
      expect(mockToast).toHaveBeenCalledWith({
        title: 'All sessions terminated',
        description: '2 sessions stopped.',
      });
    });

    it('reports partial failure with a destructive toast', async () => {
      mockTerminate.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('stuck'));

      const { wrapper } = createWrapper();
      const { result } = renderHook(() => useChatSessionControls(buildOptions()), { wrapper });

      await act(async () => {
        await result.current.handleTerminateAllAgents();
      });

      expect(mockToast).toHaveBeenCalledWith({
        title: 'Batch terminate complete',
        description: '1 stopped, 1 failed.',
        variant: 'destructive',
      });
    });

    it('is a no-op when no agents have sessions', async () => {
      const { wrapper } = createWrapper();
      const { result } = renderHook(
        () =>
          useChatSessionControls(
            buildOptions({
              agentPresence: {
                'agent-1': { online: false, sessionId: undefined },
                'agent-2': { online: false, sessionId: undefined },
              },
            }),
          ),
        { wrapper },
      );

      await act(async () => {
        await result.current.handleTerminateAllAgents();
      });

      expect(mockTerminate).not.toHaveBeenCalled();
      expect(mockToast).not.toHaveBeenCalled();
    });
  });

  describe('handleVerifyMcp (preserved-policy stub)', () => {
    // useChatSessionControls.ts:529-534 — chat's verifyMcp is a deliberate
    // return-false stub (known bug, preserved as explicit adapter policy).
    it('always resolves false and invalidates the preflight query', async () => {
      const { wrapper, queryClient } = createWrapper();
      const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');
      const { result } = renderHook(() => useChatSessionControls(buildOptions()), { wrapper });

      let verified: boolean | undefined;
      await act(async () => {
        verified = await result.current.handleVerifyMcp();
      });

      expect(verified).toBe(false);
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['preflight'] });
    });
  });
});
