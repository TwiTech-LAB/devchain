import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import type { Socket } from 'socket.io-client';
import { getAppSocket, releaseAppSocket, type WsEnvelope } from '@/ui/lib/socket';
import { useAppSocket } from '@/ui/hooks/useAppSocket';
import { Button } from '@/ui/components/ui/button';
import { Textarea } from '@/ui/components/ui/textarea';
import { Badge } from '@/ui/components/ui/badge';
import { ScrollArea } from '@/ui/components/ui/scroll-area';
import { Separator } from '@/ui/components/ui/separator';
import { Skeleton } from '@/ui/components/ui/skeleton';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/components/ui/popover';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/ui/components/ui/context-menu';
// Inline terminal components
import { InlineTerminalPanel } from '@/ui/components/chat/InlineTerminalPanel';
import { InlineTerminalHeader } from '@/ui/components/chat/InlineTerminalHeader';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/components/ui/dialog';
import { cn } from '@/ui/lib/utils';
import {
  Plus,
  Send,
  Circle,
  Terminal,
  ChevronDown,
  UserPlus,
  Users,
  MessageSquare,
  Settings,
  Loader2,
  AlertCircle,
  MoreVertical,
  Power,
  RotateCcw,
  Play,
  Square,
} from 'lucide-react';
import {
  fetchAgentPresence,
  fetchActiveSessions,
  terminateSession,
  restartSession,
  launchSession,
  type ActiveSession,
} from '@/ui/lib/sessions';
import { useTerminalWindowManager, useTerminalWindows } from '@/ui/terminal-windows';
import {
  fetchThreads,
  createGroupThread,
  fetchMessages,
  createMessage,
  inviteMembers,
  clearHistory,
  purgeHistory,
  parseMentions,
  type Message,
  type Thread,
} from '@/ui/lib/chat';
import { useChatLauncher } from '@/ui/components/chat/ChatLauncher';
import { GroupCreationDialog } from '@/ui/components/chat/GroupCreationDialog';
import { InviteMembersDialog } from '@/ui/components/chat/InviteMembersDialog';
import { ChatSettingsDialog } from '@/ui/components/chat/ChatSettingsDialog';
import { useToast } from '@/ui/hooks/use-toast';
import { useMentionAutocomplete } from '@/ui/hooks/useMentionAutocomplete';
import { useSelectedProject } from '@/ui/hooks/useProjectSelection';
import { usePointerCoarse } from '@/ui/hooks/usePointerCoarse';
import { getProviderIconDataUri } from '@/ui/lib/providers';

// ChatSoftDisable: flip to true to re-enable chat settings/invite entry points and clear-history UI.
const CHAT_SETTINGS_AND_INVITES_ENABLED = false;
const CHAT_CLEAR_HISTORY_ENABLED = false;
const CHAT_INLINE_TERMINAL_ENABLED = false;
const CHAT_THREADS_ENABLED = false;

// WsEnvelope imported from shared lib

