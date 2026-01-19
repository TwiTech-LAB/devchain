import { useState, useMemo, useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ScrollArea } from '@/ui/components/ui/scroll-area';
import { Badge } from '@/ui/components/ui/badge';
import { Button } from '@/ui/components/ui/button';
import { Skeleton } from '@/ui/components/ui/skeleton';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/ui/components/ui/alert-dialog';
import {
  MessageSquare,
  Filter,
  FileCode,
  Layers,
  X,
  Plus,
  ChevronRight,
  Circle,
} from 'lucide-react';
import { cn } from '@/ui/lib/utils';
import { CommentReferenceItem } from './CommentReferenceItem';
import { CommentDialog } from './CommentDialog';
import { useCreateComment } from '@/ui/hooks/useCommentMutations';
import { fetchReviewComments, isPendingComment, groupCommentsIntoThreads } from '@/ui/lib/reviews';
import type { ReviewComment, Review, CommentType } from '@/ui/lib/reviews';

export type CommentFilter = 'all' | 'file' | 'review';

/** Navigation target for scrolling to a comment in the diff viewer */
export interface CommentNavigationTarget {
  commentId: string;
  filePath: string | null;
  lineStart: number | null;
  side: 'old' | 'new' | null;
}

export interface CommentPanelProps {
  reviewId: string;
  review?: Review;
  projectId?: string;
  selectedFile: string | null;
  /** @deprecated Use onNavigateToComment instead */
  onCommentSelect?: (comment: ReviewComment) => void;
  /** Callback when user clicks a comment to navigate to it in the diff viewer */
  onNavigateToComment?: (target: CommentNavigationTarget) => void;
  /** Callback when user clicks a file group header to select that file */
  onSelectFile?: (filePath: string) => void;
  /** Currently selected/highlighted comment ID */
  selectedCommentId?: string | null;
  onCloseReview?: () => void;
  isClosingReview?: boolean;
  className?: string;
}

// Filter badge component
function FilterButton({
  filter,
  currentFilter,
  onClick,
  count,
  icon: Icon,
  label,
}: {
  filter: CommentFilter;
  currentFilter: CommentFilter;
  onClick: () => void;
  count?: number;
  icon: React.ElementType;
  label: string;
}) {
  const isActive = filter === currentFilter;
  return (
    <Button
      variant={isActive ? 'secondary' : 'ghost'}
      size="sm"
      onClick={onClick}
      className={cn('h-7 text-xs gap-1', isActive && 'bg-secondary')}
      aria-pressed={isActive}
      aria-label={`${label} filter${count !== undefined ? `, ${count} comments` : ''}`}
    >
      <Icon className="h-3 w-3" aria-hidden="true" />
      {label}
      {count !== undefined && (
        <Badge variant="outline" className="h-4 px-1 text-[10px] ml-1" aria-hidden="true">
          {count}
        </Badge>
      )}
    </Button>
  );
}

function CommentPanelSkeleton() {
  return (
    <div className="p-4 space-y-4">
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="space-y-2">
          <div className="flex items-center gap-2">
            <Skeleton className="h-4 w-4 rounded-full" />
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-4 w-16" />
          </div>
          <Skeleton className="h-16 w-full" />
        </div>
      ))}
    </div>
  );
}

function EmptyState({
  filter,
  _selectedFile,
  onAddComment,
}: {
  filter: CommentFilter;
  _selectedFile: string | null;
  onAddComment?: () => void;
}) {
  const getMessage = () => {
    switch (filter) {
      case 'file':
        return 'No file comments yet';
      case 'review':
        return 'No review-level comments';
      default:
        return 'No comments yet';
    }
  };

  return (
    <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
      <MessageSquare className="h-8 w-8 mb-2" />
      <p className="text-sm text-center">{getMessage()}</p>
      {filter === 'review' && onAddComment && (
        <Button variant="outline" size="sm" className="mt-3" onClick={onAddComment}>
          <Plus className="h-3 w-3 mr-1" />
          Add Review Comment
        </Button>
      )}
    </div>
  );
}

/** File group for grouped comment display */
interface FileGroup {
  filePath: string;
  fileName: string;
  comments: ReviewComment[];
  recentActivity: number;
}

