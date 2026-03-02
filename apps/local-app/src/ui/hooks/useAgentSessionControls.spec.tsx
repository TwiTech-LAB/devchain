import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import {
  useAgentSessionControls,
  readLastAgentId,
  writeLastAgentId,
  type UseAgentSessionControlsOptions,
} from './useAgentSessionControls';

// ============================================
// Mocks
// ============================================

const mockToast = jest.fn();
jest.mock('@/ui/hooks/use-toast', () => ({
  useToast: () => ({ toast: mockToast }),
}));

const mockOpenTerminalWindow = jest.fn();
jest.mock('@/ui/terminal-windows', () => ({
  useTerminalWindowManager: () => mockOpenTerminalWindow,
}));

jest.mock('@/ui/hooks/useAppSocket', () => ({
  useAppSocket: jest.fn(),
}));

jest.mock('@/ui/lib/sessions', () => {
  const actual = jest.requireActual('@/ui/lib/sessions');
  return {
    ...actual,
    fetchAgentPresence: jest.fn().mockResolvedValue({}),
    terminateSession: jest.fn().mockResolvedValue(undefined),
    launchSession: jest.fn(),
    restartSession: jest.fn(),
  };
});

import { useAppSocket } from '@/ui/hooks/useAppSocket';
import {
  fetchAgentPresence,
  terminateSession,
  launchSession,
  restartSession,
  SessionApiError,
} from '@/ui/lib/sessions';

const mockFetchPresence = fetchAgentPresence as jest.MockedFunction<typeof fetchAgentPresence>;
const mockTerminate = terminateSession as jest.MockedFunction<typeof terminateSession>;
const mockLaunch = launchSession as jest.MockedFunction<typeof launchSession>;
const mockRestart = restartSession as jest.MockedFunction<typeof restartSession>;
const mockUseAppSocket = useAppSocket as jest.MockedFunction<typeof useAppSocket>;

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
  overrides: Partial<UseAgentSessionControlsOptions> = {},
): UseAgentSessionControlsOptions {
  return {
    projectId: 'proj-1',
    refetchPreflight: jest.fn().mockResolvedValue({ data: undefined }),
    ...overrides,
  };
}

// ============================================
// Tests
// ============================================

