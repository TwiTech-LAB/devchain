import { useCallback, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { cn } from '@/ui/lib/utils';
import { Button } from '@/ui/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/ui/components/ui/tooltip';
import { ArrowLeft, Check, Copy, ExternalLink } from 'lucide-react';
import {
  InlineSessionSummaryChip,
  type InlineSessionSummaryChipProps,
} from '@/ui/components/session-reader/InlineSessionSummaryChip';
import { renameSession, type ActiveSession } from '@/ui/lib/sessions';
import { chatQueryKeys } from '@/ui/hooks/useChatQueries';
import { useToast } from '@/ui/hooks/use-toast';
import { useFetchFactory } from '@/ui/hooks/useFetchFactory';

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
  /** Session ID for the name/ID chip — chip hidden when omitted */
  sessionId?: string | null;
  /** Session display name (nullable) */
  sessionName?: string | null;
  /** Project ID needed for rename API */
  projectId?: string | null;
}

function shortSessionId(id: string): string {
  if (id.length <= 12) return id;
  return `${id.slice(0, 8)}…${id.slice(-4)}`;
}

function truncateLabel(text: string, max = 16): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + '…';
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
  sessionId,
  sessionName,
  projectId,
}: InlineTerminalHeaderProps) {
  const showTabToggle = hasTranscript && onTabChange;
  const showSessionChip = !!sessionId;

  return (
    <div className="flex items-center justify-between border-b bg-muted/40 px-3 py-1.5">
      <div className="flex min-w-0 items-center gap-2">
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
        <div className="flex min-w-0 items-center gap-1.5">
          {showTabToggle ? (
            <div
              className="flex shrink-0 items-center rounded-md border border-border/60 bg-muted/30"
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
            <span className="shrink-0 text-xs font-medium text-foreground">Terminal</span>
          )}
          {agentName ? (
            <span className="shrink-0 text-xs text-muted-foreground">· {agentName}</span>
          ) : null}
          {showSessionChip && (
            <SessionNameChip
              sessionId={sessionId!}
              sessionName={sessionName ?? null}
              projectId={projectId ?? null}
            />
          )}
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

function SessionNameChip({
  sessionId,
  sessionName,
  projectId,
}: {
  sessionId: string;
  sessionName: string | null;
  projectId: string | null;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const apiFetch = useFetchFactory();
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const [copied, setCopied] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const displayLabel = sessionName || shortSessionId(sessionId);

  const startEditing = useCallback(() => {
    if (!projectId) return;
    setEditValue(sessionName ?? '');
    setEditing(true);
    setTimeout(() => inputRef.current?.select(), 0);
  }, [projectId, sessionName]);

  const commitRename = useCallback(async () => {
    setEditing(false);
    if (!projectId) return;
    const trimmed = editValue.trim();
    const newName = trimmed || null;
    if (newName === sessionName) return;

    const cacheKey = chatQueryKeys.activeSessions(projectId);
    const previous = queryClient.getQueryData<ActiveSession[]>(cacheKey);

    queryClient.setQueryData<ActiveSession[]>(cacheKey, (old) =>
      old?.map((s) => (s.id === sessionId ? { ...s, name: newName } : s)),
    );

    try {
      await renameSession(sessionId, projectId, newName, apiFetch);
    } catch {
      queryClient.setQueryData(cacheKey, previous);
      toast({ variant: 'destructive', description: 'Failed to rename session.' });
    }
  }, [editValue, projectId, sessionId, sessionName, queryClient, toast]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commitRename();
      } else if (e.key === 'Escape') {
        setEditing(false);
      }
    },
    [commitRename],
  );

  const copyId = useCallback(async () => {
    await navigator.clipboard.writeText(sessionId);
    setCopied(true);
    toast({ description: 'Session ID copied.' });
    setTimeout(() => setCopied(false), 2000);
  }, [sessionId, toast]);

  if (editing) {
    return (
      <div className="flex items-center gap-1">
        <span className="text-xs text-muted-foreground">·</span>
        <input
          ref={inputRef}
          type="text"
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onBlur={commitRename}
          onKeyDown={handleKeyDown}
          maxLength={120}
          className="h-5 w-36 rounded border border-border bg-background px-1 text-xs text-foreground outline-none focus:ring-1 focus:ring-ring"
          aria-label="Session name"
        />
      </div>
    );
  }

  return (
    <div className="flex min-w-0 items-center gap-0.5">
      <span className="shrink-0 text-xs text-muted-foreground">·</span>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={startEditing}
              className="min-w-0 truncate rounded px-1 py-0.5 font-mono text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label="Rename session"
            >
              {truncateLabel(displayLabel)}
            </button>
          </TooltipTrigger>
          <TooltipContent>
            <span className="font-mono text-xs">{sessionId}</span>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <button
        type="button"
        onClick={copyId}
        className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
        aria-label="Copy session ID"
      >
        {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      </button>
    </div>
  );
}
