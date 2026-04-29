import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { AgentPresenceMap } from '@/ui/lib/sessions';
import type { Thread } from '@/ui/lib/chat';
import type { AgentOrGuest } from './useChatQueries';

// ============================================
// Types
// ============================================

export interface InlineTerminalEntry {
  agentId: string;
  sessionId: string | null;
}

export interface UseChatThreadUiStateOptions {
  projectId: string | null;
  agentPresence: AgentPresenceMap;
  allThreads: Thread[];
  agents: AgentOrGuest[];
}

export interface UseChatThreadUiStateResult {
  // Thread selection (URL is source of truth)
  selectedThreadId: string | null;
  handleSelectThread: (threadId: string | null, options?: { replace?: boolean }) => void;
  latestSelectedThreadRef: React.RefObject<string | null>;

  // Current thread data
  currentThread: Thread | null;
  currentThreadMembers: Array<{ id: string; name: string; online: boolean }>;
  selectedAgent: AgentOrGuest | null;
  threadDisplayName: string;
  isDirectMessage: boolean;

  // Inline terminal state
  inlineTerminalsByThread: Record<string, InlineTerminalEntry>;
  setInlineTerminalsByThread: React.Dispatch<
    React.SetStateAction<Record<string, InlineTerminalEntry>>
  >;
  attachInlineTerminalForSelectedThread: (agentId: string, sessionId: string | null) => boolean;
  inlineTerminalState: InlineTerminalEntry | null;
  showInlineTerminal: boolean;
  inlineTerminalSessionId: string | null;
  inlineUnreadCount: number;
  setInlineUnreadCount: React.Dispatch<React.SetStateAction<number>>;
  incrementInlineUnread: () => void;

  // Message draft state
  messageInput: string;
  setMessageInput: React.Dispatch<React.SetStateAction<string>>;
  composerDraftsRef: React.RefObject<Record<string, string>>;

  // Dialog states
  groupDialogOpen: boolean;
  setGroupDialogOpen: React.Dispatch<React.SetStateAction<boolean>>;
  inviteDialogOpen: boolean;
  setInviteDialogOpen: React.Dispatch<React.SetStateAction<boolean>>;
  settingsDialogOpen: boolean;
  setSettingsDialogOpen: React.Dispatch<React.SetStateAction<boolean>>;
  clearHistoryDialogOpen: boolean;
  setClearHistoryDialogOpen: React.Dispatch<React.SetStateAction<boolean>>;
  terminalMenuOpen: boolean;
  setTerminalMenuOpen: React.Dispatch<React.SetStateAction<boolean>>;
}

// ============================================
// Hook
// ============================================