describe('useAgentSessionControls', () => {
  let dispatchEventSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
    mockUseAppSocket.mockReturnValue({
      on: jest.fn(),
      off: jest.fn(),
      emit: jest.fn(),
      connected: true,
    } as unknown as ReturnType<typeof useAppSocket>);
    mockFetchPresence.mockResolvedValue({});
    mockTerminate.mockResolvedValue(undefined);
    dispatchEventSpy = jest.spyOn(window, 'dispatchEvent').mockImplementation(() => true);
  });

  afterEach(() => {
    dispatchEventSpy.mockRestore();
  });

  // ---- Presence ----

  describe('presence', () => {
    it('returns empty presence when projectId is null', () => {
      const { wrapper } = createWrapper();
      const { result } = renderHook(
        () => useAgentSessionControls(buildOptions({ projectId: null })),
        { wrapper },
      );
      expect(result.current.agentPresence).toEqual({});
    });

    it('fetches presence for given projectId', async () => {
      mockFetchPresence.mockResolvedValue({
        'agent-1': { online: true, sessionId: 'sess-1' },
      });
      const { wrapper } = createWrapper();
      const { result } = renderHook(() => useAgentSessionControls(buildOptions()), { wrapper });

      await waitFor(() => {
        expect(result.current.agentPresence).toEqual({
          'agent-1': { online: true, sessionId: 'sess-1' },
        });
      });
      expect(mockFetchPresence).toHaveBeenCalledWith('proj-1');
    });
  });

  // ---- Presence socket listener ----

  describe('presence socket listener', () => {
    it('registers message handler with useAppSocket', () => {
      const { wrapper } = createWrapper();
      renderHook(() => useAgentSessionControls(buildOptions()), { wrapper });
      expect(mockUseAppSocket).toHaveBeenCalled();
      const handlerMap = mockUseAppSocket.mock.calls[0][0];
      expect(typeof handlerMap.message).toBe('function');
    });
  });

  // ---- Launch ----

  describe('handleLaunch', () => {
    it('calls launchSession and opens terminal window on success', async () => {
      const session = makeSession();
      mockLaunch.mockResolvedValue(session);
      const { wrapper } = createWrapper();
      const { result } = renderHook(() => useAgentSessionControls(buildOptions()), { wrapper });

      act(() => {
        result.current.handleLaunch('agent-1');
      });

      await waitFor(() => {
        expect(result.current.launchingAgentId).toBeNull();
      });

      expect(mockLaunch).toHaveBeenCalledWith('agent-1', 'proj-1');
      expect(mockOpenTerminalWindow).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'sess-1' }),
      );
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Session launched' }),
      );
    });

    it('writes last-used agent to localStorage on success', async () => {
      const session = makeSession();
      mockLaunch.mockResolvedValue(session);
      const { wrapper } = createWrapper();
      const { result } = renderHook(() => useAgentSessionControls(buildOptions()), { wrapper });

      act(() => {
        result.current.handleLaunch('agent-1');
      });

      await waitFor(() => {
        expect(result.current.launchingAgentId).toBeNull();
      });

      expect(result.current.lastUsedAgentId).toBe('agent-1');
      expect(readLastAgentId('proj-1')).toBe('agent-1');
    });

    it('dispatches OPEN_TERMINAL_DOCK_EVENT on success', async () => {
      const session = makeSession();
      mockLaunch.mockResolvedValue(session);
      const { wrapper } = createWrapper();
      const { result } = renderHook(() => useAgentSessionControls(buildOptions()), { wrapper });

      act(() => {
        result.current.handleLaunch('agent-1');
      });

      await waitFor(() => {
        expect(result.current.launchingAgentId).toBeNull();
      });

      expect(dispatchEventSpy).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'devchain:terminal-dock:open' }),
      );
    });

    it('sets launchingAgentId during launch', async () => {
      let resolvePromise: (value: unknown) => void;
      mockLaunch.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolvePromise = resolve;
          }),
      );
      const { wrapper } = createWrapper();
      const { result } = renderHook(() => useAgentSessionControls(buildOptions()), { wrapper });

      act(() => {
        result.current.handleLaunch('agent-1');
      });

      await waitFor(() => {
        expect(result.current.launchingAgentId).toBe('agent-1');
      });

      await act(async () => {
        resolvePromise!(makeSession());
      });

      await waitFor(() => {
        expect(result.current.launchingAgentId).toBeNull();
      });
    });

    it('opens MCP modal on MCP_NOT_CONFIGURED error', async () => {
      const mcpError = new SessionApiError('MCP not configured', 400, {
        statusCode: 400,
        code: 'MCP_NOT_CONFIGURED',
        message: 'MCP not configured',
        details: {
          code: 'MCP_NOT_CONFIGURED',
          providerId: 'prov-1',
          providerName: 'Claude',
        },
        timestamp: '2026-01-01T00:00:00Z',
        path: '/api/sessions/launch',
      });
      mockLaunch.mockRejectedValue(mcpError);
      const { wrapper } = createWrapper();
      const { result } = renderHook(() => useAgentSessionControls(buildOptions()), { wrapper });

      act(() => {
        result.current.handleLaunch('agent-1');
      });

      await waitFor(() => {
        expect(result.current.mcpModalOpen).toBe(true);
      });

      expect(result.current.pendingMcpLaunch).toEqual(
        expect.objectContaining({
          agentId: 'agent-1',
          providerId: 'prov-1',
          providerName: 'Claude',
          action: 'launch',
        }),
      );
    });

    it('shows error toast on generic launch failure', async () => {
      mockLaunch.mockRejectedValue(new Error('Network error'));
      const { wrapper } = createWrapper();
      const { result } = renderHook(() => useAgentSessionControls(buildOptions()), { wrapper });

      act(() => {
        result.current.handleLaunch('agent-1');
      });

      await waitFor(() => {
        expect(result.current.launchingAgentId).toBeNull();
      });

      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Launch failed', variant: 'destructive' }),
      );
    });

    it('does nothing when projectId is null', () => {
      const { wrapper } = createWrapper();
      const { result } = renderHook(
        () => useAgentSessionControls(buildOptions({ projectId: null })),
        { wrapper },
      );

      act(() => {
        result.current.handleLaunch('agent-1');
      });

      expect(mockLaunch).not.toHaveBeenCalled();
    });
  });

  // ---- Restart ----

  describe('handleRestart', () => {
    it('calls restartSession and opens terminal window on success', async () => {
      const session = makeSession({ id: 'sess-new' });
      mockRestart.mockResolvedValue({ session });
      const { wrapper } = createWrapper();
      const { result } = renderHook(() => useAgentSessionControls(buildOptions()), { wrapper });

      await act(async () => {
        await result.current.handleRestart('agent-1', 'sess-old');
      });

      expect(mockRestart).toHaveBeenCalledWith('agent-1', 'proj-1', 'sess-old');
      expect(mockOpenTerminalWindow).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'sess-new' }),
      );
    });

    it('writes last-used agent on success', async () => {
      const session = makeSession();
      mockRestart.mockResolvedValue({ session });
      const { wrapper } = createWrapper();
      const { result } = renderHook(() => useAgentSessionControls(buildOptions()), { wrapper });

      await act(async () => {
        await result.current.handleRestart('agent-1', 'sess-old');
      });

      expect(result.current.lastUsedAgentId).toBe('agent-1');
      expect(readLastAgentId('proj-1')).toBe('agent-1');
    });

    it('dispatches OPEN_TERMINAL_DOCK_EVENT on success', async () => {
      const session = makeSession();
      mockRestart.mockResolvedValue({ session });
      const { wrapper } = createWrapper();
      const { result } = renderHook(() => useAgentSessionControls(buildOptions()), { wrapper });

      await act(async () => {
        await result.current.handleRestart('agent-1', 'sess-old');
      });

      expect(dispatchEventSpy).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'devchain:terminal-dock:open' }),
      );
    });

    it('shows warning toast when terminateWarning is present', async () => {
      const session = makeSession();
      mockRestart.mockResolvedValue({ session, terminateWarning: 'Previous session was stuck' });
      const { wrapper } = createWrapper();
      const { result } = renderHook(() => useAgentSessionControls(buildOptions()), { wrapper });

      await act(async () => {
        await result.current.handleRestart('agent-1', 'sess-old');
      });

      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Session restarted with warning',
          variant: 'destructive',
        }),
      );
    });

    it('opens MCP modal on MCP_NOT_CONFIGURED error', async () => {
      const mcpError = new SessionApiError('MCP not configured', 400, {
        statusCode: 400,
        code: 'MCP_NOT_CONFIGURED',
        message: 'MCP not configured',
        details: {
          code: 'MCP_NOT_CONFIGURED',
          providerId: 'prov-1',
          providerName: 'Claude',
        },
        timestamp: '2026-01-01T00:00:00Z',
        path: '/api/agents/agent-1/restart',
      });
      mockRestart.mockRejectedValue(mcpError);
      const { wrapper } = createWrapper();
      const { result } = renderHook(() => useAgentSessionControls(buildOptions()), { wrapper });

      await act(async () => {
        await result.current.handleRestart('agent-1', 'sess-old');
      });

      expect(result.current.mcpModalOpen).toBe(true);
      expect(result.current.pendingMcpLaunch).toEqual(
        expect.objectContaining({
          agentId: 'agent-1',
          action: 'restart',
          sessionId: 'sess-old',
        }),
      );
    });

    it('sets and clears restartingAgentId', async () => {
      let resolvePromise: (value: unknown) => void;
      mockRestart.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolvePromise = resolve;
          }),
      );
      const { wrapper } = createWrapper();
      const { result } = renderHook(() => useAgentSessionControls(buildOptions()), { wrapper });

      let restartPromise: Promise<void>;
      act(() => {
        restartPromise = result.current.handleRestart('agent-1', 'sess-old');
      });

      expect(result.current.restartingAgentId).toBe('agent-1');

      await act(async () => {
        resolvePromise!({ session: makeSession() });
        await restartPromise!;
      });

      expect(result.current.restartingAgentId).toBeNull();
    });

    it('shows error toast on generic restart failure', async () => {
      mockRestart.mockRejectedValue(new Error('Network error'));
      const { wrapper } = createWrapper();
      const { result } = renderHook(() => useAgentSessionControls(buildOptions()), { wrapper });

      await act(async () => {
        await result.current.handleRestart('agent-1', 'sess-old');
      });

      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Restart failed', variant: 'destructive' }),
      );
    });
  });

  // ---- Terminate ----

  describe('handleTerminate', () => {
    it('calls terminateSession and shows success toast', async () => {
      mockTerminate.mockResolvedValue(undefined);
      const { wrapper } = createWrapper();
      const { result } = renderHook(() => useAgentSessionControls(buildOptions()), { wrapper });

      act(() => {
        result.current.handleTerminate('agent-1', 'sess-1');
      });

      await waitFor(() => {
        expect(result.current.terminatingAgentId).toBeNull();
      });

      expect(mockTerminate).toHaveBeenCalledWith('sess-1');
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Session terminated' }),
      );
    });

    it('sets terminatingAgentId during termination', async () => {
      let resolvePromise: (value: unknown) => void;
      mockTerminate.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolvePromise = resolve;
          }),
      );
      const { wrapper } = createWrapper();
      const { result } = renderHook(() => useAgentSessionControls(buildOptions()), { wrapper });

      act(() => {
        result.current.handleTerminate('agent-1', 'sess-1');
      });

      expect(result.current.terminatingAgentId).toBe('agent-1');

      // Wait for mutationFn to be called before resolving
      await waitFor(() => {
        expect(mockTerminate).toHaveBeenCalled();
      });

      await act(async () => {
        resolvePromise!(undefined);
      });

      await waitFor(() => {
        expect(result.current.terminatingAgentId).toBeNull();
      });
    });

    it('shows error toast on failure', async () => {
      mockTerminate.mockRejectedValue(new Error('Terminate failed'));
      const { wrapper } = createWrapper();
      const { result } = renderHook(() => useAgentSessionControls(buildOptions()), { wrapper });

      act(() => {
        result.current.handleTerminate('agent-1', 'sess-1');
      });

      await waitFor(() => {
        expect(result.current.terminatingAgentId).toBeNull();
      });

      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Terminate failed', variant: 'destructive' }),
      );
    });
  });

  // ---- Last-used agent ----

  describe('lastUsedAgentId', () => {
    it('reads from localStorage on mount', () => {
      writeLastAgentId('proj-1', 'agent-saved');
      const { wrapper } = createWrapper();
      const { result } = renderHook(() => useAgentSessionControls(buildOptions()), { wrapper });

      expect(result.current.lastUsedAgentId).toBe('agent-saved');
    });

    it('returns null when no saved agent', () => {
      const { wrapper } = createWrapper();
      const { result } = renderHook(() => useAgentSessionControls(buildOptions()), { wrapper });

      expect(result.current.lastUsedAgentId).toBeNull();
    });
  });

  // ---- MCP retry (handleMcpConfigured) ----

  describe('handleMcpConfigured', () => {
    it('refetches preflight and retries launch', async () => {
      const session = makeSession();
      mockLaunch.mockResolvedValue(session);
      const mockRefetch = jest.fn().mockResolvedValue({ data: undefined });
      const { wrapper } = createWrapper();
      const { result } = renderHook(
        () => useAgentSessionControls(buildOptions({ refetchPreflight: mockRefetch })),
        { wrapper },
      );

      // Simulate MCP error to set pending launch
      const mcpError = new SessionApiError('MCP not configured', 400, {
        statusCode: 400,
        code: 'MCP_NOT_CONFIGURED',
        message: 'MCP not configured',
        details: { code: 'MCP_NOT_CONFIGURED', providerId: 'prov-1', providerName: 'Claude' },
        timestamp: '2026-01-01T00:00:00Z',
        path: '/api/sessions/launch',
      });
      mockLaunch.mockRejectedValueOnce(mcpError);

      act(() => {
        result.current.handleLaunch('agent-1');
      });

      await waitFor(() => {
        expect(result.current.pendingMcpLaunch).toBeTruthy();
      });

      // Now simulate MCP configured — reset the mock to succeed
      mockLaunch.mockResolvedValue(session);

      await act(async () => {
        await result.current.handleMcpConfigured();
      });

      expect(mockRefetch).toHaveBeenCalled();
      // Launch should have been retried
      expect(mockLaunch).toHaveBeenCalledTimes(2);
    });

    it('retries restart when action is restart', async () => {
      const session = makeSession();
      const mockRefetch = jest.fn().mockResolvedValue({ data: undefined });
      const { wrapper } = createWrapper();
      const { result } = renderHook(
        () => useAgentSessionControls(buildOptions({ refetchPreflight: mockRefetch })),
        { wrapper },
      );

      // Simulate MCP error on restart to set pending
      const mcpError = new SessionApiError('MCP not configured', 400, {
        statusCode: 400,
        code: 'MCP_NOT_CONFIGURED',
        message: 'MCP not configured',
        details: { code: 'MCP_NOT_CONFIGURED', providerId: 'prov-1', providerName: 'Claude' },
        timestamp: '2026-01-01T00:00:00Z',
        path: '/api/agents/agent-1/restart',
      });
      mockRestart.mockRejectedValueOnce(mcpError);

      await act(async () => {
        await result.current.handleRestart('agent-1', 'sess-old');
      });

      expect(result.current.pendingMcpLaunch?.action).toBe('restart');

      // Now simulate MCP configured — reset the mock to succeed
      mockRestart.mockResolvedValue({ session });

      await act(async () => {
        await result.current.handleMcpConfigured();
      });

      expect(mockRefetch).toHaveBeenCalled();
      expect(mockRestart).toHaveBeenCalledTimes(2);
    });
  });

  // ---- Verify MCP ----

  describe('handleVerifyMcp', () => {
    it('returns true when provider mcpStatus is pass', async () => {
      const mockRefetch = jest.fn().mockResolvedValue({
        data: { providers: [{ id: 'prov-1', mcpStatus: 'pass' }] },
      });
      const { wrapper } = createWrapper();
      const { result } = renderHook(
        () => useAgentSessionControls(buildOptions({ refetchPreflight: mockRefetch })),
        { wrapper },
      );

      // Set pending launch so verify has a providerId to check
      const mcpError = new SessionApiError('MCP not configured', 400, {
        statusCode: 400,
        code: 'MCP_NOT_CONFIGURED',
        message: 'MCP not configured',
        details: { code: 'MCP_NOT_CONFIGURED', providerId: 'prov-1', providerName: 'Claude' },
        timestamp: '2026-01-01T00:00:00Z',
        path: '/api/sessions/launch',
      });
      mockLaunch.mockRejectedValueOnce(mcpError);

      act(() => {
        result.current.handleLaunch('agent-1');
      });

      await waitFor(() => {
        expect(result.current.pendingMcpLaunch).toBeTruthy();
      });

      let verified: boolean;
      await act(async () => {
        verified = await result.current.handleVerifyMcp();
      });

      expect(verified!).toBe(true);
      expect(mockRefetch).toHaveBeenCalled();
    });

    it('returns false when no pending launch', async () => {
      const mockRefetch = jest.fn().mockResolvedValue({ data: undefined });
      const { wrapper } = createWrapper();
      const { result } = renderHook(
        () => useAgentSessionControls(buildOptions({ refetchPreflight: mockRefetch })),
        { wrapper },
      );

      let verified: boolean;
      await act(async () => {
        verified = await result.current.handleVerifyMcp();
      });

      expect(verified!).toBe(false);
    });

    it('returns false when mcpStatus is not pass', async () => {
      const mockRefetch = jest.fn().mockResolvedValue({
        data: { providers: [{ id: 'prov-1', mcpStatus: 'fail' }] },
      });
      const { wrapper } = createWrapper();
      const { result } = renderHook(
        () => useAgentSessionControls(buildOptions({ refetchPreflight: mockRefetch })),
        { wrapper },
      );

      // Set pending
      const mcpError = new SessionApiError('MCP not configured', 400, {
        statusCode: 400,
        code: 'MCP_NOT_CONFIGURED',
        message: 'MCP not configured',
        details: { code: 'MCP_NOT_CONFIGURED', providerId: 'prov-1', providerName: 'Claude' },
        timestamp: '2026-01-01T00:00:00Z',
        path: '/api/sessions/launch',
      });
      mockLaunch.mockRejectedValueOnce(mcpError);

      act(() => {
        result.current.handleLaunch('agent-1');
      });

      await waitFor(() => {
        expect(result.current.pendingMcpLaunch).toBeTruthy();
      });

      let verified: boolean;
      await act(async () => {
        verified = await result.current.handleVerifyMcp();
      });

      expect(verified!).toBe(false);
    });
  });
});

