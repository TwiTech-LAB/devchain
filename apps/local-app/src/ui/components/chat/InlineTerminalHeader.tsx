import { useCallback, useRef, useState, type Ref } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { cn } from '@/ui/lib/utils';
import { Button } from '@/ui/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/ui/components/ui/tooltip';
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuCheckboxItem,
} from '@/ui/components/ui/context-menu';
import { ArrowLeft, Check, ClockArrowDown, Copy, ExternalLink, FileText } from 'lucide-react';
import {
  InlineSessionSummaryChip,
  readChipPrefs,
  writeChipPrefs,
  type ChipVisibleItems,
  type InlineSessionSummaryChipProps,
} from '@/ui/components/session-reader/InlineSessionSummaryChip';
import { renameSession, type ActiveSession } from '@/ui/lib/sessions';
import { formatEpicTimeMinutes, MIN_VISIBLE_AGENT_TIME_BUFFER_MINUTES } from '@/ui/lib/epic-time';
import { chatQueryKeys } from '@/ui/hooks/useChatQueries';
import { useToast } from '@/ui/hooks/use-toast';
import { useFetchFactory } from '@/ui/hooks/useFetchFactory';

export type InlineTerminalTab = 'terminal' | 'session';

/** Persisted visibility of the header's unlogged-time action; row markers ignore it. */
const UNLOGGED_TIME_VISIBLE_STORAGE_KEY = 'devchain:headerUnloggedTimeVisible';

function readUnloggedTimeVisible(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    return window.localStorage.getItem(UNLOGGED_TIME_VISIBLE_STORAGE_KEY) !== 'false';
  } catch {
    return true;
  }
}

function writeUnloggedTimeVisible(visible: boolean) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(UNLOGGED_TIME_VISIBLE_STORAGE_KEY, String(visible));
  } catch {
    // Ignore storage write failures
  }
}

