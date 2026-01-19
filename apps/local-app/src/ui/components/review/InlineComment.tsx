import { useState, useMemo, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/ui/components/ui/button';
import { Badge } from '@/ui/components/ui/badge';
import { Textarea } from '@/ui/components/ui/textarea';
import { Input } from '@/ui/components/ui/input';
import { ToggleGroup, ToggleGroupItem } from '@/ui/components/ui/toggle-group';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/ui/components/ui/tooltip';
import { MessageSquare, Plus, ChevronDown, ChevronRight, Bot, User, X, Search } from 'lucide-react';
import { cn } from '@/ui/lib/utils';
import { useMentionAutocomplete } from '@/ui/hooks/useMentionAutocomplete';
import { parseMentions } from '@/ui/lib/chat';
import type { ReviewComment, CommentType } from '@/ui/lib/reviews';
import type { ActiveSession } from '@/ui/lib/sessions';

interface Agent {
  id: string;
  name: string;
}

async function fetchAgents(projectId: string): Promise<{ items: Agent[] }> {
  const res = await fetch(`/api/agents?projectId=${encodeURIComponent(projectId)}`);
  if (!res.ok) throw new Error('Failed to fetch agents');
  return res.json();
}

// Simple relative time formatter
function formatRelativeTime(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffSec < 60) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHour < 24) return `${diffHour}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;
  return date.toLocaleDateString();
}

export interface LineSelection {
  lineStart: number;
  lineEnd: number;
  side: 'old' | 'new';
}

export interface AddCommentButtonProps {
  lineNumber: number;
  side: 'old' | 'new';
  onAddComment: (lineStart: number, lineEnd: number, side: 'old' | 'new') => void;
  lineSelection?: LineSelection | null;
  className?: string;
}

/**
 * Button shown when hovering/clicking on a gutter to add a comment
 */
export function AddCommentButton({
  lineNumber,
  side,
  onAddComment,
  lineSelection,
  className,
}: AddCommentButtonProps) {
  const isInSelection =
    lineSelection &&
    lineSelection.side === side &&
    lineNumber >= lineSelection.lineStart &&
    lineNumber <= lineSelection.lineEnd;

  const handleClick = () => {
    if (lineSelection && lineSelection.side === side) {
      onAddComment(lineSelection.lineStart, lineSelection.lineEnd, side);
    } else {
      onAddComment(lineNumber, lineNumber, side);
    }
  };

  return (
    <Button
      size="sm"
      variant="ghost"
      className={cn(
        'h-5 w-5 p-0 rounded-full bg-blue-500 hover:bg-blue-600 text-white',
        isInSelection && 'bg-blue-600',
        className,
      )}
      onClick={handleClick}
      title="Add comment"
      aria-label={`Add comment on line ${lineNumber}`}
    >
      <Plus className="h-3 w-3" aria-hidden="true" />
    </Button>
  );
}

export interface CommentIndicatorProps {
  commentCount: number;
  hasUnresolved: boolean;
  onClick: () => void;
  className?: string;
}

/**
 * Indicator shown in the gutter for lines with comments
 */
export function CommentIndicator({
  commentCount,
  hasUnresolved,
  onClick,
  className,
}: CommentIndicatorProps) {
  const label = `${commentCount} comment${commentCount > 1 ? 's' : ''}${hasUnresolved ? ', has unresolved' : ''}`;
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex items-center justify-center h-5 w-5 rounded-full text-xs',
        hasUnresolved
          ? 'bg-amber-100 text-amber-800 hover:bg-amber-200 dark:bg-amber-900/30 dark:text-amber-400'
          : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-400',
        className,
      )}
      title={`${commentCount} comment${commentCount > 1 ? 's' : ''}`}
      aria-label={label}
    >
      <MessageSquare className="h-3 w-3" aria-hidden="true" />
    </button>
  );
}

export interface InlineCommentWidgetProps {
  comments: ReviewComment[];
  /** Whether this comment thread is pending (waiting for agent response) */
  isPending?: boolean;
  /** Lookup function to get ActiveSession for an agent (for terminal integration) */
  getSessionForAgent?: (agentId: string) => ActiveSession | null;
  /** Callback to open terminal for a session */
  onOpenTerminal?: (session: ActiveSession) => void;
  isExpanded?: boolean;
  onToggleExpand?: () => void;
  onReply?: (content: string) => Promise<void>;
  isReplying?: boolean;
  className?: string;
}

/**
 * Inline comment widget displayed below a diff line
 *
 * @deprecated Use CommentThread component instead which provides full action support
 * (reply, resolve, edit, delete). InlineCommentWidget only supports reply.
 * This component is kept for reference and backward compatibility.
 */
export function InlineCommentWidget({
  comments,
  isPending = false,
  getSessionForAgent,
  onOpenTerminal,
  isExpanded = true,
  onToggleExpand,
  onReply,
  isReplying = false,
  className,
}: InlineCommentWidgetProps) {
  const [showReplyInput, setShowReplyInput] = useState(false);
  const [replyContent, setReplyContent] = useState('');

  const rootComment = comments[0];
  const replies = comments.slice(1);
  const unresolvedCount = comments.filter((c) => c.status === 'open').length;

  // Render clickable agent link or disabled tooltip for "Waiting on" display
  const renderAgentLink = (agentId: string, agentName: string, showComma: boolean) => {
    const session = getSessionForAgent?.(agentId) ?? null;

    return (
      <span key={agentId}>
        {showComma && ', '}
        {session && onOpenTerminal ? (
          <button
            onClick={() => onOpenTerminal(session)}
            className="text-amber-700 hover:text-amber-900 hover:underline font-medium"
          >
            {agentName}
          </button>
        ) : (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="text-amber-800/70 dark:text-amber-400/70 cursor-not-allowed">
                  {agentName}
                </span>
              </TooltipTrigger>
              <TooltipContent>
                <p>No running session</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </span>
    );
  };

  // Render "Waiting on" section for pending comments
  const renderWaitingOn = () => {
    if (!isPending || !rootComment?.targetAgents || rootComment.targetAgents.length === 0) {
      return null;
    }

    const MAX_SHOWN = 3;
    const shown = rootComment.targetAgents.slice(0, MAX_SHOWN);
    const remaining = rootComment.targetAgents.length - MAX_SHOWN;

    return (
      <span className="text-xs text-amber-700 dark:text-amber-500 flex items-center gap-1 ml-2">
        Waiting on: {shown.map((agent, i) => renderAgentLink(agent.agentId, agent.name, i > 0))}
        {remaining > 0 && (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="text-amber-700 dark:text-amber-500 cursor-help">
                  +{remaining} more
                </span>
              </TooltipTrigger>
              <TooltipContent>
                <p>
                  {rootComment.targetAgents
                    .slice(MAX_SHOWN)
                    .map((a) => a.name)
                    .join(', ')}
                </p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </span>
    );
  };

  const handleSubmitReply = async () => {
    if (!replyContent.trim() || !onReply) return;
    await onReply(replyContent.trim());
    setReplyContent('');
    setShowReplyInput(false);
  };

  if (!rootComment) return null;

  return (
    <div
      className={cn(
        'inline-comment-widget border-l-2 px-3 py-2 my-1',
        // Pending state: amber/yellow highlight
        isPending
          ? 'border-amber-500 bg-amber-50/50 dark:bg-amber-950/20'
          : 'border-blue-400 bg-blue-50/50 dark:bg-blue-950/20',
        className,
      )}
      data-testid="inline-comment-widget"
      role="region"
      aria-label={`Inline comment thread with ${comments.length} comment${comments.length > 1 ? 's' : ''}`}
    >
      {/* Header */}
      <div className="flex items-center gap-2 mb-2">
        <button
          onClick={onToggleExpand}
          className="flex items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground"
          aria-expanded={isExpanded}
          aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${comments.length} comment${comments.length > 1 ? 's' : ''}`}
        >
          {isExpanded ? (
            <ChevronDown className="h-4 w-4" aria-hidden="true" />
          ) : (
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          )}
          <MessageSquare className="h-4 w-4" aria-hidden="true" />
          <span>
            {comments.length} comment{comments.length > 1 ? 's' : ''}
          </span>
        </button>
        {unresolvedCount > 0 && (
          <Badge
            variant="secondary"
            className="text-xs bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400"
            aria-label={`${unresolvedCount} open comment${unresolvedCount > 1 ? 's' : ''}`}
          >
            {unresolvedCount} open
          </Badge>
        )}
        {renderWaitingOn()}
      </div>

      {/* Comments */}
      {isExpanded && (
        <div className="space-y-2">
          {/* Root comment */}
          <CommentItem
            comment={rootComment}
            getSessionForAgent={getSessionForAgent}
            onOpenTerminal={onOpenTerminal}
          />

          {/* Replies */}
          {replies.map((reply) => (
            <div key={reply.id} className="ml-4 pl-3 border-l-2 border-muted">
              <CommentItem
                comment={reply}
                getSessionForAgent={getSessionForAgent}
                onOpenTerminal={onOpenTerminal}
              />
            </div>
          ))}

          {/* Reply input */}
          {showReplyInput ? (
            <div className="ml-4 space-y-2">
              <Textarea
                placeholder="Write a reply..."
                value={replyContent}
                onChange={(e) => setReplyContent(e.target.value)}
                className="min-h-[60px] text-sm bg-white"
                disabled={isReplying}
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  onClick={handleSubmitReply}
                  disabled={!replyContent.trim() || isReplying}
                >
                  {isReplying ? 'Posting...' : 'Reply'}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setShowReplyInput(false);
                    setReplyContent('');
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            onReply && (
              <Button
                size="sm"
                variant="ghost"
                className="text-xs"
                onClick={() => setShowReplyInput(true)}
              >
                Reply
              </Button>
            )
          )}
        </div>
      )}
    </div>
  );
}

