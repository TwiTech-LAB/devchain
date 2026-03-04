import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import type { Thread } from '@/ui/lib/chat';
import type { AgentPresenceMap } from '@/ui/lib/sessions';
import { useChatThreadUiState } from './useChatThreadUiState';
import type { AgentOrGuest } from './useChatQueries';

const AGENTS: AgentOrGuest[] = [
  {
    id: 'agent-1',
    name: 'Agent One',
    type: 'agent',
  },
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
});
