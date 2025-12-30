import { Button } from '@/ui/components/ui/button';
import { ArrowLeft, ExternalLink } from 'lucide-react';

interface InlineTerminalHeaderProps {
  agentName?: string | null;
  onBackToChat: () => void;
  showChatToggle?: boolean;
  onOpenWindow?: () => void;
}

export function InlineTerminalHeader({
  agentName,
  onBackToChat,
  showChatToggle = true,
  onOpenWindow,
}: InlineTerminalHeaderProps) {
  return (
    <div className="flex items-center justify-between border-b bg-muted/40 px-3 py-1.5">
      <div className="flex items-center gap-2">
        {showChatToggle && (
          <>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onBackToChat}
              aria-label="Back to chat messages"
              className="h-7 px-2"
            >
              <ArrowLeft className="mr-1 h-3.5 w-3.5" />
              <span className="text-xs">Chat</span>
            </Button>
            <div className="h-4 w-px bg-border" />
          </>
        )}
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium text-foreground">Terminal</span>
          {agentName ? <span className="text-xs text-muted-foreground">· {agentName}</span> : null}
        </div>
      </div>
      {onOpenWindow && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onOpenWindow}
          aria-label="Open terminal in window"
          className="h-7 px-2"
        >
          <ExternalLink className="mr-1 h-3.5 w-3.5" />
          <span className="text-xs">Window</span>
        </Button>
      )}
    </div>
  );
}
