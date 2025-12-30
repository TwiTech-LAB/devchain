import { useEffect, useRef } from 'react';
import { Terminal as InlineTerminal, type TerminalHandle } from '@/ui/components/Terminal';
import { Button } from '@/ui/components/ui/button';
import { useTerminalWindows } from '@/ui/terminal-windows';
import { getAppSocket } from '@/ui/lib/socket';

interface InlineTerminalPanelProps {
  sessionId: string | null;
  agentName?: string | null;
  isWindowOpen: boolean;
  emptyState?: React.ReactNode;
}

export function InlineTerminalPanel({
  sessionId,
  agentName,
  isWindowOpen,
  emptyState,
}: InlineTerminalPanelProps) {
  const handleRef = useRef<TerminalHandle | null>(null);
  const { closeWindow } = useTerminalWindows();

  // Auto-focus inline terminal when it is rendered as the active view
  useEffect(() => {
    if (sessionId && !isWindowOpen) {
      const t = setTimeout(() => handleRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }
    return;
  }, [sessionId, isWindowOpen]);

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
            try {
              closeWindow(sessionId);
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
    <InlineTerminal
      ref={handleRef}
      key={sessionId}
      sessionId={sessionId}
      socket={getAppSocket()}
      chrome="none"
      className="flex-1"
      ariaLabel={agentName ? `Inline terminal for ${agentName}` : 'Inline terminal'}
    />
  );
}
