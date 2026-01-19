import { useRef, useEffect, useMemo } from 'react';
import { ChevronDown, ChevronRight, MessageSquare } from 'lucide-react';
import { Badge } from '@/ui/components/ui/badge';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/ui/components/ui/collapsible';
import { cn } from '@/ui/lib/utils';
import { CommentThread } from './CommentThread';
import { isPendingComment, groupCommentsIntoThreads } from '@/ui/lib/reviews';
import type { ReviewComment } from '@/ui/lib/reviews';
import type { ActiveSession } from '@/ui/lib/sessions';

export interface ReviewCommentsSectionProps {
  /** All comments for the review (will be filtered to review-level) */
  comments: ReviewComment[];
  /** Currently selected/highlighted comment ID */
  selectedCommentId?: string | null;
  /** Whether the section is expanded */
  isExpanded: boolean;
  /** Callback to toggle expand/collapse */
  onToggleExpand: () => void;
  /** Callback when replying to a comment */
  onReply?: (parentId: string, content: string) => Promise<void>;
  /** Callback when resolving a comment */
  onResolve?: (commentId: string, status: 'resolved' | 'wont_fix') => Promise<void>;
  /** Callback when deleting a comment */
  onDelete?: (commentId: string) => Promise<void>;
  /** Callback when editing a comment */
  onEdit?: (commentId: string, content: string, version: number) => Promise<void>;
  /** Callback when applying a suggestion */
  onApplySuggestion?: (commentId: string) => Promise<void>;
  /** Loading state for reply action */
  isReplying?: boolean;
  /** Loading state for resolve action */
  isResolving?: boolean;
  /** Loading state for delete action */
  isDeleting?: boolean;
  /** Loading state for edit action */
  isEditing?: boolean;
  /** Loading state for apply suggestion action */
  isApplyingSuggestion?: boolean;
  /** Lookup function to get ActiveSession for an agent (for terminal integration) */
  getSessionForAgent?: (agentId: string) => ActiveSession | null;
  /** Callback to open terminal for a session */
  onOpenTerminal?: (session: ActiveSession) => void;
  /** Additional CSS classes */
  className?: string;
}

/**
 * ReviewCommentsSection - A collapsible section for review-level comments.
 *
 * Displays review-level comments (filePath === null) in a dedicated section
 * above the DiffViewer. Each comment is rendered as a full CommentThread
 * with all actions available.
 */
export function ReviewCommentsSection({
  comments,
  selectedCommentId,
  isExpanded,
  onToggleExpand,
  onReply,
  onResolve,
  onDelete,
  onEdit,
  onApplySuggestion,
  isReplying = false,
  isResolving = false,
  isDeleting = false,
  isEditing = false,
  isApplyingSuggestion = false,
  getSessionForAgent,
  onOpenTerminal,
  className,
}: ReviewCommentsSectionProps) {
  const selectedThreadRef = useRef<HTMLDivElement>(null);

  // Filter to only review-level comments (filePath === null)
  const reviewComments = useMemo(() => comments.filter((c) => c.filePath === null), [comments]);

  // Group into threads
  const threads = useMemo(() => groupCommentsIntoThreads(reviewComments), [reviewComments]);

  // Get root comments sorted by: pending → open → resolved, then by createdAt
  const rootComments = useMemo(() => {
    return reviewComments
      .filter((c) => c.parentId === null)
      .sort((a, b) => {
        const aReplies = threads.get(a.id) ?? [];
        const bReplies = threads.get(b.id) ?? [];
        const aPending = isPendingComment({ comment: a, replies: aReplies });
        const bPending = isPendingComment({ comment: b, replies: bReplies });

        // Pending comments first
        if (aPending !== bPending) return aPending ? -1 : 1;

        // Then by status: open → resolved/wont_fix
        if (a.status !== b.status) {
          if (a.status === 'open') return -1;
          if (b.status === 'open') return 1;
        }

        // Finally by createdAt (newest first)
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      });
  }, [reviewComments, threads]);

  // Scroll to selected comment when it changes
  useEffect(() => {
    if (selectedCommentId && selectedThreadRef.current && isExpanded) {
      selectedThreadRef.current.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
      });
    }
  }, [selectedCommentId, isExpanded]);

  // Don't render if no review-level comments
  if (rootComments.length === 0) {
    return null;
  }

  return (
    <Collapsible
      open={isExpanded}
      onOpenChange={onToggleExpand}
      className={cn('border-b bg-card', className)}
      data-testid="review-comments-section"
    >
      {/* Header - entire row is clickable */}
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-2 px-4 py-3 border-b bg-muted/30 w-full text-left hover:bg-muted/50 transition-colors"
          aria-label={isExpanded ? 'Collapse review comments' : 'Expand review comments'}
        >
          {isExpanded ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          )}

          <h3 className="font-medium text-sm flex items-center gap-2" id="review-comments-heading">
            <MessageSquare className="h-4 w-4" aria-hidden="true" />
            Review Comments
            <Badge
              variant="secondary"
              className="text-xs"
              aria-label={`${rootComments.length} comments`}
            >
              {rootComments.length}
            </Badge>
          </h3>
        </button>
      </CollapsibleTrigger>

      {/* Content */}
      <CollapsibleContent>
        <div className="p-4 space-y-4" role="region" aria-labelledby="review-comments-heading">
          {rootComments.map((comment) => {
            const replies = threads.get(comment.id) ?? [];
            const isPending = isPendingComment({ comment, replies });
            const isSelected = selectedCommentId === comment.id;

            return (
              <div
                key={comment.id}
                ref={isSelected ? selectedThreadRef : undefined}
                className={cn(
                  'transition-all duration-200',
                  // Highlight selected comment
                  isSelected && 'ring-2 ring-primary ring-offset-2 rounded-lg',
                )}
                data-comment-id={comment.id}
              >
                <CommentThread
                  comment={comment}
                  replies={replies}
                  isPending={isPending}
                  getSessionForAgent={getSessionForAgent}
                  onOpenTerminal={onOpenTerminal}
                  onReply={onReply}
                  onResolve={onResolve}
                  onDelete={onDelete}
                  onEdit={onEdit}
                  onApplySuggestion={onApplySuggestion}
                  isReplying={isReplying}
                  isResolving={isResolving}
                  isDeleting={isDeleting}
                  isEditing={isEditing}
                  isApplyingSuggestion={isApplyingSuggestion}
                />
              </div>
            );
          })}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
