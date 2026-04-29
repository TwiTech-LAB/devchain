import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import type { Thread } from '@/ui/lib/chat';
import type { AgentPresenceMap } from '@/ui/lib/sessions';
import { useChatThreadUiState } from './useChatThreadUiState';
import type { AgentOrGuest } from './useChatQueries';

const AGENTS: AgentOrGuest[] = [
  { id: 'agent-1', name: 'Agent One', type: 'agent' },
  { id: 'agent-2', name: 'Agent Two', type: 'agent' },
];

const THREADS: Thread[] = [
  {
    id: 'thread-main',
    projectId: 'project-main',
    title: 'Main Thread',
    isGroup: false,
    createdByType: 'user',
    createdByUserId: 'user-1',
    createdByAgentId: null,
    members: ['agent-1'],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
];

const AGENT_PRESENCE: AgentPresenceMap = {
  'agent-1': {
    online: true,
    sessionId: 'session-1',
  },
  'agent-2': {
    online: true,
    sessionId: 'session-2',
  },
};

function buildWrapper(initialEntries: string[]) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <MemoryRouter initialEntries={initialEntries}>{children}</MemoryRouter>;
  };
}

describe('useChatThreadUiState', () => {
  it('returns null thread and inline terminal session during project transition render', async () => {
    const snapshots: Array<{
      selectedThreadId: string | null;
      inlineTerminalSessionId: string | null;
    }> = [];

    const { result, rerender } = renderHook(
      ({ projectId }: { projectId: string | null }) => {
        const state = useChatThreadUiState({
          projectId,
          agentPresence: AGENT_PRESENCE,
          allThreads: THREADS,
          agents: AGENTS,
        });
        snapshots.push({
          selectedThreadId: state.selectedThreadId,
          inlineTerminalSessionId: state.inlineTerminalSessionId,
        });
        return state;
      },
      {
        initialProps: { projectId: 'project-main' },
        wrapper: buildWrapper(['/chat']),
      },
    );

    act(() => {
      result.current.handleSelectThread('thread-main');
    });
    await waitFor(() => {
      expect(result.current.selectedThreadId).toBe('thread-main');
    });

    act(() => {
      result.current.setInlineTerminalsByThread({
        'thread-main': {
          agentId: 'agent-1',
          sessionId: 'session-1',
        },
      });
    });
    await waitFor(() => {
      expect(result.current.inlineTerminalSessionId).toBe('session-1');
    });

    const transitionSnapshotIndex = snapshots.length;
    rerender({ projectId: 'project-worktree' });

    expect(snapshots[transitionSnapshotIndex]).toEqual({
      selectedThreadId: null,
      inlineTerminalSessionId: null,
    });

    await waitFor(() => {
      expect(result.current.selectedThreadId).toBeNull();
    });
    expect(result.current.inlineTerminalSessionId).toBeNull();
  });

  it('preserves thread selection behavior when project does not change', async () => {
    const { result } = renderHook(
      () =>
        useChatThreadUiState({
          projectId: 'project-main',
          agentPresence: AGENT_PRESENCE,
          allThreads: THREADS,
          agents: AGENTS,
        }),
      {
        wrapper: buildWrapper(['/chat']),
      },
    );

    act(() => {
      result.current.handleSelectThread('thread-main');
    });

    await waitFor(() => {
      expect(result.current.selectedThreadId).toBe('thread-main');
    });
    expect(result.current.currentThread?.id).toBe('thread-main');
  });

  describe('attachInlineTerminalForSelectedThread', () => {
    it('accepts attach when agentId matches the DM thread member', async () => {
      const { result } = renderHook(
        () =>
          useChatThreadUiState({
            projectId: 'project-main',
            agentPresence: AGENT_PRESENCE,
            allThreads: THREADS,
            agents: AGENTS,
          }),
        { wrapper: buildWrapper(['/chat']) },
      );

      act(() => {
        result.current.handleSelectThread('thread-main');
      });
      await waitFor(() => {
        expect(result.current.selectedThreadId).toBe('thread-main');
      });

      let accepted: boolean;
      act(() => {
        accepted = result.current.attachInlineTerminalForSelectedThread('agent-1', 'new-session');
      });

      expect(accepted!).toBe(true);
      expect(result.current.inlineTerminalsByThread['thread-main']).toEqual({
        agentId: 'agent-1',
        sessionId: 'new-session',
      });
      expect(result.current.terminalMenuOpen).toBe(false);
      expect(result.current.inlineUnreadCount).toBe(0);
    });

    it('rejects attach when agentId does not match the DM thread member', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      const { result } = renderHook(
        () =>
          useChatThreadUiState({
            projectId: 'project-main',
            agentPresence: AGENT_PRESENCE,
            allThreads: THREADS,
            agents: AGENTS,
          }),
        { wrapper: buildWrapper(['/chat']) },
      );

      act(() => {
        result.current.handleSelectThread('thread-main');
      });
      await waitFor(() => {
        expect(result.current.selectedThreadId).toBe('thread-main');
      });

      act(() => {
        result.current.setInlineTerminalsByThread({
          'thread-main': { agentId: 'agent-1', sessionId: 'session-1' },
        });
      });

      let accepted: boolean;
      act(() => {
        accepted = result.current.attachInlineTerminalForSelectedThread('agent-2', 'session-2');
      });

      expect(accepted!).toBe(false);
      expect(result.current.inlineTerminalsByThread['thread-main']).toEqual({
        agentId: 'agent-1',
        sessionId: 'session-1',
      });
      expect(warnSpy).toHaveBeenCalledWith(
        'Rejected inline terminal bind: agent not selected thread DM member',
        expect.objectContaining({
          agentId: 'agent-2',
          threadId: 'thread-main',
          expectedAgentId: 'agent-1',
        }),
      );

      warnSpy.mockRestore();
    });
  });

  describe('presence-sync self-healing', () => {
    it('skips sessionId stamp when thread is found but agentId mismatches DM member', async () => {
      const { result, rerender } = renderHook(
        ({ agentPresence }: { agentPresence: AgentPresenceMap }) =>
          useChatThreadUiState({
            projectId: 'project-main',
            agentPresence,
            allThreads: THREADS,
            agents: AGENTS,
          }),
        {
          initialProps: { agentPresence: AGENT_PRESENCE },
          wrapper: buildWrapper(['/chat']),
        },
      );

      act(() => {
        result.current.handleSelectThread('thread-main');
      });
      await waitFor(() => {
        expect(result.current.selectedThreadId).toBe('thread-main');
      });

      act(() => {
        result.current.setInlineTerminalsByThread({
          'thread-main': { agentId: 'agent-2', sessionId: 'old-session' },
        });
      });

      rerender({
        agentPresence: {
          ...AGENT_PRESENCE,
          'agent-2': { online: true, sessionId: 'new-session-2' },
        },
      });

      await waitFor(() => {
        expect(result.current.inlineTerminalsByThread['thread-main']).toEqual({
          agentId: 'agent-2',
          sessionId: 'old-session',
        });
      });
    });

    it('preserves entry when thread is not found in allThreads (loading state)', async () => {
      const { result, rerender } = renderHook(
        ({
          agentPresence,
          allThreads,
        }: {
          agentPresence: AgentPresenceMap;
          allThreads: Thread[];
        }) =>
          useChatThreadUiState({
            projectId: 'project-main',
            agentPresence,
            allThreads,
            agents: AGENTS,
          }),
        {
          initialProps: { agentPresence: AGENT_PRESENCE, allThreads: THREADS },
          wrapper: buildWrapper(['/chat']),
        },
      );

      act(() => {
        result.current.handleSelectThread('thread-main');
      });
      await waitFor(() => {
        expect(result.current.selectedThreadId).toBe('thread-main');
      });

      act(() => {
        result.current.setInlineTerminalsByThread({
          'thread-main': { agentId: 'agent-1', sessionId: 'old-session' },
        });
      });

      rerender({
        agentPresence: {
          'agent-1': { online: true, sessionId: 'new-session' },
          'agent-2': { online: true, sessionId: 'session-2' },
        },
        allThreads: [],
      });

      await waitFor(() => {
        expect(result.current.inlineTerminalsByThread['thread-main']).toEqual({
          agentId: 'agent-1',
          sessionId: 'old-session',
        });
      });
    });

    it('stamps sessionId when thread is found and agentId matches DM member', async () => {
      const { result, rerender } = renderHook(
        ({ agentPresence }: { agentPresence: AgentPresenceMap }) =>
          useChatThreadUiState({
            projectId: 'project-main',
            agentPresence,
            allThreads: THREADS,
            agents: AGENTS,
          }),
        {
          initialProps: { agentPresence: AGENT_PRESENCE },
          wrapper: buildWrapper(['/chat']),
        },
      );

      act(() => {
        result.current.handleSelectThread('thread-main');
      });
      await waitFor(() => {
        expect(result.current.selectedThreadId).toBe('thread-main');
      });

      act(() => {
        result.current.setInlineTerminalsByThread({
          'thread-main': { agentId: 'agent-1', sessionId: 'old-session' },
        });
      });

      rerender({
        agentPresence: {
          'agent-1': { online: true, sessionId: 'new-session' },
          'agent-2': { online: true, sessionId: 'session-2' },
        },
      });

      await waitFor(() => {
        expect(result.current.inlineTerminalsByThread['thread-main']).toEqual({
          agentId: 'agent-1',
          sessionId: 'new-session',
        });
      });
    });
  });
});
