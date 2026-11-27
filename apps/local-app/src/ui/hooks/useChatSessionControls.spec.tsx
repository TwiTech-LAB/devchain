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
const mockProjectFetch = jest.fn();
jest.mock('@/ui/hooks/useFetchFactory', () => ({
  useFetchFactory: () => mockProjectFetch,
}));

jest.mock('@/ui/lib/sessions', () => {
  const actual = jest.requireActual('@/ui/lib/sessions');
  return {
    ...actual,
    launchSession: jest.fn(),
    restartSession: jest.fn(),
    terminateSession: jest.fn().mockResolvedValue(undefined),
    restoreSession: jest.fn(),
    createSavePoint: jest.fn(),
    startFromSavePoint: jest.fn(),
    rollbackSession: jest.fn(),
  };
});

import {
  launchSession,
  restartSession,
  restoreSession,
  terminateSession,
  SessionApiError,
  createSavePoint,
  startFromSavePoint,
  rollbackSession,
  agentSessionTreeKey,
  agentSessionTreeKeyPrefix,
  type SessionTreeNode,
  type SessionTreePage,
} from '@/ui/lib/sessions';
import { useTerminalAttachRevision } from '@/ui/lib/terminal-attach-revision';
import { isRollbackHeld } from '@/ui/lib/rollback-holds';
import { transcriptQueryKeys } from './useSessionTranscript';