export function useChatThreadUiState({
  projectId,
  agentPresence,
  allThreads,
  agents,
}: UseChatThreadUiStateOptions): UseChatThreadUiStateResult {
  const [searchParams, setSearchParams] = useSearchParams();

  // URL-derived thread selection
  const selectedThreadId = useMemo(() => {
    const t = searchParams.get('thread');
    return t ? t : null;
  }, [searchParams]);

  const latestSelectedThreadRef = useRef<string | null>(null);
  const previousProjectIdRef = useRef<string | null>(null);
  const previousThreadIdRef = useRef<string | null>(null);
  const normalizedProjectId = projectId ?? null;
  const projectChanged =
    previousProjectIdRef.current !== null && previousProjectIdRef.current !== normalizedProjectId;
  const effectiveSelectedThreadId = projectChanged ? null : selectedThreadId;

  // Inline terminal state
  const [inlineTerminalsByThread, setInlineTerminalsByThread] = useState<
    Record<string, InlineTerminalEntry>
  >({});
  const [inlineUnreadCount, setInlineUnreadCount] = useState(0);

  // Message draft state
  const [messageInput, setMessageInput] = useState('');
  const composerDraftsRef = useRef<Record<string, string>>({});

  // Dialog states
  const [groupDialogOpen, setGroupDialogOpen] = useState(false);
  const [inviteDialogOpen, setInviteDialogOpen] = useState(false);
  const [settingsDialogOpen, setSettingsDialogOpen] = useState(false);
  const [clearHistoryDialogOpen, setClearHistoryDialogOpen] = useState(false);
  const [terminalMenuOpen, setTerminalMenuOpen] = useState(false);

  // Thread selection handler
  const handleSelectThread = useCallback(
    (threadId: string | null, { replace = false }: { replace?: boolean } = {}) => {
      const params = new URLSearchParams(searchParams);
      const currentThread = params.get('thread');
      const target = threadId ?? null;
      if ((target && currentThread === target) || (!target && !currentThread)) {
        latestSelectedThreadRef.current = target;
        return;
      }

      if (threadId) {
        params.set('thread', threadId);
      } else {
        params.delete('thread');
      }
      latestSelectedThreadRef.current = target;
      setSearchParams(params, { replace });
    },
    [searchParams, setSearchParams],
  );

  // Keep ref in sync
  useEffect(() => {
    latestSelectedThreadRef.current = effectiveSelectedThreadId;
  }, [effectiveSelectedThreadId]);

  // Current thread derived data
  const currentThread = useMemo(
    () => allThreads.find((thread) => thread.id === effectiveSelectedThreadId) ?? null,
    [allThreads, effectiveSelectedThreadId],
  );

  const currentThreadMembers = useMemo(() => {
    if (!currentThread?.members) {
      return [];
    }

    return currentThread.members
      .map((memberId) => {
        const agent = agents.find((a) => a.id === memberId);
        if (!agent) {
          return null;
        }
        const presence = agentPresence[memberId];
        return {
          id: memberId,
          name: agent.name,
          online: presence?.online ?? false,
        };
      })
      .filter((member): member is { id: string; name: string; online: boolean } => Boolean(member));
  }, [currentThread, agents, agentPresence]);

  // For direct threads, get the agent from thread members
  const selectedAgent = useMemo(() => {
    if (!currentThread || currentThread.isGroup || !currentThread.members?.length) {
      return null;
    }
    const agentId = currentThread.members[0];
    return agents.find((agent) => agent.id === agentId) ?? null;
  }, [currentThread, agents]);

  const threadDisplayName = useMemo(() => {
    if (currentThread) {
      if (currentThread.title && currentThread.title.trim().length > 0) {
        return currentThread.title;
      }
      if (currentThread.createdByType === 'agent') {
        return currentThread.title || 'Agent Thread';
      }
      if (currentThread.isGroup) {
        const fallback = currentThreadMembers.map((member) => member.name).join(', ');
        return fallback || 'Group Thread';
      }
    }
    return selectedAgent?.name ?? 'Conversation';
  }, [currentThread, currentThreadMembers, selectedAgent]);

  const isDirectMessage = Boolean(currentThread && !currentThread.isGroup);

  // Inline terminal derived state
  const inlineTerminalState = effectiveSelectedThreadId
    ? (inlineTerminalsByThread[effectiveSelectedThreadId] ?? null)
    : null;
  const showInlineTerminal = Boolean(inlineTerminalState);
  const inlineTerminalSessionId = inlineTerminalState?.sessionId ?? null;

  const incrementInlineUnread = useCallback(() => {
    setInlineUnreadCount((count) => count + 1);
  }, []);

  const attachInlineTerminalForSelectedThread = useCallback(
    (agentId: string, sessionId: string | null): boolean => {
      const threadId = effectiveSelectedThreadId;
      if (!threadId) return false;

      const thread = allThreads.find((t) => t.id === threadId);
      if (!thread || thread.isGroup || thread.members?.[0] !== agentId) {
        console.warn('Rejected inline terminal bind: agent not selected thread DM member', {
          agentId,
          threadId,
          expectedAgentId: thread?.members?.[0],
        });
        return false;
      }

      setInlineTerminalsByThread((prev) => ({
        ...prev,
        [threadId]: { agentId, sessionId },
      }));
      setTerminalMenuOpen(false);
      setInlineUnreadCount(0);
      return true;
    },
    [effectiveSelectedThreadId, allThreads],
  );

  // Sync inline terminal session IDs when presence updates
  useEffect(() => {
    setInlineTerminalsByThread((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const [threadId, entry] of Object.entries(prev)) {
        const thread = allThreads.find((t) => t.id === threadId);
        // reason: thread may be absent during loading/refetch — preserve entry to avoid data loss
        if (!thread) continue;
        if (thread.isGroup || thread.members?.[0] !== entry.agentId) continue;

        const presence = agentPresence[entry.agentId];
        const sessionId = presence?.sessionId ?? null;
        if (sessionId !== entry.sessionId) {
          next[threadId] = { ...entry, sessionId };
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [agentPresence, allThreads]);

  // Auto-enable inline terminal for newly selected DM threads
  useEffect(() => {
    if (!effectiveSelectedThreadId || !currentThread || currentThread.isGroup) {
      return;
    }
    if (inlineTerminalsByThread[effectiveSelectedThreadId]) {
      return;
    }
    const agentId = currentThread.members?.[0];
    if (!agentId) return;
    const presence = agentPresence[agentId];
    const sessionId = presence?.sessionId ?? null;
    setInlineTerminalsByThread((prev) => ({
      ...prev,
      [effectiveSelectedThreadId]: { agentId, sessionId },
    }));
  }, [effectiveSelectedThreadId, currentThread, agentPresence, inlineTerminalsByThread]);

  // Reset inline unread when terminal hidden or thread changes
  useEffect(() => {
    if (!showInlineTerminal) {
      setInlineUnreadCount(0);
    }
  }, [showInlineTerminal]);

  useEffect(() => {
    setInlineUnreadCount(0);
  }, [effectiveSelectedThreadId]);

  // Save draft when message changes
  useEffect(() => {
    if (effectiveSelectedThreadId) {
      composerDraftsRef.current[effectiveSelectedThreadId] = messageInput;
    }
  }, [messageInput, effectiveSelectedThreadId]);

  // Restore draft when thread changes
  useEffect(() => {
    const draft = effectiveSelectedThreadId
      ? (composerDraftsRef.current[effectiveSelectedThreadId] ?? '')
      : '';
    if (draft !== messageInput) {
      setMessageInput(draft);
    }
    previousThreadIdRef.current = effectiveSelectedThreadId;
  }, [effectiveSelectedThreadId, messageInput]);

  // Close terminal menu when thread/agent changes
  useEffect(() => {
    setTerminalMenuOpen(false);
  }, [effectiveSelectedThreadId, selectedAgent?.id]);

  // Reset state when project changes
  useEffect(() => {
    const previousProjectId = previousProjectIdRef.current;

    if (previousProjectId === normalizedProjectId) {
      return;
    }

    previousProjectIdRef.current = normalizedProjectId;

    handleSelectThread(null, { replace: true });
    setGroupDialogOpen(false);
    setInviteDialogOpen(false);
    setSettingsDialogOpen(false);
    setClearHistoryDialogOpen(false);
    composerDraftsRef.current = {};
    previousThreadIdRef.current = null;
    setMessageInput('');
  }, [normalizedProjectId, handleSelectThread]);

  return {
    // Thread selection
    selectedThreadId: effectiveSelectedThreadId,
    handleSelectThread,
    latestSelectedThreadRef,

    // Current thread data
    currentThread,
    currentThreadMembers,
    selectedAgent,
    threadDisplayName,
    isDirectMessage,

    // Inline terminal state
    inlineTerminalsByThread,
    setInlineTerminalsByThread,
    attachInlineTerminalForSelectedThread,
    inlineTerminalState,
    showInlineTerminal,
    inlineTerminalSessionId,
    inlineUnreadCount,
    setInlineUnreadCount,
    incrementInlineUnread,

    // Message draft state
    messageInput,
    setMessageInput,
    composerDraftsRef,

    // Dialog states
    groupDialogOpen,
    setGroupDialogOpen,
    inviteDialogOpen,
    setInviteDialogOpen,
    settingsDialogOpen,
    setSettingsDialogOpen,
    clearHistoryDialogOpen,
    setClearHistoryDialogOpen,
    terminalMenuOpen,
    setTerminalMenuOpen,
  };
}
