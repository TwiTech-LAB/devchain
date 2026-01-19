import { useState } from 'react';
import { Button } from '@/ui/components/ui/button';
import { Badge } from '@/ui/components/ui/badge';
import { Textarea } from '@/ui/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/ui/components/ui/dropdown-menu';
import {
  MessageSquare,
  Lightbulb,
  AlertCircle,
  CheckCircle2,
  Bot,
  User,
  Reply,
  Check,
  ChevronDown,
  ChevronRight,
  FileCode,
  X,
  Pencil,
  Trash2,
  MoreVertical,
} from 'lucide-react';
import { cn } from '@/ui/lib/utils';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/ui/components/ui/tooltip';
import type { ReviewComment, CommentType, CommentStatus } from '@/ui/lib/reviews';
import type { ActiveSession } from '@/ui/lib/sessions';
import { SuggestionBlock, parseSuggestionBlocks, hasSuggestionBlocks } from './SuggestionBlock';

export interface CommentThreadProps {
  comment: ReviewComment;
  replies?: ReviewComment[];
  /** Whether this comment thread is pending (waiting for agent response) */
  isPending?: boolean;
  /** Lookup function to get ActiveSession for an agent (for terminal integration) */
  getSessionForAgent?: (agentId: string) => ActiveSession | null;
  /** Callback to open terminal for a session */
  onOpenTerminal?: (session: ActiveSession) => void;
  onReply?: (parentId: string, content: string) => Promise<void>;
  onResolve?: (commentId: string, status: 'resolved' | 'wont_fix') => Promise<void>;
  onApplySuggestion?: (commentId: string) => Promise<void>;
  onDelete?: (commentId: string) => Promise<void>;
  onEdit?: (commentId: string, content: string, version: number) => Promise<void>;
  isReplying?: boolean;
  isResolving?: boolean;
  isApplyingSuggestion?: boolean;
  isDeleting?: boolean;
  isEditing?: boolean;
  className?: string;
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

// Comment type configuration
const COMMENT_TYPE_CONFIG: Record<
  CommentType,
  { icon: React.ElementType; label: string; className: string }
> = {
  comment: {
    icon: MessageSquare,
    label: 'Comment',
    className: 'bg-gray-100 text-gray-700',
  },
  suggestion: {
    icon: Lightbulb,
    label: 'Suggestion',
    className: 'bg-blue-100 text-blue-700',
  },
  issue: {
    icon: AlertCircle,
    label: 'Issue',
    className: 'bg-orange-100 text-orange-700',
  },
  approval: {
    icon: CheckCircle2,
    label: 'Approval',
    className: 'bg-green-100 text-green-700',
  },
};

// Status configuration
const STATUS_CONFIG: Record<
  CommentStatus,
  { icon: React.ElementType; label: string; className: string }
> = {
  open: {
    icon: AlertCircle,
    label: 'Open',
    className: 'text-amber-700 dark:text-amber-500',
  },
  resolved: {
    icon: Check,
    label: 'Resolved',
    className: 'text-green-600',
  },
  wont_fix: {
    icon: X,
    label: "Won't Fix",
    className: 'text-gray-500',
  },
};

function CommentHeader({
  comment,
  isReply = false,
  isPending = false,
  getSessionForAgent,
  onOpenTerminal,
}: {
  comment: ReviewComment;
  isReply?: boolean;
  isPending?: boolean;
  getSessionForAgent?: (agentId: string) => ActiveSession | null;
  onOpenTerminal?: (session: ActiveSession) => void;
}) {
  const typeConfig = COMMENT_TYPE_CONFIG[comment.commentType];
  const statusConfig = STATUS_CONFIG[comment.status];
  const TypeIcon = typeConfig.icon;
  const StatusIcon = statusConfig.icon;
  const isAgent = comment.authorType === 'agent';
  const AuthorIcon = isAgent ? Bot : User;
  const authorName = isAgent
    ? (comment.authorAgentName ?? comment.authorAgentId?.slice(0, 8) ?? 'Agent')
    : 'You';

  // Check if author agent has an active session (for clickable name)
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

  // Render clickable agent link or disabled tooltip
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
    if (!isPending || !comment.targetAgents || comment.targetAgents.length === 0) {
      return null;
    }

    const MAX_SHOWN = 3;
    const shown = comment.targetAgents.slice(0, MAX_SHOWN);
    const remaining = comment.targetAgents.length - MAX_SHOWN;

    return (
      <span className="text-xs text-amber-700 dark:text-amber-500 flex items-center gap-1">
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
                  {comment.targetAgents
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

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {/* Author - clickable if agent with active session */}
      <div
        className={cn(
          'flex items-center gap-1.5 text-sm font-medium',
          isAgent ? 'text-purple-700' : 'text-foreground',
        )}
      >
        <AuthorIcon className="h-4 w-4" aria-hidden="true" />
        {isAgent && authorSession && onOpenTerminal ? (
          <button onClick={handleAuthorClick} className="hover:underline" title="Open terminal">
            {authorName}
          </button>
        ) : isAgent && !authorSession && getSessionForAgent ? (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="cursor-not-allowed opacity-75">{authorName}</span>
              </TooltipTrigger>
              <TooltipContent>
                <p>No running session</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : (
          <span>{authorName}</span>
        )}
      </div>

      {/* Type badge (only for root comments) */}
      {!isReply && (
        <Badge
          variant="secondary"
          className={cn('text-xs', typeConfig.className)}
          aria-label={`Comment type: ${typeConfig.label}`}
        >
          <TypeIcon className="h-3 w-3 mr-1" aria-hidden="true" />
          {typeConfig.label}
        </Badge>
      )}

      {/* Status indicator (only for root comments) */}
      {!isReply && (
        <span
          className={cn('flex items-center gap-1 text-xs', statusConfig.className)}
          role="status"
          aria-label={`Status: ${statusConfig.label}`}
        >
          <StatusIcon className="h-3 w-3" aria-hidden="true" />
          {statusConfig.label}
        </span>
      )}

      {/* Waiting on (for pending comments) or Sent to (for non-pending with targets) */}
      {!isReply && isPending
        ? renderWaitingOn()
        : !isReply &&
          comment.targetAgents &&
          comment.targetAgents.length > 0 && (
            <Badge
              variant="outline"
              className="text-xs"
              title={comment.targetAgents.map((t) => t.name).join(', ')}
            >
              Sent to: {comment.targetAgents.length}
            </Badge>
          )}

      {/* Timestamp */}
      <time className="text-xs text-muted-foreground" dateTime={comment.createdAt}>
        {formatRelativeTime(comment.createdAt)}
      </time>

      {/* Edited indicator */}
      {comment.editedAt && (
        <span
          className="text-xs text-muted-foreground italic"
          title={`Edited ${formatRelativeTime(comment.editedAt)}`}
        >
          (edited)
        </span>
      )}
    </div>
  );
}

function FileReference({ comment }: { comment: ReviewComment }) {
  if (!comment.filePath) return null;

  const lineInfo =
    comment.lineStart !== null
      ? comment.lineEnd !== null && comment.lineEnd !== comment.lineStart
        ? `L${comment.lineStart}-${comment.lineEnd}`
        : `L${comment.lineStart}`
      : null;

  return (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground mt-1">
      <FileCode className="h-3 w-3" />
      <span className="font-mono">{comment.filePath}</span>
      {lineInfo && <span className="text-muted-foreground">({lineInfo})</span>}
    </div>
  );
}

function ReplyItem({
  reply,
  getSessionForAgent,
  onOpenTerminal,
}: {
  reply: ReviewComment;
  getSessionForAgent?: (agentId: string) => ActiveSession | null;
  onOpenTerminal?: (session: ActiveSession) => void;
}) {
  return (
    <div className="pl-4 border-l-2 border-muted mt-2">
      <CommentHeader
        comment={reply}
        isReply
        getSessionForAgent={getSessionForAgent}
        onOpenTerminal={onOpenTerminal}
      />
      <p className="text-sm mt-1 whitespace-pre-wrap">{reply.content}</p>
    </div>
  );
}

export function CommentThread({
  comment,
  replies = [],
  isPending = false,
  getSessionForAgent,
  onOpenTerminal,
  onReply,
  onResolve,
  onApplySuggestion,
  onDelete,
  onEdit,
  isReplying = false,
  isResolving = false,
  isApplyingSuggestion = false,
  isDeleting = false,
  isEditing = false,
  className,
}: CommentThreadProps) {
  const [showReplyInput, setShowReplyInput] = useState(false);
  const [replyContent, setReplyContent] = useState('');
  const [showResolveDialog, setShowResolveDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [resolveStatus, setResolveStatus] = useState<'resolved' | 'wont_fix'>('resolved');
  const [isExpanded, setIsExpanded] = useState(true);
  const [isEditMode, setIsEditMode] = useState(false);
  const [editContent, setEditContent] = useState(comment.content);

  const hasReplies = replies.length > 0;
  const isOpen = comment.status === 'open';
  const isUserComment = comment.authorType === 'user';

  const handleSubmitReply = async () => {
    if (!replyContent.trim() || !onReply) return;
    await onReply(comment.id, replyContent.trim());
    setReplyContent('');
    setShowReplyInput(false);
  };

  const handleResolve = async () => {
    if (!onResolve) return;
    await onResolve(comment.id, resolveStatus);
    setShowResolveDialog(false);
  };

  const handleDelete = async () => {
    if (!onDelete) return;
    await onDelete(comment.id);
    setShowDeleteDialog(false);
  };

  const handleEdit = async () => {
    if (!editContent.trim() || !onEdit) return;
    await onEdit(comment.id, editContent.trim(), comment.version);
    setIsEditMode(false);
  };

  const handleCancelEdit = () => {
    setEditContent(comment.content);
    setIsEditMode(false);
  };

  return (
    <div
      className={cn(
        'p-3 rounded-lg border bg-card',
        // Pending state: amber/yellow highlight
        isPending && 'border-l-4 border-l-amber-500 bg-amber-50/50 dark:bg-amber-950/20',
        // Resolved/won't fix state: muted
        !isOpen && 'opacity-75',
        className,
      )}
      data-testid="comment-thread"
    >
      {/* Header with expand toggle */}
      <div className="flex items-start gap-2">
        {hasReplies && (
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="mt-0.5 p-0.5 hover:bg-muted rounded"
            aria-label={isExpanded ? 'Collapse replies' : 'Expand replies'}
          >
            {isExpanded ? (
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            )}
          </button>
        )}
        <div className="flex-1 min-w-0">
          <CommentHeader
            comment={comment}
            isPending={isPending}
            getSessionForAgent={getSessionForAgent}
            onOpenTerminal={onOpenTerminal}
          />
          <FileReference comment={comment} />
        </div>
        {/* Edit/Delete dropdown menu for user comments */}
        {isUserComment && (onEdit || onDelete) && !isEditMode && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="h-6 w-6 p-0">
                <MoreVertical className="h-4 w-4" />
                <span className="sr-only">Comment actions</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {onEdit && (
                <DropdownMenuItem onClick={() => setIsEditMode(true)}>
                  <Pencil className="h-4 w-4 mr-2" />
                  Edit
                </DropdownMenuItem>
              )}
              {onDelete && (
                <DropdownMenuItem
                  onClick={() => setShowDeleteDialog(true)}
                  className="text-destructive focus:text-destructive"
                >
                  <Trash2 className="h-4 w-4 mr-2" />
                  Delete
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {/* Content */}
      <div className={cn('mt-2', hasReplies && 'ml-6')}>
        {isEditMode ? (
          <div className="space-y-2">
            <Textarea
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              className="min-h-[80px] text-sm"
              disabled={isEditing}
              aria-label="Edit comment content"
            />
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={handleEdit}
                disabled={
                  !editContent.trim() || isEditing || editContent.trim() === comment.content
                }
              >
                {isEditing ? 'Saving...' : 'Save'}
              </Button>
              <Button size="sm" variant="ghost" onClick={handleCancelEdit} disabled={isEditing}>
                Cancel
              </Button>
            </div>
          </div>
        ) : hasSuggestionBlocks(comment.content) ? (
          <div className="space-y-2">
            {parseSuggestionBlocks(comment.content).map((block, index) =>
              block.type === 'suggestion' ? (
                <SuggestionBlock
                  key={index}
                  suggestedCode={block.content}
                  filePath={comment.filePath}
                  lineStart={comment.lineStart}
                  lineEnd={comment.lineEnd}
                  onApply={onApplySuggestion ? () => onApplySuggestion(comment.id) : undefined}
                  isApplying={isApplyingSuggestion}
                  isApplied={comment.status === 'resolved'}
                  showApplyButton={!!onApplySuggestion && comment.status === 'open'}
                />
              ) : (
                <p key={index} className="text-sm whitespace-pre-wrap">
                  {block.content}
                </p>
              ),
            )}
          </div>
        ) : (
          <p className="text-sm whitespace-pre-wrap">{comment.content}</p>
        )}
      </div>

      {/* Replies */}
      {hasReplies && isExpanded && (
        <div className="mt-3 ml-6 space-y-2">
          {replies.map((reply) => (
            <ReplyItem
              key={reply.id}
              reply={reply}
              getSessionForAgent={getSessionForAgent}
              onOpenTerminal={onOpenTerminal}
            />
          ))}
        </div>
      )}

      {/* Reply input */}
      {showReplyInput && (
        <div className="mt-3 ml-6 space-y-2">
          <Textarea
            placeholder="Write a reply..."
            value={replyContent}
            onChange={(e) => setReplyContent(e.target.value)}
            className="min-h-[80px] text-sm"
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
      )}

      {/* Actions */}
      {!isEditMode && (
        <div className="mt-3 flex flex-wrap gap-1" role="group" aria-label="Comment actions">
          {onReply && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs"
              onClick={() => setShowReplyInput(!showReplyInput)}
              aria-expanded={showReplyInput}
              aria-label={showReplyInput ? 'Cancel reply' : 'Reply to this comment'}
            >
              <Reply className="h-3 w-3 mr-1" aria-hidden="true" />
              Reply
            </Button>
          )}
          {isOpen && onResolve && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs"
              onClick={() => setShowResolveDialog(true)}
              disabled={isResolving}
              aria-label="Resolve this comment"
            >
              <Check className="h-3 w-3 mr-1" aria-hidden="true" />
              Resolve
            </Button>
          )}
          {hasReplies && (
            <span className="text-xs text-muted-foreground self-center" aria-live="polite">
              {replies.length} {replies.length === 1 ? 'reply' : 'replies'}
            </span>
          )}
        </div>
      )}

      {/* Resolve confirmation dialog */}
      <Dialog open={showResolveDialog} onOpenChange={setShowResolveDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Resolve Comment</DialogTitle>
            <DialogDescription>How do you want to resolve this comment?</DialogDescription>
          </DialogHeader>
          <fieldset className="py-4">
            <legend className="sr-only">Resolution status</legend>
            <div className="flex gap-4">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="resolveStatus"
                  value="resolved"
                  checked={resolveStatus === 'resolved'}
                  onChange={() => setResolveStatus('resolved')}
                  className="h-4 w-4"
                  aria-describedby="resolve-desc"
                />
                <span className="text-sm">Resolved</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="resolveStatus"
                  value="wont_fix"
                  checked={resolveStatus === 'wont_fix'}
                  onChange={() => setResolveStatus('wont_fix')}
                  className="h-4 w-4"
                  aria-describedby="resolve-desc"
                />
                <span className="text-sm">Won&apos;t Fix</span>
              </label>
            </div>
            <p id="resolve-desc" className="sr-only">
              Choose resolved if the issue was addressed, or won&apos;t fix if it will not be
              addressed
            </p>
          </fieldset>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowResolveDialog(false)}>
              Cancel
            </Button>
            <Button onClick={handleResolve} disabled={isResolving}>
              {isResolving ? 'Resolving...' : 'Confirm'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation dialog */}
      <Dialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Comment</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this comment? This action cannot be undone.
              {hasReplies && ' All replies will also be deleted.'}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDeleteDialog(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={isDeleting}>
              {isDeleting ? 'Deleting...' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