function CommentItem({
  comment,
  getSessionForAgent,
  onOpenTerminal,
}: {
  comment: ReviewComment;
  getSessionForAgent?: (agentId: string) => ActiveSession | null;
  onOpenTerminal?: (session: ActiveSession) => void;
}) {
  const isAgent = comment.authorType === 'agent';
  const AuthorIcon = isAgent ? Bot : User;
  const authorName = isAgent
    ? (comment.authorAgentName ?? comment.authorAgentId?.slice(0, 8) ?? 'Agent')
    : 'You';

  // Check if author agent has an active session
  const authorSession =
    isAgent && comment.authorAgentId && getSessionForAgent
      ? getSessionForAgent(comment.authorAgentId)
      : null;

  // Handle clicking on agent name to open terminal
  const handleAuthorClick = () => {
    if (authorSession && onOpenTerminal) {
      onOpenTerminal(authorSession);
    }
  };

  return (
    <div className="text-sm">
      <div className="flex items-center gap-2 mb-1">
        <div
          className={cn(
            'flex items-center gap-1 font-medium',
            isAgent ? 'text-purple-700' : 'text-foreground',
          )}
        >
          <AuthorIcon className="h-3 w-3" />
          {isAgent && authorSession && onOpenTerminal ? (
            <button
              onClick={handleAuthorClick}
              className="text-xs hover:underline"
              title="Open terminal"
            >
              {authorName}
            </button>
          ) : isAgent && !authorSession && getSessionForAgent ? (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="text-xs cursor-not-allowed opacity-75">{authorName}</span>
                </TooltipTrigger>
                <TooltipContent>
                  <p>No running session</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          ) : (
            <span className="text-xs">{authorName}</span>
          )}
        </div>
        <span className="text-xs text-muted-foreground">
          {formatRelativeTime(comment.createdAt)}
        </span>
        {comment.status !== 'open' && (
          <Badge
            variant="secondary"
            className={cn(
              'text-[10px] px-1',
              comment.status === 'resolved'
                ? 'bg-green-100 text-green-700'
                : 'bg-gray-100 text-gray-600',
            )}
          >
            {comment.status === 'resolved' ? 'Resolved' : "Won't fix"}
          </Badge>
        )}
      </div>
      <p className="whitespace-pre-wrap text-foreground">{comment.content}</p>
    </div>
  );
}

