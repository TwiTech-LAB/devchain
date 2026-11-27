import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import type { AgentPresenceMap } from '@/ui/lib/sessions';
import { useAgentConsoleUiState } from './useAgentConsoleUiState';
import type { AgentOrGuest } from './useChatQueries';

// Test layer: hook-level React Testing Library coverage is the cheapest reliable layer for URL selection and query-state effects; no rendered page or browser is needed.

const AGENTS: AgentOrGuest[] = [
  {
    profileId: null,
    modelOverride: null,
    effortOverride: null,
    id: 'agent-1',
    name: 'Alpha',
    type: 'agent',
    isProjectOwner: false,
    disabled: false,
  },
  {
    profileId: null,
    modelOverride: null,
    effortOverride: null,
    id: 'agent-2',
    name: 'Zulu',
    type: 'agent',
    isProjectOwner: true,
    disabled: false,
  },
];
const PRESENCE: AgentPresenceMap = {
  'agent-1': { online: true, sessionId: 'session-1' },
  'agent-2': { online: true, sessionId: 'session-2' },
};

interface SubjectOptions {
  projectId?: string | null;
  agents?: AgentOrGuest[];
  agentPresence?: AgentPresenceMap;
  agentsQuerySuccess?: boolean;
}

function buildWrapper(initialEntry: string) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <MemoryRouter initialEntries={[initialEntry]}>{children}</MemoryRouter>;
  };
}

function useSubject({
  projectId = 'project-main',
  agents = AGENTS,
  agentPresence = PRESENCE,
  agentsQuerySuccess = true,
}: SubjectOptions = {}) {
  const state = useAgentConsoleUiState({
    projectId,
    agents,
    agentPresence,
    agentsQuerySuccess,
  });
  return { state, search: useLocation().search };
}