/** Collapsible file group header with a11y support */
function FileGroupHeader({
  group,
  isExpanded,
  isSelected,
  onToggle,
  onSelect,
}: {
  group: FileGroup;
  isExpanded: boolean;
  isSelected: boolean;
  onToggle: () => void;
  onSelect?: () => void;
}) {
  const handleSelectClick = () => {
    // Select the file (navigates diff viewer)
    onSelect?.();
    // Ensure the group is expanded when selected
    if (!isExpanded) {
      onToggle();
    }
  };

  return (
    <div
      className={cn(
        'flex items-center gap-1 w-full rounded-md',
        'hover:bg-accent transition-colors',
        isSelected && 'bg-accent/50 border-l-2 border-l-primary',
      )}
      data-testid="file-group-header"
      // For test compatibility, mirror aria-expanded on the container
      aria-expanded={isExpanded}
    >
      {/* Separate toggle button for keyboard accessibility */}
      <button
        type="button"
        onClick={onToggle}
        className="shrink-0 p-2 rounded hover:bg-accent-foreground/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={isExpanded ? 'Collapse' : 'Expand'}
        aria-expanded={isExpanded}
      >
        <ChevronRight
          className={cn('h-4 w-4 transition-transform', isExpanded && 'rotate-90')}
          aria-hidden="true"
        />
      </button>
      {/* File selection button */}
      <button
        type="button"
        onClick={handleSelectClick}
        className="flex items-center gap-2 flex-1 min-w-0 py-2 pr-2 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-r-md"
      >
        <FileCode className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="flex-1 truncate font-medium text-sm">{group.fileName}</span>
        {isSelected && (
          <Circle
            className="h-2 w-2 fill-primary text-primary shrink-0"
            aria-label="Selected file"
          />
        )}
        <Badge variant="secondary" className="text-xs shrink-0">
          {group.comments.length}
        </Badge>
      </button>
    </div>
  );
}

