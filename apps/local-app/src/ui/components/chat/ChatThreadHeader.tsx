import { useRef } from 'react';
import { Button } from '@/ui/components/ui/button';
import { Badge } from '@/ui/components/ui/badge';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/components/ui/popover';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/ui/components/ui/context-menu';
import { cn } from '@/ui/lib/utils';
import { Circle, Terminal, ChevronDown, UserPlus, Settings, MoreVertical } from 'lucide-react';
import type { AgentPresenceMap } from '@/ui/lib/sessions';
import type { Thread } from '@/ui/lib/chat';
import type { AgentOrGuest } from '@/ui/hooks/useChatQueries';

// Feature flags
const CHAT_SETTINGS_AND_INVITES_ENABLED = false;
const CHAT_CLEAR_HISTORY_ENABLED = false;
const CHAT_INLINE_TERMINAL_ENABLED = true;

export interface ChatThreadHeaderProps {
  // Data
  currentThread: Thread | null;
  currentThreadMembers: Array<{ id: string; name: string; online: boolean }>;
  selectedAgent: AgentOrGuest | null;
  threadDisplayName: string;
  agentPresence: AgentPresenceMap;
  inlineUnreadCount: number;

  // State
  terminalMenuOpen: boolean;
  hasSelectedProject: boolean;
  canInviteMembers: boolean;
  isCoarsePointer: boolean;

  // Handlers
  setTerminalMenuOpen: (open: boolean) => void;
  onOpenTerminal: (agentId: string) => void;
  onOpenInlineTerminal: (agentId: string) => void;
  onDetachInlineTerminal: () => void;
  onOpenInviteDialog: () => void;
  onOpenSettingsDialog: () => void;
  onOpenClearHistoryDialog: () => void;

  // Terminal state
  inlineTerminalAgentId: string | null;

  // Mutation states
  clearHistoryPending: boolean;
}

export function ChatThreadHeader({
  currentThread,
  currentThreadMembers,
  selectedAgent,
  threadDisplayName,
  agentPresence,
  inlineUnreadCount,
  terminalMenuOpen,
  hasSelectedProject,
  canInviteMembers,
  isCoarsePointer,
  setTerminalMenuOpen,
  onOpenTerminal,
  onOpenInlineTerminal,
  onDetachInlineTerminal,
  onOpenInviteDialog,
  onOpenSettingsDialog,
  onOpenClearHistoryDialog,
  inlineTerminalAgentId,
  clearHistoryPending,
}: ChatThreadHeaderProps) {
  const terminalMenuTriggerRef = useRef<HTMLButtonElement | null>(null);

  return (
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
                <div className="flex items-center gap-1" role="group" aria-label="Terminal actions">
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
                      onOpenTerminal(selectedAgent.id);
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
                      onClick={() => setTerminalMenuOpen(!terminalMenuOpen)}
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
                    onOpenInlineTerminal(selectedAgent.id);
                  }}
                  disabled={inlineTerminalAgentId === selectedAgent.id}
                >
                  Open Inline
                </ContextMenuItem>
                <ContextMenuItem
                  onSelect={(event) => {
                    event.preventDefault();
                    onOpenTerminal(selectedAgent.id);
                  }}
                >
                  Open in Window
                </ContextMenuItem>
                {inlineTerminalAgentId === selectedAgent.id && (
                  <ContextMenuItem
                    onSelect={(event) => {
                      event.preventDefault();
                      onDetachInlineTerminal();
                    }}
                  >
                    Detach Inline
                  </ContextMenuItem>
                )}
              </ContextMenuContent>
            </ContextMenu>
          )}
        {CHAT_SETTINGS_AND_INVITES_ENABLED && canInviteMembers && (
          <Button
            variant="outline"
            size="sm"
            onClick={onOpenInviteDialog}
            disabled={!hasSelectedProject}
            aria-label="Invite agents to this group"
          >
            <UserPlus className="mr-1 h-4 w-4" />
            Invite
          </Button>
        )}
        {CHAT_SETTINGS_AND_INVITES_ENABLED && (
          <Button
            variant="ghost"
            size="icon"
            onClick={onOpenSettingsDialog}
            disabled={!hasSelectedProject}
            aria-label="Chat settings"
          >
            <Settings className="h-4 w-4" />
          </Button>
        )}
        {CHAT_CLEAR_HISTORY_ENABLED && (
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
                onClick={onOpenClearHistoryDialog}
                disabled={clearHistoryPending}
                aria-label="Clear history for this thread"
              >
                Clear History
              </Button>
            </PopoverContent>
          </Popover>
        )}
      </div>
    </div>
  );
}