describe('useAgentConsoleUiState', () => {
  it.each([
    { label: 'bare URL', url: '/chat' },
    { label: 'stale agent URL', url: '/chat?agent=stale-agent' },
  ] as const)('heals $label to Project Owner after query success', async ({ url }) => {
    const { result } = renderHook(() => useSubject(), { wrapper: buildWrapper(url) });
    await waitFor(() => expect(result.current.state.selectedAgentId).toBe('agent-2'));
    expect(result.current.search).toBe('?agent=agent-2');
  });

  it('preserves an unknown selection until the agents query succeeds', () => {
    const { result } = renderHook(
      () => useSubject({ agents: [], agentPresence: {}, agentsQuerySuccess: false }),
      {
        wrapper: buildWrapper('/chat?agent=unknown'),
      },
    );

    expect(result.current.state.selectedAgentId).toBe('unknown');
    expect(result.current.search).toBe('?agent=unknown');
  });

  it('uses deterministic name then ID ordering when no Project Owner exists', async () => {
    const agents: AgentOrGuest[] = [
      {
        profileId: null,
        modelOverride: null,
        effortOverride: null,
        id: 'agent-z',
        name: 'Zulu',
        type: 'agent',
        isProjectOwner: false,
        disabled: false,
      },
      {
        profileId: null,
        modelOverride: null,
        effortOverride: null,
        id: 'agent-2',
        name: 'Alpha',
        type: 'agent',
        isProjectOwner: false,
        disabled: false,
      },
      {
        profileId: null,
        modelOverride: null,
        effortOverride: null,
        id: 'agent-1',
        name: 'Alpha',
        type: 'agent',
        isProjectOwner: false,
        disabled: false,
      },
    ];
    const { result } = renderHook(() => useSubject({ agents }), {
      wrapper: buildWrapper('/chat'),
    });

    await waitFor(() => expect(result.current.state.selectedAgentId).toBe('agent-1'));
    expect(result.current.search).toBe('?agent=agent-1');
  });

  it('revalidates the URL selection when switching projects', async () => {
    const nextProjectAgents: AgentOrGuest[] = [
      {
        profileId: null,
        modelOverride: null,
        effortOverride: null,
        id: 'agent-next',
        name: 'Next',
        type: 'agent',
        isProjectOwner: false,
        disabled: false,
      },
      {
        profileId: null,
        modelOverride: null,
        effortOverride: null,
        id: 'agent-other',
        name: 'Other',
        type: 'agent',
        isProjectOwner: false,
        disabled: false,
      },
    ];
    const { result, rerender } = renderHook(
      ({ projectId, agents }: { projectId: string; agents: AgentOrGuest[] }) =>
        useSubject({ projectId, agents }),
      {
        initialProps: { projectId: 'project-main', agents: AGENTS },
        wrapper: buildWrapper('/chat?agent=agent-1'),
      },
    );

    expect(result.current.state.selectedAgentId).toBe('agent-1');

    rerender({ projectId: 'project-next', agents: nextProjectAgents });

    await waitFor(() => expect(result.current.state.selectedAgentId).toBe('agent-next'));
    expect(result.current.search).toBe('?agent=agent-next');
  });

  it('clears the URL selection after a successful zero-agent load', async () => {
    const { result } = renderHook(
      () => useSubject({ agents: [], agentPresence: {}, agentsQuerySuccess: true }),
      { wrapper: buildWrapper('/chat?agent=stale-agent') },
    );

    await waitFor(() => expect(result.current.state.selectedAgentId).toBeNull());
    expect(result.current.search).toBe('');
  });

  it('clears a selection that becomes disabled and keeps it clear until the user selects', async () => {
    const { result, rerender } = renderHook((props: SubjectOptions) => useSubject(props), {
      wrapper: buildWrapper('/chat?agent=agent-1'),
      initialProps: {} as SubjectOptions,
    });
    expect(result.current.state.selectedAgentId).toBe('agent-1');
    expect(result.current.state.showInlineTerminal).toBe(true);

    const disabledRoster = AGENTS.map((a) => (a.id === 'agent-1' ? { ...a, disabled: true } : a));
    rerender({ agents: disabledRoster });
    // No terminal content for the disabled agent, also before the URL clears.
    expect(result.current.state.selectedAgent).toBeNull();
    expect(result.current.state.showInlineTerminal).toBe(false);
    await waitFor(() => expect(result.current.state.selectedAgentId).toBeNull());

    // agent-2 is enabled and online; later roster and presence updates must not select it.
    rerender({ agents: [...disabledRoster], agentPresence: { ...PRESENCE } });
    await act(async () => {});
    expect(result.current.state.selectedAgentId).toBeNull();
    expect(result.current.state.showInlineTerminal).toBe(false);
    expect(result.current.search).toBe('');

    act(() => result.current.state.handleSelectAgent('agent-2'));
    await waitFor(() => expect(result.current.state.selectedAgentId).toBe('agent-2'));
    expect(result.current.state.showInlineTerminal).toBe(true);
  });

  it('falls back to the first enabled agent when the selected agent is deleted', async () => {
    const { result, rerender } = renderHook((props: SubjectOptions) => useSubject(props), {
      wrapper: buildWrapper('/chat?agent=agent-1'),
      initialProps: {} as SubjectOptions,
    });
    rerender({ agents: AGENTS.filter((a) => a.id !== 'agent-1') });
    await waitFor(() => expect(result.current.state.selectedAgentId).toBe('agent-2'));
  });

  it('clears the selection when every agent is disabled', async () => {
    const agents = AGENTS.map((a) => ({ ...a, disabled: true }));
    const { result } = renderHook(() => useSubject({ agents }), {
      wrapper: buildWrapper('/chat?agent=agent-1'),
    });
    await waitFor(() => expect(result.current.state.selectedAgentId).toBeNull());
  });

  it('keys terminal session state by the selected agent and follows presence changes', async () => {
    const { result, rerender } = renderHook(
      ({ presence }: { presence: AgentPresenceMap }) => useSubject({ agentPresence: presence }),
      {
        initialProps: { presence: PRESENCE },
        wrapper: buildWrapper('/chat?agent=agent-1'),
      },
    );

    expect(result.current.state.inlineTerminalSessionId).toBe('session-1');
    act(() => {
      expect(result.current.state.attachInlineTerminalForAgent('agent-1', 'attached-session')).toBe(
        true,
      );
    });
    expect(result.current.state.inlineTerminalSessionId).toBe('attached-session');

    rerender({
      presence: { ...PRESENCE, 'agent-1': { online: false, sessionId: 'stale-session' } },
    });
    await waitFor(() => expect(result.current.state.inlineTerminalSessionId).toBeNull());
  });
});