const mockLaunch = launchSession as jest.MockedFunction<typeof launchSession>;
const mockRestart = restartSession as jest.MockedFunction<typeof restartSession>;
const mockRestore = restoreSession as jest.MockedFunction<typeof restoreSession>;
const mockTerminate = terminateSession as jest.MockedFunction<typeof terminateSession>;
const mockSavePoint = jest.mocked(createSavePoint);
const mockStartFromSavePoint = jest.mocked(startFromSavePoint);
const mockRollback = jest.mocked(rollbackSession);

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
        disabled: false,
        type: 'agent' as const,
      },
      {
        profileId: null,
        modelOverride: null,
        effortOverride: null,
        id: 'agent-2',
        name: 'Agent Two',
        isProjectOwner: false,
        disabled: false,
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

  describe('save point lifecycle', () => {
    const supported = { available: true } as const;
    const saved: SessionTreeNode = {
      id: 'save-1',
      kind: 'save_point',
      parentSessionId: 'sess-old',
      status: 'stopped',
      providerSessionId: 'provider-save',
      providerNameAtLaunch: 'claude',
      startedAt: '2026-01-01T12:40:00Z',
      endedAt: null,
      lastActivityAt: null,
      sizeBytes: null,
      transcriptAvailable: true,
      beforeRollback: false,
      name: null,
    };

    it('gates saving on project, presence, matching activity, and provider eligibility', async () => {
      const { wrapper } = createWrapper();
      const { result, rerender } = renderHook((options) => useChatSessionControls(options), {
        wrapper,
        initialProps: buildOptions({ projectId: null }),
      });
      await act(async () => result.current.handleSavePoint('sess-old', 'agent-1', supported));
      rerender(
        buildOptions({
          agentPresence: {
            'agent-1': { online: true, sessionId: 'sess-old', activityState: 'busy' },
          },
        }),
      );
      await act(async () => result.current.handleSavePoint('sess-old', 'agent-1', supported));
      rerender(buildOptions());
      await act(async () => {
        await result.current.handleSavePoint('different-session', 'agent-1', supported);
        await result.current.handleSavePoint('sess-old', 'agent-1', {
          available: false,
          reason: 'TEAM_MEMBER',
        });
        await result.current.handleSavePoint('sess-old', 'agent-1', {
          available: false,
          reason: 'PROVIDER_UNSUPPORTED',
        });
        await result.current.handleSavePoint('sess-old', 'agent-1', undefined);
      });
      expect(mockSavePoint).not.toHaveBeenCalled();
      expect(result.current.savingSessionIds).toEqual({});
    });

    it('tracks Save point and refreshes the tree while keeping the live terminal attached', async () => {
      const { wrapper, queryClient } = createWrapper();
      const attach = jest.fn();
      const invalidate = jest.spyOn(queryClient, 'invalidateQueries');
      let complete!: (value: SessionTreeNode) => void;
      mockSavePoint.mockReturnValueOnce(
        new Promise((resolve) => {
          complete = resolve;
        }),
      );
      const { result } = renderHook(
        () => useChatSessionControls(buildOptions({ onInlineTerminalAttach: attach })),
        { wrapper },
      );

      let saving: Promise<void> | undefined;
      act(() => {
        saving = result.current.handleSavePoint('sess-old', 'agent-1', supported);
      });
      expect(result.current.savingSessionIds).toEqual({ 'sess-old': true });
      expect(mockSavePoint).toHaveBeenCalledWith('sess-old', 'proj-1', mockProjectFetch);
      await act(async () => {
        complete(saved);
        await saving;
      });

      expect(result.current.savingSessionIds).toEqual({});
      expect(invalidate.mock.calls).toEqual([[{ queryKey: agentSessionTreeKeyPrefix }]]);
      expect(attach).not.toHaveBeenCalled();
      const time = new Date(saved.startedAt).toLocaleTimeString(undefined, {
        hour: 'numeric',
        minute: '2-digit',
      });
      expect(mockToast).toHaveBeenCalledWith({ title: `Saved ${time}` });
    });

    it('requires confirmation for a live replacement and blocks starting for team members', async () => {
      const { wrapper } = createWrapper();
      const { result, rerender } = renderHook((options) => useChatSessionControls(options), {
        wrapper,
        initialProps: buildOptions({ projectId: null }),
      });
      await act(async () => {
        await result.current.handleStartFromSavePoint(saved.id, 'agent-1', supported, 'sess-old');
      });
      rerender(buildOptions());
      await act(async () => {
        await result.current.handleStartFromSavePoint(saved.id, 'agent-1', supported);
        await result.current.handleStartFromSavePoint(
          saved.id,
          'agent-1',
          { available: false, reason: 'TEAM_MEMBER' },
          'sess-old',
        );
      });
      expect(mockStartFromSavePoint).not.toHaveBeenCalled();
      expect(result.current.forkingSessionIds).toEqual({});
    });

    it('tracks a confirmed start, primes the child, and invalidates all four session queries', async () => {
      const { wrapper, queryClient } = createWrapper();
      const attach = jest.fn();
      const invalidate = jest.spyOn(queryClient, 'invalidateQueries');
      const child = makeSession({ id: 'child-42' });
      let complete!: (value: typeof child) => void;
      mockStartFromSavePoint.mockReturnValueOnce(
        new Promise((resolve) => {
          complete = resolve;
        }),
      );
      const { result } = renderHook(
        () => useChatSessionControls(buildOptions({ onInlineTerminalAttach: attach })),
        { wrapper },
      );

      let starting: ReturnType<typeof result.current.handleStartFromSavePoint> | undefined;
      act(() => {
        starting = result.current.handleStartFromSavePoint(
          saved.id,
          'agent-1',
          supported,
          'sess-old',
        );
      });
      expect(result.current.forkingSessionIds).toEqual({ [saved.id]: true });
      expect(mockStartFromSavePoint).toHaveBeenCalledWith(
        saved.id,
        { projectId: 'proj-1', expectedAgentId: 'agent-1', replaceRunningSessionId: 'sess-old' },
        mockProjectFetch,
      );
      await act(async () => {
        complete(child);
        await starting;
      });

      expect(result.current.forkingSessionIds).toEqual({});
      expect(queryClient.getQueryData(chatQueryKeys.activeSessions('proj-1'))).toEqual([child]);
      expect(queryClient.getQueryData(chatQueryKeys.agentPresence('proj-1'))).toEqual({
        'agent-1': { online: true, sessionId: child.id },
      });
      expect(invalidate.mock.calls.map(([filters]) => filters?.queryKey)).toEqual([
        chatQueryKeys.agentPresence('proj-1'),
        chatQueryKeys.activeSessions('proj-1'),
        agentSessionTreeKeyPrefix,
      ]);
      expect(attach).toHaveBeenCalledWith('agent-1', child.id);
      expect(mockToast).toHaveBeenCalledWith({
        title: 'Session forked',
        description: 'Session child-42 is running.',
      });
    });

    it.each([
      { code: 'RUNNING_SESSION_CHANGED', title: 'Running session changed' },
      { code: 'INVALID_SESSION_STATE', title: 'Invalid session state' },
    ])('reports $code and resets the pending fork on failure', async ({ code, title }) => {
      mockStartFromSavePoint.mockRejectedValueOnce(
        new SessionApiError('Session changed', 409, {
          statusCode: 409,
          code: 'CONFLICT',
          message: 'Session changed',
          details: { code },
          timestamp: '',
          path: '',
        }),
      );
      const { wrapper } = createWrapper();
      const { result } = renderHook(() => useChatSessionControls(buildOptions()), { wrapper });

      await act(async () => {
        await result.current.handleStartFromSavePoint(saved.id, 'agent-1', supported, 'sess-old');
      });

      expect(result.current.forkingSessionIds).toEqual({});
      expect(mockToast).toHaveBeenCalledWith({
        title,
        description: 'Session changed',
        variant: 'destructive',
      });
    });

    const beforeRollback: SessionTreeNode = {
      ...saved,
      id: 'record-1',
      beforeRollback: true,
    };
    const transcriptKeys = (id: string) => [
      transcriptQueryKeys.summary(id),
      transcriptQueryKeys.index(id),
      ['transcript-chunk-page', id],
    ];

    function renderRollback(attach = jest.fn()) {
      const { wrapper, queryClient } = createWrapper();
      queryClient.setQueryData(agentSessionTreeKey('agent-1', 'proj-1'), {
        pages: [{ items: [saved, beforeRollback], nextCursor: null } as unknown as SessionTreePage],
        pageParams: [null],
      });
      const invalidate = jest.spyOn(queryClient, 'invalidateQueries');
      const view = renderHook(
        () => ({
          controls: useChatSessionControls(buildOptions({ onInlineTerminalAttach: attach })),
          revision: useTerminalAttachRevision('sess-old'),
        }),
        { wrapper },
      );
      return { ...view, invalidate, attach };
    }

    it('tracks a rollback on the session and the save point, then shows it with fresh transcripts and leaves the terminal remount to the server', async () => {
      const { result, invalidate, attach } = renderRollback();
      const revision = result.current.revision;
      let complete!: (value: ReturnType<typeof makeSession>) => void;
      let heldAtRequest: boolean | undefined;
      mockRollback.mockImplementationOnce(() => {
        heldAtRequest = isRollbackHeld('sess-old');
        return new Promise((resolve) => {
          complete = resolve;
        });
      });
      let heldAtAttach: boolean | undefined;
      attach.mockImplementation(() => {
        heldAtAttach = isRollbackHeld('sess-old');
      });

      let rollingBack: Promise<void> | undefined;
      act(() => {
        rollingBack = result.current.controls.handleRollbackSession(
          'sess-old',
          saved.id,
          'agent-1',
          true,
          'sess-old',
          'Ready',
        );
      });
      expect(result.current.controls.rollingBackSessionIds).toEqual({
        'sess-old': true,
        [saved.id]: true,
      });
      expect(mockRollback).toHaveBeenCalledWith(
        'sess-old',
        {
          projectId: 'proj-1',
          savePointId: saved.id,
          keepCurrent: true,
          expectedAgentId: 'agent-1',
          replaceRunningSessionId: 'sess-old',
        },
        mockProjectFetch,
      );
      await act(async () => {
        await result.current.controls.handleRollbackSession(
          'sess-old',
          beforeRollback.id,
          'agent-1',
          false,
          'sess-old',
          'Other',
        );
      });
      expect(mockRollback).toHaveBeenCalledTimes(1);

      await act(async () => {
        complete(makeSession({ id: 'sess-old' }));
        await rollingBack;
      });

      expect(result.current.controls.rollingBackSessionIds).toEqual({});
      // The hold covers the request and the success path, and ends with the call.
      expect(heldAtRequest).toBe(true);
      expect(heldAtAttach).toBe(true);
      expect(isRollbackHeld('sess-old')).toBe(false);
      expect(mockToast).toHaveBeenCalledWith({ title: 'Rolled back to Ready' });
      expect(attach).toHaveBeenCalledWith('agent-1', 'sess-old');
      expect(result.current.revision).toBe(revision);
      const keys = invalidate.mock.calls.map(([filters]) => filters?.queryKey);
      expect(keys).toEqual(
        expect.arrayContaining([
          ...transcriptKeys('sess-old'),
          ...transcriptKeys(beforeRollback.id),
          agentSessionTreeKeyPrefix,
        ]),
      );
    });

    it.each([
      {
        code: 'ROLLBACK_START_FAILED',
        title: 'Session rolled back but did not start',
        description: 'Use Restore to start it.',
        refreshes: true,
      },
      {
        code: 'SAVE_POINT_NOT_OF_SESSION',
        title: 'Save point does not belong to this session',
        description: 'Rollback refused',
        refreshes: false,
      },
      {
        code: 'RUNNING_SESSION_CHANGED',
        title: 'Running session changed',
        description: 'Rollback refused',
        refreshes: false,
      },
    ])(
      'reports $code and clears both pending IDs and the rollback hold',
      async ({ code, title, description, refreshes }) => {
        let heldAtRequest: boolean | undefined;
        mockRollback.mockImplementationOnce(async () => {
          heldAtRequest = isRollbackHeld('sess-old');
          throw new SessionApiError('Rollback refused', 409, {
            statusCode: 409,
            code: 'CONFLICT',
            message: 'Rollback refused',
            details: { code },
            timestamp: '',
            path: '',
          });
        });
        const { result, invalidate, attach } = renderRollback();
        const revision = result.current.revision;

        await act(async () => {
          await result.current.controls.handleRollbackSession(
            'sess-old',
            saved.id,
            'agent-1',
            true,
            'sess-old',
            'Ready',
          );
        });

        expect(result.current.controls.rollingBackSessionIds).toEqual({});
        expect(heldAtRequest).toBe(true);
        expect(isRollbackHeld('sess-old')).toBe(false);
        expect(mockToast).toHaveBeenCalledWith({ title, description, variant: 'destructive' });
        expect(attach).not.toHaveBeenCalled();
        expect(result.current.revision).toBe(revision);
        const keys = invalidate.mock.calls.map(([filters]) => filters?.queryKey);
        if (refreshes) {
          expect(keys).toEqual(
            expect.arrayContaining([
              ...transcriptKeys('sess-old'),
              ...transcriptKeys(beforeRollback.id),
              agentSessionTreeKeyPrefix,
              chatQueryKeys.agentPresence('proj-1'),
              chatQueryKeys.activeSessions('proj-1'),
            ]),
          );
        } else {
          expect(keys).toEqual([]);
        }
      },
    );
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

    it('sends the switch config id with the restore request', async () => {
      mockRestore.mockResolvedValue(makeSession({ id: sessionId, agentId }));
      const { wrapper } = createWrapper();
      const { result } = renderHook(() => useChatSessionControls(buildOptions()), { wrapper });
      await act(async () => {
        await result.current.handleRestoreSession(sessionId, agentId, undefined, 'cfg-codex');
      });
      expect(mockRestore).toHaveBeenCalledWith(
        sessionId,
        expect.objectContaining({ switchToProviderConfigId: 'cfg-codex' }),
        expect.any(Function),
      );
    });

    it('restores the session, shows success and clears pending state', async () => {
      mockRestore.mockResolvedValue(makeSession({ id: sessionId, agentId }));
      const { wrapper } = createWrapper();
      const { result } = renderHook(() => useChatSessionControls(buildOptions()), { wrapper });
      await act(async () => {
        await result.current.handleRestoreSession(sessionId, agentId);
      });
      {
        expect(mockRestore).toHaveBeenCalledWith(
          sessionId,
          { projectId: 'proj-1', targetAgentId: agentId, replaceRunningSessionId: undefined },
          expect.any(Function),
        );
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

    it('calls terminateSession with the agent as the expected owner and shows the chat success toast', async () => {
      mockTerminate.mockResolvedValue(undefined);

      const { wrapper } = createWrapper();
      const { result } = renderHook(() => useChatSessionControls(buildOptions()), { wrapper });

      await act(async () => {
        await result.current.handleTerminateSession('agent-1', 'sess-old');
      });

      expect(mockTerminate).toHaveBeenCalledWith('sess-old', expect.any(Function), {
        expectedAgentId: 'agent-1',
      });
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

    it('skips disabled agents in the offline list and Start all', async () => {
      mockLaunch.mockResolvedValue(makeSession());
      const base = buildOptions({ agentPresence: offlinePresence });
      const options = {
        ...base,
        agents: base.agents.map((a) => (a.id === 'agent-2' ? { ...a, disabled: true } : a)),
      };

      const { wrapper } = createWrapper();
      const { result } = renderHook(() => useChatSessionControls(options), { wrapper });

      expect(result.current.offlineAgents.map((a) => a.id)).toEqual(['agent-1']);
      await act(async () => {
        await result.current.handleStartAllAgents();
      });
      expect(mockLaunch).toHaveBeenCalledTimes(1);
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

    it('terminates every agent-with-session as its expected owner and reports total success', async () => {
      mockTerminate.mockResolvedValue(undefined);

      const { wrapper } = createWrapper();
      const { result } = renderHook(() => useChatSessionControls(buildOptions()), { wrapper });

      await act(async () => {
        await result.current.handleTerminateAllAgents();
      });

      expect(mockTerminate.mock.calls).toEqual([
        ['sess-old', expect.any(Function), { expectedAgentId: 'agent-1' }],
        ['sess-2-old', expect.any(Function), { expectedAgentId: 'agent-2' }],
      ]);
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
