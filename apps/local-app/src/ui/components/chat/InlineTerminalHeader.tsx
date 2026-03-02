import { cn } from '@/ui/lib/utils';
import { Button } from '@/ui/components/ui/button';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import {
  InlineSessionSummaryChip,
  type InlineSessionSummaryChipProps,
} from '@/ui/components/session-reader/InlineSessionSummaryChip';

export type InlineTerminalTab = 'terminal' | 'session';

interface InlineTerminalHeaderProps {
  agentName?: string | null;
  onBackToChat: () => void;
  showChatToggle?: boolean;
  onOpenWindow?: () => void;
  /** Session summary chip props — chip hidden when omitted */
  sessionChip?: Pick<InlineSessionSummaryChipProps, 'metrics' | 'activeTab' | 'onSwitchToSession'>;
  /** Currently active tab */
  activeTab?: InlineTerminalTab;
  /** Callback when tab changes */
  onTabChange?: (tab: InlineTerminalTab) => void;
  /** Whether a transcript is available (controls Session tab visibility) */
  hasTranscript?: boolean;
}

export function InlineTerminalHeader({
  agentName,
  onBackToChat,
  showChatToggle = true,
  onOpenWindow,
  sessionChip,
  activeTab = 'terminal',
  onTabChange,
  hasTranscript = false,
}: InlineTerminalHeaderProps) {
  const showTabToggle = hasTranscript && onTabChange;

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
          {showTabToggle ? (
            <div
              className="flex items-center rounded-md border border-border/60 bg-muted/30"
              role="tablist"
              aria-label="Terminal panel tabs"
            >
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'terminal'}
                onClick={() => onTabChange('terminal')}
                className={cn(
                  'px-2 py-0.5 text-xs font-medium transition-colors rounded-l-[5px]',
                  activeTab === 'terminal'
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                Terminal
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'session'}
                onClick={() => onTabChange('session')}
                className={cn(
                  'px-2 py-0.5 text-xs font-medium transition-colors rounded-r-[5px]',
                  activeTab === 'session'
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                Session
              </button>
            </div>
          ) : (
            <span className="text-xs font-medium text-foreground">Terminal</span>
          )}
          {agentName ? <span className="text-xs text-muted-foreground">· {agentName}</span> : null}
          {sessionChip && <InlineSessionSummaryChip {...sessionChip} />}
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