interface InlineTerminalHeaderProps {
  agentName?: string | null;
  onBackToChat?: () => void;
  showChatToggle?: boolean;
  onOpenWindow?: () => void;
  onOpenPrompts?: () => void;
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
  /**
   * Unlogged-time capability for this header. Present only on the main
   * inline terminal; whole minutes below one keep the action hidden while
   * the capability (and the Visible Items entry) stays declared.
   */
  unloggedTime?: { minutes: number; onAssign: () => void } | null;
  /** Connected root element for programmatic focus (tabIndex is -1). */
  headerRef?: Ref<HTMLDivElement>;
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
  onOpenPrompts,
  sessionChip,
  activeTab = 'terminal',
  onTabChange,
  hasTranscript = false,
  sessionId,
  sessionName,
  projectId,
  unloggedTime = null,
  headerRef,
}: InlineTerminalHeaderProps) {
  const connectedHeaderRef = useRef<HTMLDivElement | null>(null);
  const [chipPrefs, setChipPrefs] = useState<ChipVisibleItems>(() => readChipPrefs());
  const [unloggedTimeVisible, setUnloggedTimeVisible] = useState(() => readUnloggedTimeVisible());
  const showTabToggle = hasTranscript && onTabChange;
  const showSessionChip = !!sessionId;
  const showMetricItems = Boolean(sessionChip);
  const unloggedDurationLabel =
    unloggedTime && unloggedTime.minutes >= MIN_VISIBLE_AGENT_TIME_BUFFER_MINUTES
      ? formatEpicTimeMinutes(unloggedTime.minutes)
      : null;
  const unloggedLabel = unloggedDurationLabel
    ? `${unloggedDurationLabel} not logged to an Epic.`
    : null;
  const unloggedAction =
    unloggedDurationLabel && unloggedTimeVisible && unloggedTime ? unloggedTime : null;

  const setChipVisibleItem = useCallback((key: keyof ChipVisibleItems, checked: boolean) => {
    setChipPrefs((previous) => {
      const next = { ...previous, [key]: checked };
      writeChipPrefs(next);
      return next;
    });
  }, []);

  const toggleUnloggedTimeVisible = useCallback((checked: boolean) => {
    setUnloggedTimeVisible(checked);
    writeUnloggedTimeVisible(checked);
  }, []);

  const setHeaderElement = useCallback(
    (element: HTMLDivElement | null) => {
      connectedHeaderRef.current = element;
      if (typeof headerRef === 'function') {
        headerRef(element);
      } else if (headerRef && typeof headerRef === 'object') {
        (headerRef as { current: HTMLDivElement | null }).current = element;
      }
    },
    [headerRef],
  );

  // Shift+F10 opens the root menu for keyboard users; the root itself is not
  // a tab stop (tabIndex -1), so this fires while focus sits inside the header.
  const handleRootKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (
      event.key === 'F10' &&
      event.shiftKey &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey
    ) {
      event.preventDefault();
      event.stopPropagation();
      connectedHeaderRef.current?.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }),
      );
    }
  }, []);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={setHeaderElement}
          tabIndex={-1}
          onKeyDown={handleRootKeyDown}
          className="flex items-center justify-between border-b bg-muted/40 px-3 py-1.5 outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <div className="flex min-w-0 items-center gap-2">
            {showChatToggle && onBackToChat && (
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
              {sessionChip && (
                <InlineSessionSummaryChip {...sessionChip} visibleItems={chipPrefs} />
              )}
            </div>
          </div>
          <div className="flex items-center gap-1">
            {unloggedAction && (
              <TooltipProvider delayDuration={300}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={unloggedAction.onAssign}
                      aria-label={`Log unlogged time to an Epic (${unloggedDurationLabel})`}
                      className="h-7 px-2 text-xs"
                    >
                      <ClockArrowDown
                        className="mr-1 h-3.5 w-3.5 text-amber-700 dark:text-amber-500"
                        aria-hidden="true"
                      />
                      <span className="tabular-nums">{unloggedDurationLabel}</span>
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{unloggedLabel}</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
            {onOpenPrompts && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={onOpenPrompts}
                aria-label="Open custom prompts"
                aria-keyshortcuts="Alt+Shift+P"
                className="h-7 px-2"
              >
                <FileText className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                <span className="text-xs">Prompts</span>
              </Button>
            )}
            {onOpenWindow && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={onOpenWindow}
                aria-label="Open terminal in window"
                className="h-7 px-2"
              >
                <ExternalLink className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                <span className="text-xs">Window</span>
              </Button>
            )}
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        <ContextMenuLabel>Visible Items</ContextMenuLabel>
        <ContextMenuSeparator />
        {showMetricItems && (
          <>
            <ContextMenuCheckboxItem
              checked={chipPrefs.tokens}
              onCheckedChange={(checked) => setChipVisibleItem('tokens', checked === true)}
            >
              Tokens
            </ContextMenuCheckboxItem>
            <ContextMenuCheckboxItem
              checked={chipPrefs.cost}
              onCheckedChange={(checked) => setChipVisibleItem('cost', checked === true)}
            >
              Cost
            </ContextMenuCheckboxItem>
            <ContextMenuCheckboxItem
              checked={chipPrefs.context}
              onCheckedChange={(checked) => setChipVisibleItem('context', checked === true)}
            >
              Context
            </ContextMenuCheckboxItem>
            <ContextMenuCheckboxItem
              checked={chipPrefs.compactions}
              onCheckedChange={(checked) => setChipVisibleItem('compactions', checked === true)}
            >
              Compactions
            </ContextMenuCheckboxItem>
          </>
        )}
        {unloggedTime !== null && (
          <ContextMenuCheckboxItem
            checked={unloggedTimeVisible}
            onCheckedChange={(checked) => toggleUnloggedTimeVisible(checked === true)}
          >
            Unlogged time
          </ContextMenuCheckboxItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
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