export function CommentPanel({
  reviewId,
  review,
  projectId,
  selectedFile,
  onCommentSelect,
  onNavigateToComment,
  onSelectFile,
  selectedCommentId,
  onCloseReview,
  isClosingReview,
  className,
}: CommentPanelProps) {
  const [activeFilter, setActiveFilter] = useState<CommentFilter>('all');
  const [isCommentDialogOpen, setIsCommentDialogOpen] = useState(false);
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());
  const selectedGroupRef = useRef<HTMLDivElement>(null);

  // Mutation hook for creating review-level comments
  const createMutation = useCreateComment();

  // Auto-switch to 'file' filter when a file is selected
  useEffect(() => {
    if (selectedFile) {
      setActiveFilter('file');
    }
  }, [selectedFile]);

  // Fetch all comments for the review
  const {
    data: commentsData,
    isLoading,
    isError,
  } = useQuery({
    queryKey: ['review-comments', reviewId],
    queryFn: () => fetchReviewComments(reviewId),
    enabled: !!reviewId,
  });

  const comments = commentsData?.items ?? [];

  // Filter comments based on current filter
  const filteredComments = useMemo(() => {
    switch (activeFilter) {
      case 'file':
        // Show ALL file-level comments (filePath !== null)
        return comments.filter((c) => c.filePath !== null);
      case 'review':
        return comments.filter((c) => c.filePath === null);
      default:
        return comments;
    }
  }, [comments, activeFilter]);

  // Group into threads
  const threads = useMemo(() => {
    return groupCommentsIntoThreads(filteredComments);
  }, [filteredComments]);

  // Get root comments for display, sorted by: pending → open → resolved, then by createdAt
  const rootComments = useMemo(() => {
    return filteredComments
      .filter((c) => c.parentId === null)
      .sort((a, b) => {
        // Check pending state using thread replies
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
  }, [filteredComments, threads]);

  // Group file comments by file path (only used when activeFilter === 'file')
  const fileGroups = useMemo((): FileGroup[] => {
    if (activeFilter !== 'file') return [];

    const groupMap = new Map<string, ReviewComment[]>();
    for (const comment of rootComments) {
      if (comment.filePath) {
        const existing = groupMap.get(comment.filePath) || [];
        groupMap.set(comment.filePath, [...existing, comment]);
      }
    }

    // Convert to array with metadata
    const groups: FileGroup[] = [];
    for (const [filePath, groupComments] of groupMap) {
      // Get all timestamps including replies for recent activity
      const allTimestamps = groupComments.flatMap((c) => {
        const replies = threads.get(c.id) ?? [];
        return [c.createdAt, ...replies.map((r) => r.createdAt)];
      });
      const recentActivity = Math.max(...allTimestamps.map((t) => new Date(t).getTime()));

      groups.push({
        filePath,
        fileName: filePath.split('/').pop() || filePath,
        comments: groupComments,
        recentActivity,
      });
    }

    // Sort: most recent activity first, tie-break alphabetically
    return groups.sort((a, b) => {
      if (b.recentActivity !== a.recentActivity) {
        return b.recentActivity - a.recentActivity;
      }
      return a.filePath.localeCompare(b.filePath);
    });
  }, [rootComments, threads, activeFilter]);

  // Create a stable key for fileGroups membership (tracks actual file paths, not just length)
  const fileGroupsKey = useMemo(() => fileGroups.map((g) => g.filePath).join('|'), [fileGroups]);

  // Auto-expand all file groups on initial load when switching to file filter
  useEffect(() => {
    if (activeFilter === 'file' && fileGroups.length > 0) {
      setExpandedFiles(new Set(fileGroups.map((g) => g.filePath)));
    }
  }, [activeFilter, fileGroupsKey, fileGroups]);

  // Auto-expand selected file group when selectedFile changes
  useEffect(() => {
    if (selectedFile && activeFilter === 'file') {
      setExpandedFiles((prev) => new Set([...prev, selectedFile]));
    }
  }, [selectedFile, activeFilter]);

  // Auto-scroll to selected file group when selectedFile changes
  useEffect(() => {
    if (!selectedFile || activeFilter !== 'file' || !selectedGroupRef.current) {
      return;
    }
    // Use setTimeout to allow DOM to update after expand state change
    const timeoutId = setTimeout(() => {
      selectedGroupRef.current?.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
      });
    }, 0);
    return () => clearTimeout(timeoutId);
  }, [selectedFile, activeFilter]);

  // Count comments by filter type
  const counts = useMemo(() => {
    // Count ALL file-level comments (filePath !== null), not just selected file
    const fileComments = comments.filter((c) => c.filePath !== null && c.parentId === null);
    const reviewComments = comments.filter((c) => c.filePath === null && c.parentId === null);
    const allRootComments = comments.filter((c) => c.parentId === null);
    return {
      all: allRootComments.length,
      file: fileComments.length,
      review: reviewComments.length,
    };
  }, [comments]);

  // Count comments by status (for close review confirmation)
  const statusCounts = useMemo(() => {
    const rootComments = comments.filter((c) => c.parentId === null);
    const openCount = rootComments.filter((c) => c.status === 'open').length;
    const resolvedCount = rootComments.filter(
      (c) => c.status === 'resolved' || c.status === 'wont_fix',
    ).length;
    return { open: openCount, resolved: resolvedCount };
  }, [comments]);

  // Handle comment click - navigate to the comment in the diff viewer
  const handleCommentClick = (comment: ReviewComment) => {
    // Support new navigation callback
    if (onNavigateToComment) {
      onNavigateToComment({
        commentId: comment.id,
        filePath: comment.filePath,
        lineStart: comment.lineStart,
        side: comment.side,
      });
    }
    // Support legacy callback for backward compatibility
    if (onCommentSelect) {
      onCommentSelect(comment);
    }
  };

  // Handle opening the add review comment dialog
  const handleAddCommentClick = () => {
    setIsCommentDialogOpen(true);
  };

  // Handle creating a review-level comment
  const handleCreateComment = async (data: {
    content: string;
    commentType: CommentType;
    assignedAgentIds: string[];
    filePath: string | null;
    lineStart: number | null;
    lineEnd: number | null;
    side: 'old' | 'new' | null;
  }) => {
    await createMutation.mutateAsync({
      reviewId,
      content: data.content,
      commentType: data.commentType,
      filePath: data.filePath,
      lineStart: data.lineStart,
      lineEnd: data.lineEnd,
      side: data.side,
      targetAgentIds: data.assignedAgentIds,
    });
    setIsCommentDialogOpen(false);
    // Switch to review filter to show the new comment
    setActiveFilter('review');
  };

  if (isLoading) {
    return (
      <div className={cn('h-full flex flex-col', className)}>
        <div className="p-3 border-b">
          <h3 className="font-medium flex items-center gap-2 text-sm">
            <MessageSquare className="h-4 w-4" />
            Comments
          </h3>
        </div>
        <CommentPanelSkeleton />
      </div>
    );
  }

  if (isError) {
    return (
      <div className={cn('h-full flex flex-col', className)}>
        <div className="p-3 border-b">
          <h3 className="font-medium flex items-center gap-2 text-sm">
            <MessageSquare className="h-4 w-4" />
            Comments
          </h3>
        </div>
        <div className="flex-1 flex items-center justify-center text-muted-foreground p-4">
          <p className="text-sm">Failed to load comments</p>
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn('h-full flex flex-col', className)}
      role="region"
      aria-label="Comments panel"
      data-testid="comment-panel"
    >
      {/* Header */}
      <div className="p-3 border-b space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="font-medium flex items-center gap-2 text-sm" id="comments-heading">
            <MessageSquare className="h-4 w-4" aria-hidden="true" />
            Comments
            {counts.all > 0 && (
              <Badge
                variant="secondary"
                className="text-xs"
                aria-label={`${counts.all} total comments`}
              >
                {counts.all}
              </Badge>
            )}
          </h3>

          {/* Close Review button */}
          {review && onCloseReview && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  disabled={isClosingReview}
                >
                  <X className="h-3 w-3 mr-1" />
                  Close Review
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Close review?</AlertDialogTitle>
                  <AlertDialogDescription asChild>
                    <div className="space-y-2">
                      <p>Are you sure you want to close this review?</p>
                      {statusCounts.open > 0 && (
                        <p className="text-amber-700 dark:text-amber-500">
                          {statusCounts.open} open comment{statusCounts.open !== 1 ? 's' : ''} will
                          be deleted.
                        </p>
                      )}
                      {statusCounts.resolved > 0 && (
                        <p className="text-muted-foreground">
                          {statusCounts.resolved} resolved comment
                          {statusCounts.resolved !== 1 ? 's' : ''} will be kept.
                        </p>
                      )}
                      {statusCounts.open === 0 && statusCounts.resolved === 0 && (
                        <p className="text-muted-foreground">No comments in this review.</p>
                      )}
                    </div>
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={onCloseReview} disabled={isClosingReview}>
                    {isClosingReview ? 'Closing...' : 'Close Review'}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>

        {/* Filter buttons */}
        <div className="flex gap-1 flex-wrap" role="group" aria-label="Comment filters">
          <FilterButton
            filter="all"
            currentFilter={activeFilter}
            onClick={() => setActiveFilter('all')}
            count={counts.all}
            icon={Layers}
            label="All"
          />
          <FilterButton
            filter="file"
            currentFilter={activeFilter}
            onClick={() => setActiveFilter('file')}
            count={counts.file}
            icon={FileCode}
            label="Files"
          />
          <FilterButton
            filter="review"
            currentFilter={activeFilter}
            onClick={() => setActiveFilter('review')}
            count={counts.review}
            icon={Filter}
            label="Review"
          />
          {/* Add Comment button (only for review filter and when projectId is available) */}
          {activeFilter === 'review' && projectId && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs gap-1 ml-auto"
              onClick={handleAddCommentClick}
            >
              <Plus className="h-3 w-3" />
              Add Comment
            </Button>
          )}
        </div>
      </div>

      {/* Comments list */}
      <ScrollArea className="flex-1">
        {rootComments.length === 0 ? (
          <EmptyState
            filter={activeFilter}
            _selectedFile={selectedFile}
            onAddComment={projectId ? handleAddCommentClick : undefined}
          />
        ) : activeFilter === 'file' ? (
          // Grouped view for file comments
          <div className="p-3 space-y-1" aria-labelledby="comments-heading">
            {fileGroups.map((group) => {
              const isExpanded = expandedFiles.has(group.filePath);
              const isSelected = selectedFile === group.filePath;
              return (
                <div
                  key={group.filePath}
                  ref={isSelected ? selectedGroupRef : undefined}
                  data-testid="file-group"
                >
                  <FileGroupHeader
                    group={group}
                    isExpanded={isExpanded}
                    isSelected={isSelected}
                    onToggle={() => {
                      setExpandedFiles((prev) => {
                        const next = new Set(prev);
                        if (next.has(group.filePath)) {
                          next.delete(group.filePath);
                        } else {
                          next.add(group.filePath);
                        }
                        return next;
                      });
                    }}
                    onSelect={() => onSelectFile?.(group.filePath)}
                  />
                  {isExpanded && (
                    <div className="ml-6 mt-1 space-y-2">
                      {group.comments.map((comment) => {
                        const replies = threads.get(comment.id) ?? [];
                        const isPending = isPendingComment({ comment, replies });
                        return (
                          <CommentReferenceItem
                            key={comment.id}
                            comment={comment}
                            replyCount={replies.length}
                            isPending={isPending}
                            onClick={() => handleCommentClick(comment)}
                            isSelected={selectedCommentId === comment.id}
                          />
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          // Flat view for all and review filters
          <div className="p-3 space-y-2" aria-labelledby="comments-heading">
            {rootComments.map((comment) => {
              const replies = threads.get(comment.id) ?? [];
              const isPending = isPendingComment({ comment, replies });

              return (
                <CommentReferenceItem
                  key={comment.id}
                  comment={comment}
                  replyCount={replies.length}
                  isPending={isPending}
                  onClick={() => handleCommentClick(comment)}
                  isSelected={selectedCommentId === comment.id}
                />
              );
            })}
          </div>
        )}
      </ScrollArea>

      {/* Comment Dialog for creating review-level comments */}
      {projectId && (
        <CommentDialog
          open={isCommentDialogOpen}
          onOpenChange={setIsCommentDialogOpen}
          filePath={null}
          lineStart={null}
          lineEnd={null}
          side={null}
          projectId={projectId}
          reviewId={reviewId}
          onSubmit={handleCreateComment}
          isSubmitting={createMutation.isPending}
        />
      )}
    </div>
  );
}