export interface NewCommentFormProps {
  lineStart: number;
  lineEnd: number;
  side: 'old' | 'new';
  projectId: string;
  onSubmit: (content: string, commentType: CommentType, targetAgentIds: string[]) => Promise<void>;
  onCancel: () => void;
  isSubmitting?: boolean;
  className?: string;
}

/**
 * Form for creating a new comment on a line or range
 */
export function NewCommentForm({
  lineStart,
  lineEnd,
  side,
  projectId,
  onSubmit,
  onCancel,
  isSubmitting = false,
  className,
}: NewCommentFormProps) {
  const [content, setContent] = useState('');
  const [commentType, setCommentType] = useState<CommentType>('comment');
  const [selectedAgentIds, setSelectedAgentIds] = useState<Set<string>>(new Set());
  const [agentSearch, setAgentSearch] = useState('');
  const [showAllAgents, setShowAllAgents] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Fetch agents for the project (always fetch when projectId is available)
  const { data: agentsData, isLoading: agentsLoading } = useQuery({
    queryKey: ['agents', projectId],
    queryFn: () => fetchAgents(projectId),
    enabled: !!projectId,
  });

  const agents = agentsData?.items ?? [];

  // @ mention autocomplete
  const {
    showAutocomplete,
    mentionQuery,
    selectedIndex,
    handleInputChange,
    handleKeyDown: mentionHandleKeyDown,
    insertMention,
  } = useMentionAutocomplete(textareaRef, agents, (agent) => {
    // Auto-select agent chip when selected via Enter key
    setSelectedAgentIds((prev) => new Set([...prev, agent.id]));
  });

  // Filter agents for autocomplete dropdown
  const autocompleteAgents = useMemo(() => {
    return agents.filter((agent) => agent.name.toLowerCase().includes(mentionQuery.toLowerCase()));
  }, [agents, mentionQuery]);

  // Handle selecting an agent from autocomplete
  const handleMentionSelect = (agent: Agent) => {
    const newContent = insertMention(agent, content);
    setContent(newContent);
    // Also add to selected agents (pills)
    setSelectedAgentIds((prev) => new Set([...prev, agent.id]));
  };

  // Filter agents by search
  const filteredAgents = useMemo(() => {
    if (!agentSearch.trim()) return agents;
    const search = agentSearch.toLowerCase();
    return agents.filter((agent) => agent.name.toLowerCase().includes(search));
  }, [agents, agentSearch]);

  // Visible agents (first 6 when not expanded, but always include selected agents)
  const MAX_VISIBLE_AGENTS = 6;
  const visibleAgents = useMemo(() => {
    if (showAllAgents) return filteredAgents;

    const firstN = filteredAgents.slice(0, MAX_VISIBLE_AGENTS);
    // Add any selected agents that aren't already in the first N
    const selectedNotInFirstN = filteredAgents.filter(
      (agent) => selectedAgentIds.has(agent.id) && !firstN.some((a) => a.id === agent.id),
    );
    return [...firstN, ...selectedNotInFirstN];
  }, [filteredAgents, showAllAgents, selectedAgentIds]);
  const hasMoreAgents = filteredAgents.length > MAX_VISIBLE_AGENTS;

  const lineRange = lineStart === lineEnd ? `Line ${lineStart}` : `Lines ${lineStart}-${lineEnd}`;

  const handleSubmit = async () => {
    if (!content.trim()) return;
    // Compute target agents as union of pills + mentions in text
    const mentionedIds = parseMentions(content, agents);
    const targetAgentIds = [...new Set([...selectedAgentIds, ...mentionedIds])];
    await onSubmit(content.trim(), commentType, targetAgentIds);
  };

  return (
    <div
      className={cn(
        'new-comment-form border-l-2 border-green-400 bg-green-50/50 dark:bg-green-950/30 px-3 py-2 my-1',
        className,
      )}
      data-testid="new-comment-form"
    >
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-muted-foreground">
          {lineRange} ({side === 'new' ? 'new' : 'old'})
        </span>
        <Button size="sm" variant="ghost" className="h-5 w-5 p-0" onClick={onCancel}>
          <X className="h-3 w-3" />
        </Button>
      </div>

      {/* Textarea with @ mention autocomplete */}
      <div className="relative mb-2">
        <Textarea
          ref={textareaRef}
          placeholder="Write a comment... (type @ to mention agents)"
          value={content}
          onChange={(e) => {
            setContent(e.target.value);
            handleInputChange(e.target.value, e.target.selectionStart);
          }}
          onKeyDown={(e) => {
            mentionHandleKeyDown(e, content, setContent);
          }}
          className="min-h-[80px] text-sm bg-white dark:bg-background"
          disabled={isSubmitting}
          autoFocus
        />
        {/* Autocomplete dropdown */}
        {showAutocomplete && autocompleteAgents.length > 0 && (
          <div className="absolute bottom-full left-0 mb-1 w-48 max-h-40 overflow-auto bg-popover border rounded-md shadow-lg z-50">
            {autocompleteAgents.map((agent, index) => (
              <button
                key={agent.id}
                type="button"
                className={cn(
                  'w-full px-3 py-1.5 text-sm text-left flex items-center gap-2 hover:bg-accent',
                  index === selectedIndex && 'bg-accent',
                )}
                onClick={() => handleMentionSelect(agent)}
              >
                <Bot className="h-3 w-3 text-muted-foreground" />
                {agent.name}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Agent Assignment - Always visible pill buttons */}
      {agents.length > 0 && (
        <div className="mb-2 space-y-2" role="group" aria-label="Assign to agents">
          <div className="flex items-center gap-1 flex-wrap">
            <span className="text-xs text-muted-foreground mr-1">
              <Bot className="h-3 w-3 inline mr-0.5" />
              Assign to:
            </span>
            <ToggleGroup
              type="multiple"
              value={Array.from(selectedAgentIds)}
              onValueChange={(values) => setSelectedAgentIds(new Set(values))}
              className="flex-wrap !justify-start gap-1"
            >
              {visibleAgents.map((agent) => (
                <ToggleGroupItem
                  key={agent.id}
                  value={agent.id}
                  size="sm"
                  variant="outline"
                  className="h-6 text-xs gap-1 px-2 data-[state=on]:!bg-primary data-[state=on]:!text-primary-foreground"
                  aria-label={`Assign to ${agent.name}`}
                >
                  <Bot className="h-3 w-3" />
                  {agent.name}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            {visibleAgents.length === 0 && agentSearch.trim() && (
              <span className="text-xs text-muted-foreground">No agents found</span>
            )}
            {hasMoreAgents && !showAllAgents && (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 text-xs px-2"
                onClick={() => setShowAllAgents(true)}
              >
                +{filteredAgents.length - MAX_VISIBLE_AGENTS} more
              </Button>
            )}
          </div>

          {/* Search and expanded list when showing all agents */}
          {showAllAgents && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <div className="relative flex-1">
                  <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
                  <Input
                    value={agentSearch}
                    onChange={(e) => setAgentSearch(e.target.value)}
                    placeholder="Search agents..."
                    className="h-7 pl-7 text-xs"
                  />
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => {
                    setShowAllAgents(false);
                    setAgentSearch('');
                  }}
                >
                  <ChevronDown className="h-3 w-3 mr-1" />
                  Collapse
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Loading skeleton for agents */}
      {agentsLoading && (
        <div className="mb-2 flex items-center gap-1">
          <span className="text-xs text-muted-foreground">
            <Bot className="h-3 w-3 inline mr-0.5" />
            Loading agents...
          </span>
        </div>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <select
          value={commentType}
          onChange={(e) => setCommentType(e.target.value as CommentType)}
          className="text-xs border rounded px-2 py-1 bg-white dark:bg-background"
          disabled={isSubmitting}
        >
          <option value="comment">Comment</option>
          <option value="suggestion">Suggestion</option>
          <option value="issue">Issue</option>
          <option value="approval">Approval</option>
        </select>

        <div className="flex-1 min-w-0" />

        <Button size="sm" variant="ghost" onClick={onCancel} disabled={isSubmitting}>
          Cancel
        </Button>
        <Button size="sm" onClick={handleSubmit} disabled={!content.trim() || isSubmitting}>
          {isSubmitting ? 'Posting...' : 'Comment'}
        </Button>
      </div>
    </div>
  );
}
