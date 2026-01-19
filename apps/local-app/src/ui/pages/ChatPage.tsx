import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { Loader2, AlertCircle, MessageSquare } from 'lucide-react';
import { useTerminalWindowManager, useTerminalWindows } from '@/ui/terminal-windows';
import { parseMentions } from '@/ui/lib/chat';
import { useChatLauncher } from '@/ui/components/chat/ChatLauncher';
import { useToast } from '@/ui/hooks/use-toast';
import { useSelectedProject } from '@/ui/hooks/useProjectSelection';
import { usePointerCoarse } from '@/ui/hooks/usePointerCoarse';

// Inline terminal components
import { InlineTerminalPanel } from '@/ui/components/chat/InlineTerminalPanel';
import { InlineTerminalHeader } from '@/ui/components/chat/InlineTerminalHeader';
import { Button } from '@/ui/components/ui/button';

// Extracted hooks
import { useChatQueries } from '@/ui/hooks/useChatQueries';
import { useChatSocket } from '@/ui/hooks/useChatSocket';
import { useChatSessionControls } from '@/ui/hooks/useChatSessionControls';
import { useChatThreadUiState } from '@/ui/hooks/useChatThreadUiState';

// Extracted components
import { ChatSidebar } from '@/ui/components/chat/ChatSidebar';
import { ChatThreadHeader } from '@/ui/components/chat/ChatThreadHeader';
import { ChatMessageList } from '@/ui/components/chat/ChatMessageList';
import { ChatComposer } from '@/ui/components/chat/ChatComposer';
import { ChatModals } from '@/ui/components/chat/ChatModals';

// Feature flags
const CHAT_INLINE_TERMINAL_ENABLED = true;

