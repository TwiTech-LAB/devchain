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
    latestSelectedThreadRef.current = selectedThreadId;
  }, [selectedThreadId]);

  // Current thread derived data
  const currentThread = useMemo(
    () => allThreads.find((thread) => thread.id === selectedThreadId) ?? null,
    [allThreads, selectedThreadId],
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
  const inlineTerminalState = selectedThreadId
    ? (inlineTerminalsByThread[selectedThreadId] ?? null)
    : null;
  const showInlineTerminal = Boolean(inlineTerminalState);
  const inlineTerminalSessionId = inlineTerminalState?.sessionId ?? null;

  const incrementInlineUnread = useCallback(() => {
    setInlineUnreadCount((count) => count + 1);
  }, []);

  // Sync inline terminal session IDs when presence updates
  useEffect(() => {
    setInlineTerminalsByThread((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const [threadId, entry] of Object.entries(prev)) {
        const presence = agentPresence[entry.agentId];
        const sessionId = presence?.sessionId ?? null;
        if (sessionId !== entry.sessionId) {
          next[threadId] = { ...entry, sessionId };
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [agentPresence]);

  // Auto-enable inline terminal for newly selected DM threads
  useEffect(() => {
    if (!selectedThreadId || !currentThread || currentThread.isGroup) {
      return;
    }
    if (inlineTerminalsByThread[selectedThreadId]) {
      return;
    }
    const agentId = currentThread.members?.[0];
    if (!agentId) return;
    const presence = agentPresence[agentId];
    const sessionId = presence?.sessionId ?? null;
    setInlineTerminalsByThread((prev) => ({
      ...prev,
      [selectedThreadId]: { agentId, sessionId },
    }));
  }, [selectedThreadId, currentThread, agentPresence, inlineTerminalsByThread]);

  // Reset inline unread when terminal hidden or thread changes
  useEffect(() => {
    if (!showInlineTerminal) {
      setInlineUnreadCount(0);
    }
  }, [showInlineTerminal]);

  useEffect(() => {
    setInlineUnreadCount(0);
  }, [selectedThreadId]);

  // Save draft when message changes
  useEffect(() => {
    if (selectedThreadId) {
      composerDraftsRef.current[selectedThreadId] = messageInput;
    }
  }, [messageInput, selectedThreadId]);

  // Restore draft when thread changes
  useEffect(() => {
    const draft = selectedThreadId ? (composerDraftsRef.current[selectedThreadId] ?? '') : '';
    if (draft !== messageInput) {
      setMessageInput(draft);
    }
    previousThreadIdRef.current = selectedThreadId;
  }, [selectedThreadId, messageInput]);

  // Close terminal menu when thread/agent changes
  useEffect(() => {
    setTerminalMenuOpen(false);
  }, [selectedThreadId, selectedAgent?.id]);

  // Reset state when project changes
  useEffect(() => {
    const previousProjectId = previousProjectIdRef.current;
    const normalizedProjectId = projectId ?? null;

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
  }, [projectId, handleSelectThread]);

  return {
    // Thread selection
    selectedThreadId,
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