export function ChatPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [messageInput, setMessageInput] = useState('');
  // Selected thread derives from URL; no local state mirror
  const selectedThreadId = useMemo(() => {
    const t = searchParams.get('thread');
    return t ? t : null;
  }, [searchParams]);
  const [groupDialogOpen, setGroupDialogOpen] = useState(false);
  const [inviteDialogOpen, setInviteDialogOpen] = useState(false);
  const [settingsDialogOpen, setSettingsDialogOpen] = useState(false);
  const [clearHistoryDialogOpen, setClearHistoryDialogOpen] = useState(false);
  const [inlineTerminalsByThread, setInlineTerminalsByThread] = useState<
    Record<string, { agentId: string; sessionId: string | null }>
  >({});
  const [terminalMenuOpen, setTerminalMenuOpen] = useState(false);
  const [launchingAgentIds, setLaunchingAgentIds] = useState<Record<string, boolean>>({});
  const [restartingAgentId, setRestartingAgentId] = useState<string | null>(null);
  const [terminateConfirm, setTerminateConfirm] = useState<{
    agentId: string;
    sessionId: string;
  } | null>(null);
  const [batchLaunching, setBatchLaunching] = useState(false);
  const [startingAll, setStartingAll] = useState(false);
  const [terminatingAll, setTerminatingAll] = useState(false);
  const [terminateAllConfirm, setTerminateAllConfirm] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const socketRef = useRef<Socket | null>(null);
  const subscribedThreadRef = useRef<string | null>(null);
  const latestSelectedThreadRef = useRef<string | null>(null);
  const socketInitializedRef = useRef(false);
  const previousProjectIdRef = useRef<string | null>(null);
  const composerDraftsRef = useRef<Record<string, string>>({});
  const previousThreadIdRef = useRef<string | null>(null);
  const terminalMenuTriggerRef = useRef<HTMLButtonElement | null>(null);

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
  const openTerminalWindow = useTerminalWindowManager();
  const { windows: terminalWindows, closeWindow, focusedWindowId } = useTerminalWindows();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { selectedProjectId, projectsLoading } = useSelectedProject();
  const projectId = selectedProjectId ?? null;
  const hasSelectedProject = Boolean(projectId);
  const isCoarsePointer = usePointerCoarse();
  const inlineTerminalState = selectedThreadId
    ? (inlineTerminalsByThread[selectedThreadId] ?? null)
    : null;
  const isInlineTerminalActive = Boolean(inlineTerminalState);
  const inlineTerminalSessionId = inlineTerminalState?.sessionId ?? null;
  const isInlineSessionWindowOpen = useMemo(() => {
    if (!inlineTerminalSessionId) return false;
    return terminalWindows.some((w) => w.id === inlineTerminalSessionId && !w.minimized);
  }, [inlineTerminalSessionId, terminalWindows]);
  const { data: agentPresence = {}, isLoading: agentPresenceLoading } = useQuery({
    queryKey: ['agent-presence', projectId],
    queryFn: () => fetchAgentPresence(projectId!),
    enabled: hasSelectedProject,
    refetchInterval: 10000,
  });
  const showInlineTerminal = Boolean(inlineTerminalState);
  const [inlineUnreadCount, setInlineUnreadCount] = useState(0);
  const presenceReady = !agentPresenceLoading;
  const inlineActiveRef = useRef(showInlineTerminal);

  // Track active state flag used for inline unread count updates
  useEffect(() => {
    inlineActiveRef.current = showInlineTerminal;
  }, [showInlineTerminal]);

  // Chat launcher for direct thread creation
  const { launchChat, isLaunching: isLaunchingChat } = useChatLauncher({
    projectId: projectId!,
  });

  // Fetch active sessions for terminal opening
  const { data: activeSessions = [] } = useQuery({
    queryKey: ['active-sessions', projectId],
    queryFn: () => fetchActiveSessions(projectId!),
    enabled: hasSelectedProject,
    refetchInterval: 10000,
  });

  // Tick for relative durations (busy badge)
  const [, setNowTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setNowTick((n) => (n + 1) % 1000000), 1000);
    return () => clearInterval(id);
  }, []);

  // Fetch agents
  const {
    data: agentsResponse = [],
    isLoading: agentsLoading,
    isError: agentsError,
  } = useQuery({
    queryKey: ['agents', projectId],
    queryFn: async () => {
      const response = await fetch(`/api/agents?projectId=${projectId}`);
      if (!response.ok) {
        throw new Error('Failed to fetch agents');
      }
      return response.json();
    },
    enabled: hasSelectedProject,
  });

  // Fetch agent profiles for provider lookup
  const { data: profilesResponse = [] } = useQuery({
    queryKey: ['profiles', projectId],
    queryFn: async () => {
      const response = await fetch(`/api/profiles?projectId=${encodeURIComponent(projectId!)}`);
      if (!response.ok) {
        throw new Error('Failed to fetch profiles');
      }
      return response.json();
    },
    enabled: hasSelectedProject,
  });

  // Fetch providers (global, not project-specific)
  const { data: providersResponse = [] } = useQuery({
    queryKey: ['providers'],
    queryFn: async () => {
      const response = await fetch('/api/providers');
      if (!response.ok) {
        throw new Error('Failed to fetch providers');
      }
      return response.json();
    },
  });

  // Fetch user threads (groups + direct messages)
  const { data: userThreadsData, isLoading: userThreadsLoading } = useQuery({
    queryKey: ['threads', projectId, 'user'],
    queryFn: () => fetchThreads(projectId!, 'user'),
    enabled: hasSelectedProject,
  });

  // Fetch agent threads
  const { data: agentThreadsData, isLoading: agentThreadsLoading } = useQuery({
    queryKey: ['threads', projectId, 'agent'],
    queryFn: () => fetchThreads(projectId!, 'agent'),
    enabled: hasSelectedProject,
  });

  // Group creation mutation
  const createGroupMutation = useMutation({
    mutationFn: ({ agentIds, title }: { agentIds: string[]; title?: string }) => {
      if (!projectId) {
        throw new Error('Select a project before creating a group.');
      }
      return createGroupThread({ projectId: projectId!, agentIds, title });
    },
    onSuccess: (thread) => {
      if (projectId) {
        queryClient.invalidateQueries({ queryKey: ['threads', projectId, 'user'] });
        queryClient.invalidateQueries({ queryKey: ['threads', projectId, 'agent'] });
      }
      handleSelectThread(thread.id);
      toast({
        title: 'Group created',
        description: `Group "${thread.title || 'Untitled'}" has been created.`,
      });
    },
    onError: (error: Error) => {
      toast({
        title: 'Failed to create group',
        description: error.message,
        variant: 'destructive',
      });
    },
  });

  const inviteMembersMutation = useMutation({
    mutationFn: ({
      threadId,
      agentIds,
      inviterName,
    }: {
      threadId: string;
      agentIds: string[];
      inviterName?: string;
    }) => inviteMembers(threadId, { agentIds, inviterName, projectId: projectId! }),
    onSuccess: (thread) => {
      if (projectId) {
        queryClient.invalidateQueries({ queryKey: ['threads', projectId, 'user'] });
        queryClient.invalidateQueries({ queryKey: ['threads', projectId, 'agent'] });
      }
      if (thread.id === selectedThreadId) {
        refetchMessages();
      }
      toast({
        title: 'Agents invited',
        description: 'Invite messages have been posted to the thread.',
      });
    },
    onError: (error: Error) => {
      toast({
        title: 'Failed to invite agents',
        description: error.message,
        variant: 'destructive',
      });
    },
  });

  const clearHistoryMutation = useMutation({
    mutationFn: (threadId: string) => clearHistory(threadId, { announce: true }),
    onSuccess: () => {
      if (projectId && selectedThreadId) {
        queryClient.invalidateQueries({ queryKey: ['messages', selectedThreadId, projectId] });
      }
      refetchMessages();
      toast({
        title: 'History cleared',
        description: 'Messages before this point have been hidden.',
      });
    },
    onError: (error: Error) => {
      toast({
        title: 'Failed to clear history',
        description: error.message,
        variant: 'destructive',
      });
    },
  });

  const purgeHistoryMutation = useMutation({
    mutationFn: (threadId: string) => purgeHistory(threadId, { announce: true }),
    onSuccess: () => {
      if (projectId && selectedThreadId) {
        queryClient.invalidateQueries({ queryKey: ['messages', selectedThreadId, projectId] });
      }
      refetchMessages();
      toast({
        title: 'History purged',
        description: 'Older messages have been permanently removed.',
      });
    },
    onError: (error: Error) => {
      toast({
        title: 'Failed to purge history',
        description: error.message,
        variant: 'destructive',
      });
    },
  });

  // Fetch messages for selected thread
  const { data: messagesData, refetch: refetchMessages } = useQuery({
    queryKey: ['messages', selectedThreadId, projectId],
    queryFn: () => fetchMessages(selectedThreadId!, projectId!),
    enabled: Boolean(selectedThreadId && projectId),
  });

  // Message sending mutation
  const sendMessageMutation = useMutation({
    mutationFn: ({
      threadId,
      content,
      targets,
    }: {
      threadId: string;
      content: string;
      targets?: string[];
    }) =>
      createMessage(threadId, {
        content,
        authorType: 'user',
        projectId: projectId!,
        targets,
      }),
    onSuccess: () => {
      if (projectId) {
        queryClient.invalidateQueries({ queryKey: ['messages', selectedThreadId, projectId] });
      }
      refetchMessages();
      setMessageInput('');
    },
    onError: (error: Error) => {
      toast({
        title: 'Failed to send message',
        description: error.message,
        variant: 'destructive',
      });
    },
  });

  const agents = useMemo(() => {
    if (Array.isArray(agentsResponse)) {
      return agentsResponse;
    }

    if (agentsResponse && Array.isArray((agentsResponse as { items?: unknown[] }).items)) {
      return (agentsResponse as { items: Array<{ id: string; name: string }> }).items;
    }

    return [];
  }, [agentsResponse]);

  // Derived state for batch operations
  const offlineAgents = useMemo(
    () => (presenceReady ? agents.filter((a) => !agentPresence[a.id]?.online) : []),
    [presenceReady, agents, agentPresence],
  );

  const agentsWithSessions = useMemo(
    () =>
      presenceReady
        ? agents.filter((a) => agentPresence[a.id]?.online && agentPresence[a.id]?.sessionId)
        : [],
    [presenceReady, agents, agentPresence],
  );

  // Normalize profiles response
  const profiles = useMemo(() => {
    if (Array.isArray(profilesResponse)) {
      return profilesResponse as Array<{ id: string; providerId: string }>;
    }
    if (profilesResponse && Array.isArray((profilesResponse as { items?: unknown[] }).items)) {
      return (profilesResponse as { items: Array<{ id: string; providerId: string }> }).items;
    }
    return [];
  }, [profilesResponse]);

  // Normalize providers response
  const providers = useMemo(() => {
    if (Array.isArray(providersResponse)) {
      return providersResponse as Array<{ id: string; name: string }>;
    }
    if (providersResponse && Array.isArray((providersResponse as { items?: unknown[] }).items)) {
      return (providersResponse as { items: Array<{ id: string; name: string }> }).items;
    }
    return [];
  }, [providersResponse]);

  // Build agent → provider lookup map
  // Join: agent.profileId → profile.providerId → provider.name
  const agentToProviderMap = useMemo(() => {
    const map = new Map<string, string>();
    const profileMap = new Map(profiles.map((p) => [p.id, p.providerId]));
    const providerMap = new Map(providers.map((p) => [p.id, p.name]));

    for (const agent of agents as Array<{ id: string; profileId?: string }>) {
      if (agent.profileId) {
        const providerId = profileMap.get(agent.profileId);
        if (providerId) {
          const providerName = providerMap.get(providerId);
          if (providerName) {
            map.set(agent.id, providerName);
          }
        }
      }
    }
    return map;
  }, [agents, profiles, providers]);

  // Helper to get provider name for an agent
  const getProviderForAgent = useCallback(
    (agentId: string | null | undefined): string | null => {
      if (!agentId) return null;
      return agentToProviderMap.get(agentId) ?? null;
    },
    [agentToProviderMap],
  );

  const userThreads: Thread[] = userThreadsData?.items ?? [];
  const groups = userThreads
    .filter((t) => t.isGroup)
    .map((g) => ({
      ...g,
      memberCount: g.members?.length ?? 0,
      name: g.title ?? 'Untitled Group',
    }));

  const agentThreads: Thread[] = agentThreadsData?.items ?? [];

  const allThreads = useMemo(() => [...userThreads, ...agentThreads], [userThreads, agentThreads]);

  const currentThread = useMemo(
    () => allThreads.find((thread) => thread.id === selectedThreadId) ?? null,
    [allThreads, selectedThreadId],
  );

  useEffect(() => {
    latestSelectedThreadRef.current = selectedThreadId;
  }, [selectedThreadId]);

  // Sync inline terminal session IDs when presence updates (e.g., launch via context menu)
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

  useEffect(() => {
    // Auto-enable inline terminal for newly selected DM threads.
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

  useEffect(() => {
    inlineActiveRef.current = showInlineTerminal;
    if (!showInlineTerminal) {
      setInlineUnreadCount(0);
    }
  }, [showInlineTerminal]);

  useEffect(() => {
    if (selectedThreadId) {
      composerDraftsRef.current[selectedThreadId] = messageInput;
    }
  }, [messageInput, selectedThreadId]);

  useEffect(() => {
    setInlineUnreadCount(0);
  }, [selectedThreadId]);

  useEffect(() => {
    const draft = selectedThreadId ? (composerDraftsRef.current[selectedThreadId] ?? '') : '';
    if (draft !== messageInput) {
      setMessageInput(draft);
    }
    previousThreadIdRef.current = selectedThreadId;
  }, [selectedThreadId, messageInput]);

  // Mention autocomplete hook
  const {
    showAutocomplete,
    mentionQuery,
    selectedIndex,
    handleInputChange,
    handleKeyDown: handleAutocompleteKeyDown,
    insertMention,
  } = useMentionAutocomplete(textareaRef, agents);

  // For direct threads, get the agent from thread members
  const selectedAgent = useMemo(() => {
    if (!currentThread || currentThread.isGroup || !currentThread.members?.length) {
      return null;
    }
    // Direct thread has exactly one member
    const agentId = currentThread.members[0];
    return agents.find((agent: { id: string; name: string }) => agent.id === agentId) ?? null;
  }, [currentThread, agents]);

  useEffect(() => {
    setTerminalMenuOpen(false);
  }, [selectedThreadId, selectedAgent?.id]);

  const currentThreadMembers = useMemo(() => {
    if (!currentThread?.members) {
      return [];
    }

    return currentThread.members
      .map((memberId) => {
        const agent = agents.find((a: { id: string; name: string }) => a.id === memberId);
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

  const selectedAgentPresence = selectedAgent ? agentPresence[selectedAgent.id] : undefined;
  const isSelectedAgentOnline = Boolean(selectedAgentPresence?.online);
  const offlineGroupMembers = useMemo(() => {
    if (!currentThread?.isGroup) return [];
    return currentThreadMembers.filter((member) => !member.online);
  }, [currentThread, currentThreadMembers]);

  const canInviteMembers = Boolean(
    currentThread && currentThread.isGroup && currentThread.createdByType === 'user',
  );

  const inviteableAgents = useMemo(() => {
    if (!currentThread?.members) {
      return agents;
    }

    return agents.filter(
      (agent: { id: string; name: string }) => !currentThread.members!.includes(agent.id),
    );
  }, [agents, currentThread]);

  const sampleInviteeName =
    inviteableAgents.length > 0 ? inviteableAgents[0].name : 'Invited Agent';

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

  const messages: Message[] = messagesData?.items ?? [];

  // Initialize shared socket reference and subscribe to events
  useEffect(() => {
    // Keep a handle to the shared socket for emit calls elsewhere in the component
    socketRef.current = getAppSocket();
    return () => {
      // Release socket reference on unmount
      releaseAppSocket();
      socketRef.current = null;
    };
  }, []);

  // Subscribe to socket events via shared hook
  useAppSocket(
    {
      connect: () => {
        const socket = getAppSocket();
        const threadToSubscribe = subscribedThreadRef.current ?? latestSelectedThreadRef.current;
        if (threadToSubscribe) {
          socket.emit('chat:subscribe', { threadId: threadToSubscribe });
          subscribedThreadRef.current = threadToSubscribe;
        }
      },
      disconnect: () => {
        subscribedThreadRef.current = null;
      },
      message: (envelope: WsEnvelope) => {
        const { topic, type, payload } = envelope;

        // Handle message.created events for chat threads
        if (topic.startsWith('chat/') && type === 'message.created') {
          const threadId = topic.split('/')[1];
          const message = payload as Message;
          queryClient.invalidateQueries({ queryKey: ['messages', threadId] });

          const activeThreadId = latestSelectedThreadRef.current;
          if (threadId === activeThreadId && message.authorType === 'agent') {
            const agentName =
              agents.find((a: { id: string; name: string }) => a.id === message.authorAgentId)
                ?.name || 'Agent';
            toast({
              title: `New message from ${agentName}`,
              description:
                message.content.substring(0, 50) + (message.content.length > 50 ? '...' : ''),
            });
          }

          if (threadId === latestSelectedThreadRef.current && inlineActiveRef.current) {
            setInlineUnreadCount((count) => count + 1);
          }
        }

        // Presence updates
        if (topic.startsWith('agent/') && type === 'presence') {
          queryClient.invalidateQueries({ queryKey: ['agent-presence'] });
        }
        // Session activity updates
        if (topic.startsWith('session/') && type === 'activity') {
          queryClient.invalidateQueries({ queryKey: ['agent-presence'] });
        }
        // Future: message.read for unread counts
        if (topic === 'system' && type === 'ping') {
          getAppSocket().emit('pong');
        }
      },
    },
    [agents, queryClient, toast],
  );

  // If project context is removed, unsubscribe from current thread but do not disconnect
  useEffect(() => {
    const socket = getAppSocket();
    if (!hasSelectedProject) {
      if (socket.connected && subscribedThreadRef.current) {
        socket.emit('chat:unsubscribe', { threadId: subscribedThreadRef.current });
      }
      subscribedThreadRef.current = null;
      socketInitializedRef.current = false;
      return;
    }
  }, [hasSelectedProject]);

  // Subscribe to chat thread when selected
  useEffect(() => {
    const socket = getAppSocket();
    if (!socket.connected) {
      subscribedThreadRef.current = selectedThreadId ?? null;
      return;
    }

    if (!selectedThreadId) {
      if (subscribedThreadRef.current) {
        socket.emit('chat:unsubscribe', { threadId: subscribedThreadRef.current });
        subscribedThreadRef.current = null;
      }
      return;
    }

    if (subscribedThreadRef.current === selectedThreadId) {
      return;
    }

    if (subscribedThreadRef.current) {
      socket.emit('chat:unsubscribe', { threadId: subscribedThreadRef.current });
    }
    socket.emit('chat:subscribe', { threadId: selectedThreadId });
    subscribedThreadRef.current = selectedThreadId;
  }, [selectedThreadId]);

  // URL is source of truth; no back-sync effect needed

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

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // ESC key interception for terminal sessions
  useEffect(() => {
    const handleGlobalEscape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;

      // Skip if any modal is open - let normal ESC handling close modals
      if (groupDialogOpen || inviteDialogOpen || settingsDialogOpen || clearHistoryDialogOpen) {
        return;
      }

      let targetSessionId: string | null = null;

      // Priority 1: Inline terminal (if active)
      if (showInlineTerminal && inlineTerminalSessionId) {
        targetSessionId = inlineTerminalSessionId;
      }
      // Priority 2: Focused floating window
      else if (focusedWindowId) {
        targetSessionId = focusedWindowId;
      }

      if (targetSessionId && socketRef.current?.connected) {
        e.preventDefault();
        e.stopPropagation();
        socketRef.current.emit('terminal:input', {
          sessionId: targetSessionId,
          data: '\x1b', // ESC character
        });
      }
    };

    document.addEventListener('keydown', handleGlobalEscape, { capture: true });
    return () => document.removeEventListener('keydown', handleGlobalEscape, { capture: true });
  }, [
    groupDialogOpen,
    inviteDialogOpen,
    settingsDialogOpen,
    clearHistoryDialogOpen,
    showInlineTerminal,
    inlineTerminalSessionId,
    focusedWindowId,
  ]);

  const handleSendMessage = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!messageInput.trim() || !selectedThreadId) return;

    // Parse @mentions from the message
    const targets = parseMentions(messageInput, agents);

    sendMessageMutation.mutate({
      threadId: selectedThreadId,
      content: messageInput,
      targets: targets.length > 0 ? targets : undefined,
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Handle autocomplete navigation first
    const autocompleteHandled = handleAutocompleteKeyDown(e, messageInput, setMessageInput);
    if (autocompleteHandled) {
      return;
    }

    // Handle send on Ctrl/Cmd+Enter
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      handleSendMessage();
    }
  };

  // Helper to format timestamp
  const formatTimestamp = (isoString: string) => {
    const date = new Date(isoString);
    const now = new Date();
    const isToday =
      date.getDate() === now.getDate() &&
      date.getMonth() === now.getMonth() &&
      date.getFullYear() === now.getFullYear();

    if (isToday) {
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    return date.toLocaleDateString([], {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  // Helper to get agent name by ID
  const getAgentName = (agentId: string | null) => {
    if (!agentId) return null;
    return agents.find((a: { id: string; name: string }) => a.id === agentId)?.name;
  };

  const inlineTerminalAgentName = inlineTerminalState
    ? getAgentName(inlineTerminalState.agentId)
    : null;
  const inlineTerminalAgentId = inlineTerminalState?.agentId ?? null;

  const handleCreateGroup = () => {
    setGroupDialogOpen(true);
  };

  const handleGroupCreation = async (selectedAgentIds: string[], title?: string) => {
    if (!projectId) {
      toast({
        title: 'Select a project',
        description: 'Choose a project before creating a group chat.',
        variant: 'destructive',
      });
      return;
    }
    await createGroupMutation.mutateAsync({ agentIds: selectedAgentIds, title });
  };

  const handleInviteMembers = async (agentIds: string[], inviterName?: string) => {
    if (!selectedThreadId || !projectId) {
      return;
    }
    await inviteMembersMutation.mutateAsync({
      threadId: selectedThreadId,
      agentIds,
      inviterName,
    });
  };

  const handleLaunchSession = useCallback(
    async (
      agentId: string,
      { attach = true, silent = false }: { attach?: boolean; silent?: boolean } = {},
    ) => {
      if (!projectId) {
        if (!silent) {
          toast({
            title: 'Select a project',
            description: 'Choose a project before launching a session.',
            variant: 'destructive',
          });
        }
        return null;
      }
      if (attach && !selectedThreadId) {
        if (!silent) {
          toast({
            title: 'Select a conversation',
            description: 'Choose a chat thread before attaching an inline terminal.',
            variant: 'destructive',
          });
        }
        return null;
      }

      setLaunchingAgentIds((prev) => ({ ...prev, [agentId]: true }));
      try {
        const raw = await launchSession(agentId, projectId);
        if (!raw || typeof raw !== 'object' || !('id' in raw)) {
          throw new Error('Unexpected response when launching session');
        }

        const session: ActiveSession = {
          id: raw.id,
          epicId: raw.epicId ?? null,
          agentId: raw.agentId ?? agentId,
          tmuxSessionId: raw.tmuxSessionId ?? null,
          status: raw.status ?? 'running',
          startedAt: raw.startedAt,
          endedAt: raw.endedAt ?? null,
          createdAt: raw.createdAt,
          updatedAt: raw.updatedAt,
        };

        if (!silent) {
          toast({
            title: 'Session launched',
            description: `Session ${session.id.slice(0, 8)} started.`,
          });
        }

        if (attach && selectedThreadId) {
          setInlineTerminalsByThread((prev) => ({
            ...prev,
            [selectedThreadId]: { agentId: session.agentId ?? agentId, sessionId: session.id },
          }));
          setTerminalMenuOpen(false);
          setInlineUnreadCount(0);
        }

        if (!silent) {
          queryClient.invalidateQueries({ queryKey: ['agent-presence', projectId] });
          queryClient.invalidateQueries({ queryKey: ['active-sessions', projectId] });
        }

        return session;
      } catch (error) {
        if (!silent) {
          toast({
            title: 'Failed to launch session',
            description:
              error instanceof Error ? error.message : 'Unable to launch session right now.',
            variant: 'destructive',
          });
        }
        return null;
      } finally {
        setLaunchingAgentIds((prev) => {
          const next = { ...prev };
          delete next[agentId];
          return next;
        });
      }
    },
    [
      projectId,
      selectedThreadId,
      toast,
      queryClient,
      setInlineTerminalsByThread,
      setTerminalMenuOpen,
    ],
  );

  const handleRestartSession = useCallback(
    async (agentId: string) => {
      if (!projectId) {
        toast({
          title: 'Select a project',
          description: 'Choose a project before restarting a session.',
          variant: 'destructive',
        });
        return;
      }
      const presence = agentPresence[agentId];
      const sessionId = presence?.sessionId ?? null;
      setRestartingAgentId(agentId);
      try {
        let session: ActiveSession;
        let terminateWarning: string | undefined;

        if (sessionId) {
          const result = await restartSession(agentId, projectId, sessionId);
          session = result.session;
          terminateWarning = result.terminateWarning;
        } else {
          session = await launchSession(agentId, projectId);
        }

        if (terminateWarning) {
          toast({
            title: 'Session restarted with warning',
            description: terminateWarning,
            variant: 'destructive',
          });
        } else {
          toast({
            title: sessionId ? 'Session restarted' : 'Session launched',
            description: session ? `Session ${session.id?.slice(0, 8)}` : 'Session started',
          });
        }

        queryClient.invalidateQueries({ queryKey: ['agent-presence', projectId] });
        queryClient.invalidateQueries({ queryKey: ['active-sessions', projectId] });

        // Attach inline if we're in a direct message with this agent
        if (selectedThreadId) {
          setInlineTerminalsByThread((prev) => ({
            ...prev,
            [selectedThreadId]: { agentId, sessionId: session?.id ?? null },
          }));
        }
      } catch (error) {
        toast({
          title: sessionId ? 'Restart failed' : 'Launch failed',
          description: error instanceof Error ? error.message : 'Unable to start session',
          variant: 'destructive',
        });
      } finally {
        setRestartingAgentId(null);
      }
    },
    [agentPresence, projectId, queryClient, selectedThreadId, setInlineTerminalsByThread, toast],
  );

  const handleTerminateSession = useCallback(
    async (agentId: string, sessionId: string) => {
      if (!projectId) {
        toast({
          title: 'Select a project',
          description: 'Choose a project before terminating a session.',
          variant: 'destructive',
        });
        return;
      }
      setTerminateConfirm(null);
      setLaunchingAgentIds((prev) => ({ ...prev, [agentId]: true }));
      try {
        await terminateSession(sessionId);
        toast({ title: 'Session terminated', description: 'The session was terminated.' });
        queryClient.invalidateQueries({ queryKey: ['agent-presence', projectId] });
        queryClient.invalidateQueries({ queryKey: ['active-sessions', projectId] });
      } catch (error) {
        toast({
          title: 'Terminate failed',
          description: error instanceof Error ? error.message : 'Unable to terminate session',
          variant: 'destructive',
        });
      } finally {
        setLaunchingAgentIds((prev) => {
          const next = { ...prev };
          delete next[agentId];
          return next;
        });
      }
    },
    [projectId, queryClient, toast],
  );

  const handleLaunchAllSessions = useCallback(async () => {
    if (!currentThread?.isGroup || offlineGroupMembers.length === 0) {
      return;
    }
    if (!selectedThreadId) {
      return;
    }
    setBatchLaunching(true);
    try {
      let attached = false;
      for (const member of offlineGroupMembers) {
        const session = await handleLaunchSession(member.id, { attach: !attached });
        if (session && !attached) {
          attached = true;
        }
      }
    } finally {
      setBatchLaunching(false);
    }
  }, [currentThread?.isGroup, handleLaunchSession, offlineGroupMembers, selectedThreadId]);

  // Batch handler for "Start All" button
  const handleStartAllAgents = useCallback(async () => {
    if (!presenceReady || offlineAgents.length === 0) return;

    setStartingAll(true);
    let succeeded = 0;
    let failed = 0;

    try {
      for (const agent of offlineAgents) {
        try {
          const session = await handleLaunchSession(agent.id, { attach: false, silent: true });
          if (session) {
            succeeded++;
          } else {
            failed++;
          }
        } catch {
          failed++;
        }
      }
    } finally {
      setStartingAll(false);

      // Single invalidation at end
      queryClient.invalidateQueries({ queryKey: ['agent-presence', projectId] });
      queryClient.invalidateQueries({ queryKey: ['active-sessions', projectId] });

      // Summary toast
      if (failed === 0) {
        toast({
          title: 'All agents started',
          description: `${succeeded} session${succeeded !== 1 ? 's' : ''} launched successfully.`,
        });
      } else {
        toast({
          title: 'Batch launch complete',
          description: `${succeeded} started, ${failed} failed.`,
          variant: failed > 0 ? 'destructive' : 'default',
        });
      }
    }
  }, [presenceReady, offlineAgents, handleLaunchSession, queryClient, projectId, toast]);

  // Batch handler for "Stop All" button (called from confirmation dialog)
  const handleTerminateAllAgents = useCallback(async () => {
    if (!presenceReady || agentsWithSessions.length === 0) return;

    setTerminatingAll(true);
    let succeeded = 0;
    let failed = 0;

    try {
      for (const agent of agentsWithSessions) {
        const sessionId = agentPresence[agent.id]?.sessionId;
        if (sessionId) {
          try {
            await terminateSession(sessionId);
            succeeded++;
          } catch {
            failed++;
          }
        }
      }
    } finally {
      setTerminatingAll(false);
      setTerminateAllConfirm(false);

      // Single invalidation at end
      queryClient.invalidateQueries({ queryKey: ['agent-presence', projectId] });
      queryClient.invalidateQueries({ queryKey: ['active-sessions', projectId] });

      // Summary toast
      if (failed === 0) {
        toast({
          title: 'All sessions terminated',
          description: `${succeeded} session${succeeded !== 1 ? 's' : ''} stopped.`,
        });
      } else {
        toast({
          title: 'Batch terminate complete',
          description: `${succeeded} stopped, ${failed} failed.`,
          variant: 'destructive',
        });
      }
    }
  }, [presenceReady, agentsWithSessions, agentPresence, queryClient, projectId, toast]);

  const resolveActiveSessionForAgent = (agentId: string) => {
    const presence = agentPresence[agentId];
    if (!presence?.online || !presence.sessionId) {
      return null;
    }

    const session = activeSessions.find((s) => s.id === presence.sessionId);
    if (!session) {
      return null;
    }

    return session;
  };

  const handleOpenTerminal = (agentId: string) => {
    const session = resolveActiveSessionForAgent(agentId);
    if (!selectedThreadId) {
      return;
    }
    if (!session) {
      setInlineTerminalsByThread((prev) => ({
        ...prev,
        [selectedThreadId]: { agentId, sessionId: null },
      }));
      setTerminalMenuOpen(false);
      return;
    }
    setTerminalMenuOpen(false);
    openTerminalWindow(session);

    // If inline is showing this same session, keep inline region visible
    // and rely on the placeholder to indicate the window is active.
  };

  const handleOpenInlineTerminal = (agentId: string) => {
    if (!selectedThreadId) {
      return;
    }
    const session = resolveActiveSessionForAgent(agentId);
    // If a floating window for this session exists, close it to avoid conflicts
    if (session) {
      try {
        closeWindow(session.id);
      } catch {
        // no-op if not open
      }
    }
    setInlineTerminalsByThread((prev) => ({
      ...prev,
      [selectedThreadId]: { agentId, sessionId: session ? session.id : null },
    }));
    setTerminalMenuOpen(false);
    setInlineUnreadCount(0);
  };

  const handleDetachInlineTerminal = () => {
    if (!selectedThreadId || !inlineTerminalState) {
      return;
    }
    setInlineTerminalsByThread((prev) => {
      if (!prev[selectedThreadId]) {
        return prev;
      }
      const next = { ...prev };
      delete next[selectedThreadId];
      return next;
    });
    setTerminalMenuOpen(false);
    setInlineUnreadCount(0);
  };

  const handleClearHistory = async () => {
    if (!selectedThreadId) {
      return;
    }
    setClearHistoryDialogOpen(false);
    await clearHistoryMutation.mutateAsync(selectedThreadId);
  };

  const handlePurgeHistory = async () => {
    if (!selectedThreadId) {
      return;
    }
    setClearHistoryDialogOpen(false);
    await purgeHistoryMutation.mutateAsync(selectedThreadId);
  };

  const isDirectMessage = Boolean(currentThread && !currentThread.isGroup);
  const shouldShowDirectLaunchCta = Boolean(
    presenceReady && isDirectMessage && selectedAgent && !isSelectedAgentOnline,
  );
  const shouldShowGroupLaunchCta = Boolean(
    presenceReady && currentThread?.isGroup && offlineGroupMembers.length > 0,
  );

  const launchingSelectedAgent =
    selectedAgent && launchingAgentIds[selectedAgent.id] ? true : false;
  const launchAllDisabled =
    !hasSelectedProject ||
    batchLaunching ||
    offlineGroupMembers.length === 0 ||
    offlineGroupMembers.every((member) => launchingAgentIds[member.id]);

  const directLaunchCta =
    shouldShowDirectLaunchCta && selectedAgent ? (
      <div className="flex items-center justify-between gap-4 rounded-lg border border-dashed border-border bg-muted/40 p-4">
        <div>
          <p className="text-sm font-semibold text-foreground">Agent is not active.</p>
          <p className="text-xs text-muted-foreground">
            Launch a session to collaborate inline inside this conversation.
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          onClick={() => handleLaunchSession(selectedAgent.id)}
          disabled={launchingSelectedAgent || !hasSelectedProject}
        >
          {launchingSelectedAgent ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Launching…
            </>
          ) : (
            'Launch session'
          )}
        </Button>
      </div>
    ) : null;

  const groupLaunchCta = shouldShowGroupLaunchCta ? (
    <div className="space-y-3 rounded-lg border border-dashed border-border bg-muted/30 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-foreground">Agents aren’t active.</p>
          <p className="text-xs text-muted-foreground">
            Launch sessions for offline agents to collaborate inline.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleLaunchAllSessions}
          disabled={launchAllDisabled}
        >
          {batchLaunching ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Launching…
            </>
          ) : (
            'Launch all'
          )}
        </Button>
      </div>
      <div className="space-y-2">
        {offlineGroupMembers.map((member) => {
          const launchingMember = Boolean(launchingAgentIds[member.id]) || batchLaunching;
          return (
            <div
              key={member.id}
              className="flex items-center justify-between gap-3 rounded-md border border-dashed border-border/60 bg-background/50 px-3 py-2"
            >
              <div>
                <p className="text-sm font-medium text-foreground">{member.name}</p>
                <p className="text-xs text-muted-foreground">Offline</p>
              </div>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => handleLaunchSession(member.id)}
                disabled={launchingMember || !hasSelectedProject}
              >
                {launchingMember ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Launching…
                  </>
                ) : (
                  'Launch'
                )}
              </Button>
            </div>
          );
        })}
      </div>
    </div>
  ) : null;

  const composerBlockedContent = directLaunchCta ?? groupLaunchCta ?? null;

  if (projectsLoading) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <div className="flex items-center gap-2">
          <Loader2 className="h-6 w-6 animate-spin" />
          <span>Loading projects…</span>
        </div>
      </div>
    );
  }

  if (!hasSelectedProject) {
    return (
      <div className="flex h-full flex-col items-center justify-center text-center text-muted-foreground">
        <AlertCircle className="mb-4 h-12 w-12" />
        <h2 className="text-xl font-semibold text-foreground">Select a project to open Chat</h2>
        <p className="mt-2 max-w-md">
          Use the project selector in the header to choose a project. Chat lists agents, threads,
          and messages for the selected project only.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full gap-4">
      {/* Left Sidebar */}
      <div className="flex w-80 flex-col border-r bg-card">
        <div className="flex items-center justify-between p-4">
          <h2 className="text-xl font-bold">Chat</h2>
          <div className="inline-flex rounded-md border">
            <Button
              variant="ghost"
              size="sm"
              className="rounded-r-none border-r text-green-600 hover:bg-green-50 hover:text-green-700 dark:text-green-500 dark:hover:bg-green-950 dark:hover:text-green-400"
              onClick={handleStartAllAgents}
              disabled={!presenceReady || offlineAgents.length === 0 || startingAll}
              title="Launch sessions for all offline agents"
            >
              {startingAll ? (
                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
              ) : (
                <Play className="mr-1 h-3 w-3" />
              )}
              Start{offlineAgents.length > 0 ? ` (${offlineAgents.length})` : ''}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="rounded-l-none text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={() => setTerminateAllConfirm(true)}
              disabled={!presenceReady || agentsWithSessions.length === 0 || terminatingAll}
              title="Terminate all running sessions"
            >
              {terminatingAll ? (
                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
              ) : (
                <Square className="mr-1 h-3 w-3" />
              )}
              Stop{agentsWithSessions.length > 0 ? ` (${agentsWithSessions.length})` : ''}
            </Button>
          </div>
        </div>

        <ScrollArea className="flex-1">
          {/* Agents Section */}
          <div className="px-4 py-4">
            <div className="space-y-1" role="list" aria-label="Direct messages">
              {agentsLoading ? (
                <div className="space-y-2" aria-hidden>
                  {Array.from({ length: 3 }).map((_, index) => (
                    <Skeleton key={index} className="h-8 w-full" />
                  ))}
                </div>
              ) : agentsError ? (
                <p className="text-xs text-destructive">Failed to load agents. Please try again.</p>
              ) : agents.length === 0 ? (
                <p className="text-xs text-muted-foreground">No agents yet.</p>
              ) : (
                agents.map((agent: { id: string; name: string }) => {
                  const isOnline = agentPresence[agent.id]?.online ?? false;
                  const activityState = agentPresence[agent.id]?.activityState ?? null;
                  const busySince = agentPresence[agent.id]?.busySince ?? null;
                  // Check if there's already a direct thread with this agent
                  const existingThread = userThreads.find(
                    (t) => !t.isGroup && t.members?.length === 1 && t.members[0] === agent.id,
                  );
                  const isSelected = existingThread
                    ? selectedThreadId === existingThread.id
                    : false;

                  // Get provider info for icon display
                  const agentProviderName = getProviderForAgent(agent.id);
                  const agentProviderIcon = agentProviderName
                    ? getProviderIconDataUri(agentProviderName)
                    : null;

                  const renderActivityBadge = () => {
                    if (!isOnline) return null;
                    if (activityState === 'busy') {
                      const since = busySince ? new Date(busySince).getTime() : Date.now();
                      const ms = Math.max(0, Date.now() - since);
                      const mins = Math.floor(ms / 60000);
                      const secs = Math.floor((ms % 60000) / 1000);
                      const label = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
                      const aria = `Busy for ${label}`;
                      return (
                        <Badge className="ml-2" aria-label={aria}>
                          Busy {label}
                        </Badge>
                      );
                    }
                    if (activityState === 'idle') {
                      return (
                        <Badge variant="outline" className="ml-2" aria-label="Idle">
                          Idle
                        </Badge>
                      );
                    }
                    return null;
                  };

                  const hasSession = Boolean(isOnline && agentPresence[agent.id]?.sessionId);
                  const sessionId = agentPresence[agent.id]?.sessionId ?? null;
                  const isLaunching = Boolean(launchingAgentIds[agent.id]);
                  const isRestarting = restartingAgentId === agent.id;
                  const anyBusy = isLaunching || isRestarting;

                  return (
                    <ContextMenu key={agent.id}>
                      <ContextMenuTrigger asChild>
                        <button
                          onClick={() => launchChat([agent.id])}
                          disabled={isLaunchingChat}
                          className={cn(
                            'flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors hover:bg-muted',
                            isSelected && 'bg-secondary',
                            isLaunchingChat && 'opacity-50 cursor-not-allowed',
                          )}
                          role="listitem"
                          aria-label={`Chat with ${agent.name}${isOnline ? ' (online)' : ' (offline)'}`}
                          aria-current={isSelected ? 'true' : undefined}
                        >
                          <Circle
                            className={cn(
                              'h-2 w-2 fill-current',
                              isOnline ? 'text-green-500' : 'text-muted-foreground',
                            )}
                            aria-hidden="true"
                          />
                          {agentProviderIcon && (
                            <img
                              src={agentProviderIcon}
                              className="h-4 w-4 flex-shrink-0"
                              aria-hidden="true"
                              title={`Provider: ${agentProviderName}`}
                              alt=""
                            />
                          )}
                          <div className="flex-1 overflow-hidden text-left">
                            <div className="flex items-center gap-2">
                              <span className="truncate">{agent.name}</span>
                              {renderActivityBadge()}
                            </div>
                            {isOnline &&
                              activityState === 'busy' &&
                              agentPresence[agent.id]?.currentActivityTitle && (
                                <div
                                  className="truncate text-xs text-muted-foreground"
                                  title={agentPresence[agent.id]?.currentActivityTitle || undefined}
                                  aria-label={
                                    agentPresence[agent.id]?.currentActivityTitle
                                      ? `Running: ${agentPresence[agent.id]?.currentActivityTitle}`
                                      : undefined
                                  }
                                >
                                  {agentPresence[agent.id]?.currentActivityTitle}
                                </div>
                              )}
                          </div>
                        </button>
                      </ContextMenuTrigger>
                      <ContextMenuContent className="w-56">
                        {!hasSession && (
                          <ContextMenuItem
                            onSelect={async (e) => {
                              e.preventDefault();
                              await handleLaunchSession(agent.id, { attach: false });
                            }}
                            disabled={isLaunching || !hasSelectedProject}
                          >
                            {isLaunching && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                            Launch session
                          </ContextMenuItem>
                        )}
                        <ContextMenuItem
                          onSelect={async (e) => {
                            e.preventDefault();
                            await handleRestartSession(agent.id);
                          }}
                          disabled={anyBusy || !hasSelectedProject}
                        >
                          {isRestarting ? (
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          ) : (
                            <RotateCcw className="mr-2 h-4 w-4" />
                          )}
                          Restart session
                        </ContextMenuItem>
                        {hasSession && sessionId && (
                          <>
                            <ContextMenuSeparator />
                            <ContextMenuItem
                              onSelect={(e) => {
                                e.preventDefault();
                                setTerminateConfirm({ agentId: agent.id, sessionId });
                              }}
                              disabled={anyBusy || !hasSelectedProject}
                            >
                              <Power className="mr-2 h-4 w-4" />
                              Terminate session
                            </ContextMenuItem>
                          </>
                        )}
                      </ContextMenuContent>
                    </ContextMenu>
                  );
                })
              )}
            </div>
          </div>

          <Separator />

          {CHAT_THREADS_ENABLED && (
            <>
              {/* Groups Section */}
              <div className="px-4 py-4">
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-muted-foreground">GROUPS</h3>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleCreateGroup}
                    className="h-6 w-6 p-0"
                    aria-label="Create new group"
                    disabled={agents.length < 2 || createGroupMutation.isPending}
                  >
                    <Plus className="h-4 w-4" />
                  </Button>
                </div>
                <div className="space-y-1" role="list" aria-label="Group chats">
                  {userThreadsLoading ? (
                    <div className="space-y-2" aria-hidden>
                      {Array.from({ length: 2 }).map((_, index) => (
                        <Skeleton key={index} className="h-8 w-full" />
                      ))}
                    </div>
                  ) : groups.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No group threads yet.</p>
                  ) : (
                    groups.map((group) => (
                      <button
                        key={group.id}
                        onClick={() => handleSelectThread(group.id)}
                        className={cn(
                          'flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors hover:bg-muted',
                          selectedThreadId === group.id && 'bg-secondary',
                        )}
                        role="listitem"
                        aria-label={`${group.name} group with ${group.memberCount} members`}
                        aria-current={selectedThreadId === group.id ? 'true' : undefined}
                      >
                        <Users className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                        <span className="flex-1 truncate text-left">{group.name}</span>
                        <Badge
                          variant="secondary"
                          className="text-xs"
                          aria-label={`${group.memberCount} members`}
                        >
                          {group.memberCount}
                        </Badge>
                      </button>
                    ))
                  )}
                </div>
              </div>

              <Separator />

              {/* Agent Threads Section */}
              <div className="px-4 py-4">
                <div className="mb-2">
                  <h3 className="text-sm font-semibold text-muted-foreground">AGENT THREADS</h3>
                  <p className="text-xs text-muted-foreground">Read-only agent conversations</p>
                </div>
                <div className="space-y-1" role="list" aria-label="Agent-initiated threads">
                  {agentThreadsLoading ? (
                    <div className="space-y-2" aria-hidden>
                      {Array.from({ length: 2 }).map((_, index) => (
                        <Skeleton key={index} className="h-6 w-full" />
                      ))}
                    </div>
                  ) : agentThreads.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No agent-initiated threads.</p>
                  ) : (
                    agentThreads.map((thread) => (
                      <button
                        key={thread.id}
                        onClick={() => handleSelectThread(thread.id)}
                        className={cn(
                          'flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors hover:bg-muted',
                          selectedThreadId === thread.id && 'bg-secondary',
                        )}
                        role="listitem"
                        aria-label={`${thread.title || 'Agent Thread'} with ${thread.members?.length ?? 0} agents`}
                        aria-current={selectedThreadId === thread.id ? 'true' : undefined}
                      >
                        <MessageSquare
                          className="h-4 w-4 text-muted-foreground"
                          aria-hidden="true"
                        />
                        <span className="flex-1 truncate text-left text-xs">
                          {thread.title || 'Agent Thread'}
                        </span>
                        <Badge
                          variant="outline"
                          className="text-xs"
                          aria-label={`${thread.members?.length ?? 0} agents`}
                        >
                          {thread.members?.length ?? 0}
                        </Badge>
                      </button>
                    ))
                  )}
                </div>
              </div>
            </>
          )}
        </ScrollArea>
      </div>

      {/* Right Content Area */}
      <div className="flex flex-1 flex-col">
        {selectedThreadId ? (
          <>
            {/* Thread Header */}
            <div className="flex items-center justify-between border-b p-4">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-lg font-semibold">{threadDisplayName}</h2>
                  {!currentThread?.isGroup && currentThreadMembers[0] && (
                    <Circle
                      className={cn(
                        'h-2.5 w-2.5 fill-current',
                        currentThreadMembers[0].online ? 'text-green-500' : 'text-muted-foreground',
                      )}
                      aria-label={currentThreadMembers[0].online ? 'Agent online' : 'Agent offline'}
                    />
                  )}
                  {inlineUnreadCount > 0 && (
                    <Badge variant="secondary" className="text-xs">
                      {inlineUnreadCount}
                    </Badge>
                  )}
                </div>
                {currentThread?.isGroup && currentThreadMembers.length > 0 && (
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    {currentThreadMembers.map((member) => (
                      <div
                        key={member.id}
                        className="flex items-center gap-1 rounded-md border px-2 py-1"
                        title={member.name}
                      >
                        <Circle
                          className={cn(
                            'h-2 w-2 fill-current',
                            member.online ? 'text-green-500' : 'text-muted-foreground',
                          )}
                        />
                        <span className="sr-only">{member.name}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2">
                {CHAT_INLINE_TERMINAL_ENABLED &&
                  selectedAgent &&
                  agentPresence[selectedAgent.id]?.online && (
                    <ContextMenu onOpenChange={setTerminalMenuOpen}>
                      <ContextMenuTrigger asChild>
                        <div
                          className="flex items-center gap-1"
                          role="group"
                          aria-label="Terminal actions"
                        >
                          <Button
                            ref={terminalMenuTriggerRef}
                            type="button"
                            variant="outline"
                            size="sm"
                            title="Open Terminal"
                            aria-haspopup="menu"
                            aria-expanded={terminalMenuOpen}
                            onKeyDown={(event) => {
                              if (
                                (event.key === 'Enter' || event.key === ' ') &&
                                !event.altKey &&
                                !event.ctrlKey &&
                                !event.metaKey &&
                                !event.shiftKey
                              ) {
                                event.preventDefault();
                                event.stopPropagation();
                                terminalMenuTriggerRef.current?.dispatchEvent(
                                  new MouseEvent('contextmenu', {
                                    bubbles: true,
                                    cancelable: true,
                                    button: 2,
                                  }),
                                );
                              }
                            }}
                            onClick={(event) => {
                              if (event.detail === 0) {
                                event.preventDefault();
                                terminalMenuTriggerRef.current?.dispatchEvent(
                                  new MouseEvent('contextmenu', {
                                    bubbles: true,
                                    cancelable: true,
                                    button: 2,
                                  }),
                                );
                                return;
                              }
                              handleOpenTerminal(selectedAgent.id);
                            }}
                          >
                            <Terminal className="mr-1 h-4 w-4" />
                            Terminal
                          </Button>
                          {isCoarsePointer && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="h-9 w-9"
                              title="Terminal options"
                              aria-label="Open terminal options"
                              onClick={() => setTerminalMenuOpen((isOpen) => !isOpen)}
                            >
                              <ChevronDown className="h-4 w-4" />
                            </Button>
                          )}
                        </div>
                      </ContextMenuTrigger>
                      <ContextMenuContent className="w-48">
                        <ContextMenuItem
                          onSelect={(event) => {
                            event.preventDefault();
                            handleOpenInlineTerminal(selectedAgent.id);
                          }}
                          disabled={inlineTerminalState?.agentId === selectedAgent.id}
                        >
                          Open Inline
                        </ContextMenuItem>
                        <ContextMenuItem
                          onSelect={(event) => {
                            event.preventDefault();
                            handleOpenTerminal(selectedAgent.id);
                          }}
                        >
                          Open in New Window
                        </ContextMenuItem>
                        {isInlineTerminalActive && (
                          <>
                            <ContextMenuSeparator />
                            <ContextMenuItem
                              onSelect={(event) => {
                                event.preventDefault();
                                handleDetachInlineTerminal();
                              }}
                            >
                              Detach Inline
                            </ContextMenuItem>
                          </>
                        )}
                      </ContextMenuContent>
                    </ContextMenu>
                  )}
                {CHAT_SETTINGS_AND_INVITES_ENABLED && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setSettingsDialogOpen(true)}
                    title="Chat settings"
                    disabled={!hasSelectedProject}
                  >
                    <Settings className="h-4 w-4" />
                  </Button>
                )}
                {CHAT_SETTINGS_AND_INVITES_ENABLED && canInviteMembers && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setInviteDialogOpen(true)}
                    title="Invite agents to this thread"
                    disabled={
                      !hasSelectedProject ||
                      inviteableAgents.length === 0 ||
                      inviteMembersMutation.isPending
                    }
                  >
                    <UserPlus className="mr-1 h-4 w-4" />
                    Invite
                  </Button>
                )}
                {CHAT_CLEAR_HISTORY_ENABLED && isDirectMessage && (
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        title="Thread options"
                        disabled={!hasSelectedProject}
                        aria-label="Thread options"
                      >
                        <MoreVertical className="h-4 w-4" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent align="end" className="w-48">
                      <Button
                        variant="ghost"
                        className="w-full justify-start"
                        onClick={() => setClearHistoryDialogOpen(true)}
                        disabled={clearHistoryMutation.isPending}
                        aria-label="Clear history for this thread"
                      >
                        Clear History
                      </Button>
                    </PopoverContent>
                  </Popover>
                )}
              </div>
            </div>

            {showInlineTerminal ? (
              <div className="flex flex-1 min-h-0 flex-col p-4">
                <div className="flex h-full flex-col overflow-hidden rounded-xl border border-border bg-terminal text-terminal-foreground shadow-sm">
                  <InlineTerminalHeader
                    agentName={inlineTerminalAgentName}
                    onBackToChat={handleDetachInlineTerminal}
                    showChatToggle={false}
                    onOpenWindow={
                      inlineTerminalAgentId
                        ? () => handleOpenTerminal(inlineTerminalAgentId)
                        : undefined
                    }
                  />
                  <InlineTerminalPanel
                    sessionId={inlineTerminalSessionId}
                    agentName={inlineTerminalAgentName}
                    isWindowOpen={isInlineSessionWindowOpen}
                    emptyState={
                      directLaunchCta ?? (
                        <p>Agent must be online before the terminal is available.</p>
                      )
                    }
                  />
                </div>
              </div>
            ) : (
              <>
                {/* Message List */}
                <ScrollArea className="flex-1 p-4">
                  <div
                    className="space-y-4"
                    role="log"
                    aria-live="polite"
                    aria-label="Chat messages"
                  >
                    {messages.length === 0 && (
                      <div className="flex h-full items-center justify-center text-center text-muted-foreground">
                        <p className="text-sm">No messages yet. Start the conversation!</p>
                      </div>
                    )}
                    {messages.map((message) => {
                      const isUser = message.authorType === 'user';
                      const isAgentAuthor = message.authorType === 'agent';
                      const isSystem = message.authorType === 'system';
                      const authorName = isUser
                        ? 'You'
                        : getAgentName(message.authorAgentId) || (isSystem ? 'System' : 'Agent');
                      const isTargeted = Boolean(message.targets && message.targets.length > 0);

                      if (isSystem) {
                        return (
                          <div key={message.id} className="flex justify-center">
                            <div className="flex max-w-2xl flex-col items-center gap-1 text-center">
                              <Badge
                                variant="secondary"
                                className="text-[10px] uppercase tracking-wide"
                              >
                                System
                              </Badge>
                              <div className="w-full whitespace-pre-wrap rounded-md border bg-muted px-3 py-2 text-sm text-muted-foreground">
                                {message.content}
                              </div>
                              <span className="text-[10px] uppercase text-muted-foreground">
                                {formatTimestamp(message.createdAt)}
                              </span>
                            </div>
                          </div>
                        );
                      }

                      const providerName = isAgentAuthor
                        ? getProviderForAgent(message.authorAgentId)
                        : null;
                      const providerIcon = providerName
                        ? getProviderIconDataUri(providerName)
                        : null;

                      return (
                        <div
                          key={message.id}
                          className={cn('flex flex-col', isUser ? 'items-end' : 'items-start')}
                        >
                          <div className="flex items-baseline gap-2">
                            {isAgentAuthor && providerIcon ? (
                              <div className="flex items-center gap-1.5">
                                <img
                                  src={providerIcon}
                                  className="h-4 w-4"
                                  aria-hidden="true"
                                  title={`Provider: ${providerName}`}
                                  alt=""
                                />
                                <span className="text-sm font-semibold">{authorName}</span>
                              </div>
                            ) : (
                              <span className="text-sm font-semibold">{authorName}</span>
                            )}
                            <span className="text-xs text-muted-foreground">
                              {formatTimestamp(message.createdAt)}
                            </span>
                            {isUser && (
                              <Badge variant="outline" className="text-xs">
                                {isTargeted ? 'Targeted' : 'Broadcast'}
                              </Badge>
                            )}
                            {isAgentAuthor && (
                              <Badge variant="secondary" className="text-xs uppercase">
                                Agent
                              </Badge>
                            )}
                          </div>
                          <div
                            className={cn(
                              'mt-1 whitespace-pre-wrap rounded-lg px-3 py-2 text-sm',
                              isUser ? 'bg-primary text-primary-foreground' : 'bg-muted',
                            )}
                          >
                            {message.content}
                          </div>
                          {isTargeted && isUser && (
                            <div className="mt-1 text-xs text-muted-foreground">
                              To: {message.targets!.map((id) => getAgentName(id) || id).join(', ')}
                            </div>
                          )}
                        </div>
                      );
                    })}
                    <div ref={messagesEndRef} />
                  </div>
                </ScrollArea>

                {/* Message Composer */}
                {composerBlockedContent ? (
                  <div className="border-t p-4" aria-live="polite">
                    {composerBlockedContent}
                  </div>
                ) : (
                  <form
                    onSubmit={handleSendMessage}
                    className="border-t p-4"
                    aria-label="Message composition form"
                  >
                    <div className="flex items-end gap-2">
                      <div className="relative flex-1">
                        <label htmlFor="message-input" className="sr-only">
                          Message
                        </label>
                        <Textarea
                          ref={textareaRef}
                          id="message-input"
                          value={messageInput}
                          onChange={(e) => {
                            const newValue = e.target.value;
                            setMessageInput(newValue);
                            handleInputChange(newValue, e.target.selectionStart);
                          }}
                          onKeyDown={handleKeyDown}
                          placeholder="Type a message... (Ctrl/Cmd+Enter to send, @ to mention)"
                          className="min-h-[60px] max-h-[200px] resize-y"
                          disabled={sendMessageMutation.isPending}
                          aria-label="Type your message"
                        />
                        {/* Mention autocomplete dropdown */}
                        {showAutocomplete && (
                          <div className="absolute bottom-full left-0 z-50 mb-2 w-64 rounded-md border bg-popover shadow-md">
                            <div className="p-2">
                              <div className="mb-2 text-xs text-muted-foreground">
                                Mention agent (↑↓ to navigate, Enter to select)
                              </div>
                              <div className="space-y-1">
                                {agents
                                  .filter((agent: { id: string; name: string }) =>
                                    agent.name.toLowerCase().includes(mentionQuery.toLowerCase()),
                                  )
                                  .map((agent: { id: string; name: string }, index: number) => (
                                    <button
                                      key={agent.id}
                                      type="button"
                                      onClick={() => {
                                        const newText = insertMention(agent, messageInput);
                                        setMessageInput(newText);
                                      }}
                                      className={cn(
                                        'w-full rounded-md px-3 py-2 text-left text-sm transition-colors',
                                        index === selectedIndex
                                          ? 'bg-accent text-accent-foreground'
                                          : 'hover:bg-muted',
                                      )}
                                    >
                                      <div className="flex items-center gap-2">
                                        <Circle
                                          className={cn(
                                            'h-2 w-2 fill-current',
                                            agentPresence[agent.id]?.online
                                              ? 'text-green-500'
                                              : 'text-muted-foreground',
                                          )}
                                        />
                                        <span className="font-medium">{agent.name}</span>
                                      </div>
                                    </button>
                                  ))}
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                      <Button
                        type="submit"
                        size="icon"
                        disabled={!messageInput.trim() || sendMessageMutation.isPending}
                        aria-label="Send message"
                      >
                        <Send className="h-4 w-4" aria-hidden="true" />
                        <span className="sr-only">Send message</span>
                      </Button>
                    </div>
                  </form>
                )}
              </>
            )}
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center text-center">
            <div>
              <MessageSquare className="mx-auto mb-4 h-16 w-16 text-muted-foreground" />
              <h2 className="text-xl font-semibold">No conversation selected</h2>
              <p className="text-muted-foreground">
                Select an agent, group, or thread from the sidebar to start chatting
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Group Creation Dialog */}
      <GroupCreationDialog
        open={groupDialogOpen}
        onOpenChange={setGroupDialogOpen}
        agents={agents}
        onCreateGroup={handleGroupCreation}
      />
      <InviteMembersDialog
        open={inviteDialogOpen && CHAT_SETTINGS_AND_INVITES_ENABLED}
        onOpenChange={setInviteDialogOpen}
        agents={inviteableAgents}
        existingMemberIds={currentThread?.members ?? []}
        onInvite={handleInviteMembers}
        isSubmitting={inviteMembersMutation.isPending}
      />
      {CHAT_SETTINGS_AND_INVITES_ENABLED && (
        <ChatSettingsDialog
          open={settingsDialogOpen}
          onOpenChange={setSettingsDialogOpen}
          projectId={hasSelectedProject ? projectId : null}
          threadContext={{
            threadId: currentThread?.id ?? selectedThreadId,
            threadTitle: threadDisplayName,
            participantNames: currentThreadMembers.map((member) => member.name),
          }}
          sampleInviteeName={sampleInviteeName}
        />
      )}
      {CHAT_CLEAR_HISTORY_ENABLED && (
        <Dialog open={clearHistoryDialogOpen} onOpenChange={setClearHistoryDialogOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Clear or purge chat history?</DialogTitle>
              <DialogDescription>
                Choose how you want to handle older messages in this thread.
                <br />
                <strong>Clear</strong>: hides older messages by default (non-destructive).
                <br />
                <strong>Purge</strong>: permanently deletes older messages (destructive).
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setClearHistoryDialogOpen(false)}
                disabled={clearHistoryMutation.isPending || purgeHistoryMutation.isPending}
              >
                Cancel
              </Button>
              <Button onClick={handleClearHistory} disabled={clearHistoryMutation.isPending}>
                {clearHistoryMutation.isPending ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Clearing...
                  </>
                ) : (
                  'Clear'
                )}
              </Button>
              <Button
                variant="destructive"
                onClick={handlePurgeHistory}
                disabled={purgeHistoryMutation.isPending}
              >
                {purgeHistoryMutation.isPending ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Purging...
                  </>
                ) : (
                  'Purge'
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
      <Dialog
        open={!!terminateConfirm}
        onOpenChange={(open) => {
          if (!open) setTerminateConfirm(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Terminate session?</DialogTitle>
            <DialogDescription>
              This will stop the agent&apos;s current session. You can launch again afterward.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTerminateConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (terminateConfirm) {
                  void handleTerminateSession(terminateConfirm.agentId, terminateConfirm.sessionId);
                }
              }}
              disabled={
                !terminateConfirm ||
                Boolean(launchingAgentIds[terminateConfirm.agentId]) ||
                !hasSelectedProject
              }
            >
              {terminateConfirm && launchingAgentIds[terminateConfirm.agentId] ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Terminating...
                </>
              ) : (
                'Terminate'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={terminateAllConfirm} onOpenChange={setTerminateAllConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Terminate all sessions?</DialogTitle>
            <DialogDescription>
              This will stop all {agentsWithSessions.length} running agent session
              {agentsWithSessions.length !== 1 ? 's' : ''}. You can launch them again afterward.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setTerminateAllConfirm(false)}
              disabled={terminatingAll}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleTerminateAllAgents}
              disabled={terminatingAll || agentsWithSessions.length === 0}
            >
              {terminatingAll ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Terminating...
                </>
              ) : (
                'Terminate All'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
