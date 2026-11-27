import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { AgentPresenceMap } from '@/ui/lib/sessions';
import { compareCanonicalAgents } from '@/ui/lib/agent-ordering';
import type { AgentOrGuest } from './useChatQueries';

export interface InlineTerminalEntry {
  agentId: string;
  sessionId: string | null;
}

export interface UseAgentConsoleUiStateOptions {
  projectId: string | null;
  agentPresence: AgentPresenceMap;
  agents: AgentOrGuest[];
  agentsQuerySuccess: boolean;
}

export interface UseAgentConsoleUiStateResult {
  selectedAgentId: string | null;
  selectedAgent: AgentOrGuest | null;
  handleSelectAgent: (agentId: string | null, options?: { replace?: boolean }) => void;
  attachInlineTerminalForAgent: (agentId: string, sessionId: string | null) => boolean;
  inlineTerminalState: InlineTerminalEntry | null;
  showInlineTerminal: boolean;
  inlineTerminalSessionId: string | null;
}

export function useAgentConsoleUiState({
  projectId,
  agentPresence,
  agents,
  agentsQuerySuccess,
}: UseAgentConsoleUiStateOptions): UseAgentConsoleUiStateResult {
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedAgentId = searchParams.get('agent') || null;
  const previousProjectIdRef = useRef<string | null>(null);
  const [inlineTerminalsByAgent, setInlineTerminalsByAgent] = useState<
    Record<string, InlineTerminalEntry>
  >({});

  const handleSelectAgent = useCallback(
    (agentId: string | null, { replace = false }: { replace?: boolean } = {}) => {
      const params = new URLSearchParams(searchParams);
      const currentAgentId = params.get('agent');
      const target = agentId || null;

      if ((target && currentAgentId === target) || (!target && !currentAgentId)) {
        return;
      }

      if (target) {
        params.set('agent', target);
      } else {
        params.delete('agent');
      }
      setSearchParams(params, { replace });
    },
    [searchParams, setSearchParams],
  );

  const canonicalAgents = useMemo(() => [...agents].sort(compareCanonicalAgents), [agents]);
  /**
   * Project in which a disabled selection was cleared. While it matches, an
   * empty selection stays empty: the fallback to the first agent would open
   * another agent's terminal the user did not choose.
   */
  const clearedForDisabledProjectRef = useRef<string | null>(null);

  const selectedRosterAgent = useMemo(
    () => agents.find((agent) => agent.id === selectedAgentId) ?? null,
    [agents, selectedAgentId],
  );
  const selectedIsDisabled = selectedRosterAgent?.disabled === true;

  useEffect(() => {
    if (!projectId || !agentsQuerySuccess) {
      return;
    }

    if (selectedIsDisabled) {
      clearedForDisabledProjectRef.current = projectId;
      handleSelectAgent(null, { replace: true });
      return;
    }
    if (selectedAgentId === null && clearedForDisabledProjectRef.current === projectId) {
      return;
    }
    clearedForDisabledProjectRef.current = null;

    const selectable = canonicalAgents.filter((agent) => !agent.disabled);
    const validSelection = selectable.some((agent) => agent.id === selectedAgentId);
    const nextAgentId = validSelection ? selectedAgentId : (selectable[0]?.id ?? null);
    if (nextAgentId !== selectedAgentId) {
      handleSelectAgent(nextAgentId, { replace: true });
    }
  }, [
    agentsQuerySuccess,
    canonicalAgents,
    handleSelectAgent,
    projectId,
    selectedAgentId,
    selectedIsDisabled,
  ]);

  // A disabled agent gets no terminal or launch content, also before the URL clears.
  const selectedAgent = selectedIsDisabled ? null : selectedRosterAgent;
  const liveSelectedAgentId = selectedIsDisabled ? null : selectedAgentId;
  const selectedPresence = liveSelectedAgentId ? agentPresence[liveSelectedAgentId] : undefined;
  const inlineTerminalState = liveSelectedAgentId
    ? (inlineTerminalsByAgent[liveSelectedAgentId] ?? {
        agentId: liveSelectedAgentId,
        sessionId: selectedPresence?.online ? (selectedPresence.sessionId ?? null) : null,
      })
    : null;
  const showInlineTerminal = Boolean(inlineTerminalState);
  const inlineTerminalSessionId = inlineTerminalState?.sessionId ?? null;

  const attachInlineTerminalForAgent = useCallback(
    (agentId: string, sessionId: string | null): boolean => {
      if (liveSelectedAgentId !== agentId) {
        console.warn('Rejected inline terminal bind: agent is not selected', {
          agentId,
          selectedAgentId: liveSelectedAgentId,
        });
        return false;
      }

      setInlineTerminalsByAgent((previous) => ({
        ...previous,
        [agentId]: { agentId, sessionId },
      }));
      return true;
    },
    [liveSelectedAgentId],
  );

  useEffect(() => {
    setInlineTerminalsByAgent((previous) => {
      let changed = false;
      const next = { ...previous };
      for (const [agentId, entry] of Object.entries(previous)) {
        const presence = agentPresence[entry.agentId];
        const sessionId = presence?.online ? (presence.sessionId ?? null) : null;
        if (sessionId !== entry.sessionId) {
          next[agentId] = { ...entry, sessionId };
          changed = true;
        }
      }
      return changed ? next : previous;
    });
  }, [agentPresence]);

  useEffect(() => {
    if (!liveSelectedAgentId) {
      return;
    }

    const presence = agentPresence[liveSelectedAgentId];
    const sessionId = presence?.online ? (presence.sessionId ?? null) : null;
    setInlineTerminalsByAgent((previous) => {
      if (previous[liveSelectedAgentId]) {
        return previous;
      }

      return {
        ...previous,
        [liveSelectedAgentId]: { agentId: liveSelectedAgentId, sessionId },
      };
    });
  }, [liveSelectedAgentId, agentPresence]);

  useEffect(() => {
    const previousProjectId = previousProjectIdRef.current;
    if (previousProjectId === projectId) {
      return;
    }

    previousProjectIdRef.current = projectId;
    if (previousProjectId !== null) {
      setInlineTerminalsByAgent({});
    }
  }, [projectId]);

  return {
    selectedAgentId,
    selectedAgent,
    handleSelectAgent,
    attachInlineTerminalForAgent,
    inlineTerminalState,
    showInlineTerminal,
    inlineTerminalSessionId,
  };
}
