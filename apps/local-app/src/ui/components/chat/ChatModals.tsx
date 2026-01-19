import { Button } from '@/ui/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/components/ui/dialog';
import { Loader2 } from 'lucide-react';
import { GroupCreationDialog } from '@/ui/components/chat/GroupCreationDialog';
import { InviteMembersDialog } from '@/ui/components/chat/InviteMembersDialog';
import { ChatSettingsDialog } from '@/ui/components/chat/ChatSettingsDialog';
import { McpConfigurationModal } from '@/ui/components/shared/McpConfigurationModal';
import type { AgentOrGuest, PendingLaunchAgent } from '@/ui/hooks/useChatQueries';
import type { Thread } from '@/ui/lib/chat';

// Feature flags
const CHAT_SETTINGS_AND_INVITES_ENABLED = false;
const CHAT_CLEAR_HISTORY_ENABLED = false;

export interface ChatModalsProps {
  // Dialog states
  groupDialogOpen: boolean;
  setGroupDialogOpen: (open: boolean) => void;
  inviteDialogOpen: boolean;
  setInviteDialogOpen: (open: boolean) => void;
  settingsDialogOpen: boolean;
  setSettingsDialogOpen: (open: boolean) => void;
  clearHistoryDialogOpen: boolean;
  setClearHistoryDialogOpen: (open: boolean) => void;
  terminateConfirm: { agentId: string; sessionId: string } | null;
  setTerminateConfirm: (confirm: { agentId: string; sessionId: string } | null) => void;
  terminateAllConfirm: boolean;
  setTerminateAllConfirm: (confirm: boolean) => void;
  mcpModalOpen: boolean;
  setMcpModalOpen: (open: boolean) => void;

  // Data
  agents: AgentOrGuest[];
  inviteableAgents: AgentOrGuest[];
  currentThread: Thread | null;
  currentThreadMembers: Array<{ id: string; name: string; online: boolean }>;
  agentsWithSessions: AgentOrGuest[];
  pendingLaunchAgent: PendingLaunchAgent | null;
  setPendingLaunchAgent: (agent: PendingLaunchAgent | null) => void;

  // Project context
  projectId: string | null;
  projectRootPath?: string;
  hasSelectedProject: boolean;
  selectedThreadId: string | null;
  threadDisplayName: string;

  // Handlers
  onCreateGroup: (agentIds: string[], title?: string) => Promise<void>;
  onInviteMembers: (agentIds: string[], inviterName?: string) => Promise<void>;
  onClearHistory: () => Promise<void>;
  onPurgeHistory: () => Promise<void>;
  onTerminateSession: (agentId: string, sessionId: string) => Promise<void>;
  onTerminateAllAgents: () => Promise<void>;
  onMcpConfigured: () => Promise<void>;
  onVerifyMcp: () => Promise<boolean>;

  // Loading states
  launchingAgentIds: Record<string, boolean>;
  clearHistoryPending: boolean;
  purgeHistoryPending: boolean;
  invitePending: boolean;
  terminatingAll: boolean;
}

export function ChatModals({
  groupDialogOpen,
  setGroupDialogOpen,
  inviteDialogOpen,
  setInviteDialogOpen,
  settingsDialogOpen,
  setSettingsDialogOpen,
  clearHistoryDialogOpen,
  setClearHistoryDialogOpen,
  terminateConfirm,
  setTerminateConfirm,
  terminateAllConfirm,
  setTerminateAllConfirm,
  mcpModalOpen,
  setMcpModalOpen,
  agents,
  inviteableAgents,
  currentThread,
  currentThreadMembers,
  agentsWithSessions,
  pendingLaunchAgent,
  setPendingLaunchAgent,
  projectId,
  projectRootPath,
  hasSelectedProject,
  selectedThreadId,
  threadDisplayName,
  onCreateGroup,
  onInviteMembers,
  onClearHistory,
  onPurgeHistory,
  onTerminateSession,
  onTerminateAllAgents,
  onMcpConfigured,
  onVerifyMcp,
  launchingAgentIds,
  clearHistoryPending,
  purgeHistoryPending,
  invitePending,
  terminatingAll,
}: ChatModalsProps) {
  const sampleInviteeName =
    inviteableAgents.length > 0 ? inviteableAgents[0].name : 'Invited Agent';

  return (
    <>
      {/* Group Creation Dialog */}
      <GroupCreationDialog
        open={groupDialogOpen}
        onOpenChange={setGroupDialogOpen}
        agents={agents}
        onCreateGroup={onCreateGroup}
      />

      {/* Invite Members Dialog */}
      <InviteMembersDialog
        open={inviteDialogOpen && CHAT_SETTINGS_AND_INVITES_ENABLED}
        onOpenChange={setInviteDialogOpen}
        agents={inviteableAgents}
        existingMemberIds={currentThread?.members ?? []}
        onInvite={onInviteMembers}
        isSubmitting={invitePending}
      />

      {/* Settings Dialog */}
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

      {/* Clear History Dialog */}
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
                disabled={clearHistoryPending || purgeHistoryPending}
              >
                Cancel
              </Button>
              <Button onClick={onClearHistory} disabled={clearHistoryPending}>
                {clearHistoryPending ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Clearing...
                  </>
                ) : (
                  'Clear'
                )}
              </Button>
              <Button variant="destructive" onClick={onPurgeHistory} disabled={purgeHistoryPending}>
                {purgeHistoryPending ? (
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

      {/* Terminate Confirm Dialog */}
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
                  void onTerminateSession(terminateConfirm.agentId, terminateConfirm.sessionId);
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

      {/* Terminate All Dialog */}
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
              onClick={onTerminateAllAgents}
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

      {/* MCP Configuration Modal */}
      {pendingLaunchAgent && (
        <McpConfigurationModal
          open={mcpModalOpen}
          onOpenChange={(open) => {
            setMcpModalOpen(open);
            if (!open) {
              setPendingLaunchAgent(null);
            }
          }}
          providerId={pendingLaunchAgent.providerId}
          providerName={pendingLaunchAgent.providerName}
          projectPath={projectRootPath}
          onConfigured={onMcpConfigured}
          onVerify={onVerifyMcp}
        />
      )}
    </>
  );
}