// ============================================
// Standalone helpers
// ============================================

describe('readLastAgentId', () => {
  beforeEach(() => localStorage.clear());

  it('returns null for null projectId', () => {
    expect(readLastAgentId(null)).toBeNull();
  });

  it('returns null when nothing stored', () => {
    expect(readLastAgentId('proj-1')).toBeNull();
  });

  it('returns stored agentId for projectId', () => {
    localStorage.setItem('devchain:lastAgentByProject', JSON.stringify({ 'proj-1': 'agent-1' }));
    expect(readLastAgentId('proj-1')).toBe('agent-1');
  });

  it('returns null for malformed storage', () => {
    localStorage.setItem('devchain:lastAgentByProject', 'not-json');
    expect(readLastAgentId('proj-1')).toBeNull();
  });
});

describe('writeLastAgentId', () => {
  beforeEach(() => localStorage.clear());

  it('writes agentId for projectId', () => {
    writeLastAgentId('proj-1', 'agent-1');
    const stored = JSON.parse(localStorage.getItem('devchain:lastAgentByProject')!);
    expect(stored['proj-1']).toBe('agent-1');
  });

  it('preserves existing entries for other projects', () => {
    localStorage.setItem('devchain:lastAgentByProject', JSON.stringify({ 'proj-2': 'agent-2' }));
    writeLastAgentId('proj-1', 'agent-1');
    const stored = JSON.parse(localStorage.getItem('devchain:lastAgentByProject')!);
    expect(stored['proj-1']).toBe('agent-1');
    expect(stored['proj-2']).toBe('agent-2');
  });

  it('recovers from malformed storage', () => {
    localStorage.setItem('devchain:lastAgentByProject', 'not-json');
    writeLastAgentId('proj-1', 'agent-1');
    const stored = JSON.parse(localStorage.getItem('devchain:lastAgentByProject')!);
    expect(stored['proj-1']).toBe('agent-1');
  });
});