export function ChatPage() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { selectedProjectId, selectedProject, projectsLoading } = useSelectedProject();
  const projectId = selectedProjectId ?? null;
  const hasSelectedProject = Boolean(projectId);
  const isCoarsePointer = usePointerCoarse();
  const openTerminalWindow = useTerminalWindowManager();
  const { windows: terminalWindows, closeWindow, focusedWindowId } = useTerminalWindows();

  // Derive selectedThreadId from URL params FIRST (before hooks that depend on it)
  const [searchParams] = useSearchParams();
  const selectedThreadIdFromUrl = searchParams.get('thread');

  // Tick for relative durations (busy badge)
  const [, setNowTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setNowTick((n) => (n + 1) % 1000000), 1000);
    return () => clearInterval(id);
  }, []);

  // Chat launcher for direct thread creation
  const { launchChat, isLaunching: isLaunchingChat } = useChatLauncher({
    projectId: projectId!,
  });

  // ============================================
  // Initialize Hooks
  // ============================================

  // Queries and mutations (use URL-derived selectedThreadId)
  const queries = useChatQueries({
    projectId,
    selectedThreadId: selectedThreadIdFromUrl,
    projectRootPath: selectedProject?.rootPath,
  });

  // Thread UI state - called ONCE with real data
  const threadUiState = useChatThreadUiState({
    projectId,
    agentPresence: queries.agentPresence,
    allThreads: queries.allThreads,
    agents: queries.agents,
  });

  // Inline terminal attach handler
  const handleInlineTerminalAttach = useCallback(
    (agentId: string, sessionId: string | null) => {
      if (threadUiState.selectedThreadId) {
        threadUiState.setInlineTerminalsByThread((prev) => ({
          ...prev,
          [threadUiState.selectedThreadId!]: { agentId, sessionId },
        }));
        threadUiState.setTerminalMenuOpen(false);
        threadUiState.setInlineUnreadCount(0);
      }
    },
    [threadUiState],
  );

  // Session controls
  const sessionControls = useChatSessionControls({
    projectId,
    selectedThreadId: threadUiState.selectedThreadId,
    agentPresence: queries.agentPresence,
    agents: queries.agents,
    presenceReady: queries.presenceReady,
    onInlineTerminalAttach: handleInlineTerminalAttach,
    onTerminalMenuClose: () => threadUiState.setTerminalMenuOpen(false),
  });

  // Get latest selected thread ID for socket callbacks
  const getLatestSelectedThreadId = useCallback(
    () => threadUiState.latestSelectedThreadRef.current,
    [threadUiState.latestSelectedThreadRef],
  );

  // Check if inline terminal is active
  const inlineActiveRef = useRef(threadUiState.showInlineTerminal);
  useEffect(() => {
    inlineActiveRef.current = threadUiState.showInlineTerminal;
  }, [threadUiState.showInlineTerminal]);
  const isInlineActive = useCallback(() => inlineActiveRef.current, []);

  // Socket handling - capture socketRef for ESC key interception
  const { socketRef } = useChatSocket({
    projectId,
    selectedThreadId: threadUiState.selectedThreadId,
    agents: queries.agents,
    onInlineUnread: threadUiState.incrementInlineUnread,
    getLatestSelectedThreadId,
    isInlineActive,
  });

  // ============================================
  // Derived State
  // ============================================

  const {
    currentThread,
    currentThreadMembers,
    selectedAgent,
    threadDisplayName,
    isDirectMessage,
    inlineTerminalState,
    showInlineTerminal,
    inlineTerminalSessionId,
    inlineUnreadCount,
  } = threadUiState;

  const selectedAgentPresence = selectedAgent ? queries.agentPresence[selectedAgent.id] : undefined;
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
      return queries.agents;
    }
    return queries.agents.filter((agent) => !currentThread.members!.includes(agent.id));
  }, [queries.agents, currentThread]);

  const inlineTerminalAgentName = inlineTerminalState
    ? (queries.agents.find((a) => a.id === inlineTerminalState.agentId)?.name ?? null)
    : null;
  const inlineTerminalAgentId = inlineTerminalState?.agentId ?? null;

  const isInlineSessionWindowOpen = useMemo(() => {
    if (!inlineTerminalSessionId) return false;
    return terminalWindows.some((w) => w.id === inlineTerminalSessionId && !w.minimized);
  }, [inlineTerminalSessionId, terminalWindows]);

  // ============================================
  // Handlers
  // ============================================

  const handleSendMessage = useCallback(
    (content: string, targets?: string[]) => {
      if (!threadUiState.selectedThreadId) return;
      queries.sendMessageMutation.mutate({
        threadId: threadUiState.selectedThreadId,
        content,
        targets,
      });
      threadUiState.setMessageInput('');
    },
    [threadUiState, queries.sendMessageMutation],
  );

  const handleCreateGroup = useCallback(
    async (agentIds: string[], title?: string) => {
      if (!projectId) {
        toast({
          title: 'Select a project',
          description: 'Choose a project before creating a group chat.',
          variant: 'destructive',
        });
        return;
      }
      const thread = await queries.createGroupMutation.mutateAsync({ agentIds, title });
      threadUiState.handleSelectThread(thread.id);
      toast({
        title: 'Group created',
        description: `Group "${thread.title || 'Untitled'}" has been created.`,
      });
    },
    [projectId, queries.createGroupMutation, threadUiState, toast],
  );

  const handleInviteMembers = useCallback(
    async (agentIds: string[], inviterName?: string) => {
      if (!threadUiState.selectedThreadId || !projectId) return;
      await queries.inviteMembersMutation.mutateAsync({
        threadId: threadUiState.selectedThreadId,
        agentIds,
        inviterName,
      });
      queries.refetchMessages();
      toast({
        title: 'Agents invited',
        description: 'Invite messages have been posted to the thread.',
      });
    },
    [threadUiState.selectedThreadId, projectId, queries, toast],
  );

  const handleClearHistory = useCallback(async () => {
    if (!threadUiState.selectedThreadId) return;
    threadUiState.setClearHistoryDialogOpen(false);
    await queries.clearHistoryMutation.mutateAsync(threadUiState.selectedThreadId);
  }, [threadUiState, queries.clearHistoryMutation]);

  const handlePurgeHistory = useCallback(async () => {
    if (!threadUiState.selectedThreadId) return;
    threadUiState.setClearHistoryDialogOpen(false);
    await queries.purgeHistoryMutation.mutateAsync(threadUiState.selectedThreadId);
  }, [threadUiState, queries.purgeHistoryMutation]);

  const handleOpenTerminal = useCallback(
    (agentId: string) => {
      const presence = queries.agentPresence[agentId];
      if (!threadUiState.selectedThreadId) return;

      if (!presence?.online || !presence.sessionId) {
        threadUiState.setInlineTerminalsByThread((prev) => ({
          ...prev,
          [threadUiState.selectedThreadId!]: { agentId, sessionId: null },
        }));
        threadUiState.setTerminalMenuOpen(false);
        return;
      }

      const session = queries.activeSessions.find((s) => s.id === presence.sessionId);
      if (session) {
        threadUiState.setTerminalMenuOpen(false);
        openTerminalWindow(session);
      }
    },
    [queries.agentPresence, queries.activeSessions, threadUiState, openTerminalWindow],
  );

  const handleOpenInlineTerminal = useCallback(
    (agentId: string) => {
      if (!threadUiState.selectedThreadId) return;
      const presence = queries.agentPresence[agentId];
      const session = presence?.sessionId
        ? queries.activeSessions.find((s) => s.id === presence.sessionId)
        : null;

      if (session) {
        try {
          closeWindow(session.id);
        } catch {
          // no-op if not open
        }
      }

      threadUiState.setInlineTerminalsByThread((prev) => ({
        ...prev,
        [threadUiState.selectedThreadId!]: {
          agentId,
          sessionId: session ? session.id : null,
        },
      }));
      threadUiState.setTerminalMenuOpen(false);
      threadUiState.setInlineUnreadCount(0);
    },
    [queries.agentPresence, queries.activeSessions, threadUiState, closeWindow],
  );

  const handleDetachInlineTerminal = useCallback(() => {
    if (!threadUiState.selectedThreadId || !inlineTerminalState) return;
    threadUiState.setInlineTerminalsByThread((prev) => {
      if (!prev[threadUiState.selectedThreadId!]) return prev;
      const next = { ...prev };
      delete next[threadUiState.selectedThreadId!];
      return next;
    });
    threadUiState.setTerminalMenuOpen(false);
    threadUiState.setInlineUnreadCount(0);
  }, [threadUiState, inlineTerminalState]);

  const handleVerifyMcp = useCallback(async (): Promise<boolean> => {
    queryClient.invalidateQueries({ queryKey: ['preflight'] });
    const result = await queries.refetchPreflight();
    const data = result.data as
      | { providers?: Array<{ id: string; mcpStatus: string }> }
      | undefined;
    if (!sessionControls.pendingLaunchAgent || !data?.providers) return false;
    const providerCheck = data.providers.find(
      (p) => p.id === sessionControls.pendingLaunchAgent!.providerId,
    );
    return providerCheck?.mcpStatus === 'pass';
  }, [queryClient, queries.refetchPreflight, sessionControls.pendingLaunchAgent]);

  // ESC key interception for terminal sessions
  useEffect(() => {
    const handleGlobalEscape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (
        threadUiState.groupDialogOpen ||
        threadUiState.inviteDialogOpen ||
        threadUiState.settingsDialogOpen ||
        threadUiState.clearHistoryDialogOpen
      ) {
        return;
      }

      let targetSessionId: string | null = null;
      if (showInlineTerminal && inlineTerminalSessionId) {
        targetSessionId = inlineTerminalSessionId;
      } else if (focusedWindowId) {
        targetSessionId = focusedWindowId;
      }

      if (targetSessionId && socketRef.current?.connected) {
        e.preventDefault();
        e.stopPropagation();
        socketRef.current.emit('terminal:input', {
          sessionId: targetSessionId,
          data: '\x1b',
        });
      }
    };

    document.addEventListener('keydown', handleGlobalEscape, { capture: true });
    return () => document.removeEventListener('keydown', handleGlobalEscape, { capture: true });
  }, [
    threadUiState.groupDialogOpen,
    threadUiState.inviteDialogOpen,
    threadUiState.settingsDialogOpen,
    threadUiState.clearHistoryDialogOpen,
    showInlineTerminal,
    inlineTerminalSessionId,
    focusedWindowId,
  ]);

  // ============================================
  // Render CTAs
  // ============================================

  const shouldShowDirectLaunchCta = Boolean(
    queries.presenceReady && isDirectMessage && selectedAgent && !isSelectedAgentOnline,
  );
  const shouldShowGroupLaunchCta = Boolean(
    queries.presenceReady && currentThread?.isGroup && offlineGroupMembers.length > 0,
  );
  const launchingSelectedAgent =
    selectedAgent && sessionControls.launchingAgentIds[selectedAgent.id];

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
          onClick={() => sessionControls.handleLaunchSession(selectedAgent.id)}
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
          <p className="text-sm font-semibold text-foreground">Agents aren&apos;t active.</p>
          <p className="text-xs text-muted-foreground">
            Launch sessions for offline agents to collaborate inline.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={sessionControls.handleStartAllAgents}
          disabled={sessionControls.startingAll || offlineGroupMembers.length === 0}
        >
          {sessionControls.startingAll ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Launching…
            </>
          ) : (
            'Launch all'
          )}
        </Button>
      </div>
    </div>
  ) : null;

  const composerBlockedContent = directLaunchCta ?? groupLaunchCta ?? null;

  // ============================================
  // Early Returns
  // ============================================

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

  // ============================================
  // Main Render
  // ============================================

  return (
    <div className="flex h-full gap-4">
      {/* Left Sidebar */}
      <ChatSidebar
        agents={queries.agents}
        guests={queries.guests}
        agentPresence={queries.agentPresence}
        userThreads={queries.userThreads}
        agentThreads={queries.agentThreads}
        presenceReady={queries.presenceReady}
        offlineAgents={sessionControls.offlineAgents}
        agentsWithSessions={sessionControls.agentsWithSessions}
        agentsLoading={queries.agentsLoading}
        agentsError={queries.agentsError}
        userThreadsLoading={queries.userThreadsLoading}
        agentThreadsLoading={queries.agentThreadsLoading}
        launchingAgentIds={sessionControls.launchingAgentIds}
        restartingAgentId={sessionControls.restartingAgentId}
        startingAll={sessionControls.startingAll}
        terminatingAll={sessionControls.terminatingAll}
        isLaunchingChat={isLaunchingChat}
        selectedThreadId={threadUiState.selectedThreadId}
        hasSelectedProject={hasSelectedProject}
        onSelectThread={threadUiState.handleSelectThread}
        onLaunchChat={launchChat}
        onCreateGroup={() => threadUiState.setGroupDialogOpen(true)}
        onStartAllAgents={sessionControls.handleStartAllAgents}
        onTerminateAllConfirm={() => sessionControls.setTerminateAllConfirm(true)}
        onLaunchSession={sessionControls.handleLaunchSession}
        onRestartSession={sessionControls.handleRestartSession}
        onTerminateConfirm={(agentId, sessionId) =>
          sessionControls.setTerminateConfirm({ agentId, sessionId })
        }
        getProviderForAgent={queries.getProviderForAgent}
        createGroupPending={queries.createGroupMutation.isPending}
      />

      {/* Right Content Area */}
      <div className="flex flex-1 flex-col">
        {threadUiState.selectedThreadId ? (
          <>
            {/* Thread Header */}
            <ChatThreadHeader
              currentThread={currentThread}
              currentThreadMembers={currentThreadMembers}
              selectedAgent={selectedAgent}
              threadDisplayName={threadDisplayName}
              agentPresence={queries.agentPresence}
              inlineUnreadCount={inlineUnreadCount}
              terminalMenuOpen={threadUiState.terminalMenuOpen}
              hasSelectedProject={hasSelectedProject}
              canInviteMembers={canInviteMembers}
              isCoarsePointer={isCoarsePointer}
              setTerminalMenuOpen={threadUiState.setTerminalMenuOpen}
              onOpenTerminal={handleOpenTerminal}
              onOpenInlineTerminal={handleOpenInlineTerminal}
              onDetachInlineTerminal={handleDetachInlineTerminal}
              onOpenInviteDialog={() => threadUiState.setInviteDialogOpen(true)}
              onOpenSettingsDialog={() => threadUiState.setSettingsDialogOpen(true)}
              onOpenClearHistoryDialog={() => threadUiState.setClearHistoryDialogOpen(true)}
              inlineTerminalAgentId={inlineTerminalAgentId}
              clearHistoryPending={queries.clearHistoryMutation.isPending}
            />

            {showInlineTerminal && CHAT_INLINE_TERMINAL_ENABLED ? (
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
                <ChatMessageList
                  messages={queries.messages}
                  getAgentName={(agentId) =>
                    agentId ? (queries.agents.find((a) => a.id === agentId)?.name ?? null) : null
                  }
                  getProviderForAgent={queries.getProviderForAgent}
                />

                {/* Message Composer */}
                {composerBlockedContent ? (
                  <div className="border-t p-4" aria-live="polite">
                    {composerBlockedContent}
                  </div>
                ) : (
                  <ChatComposer
                    messageInput={threadUiState.messageInput}
                    setMessageInput={threadUiState.setMessageInput}
                    agents={queries.agents}
                    agentPresence={queries.agentPresence}
                    onSendMessage={handleSendMessage}
                    parseMentions={parseMentions}
                    isSending={queries.sendMessageMutation.isPending}
                  />
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

      {/* Modals */}
      <ChatModals
        groupDialogOpen={threadUiState.groupDialogOpen}
        setGroupDialogOpen={threadUiState.setGroupDialogOpen}
        inviteDialogOpen={threadUiState.inviteDialogOpen}
        setInviteDialogOpen={threadUiState.setInviteDialogOpen}
        settingsDialogOpen={threadUiState.settingsDialogOpen}
        setSettingsDialogOpen={threadUiState.setSettingsDialogOpen}
        clearHistoryDialogOpen={threadUiState.clearHistoryDialogOpen}
        setClearHistoryDialogOpen={threadUiState.setClearHistoryDialogOpen}
        terminateConfirm={sessionControls.terminateConfirm}
        setTerminateConfirm={sessionControls.setTerminateConfirm}
        terminateAllConfirm={sessionControls.terminateAllConfirm}
        setTerminateAllConfirm={sessionControls.setTerminateAllConfirm}
        mcpModalOpen={sessionControls.mcpModalOpen}
        setMcpModalOpen={sessionControls.setMcpModalOpen}
        agents={queries.agents}
        inviteableAgents={inviteableAgents}
        currentThread={currentThread}
        currentThreadMembers={currentThreadMembers}
        agentsWithSessions={sessionControls.agentsWithSessions}
        pendingLaunchAgent={sessionControls.pendingLaunchAgent}
        setPendingLaunchAgent={sessionControls.setPendingLaunchAgent}
        projectId={projectId}
        projectRootPath={selectedProject?.rootPath}
        hasSelectedProject={hasSelectedProject}
        selectedThreadId={threadUiState.selectedThreadId}
        threadDisplayName={threadDisplayName}
        onCreateGroup={handleCreateGroup}
        onInviteMembers={handleInviteMembers}
        onClearHistory={handleClearHistory}
        onPurgeHistory={handlePurgeHistory}
        onTerminateSession={sessionControls.handleTerminateSession}
        onTerminateAllAgents={sessionControls.handleTerminateAllAgents}
        onMcpConfigured={sessionControls.handleMcpConfigured}
        onVerifyMcp={handleVerifyMcp}
        launchingAgentIds={sessionControls.launchingAgentIds}
        clearHistoryPending={queries.clearHistoryMutation.isPending}
        purgeHistoryPending={queries.purgeHistoryMutation.isPending}
        invitePending={queries.inviteMembersMutation.isPending}
        terminatingAll={sessionControls.terminatingAll}
      />
    </div>
  );
}
