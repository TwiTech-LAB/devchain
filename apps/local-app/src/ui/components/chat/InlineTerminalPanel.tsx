import { useEffect, useMemo, useRef } from 'react';
import { Terminal as InlineTerminal, type TerminalHandle } from '@/ui/components/Terminal';
import { Button } from '@/ui/components/ui/button';
import { useTerminalWindows } from '@/ui/terminal-windows';
import {
  getAppSocket,
  getWorktreeSocket,
  releaseAppSocket,
  releaseWorktreeSocket,
} from '@/ui/lib/socket';
import { useOptionalWorktreeTab } from '@/ui/hooks/useWorktreeTab';
import type { Socket } from 'socket.io-client';
import type { InlineTerminalTab } from './InlineTerminalHeader';

interface InlineTerminalPanelProps {
  sessionId: string | null;
  agentName?: string | null;
  isWindowOpen: boolean;
  emptyState?: React.ReactNode;
  socket?: Socket;
  windowId?: string | null;
  /** Currently active tab — controls CSS visibility of terminal */
  activeTab?: InlineTerminalTab;
  /** Content to render when Session tab is active */
  sessionContent?: React.ReactNode;
}

export function InlineTerminalPanel({
  sessionId,
  agentName,
  isWindowOpen,
  emptyState,
  socket,
  windowId,
  activeTab = 'terminal',
  sessionContent,
}: InlineTerminalPanelProps) {
  const { activeWorktree } = useOptionalWorktreeTab();
  const worktreeName = useMemo(() => {
    const normalized = activeWorktree?.name?.trim() ?? '';
    return normalized.length > 0 ? normalized : null;
  }, [activeWorktree?.name]);

  const resolvedSocket = useMemo<Socket>(() => {
    if (socket) return socket;
    if (worktreeName) return getWorktreeSocket(worktreeName);
    return getAppSocket();
  }, [socket, worktreeName]);

  useEffect(() => {
    if (socket) return;
    return () => {
      if (worktreeName) {
        releaseWorktreeSocket(worktreeName);
      } else {
        releaseAppSocket();
      }
    };
  }, [socket, worktreeName]);

  const handleRef = useRef<TerminalHandle | null>(null);
  const { closeWindow } = useTerminalWindows();
  const targetWindowId = windowId ?? sessionId;

  // Auto-focus inline terminal when it is rendered as the active view
  useEffect(() => {
    if (sessionId && !isWindowOpen && activeTab === 'terminal') {
      const t = setTimeout(() => handleRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }
    return;
  }, [sessionId, isWindowOpen, activeTab]);

  if (!sessionId) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground">
        {emptyState ?? <p>Agent must be online before the terminal is available.</p>}
      </div>
    );
  }

  if (isWindowOpen) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center text-sm">
        <p className="text-muted-foreground">
          Terminal is open in a floating window. Reopen it here to continue in chat.
        </p>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            if (!targetWindowId) {
              return;
            }
            try {
              closeWindow(targetWindowId);
            } catch {}
            setTimeout(() => handleRef.current?.focus(), 0);
          }}
          aria-label="Reopen terminal in chat"
        >
          Reopen Here
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      {/* Terminal — always mounted, CSS-hidden when Session tab active */}
      <div
        className="flex-1 min-h-0"
        style={{ display: activeTab === 'terminal' ? 'flex' : 'none' }}
      >
        <InlineTerminal
          ref={handleRef}
          key={sessionId}
          sessionId={sessionId}
          socket={resolvedSocket}
          chrome="none"
          className="flex-1"
          ariaLabel={agentName ? `Inline terminal for ${agentName}` : 'Inline terminal'}
        />
      </div>

      {/* Session viewer — shown when Session tab active */}
      {activeTab === 'session' && (
        <div className="flex flex-1 min-h-0 flex-col" data-testid="session-tab-content">
          {sessionContent ?? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              <p>Session viewer loading…</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
