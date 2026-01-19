import {
  MessageSquare,
  Lightbulb,
  AlertCircle,
  CheckCircle2,
  Bot,
  User,
  FileCode,
  Check,
  X,
  MessageCircle,
} from 'lucide-react';
import { Badge } from '@/ui/components/ui/badge';
import { cn } from '@/ui/lib/utils';
import type { ReviewComment, CommentType, CommentStatus } from '@/ui/lib/reviews';

export interface CommentReferenceItemProps {
  comment: ReviewComment;
  replyCount: number;
  isPending: boolean;
  onClick: () => void;
  isSelected?: boolean;
  className?: string;
}

// Comment type configuration (matches CommentThread.tsx)
const COMMENT_TYPE_CONFIG: Record<
  CommentType,
  { icon: React.ElementType; label: string; className: string }
> = {
  comment: {
    icon: MessageSquare,
    label: 'Comment',
    className: 'text-gray-500',
  },
  suggestion: {
    icon: Lightbulb,
    label: 'Suggestion',
    className: 'text-blue-500',
  },
  issue: {
    icon: AlertCircle,
    label: 'Issue',
    className: 'text-orange-500',
  },
  approval: {
    icon: CheckCircle2,
    label: 'Approval',
    className: 'text-green-500',
  },
};

// Status configuration for badges
const STATUS_CONFIG: Record<
  CommentStatus,
  { icon: React.ElementType; label: string; badgeVariant: 'default' | 'secondary' | 'outline' }
> = {
  open: {
    icon: AlertCircle,
    label: 'Open',
    badgeVariant: 'secondary',
  },
  resolved: {
    icon: Check,
    label: 'Resolved',
    badgeVariant: 'outline',
  },
  wont_fix: {
    icon: X,
    label: "Won't Fix",
    badgeVariant: 'outline',
  },
};

/**
 * Truncates content to a specified length with ellipsis
 */
function truncateContent(content: string, maxLength: number = 60): string {
  const singleLine = content.replace(/\n/g, ' ').trim();
  if (singleLine.length <= maxLength) {
    return singleLine;
  }
  return singleLine.slice(0, maxLength).trim() + '…';
}

/**
 * Formats file path and line reference for display
 */
function formatFileReference(comment: ReviewComment): string {
  if (!comment.filePath) {
    return 'Review-level';
  }

  const fileName = comment.filePath.split('/').pop() || comment.filePath;
  const lineInfo =
    comment.lineStart !== null
      ? comment.lineEnd !== null && comment.lineEnd !== comment.lineStart
        ? `:${comment.lineStart}-${comment.lineEnd}`
        : `:${comment.lineStart}`
      : '';

  return `${fileName}${lineInfo}`;
}

/**
 * CommentReferenceItem - A compact clickable item for displaying comment references in the sidebar.
 *
 * Shows essential comment info in a scannable format:
 * - Comment type icon and author
 * - Truncated content snippet
 * - File location or "Review-level"
 * - Status badge and reply count
 */
export function CommentReferenceItem({
  comment,
  replyCount,
  isPending,
  onClick,
  isSelected = false,
  className,
}: CommentReferenceItemProps) {
  const typeConfig = COMMENT_TYPE_CONFIG[comment.commentType];
  const statusConfig = STATUS_CONFIG[comment.status];
  const TypeIcon = typeConfig.icon;
  const StatusIcon = statusConfig.icon;
  const isAgent = comment.authorType === 'agent';
  const AuthorIcon = isAgent ? Bot : User;
  const authorName = isAgent
    ? (comment.authorAgentName ?? comment.authorAgentId?.slice(0, 8) ?? 'Agent')
    : 'You';

  const fileRef = formatFileReference(comment);
  const snippet = truncateContent(comment.content);

  // Build accessible label
  const ariaLabel = [
    typeConfig.label,
    'by',
    authorName,
    '-',
    snippet,
    '-',
    fileRef,
    '-',
    statusConfig.label,
    replyCount > 0 ? `- ${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}` : '',
    isPending ? '- Pending response' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'w-full text-left p-2 rounded-md border transition-colors',
        'hover:bg-accent hover:border-accent-foreground/20',
        'focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
        // Pending state: amber highlight
        isPending && 'border-l-4 border-l-amber-500 bg-amber-50/50 dark:bg-amber-950/20',
        // Selected state
        isSelected && 'bg-accent border-accent-foreground/30',
        // Resolved/won't fix: muted appearance
        comment.status !== 'open' && !isSelected && 'opacity-60',
        className,
      )}
      aria-label={ariaLabel}
      data-testid="comment-reference-item"
    >
      {/* Row 1: Type icon, Author, Status badge */}
      <div className="flex items-center gap-2 mb-1">
        {/* Comment type icon */}
        <TypeIcon
          className={cn('h-4 w-4 flex-shrink-0', typeConfig.className)}
          aria-hidden="true"
        />

        {/* Author */}
        <div
          className={cn(
            'flex items-center gap-1 text-xs font-medium min-w-0',
            isAgent ? 'text-purple-700 dark:text-purple-400' : 'text-foreground',
          )}
        >
          <AuthorIcon className="h-3 w-3 flex-shrink-0" aria-hidden="true" />
          <span className="truncate">{authorName}</span>
        </div>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Status badge */}
        <Badge
          variant={statusConfig.badgeVariant}
          className={cn(
            'text-[10px] px-1.5 py-0 h-4 flex-shrink-0',
            comment.status === 'open' &&
              'bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-400',
            comment.status === 'resolved' && 'text-green-600 dark:text-green-400',
            comment.status === 'wont_fix' && 'text-gray-500',
          )}
        >
          <StatusIcon className="h-2.5 w-2.5 mr-0.5" aria-hidden="true" />
          {statusConfig.label}
        </Badge>
      </div>

      {/* Row 2: Content snippet */}
      <p className="text-sm text-foreground truncate mb-1" title={comment.content}>
        {snippet}
      </p>

      {/* Row 3: File reference and reply count */}
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {/* File reference */}
        <div className="flex items-center gap-1 min-w-0 flex-1">
          <FileCode className="h-3 w-3 flex-shrink-0" aria-hidden="true" />
          <span className="truncate" title={comment.filePath ?? 'Review-level'}>
            {fileRef}
          </span>
        </div>

        {/* Reply count */}
        {replyCount > 0 && (
          <div className="flex items-center gap-0.5 flex-shrink-0">
            <MessageCircle className="h-3 w-3" aria-hidden="true" />
            <span>{replyCount}</span>
          </div>
        )}

        {/* Pending indicator */}
        {isPending && (
          <span className="text-amber-600 dark:text-amber-400 flex-shrink-0">Pending</span>
        )}
      </div>
    </button>
  );
}
