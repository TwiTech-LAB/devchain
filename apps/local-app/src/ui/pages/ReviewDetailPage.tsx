import { useState, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/ui/components/ui/button';
import { Badge } from '@/ui/components/ui/badge';
import { Skeleton } from '@/ui/components/ui/skeleton';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/ui/components/ui/tooltip';
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
  useDefaultLayout,
} from '@/ui/components/ui/resizable';
import { ArrowLeft, GitBranch, FileCode, AlertCircle, Keyboard } from 'lucide-react';
import { cn } from '@/ui/lib/utils';
import { FileNavigator } from '@/ui/components/review/FileNavigator';
import { DiffViewer, type ViewType } from '@/ui/components/review/DiffViewer';
import { CommentPanel } from '@/ui/components/review/CommentPanel';
import { KeyboardShortcutsHelp } from '@/ui/components/review/KeyboardShortcutsHelp';
import { useReviewSubscription } from '@/ui/hooks/useReviewSubscription';
import { useCreateComment, useReplyToComment } from '@/ui/hooks/useCommentMutations';
import { useKeyboardShortcuts } from '@/ui/hooks/useKeyboardShortcuts';
import {
  fetchReview,
  fetchChangedFiles,
  fetchDiff,
  fetchReviewComments,
  STATUS_COLORS,
  STATUS_LABELS,
} from '@/ui/lib/reviews';
import type { CommentType, ReviewComment } from '@/ui/lib/reviews';

// Group IDs for persisting panel layouts
const FILE_NAV_GROUP_ID = 'review-file-nav';
const SPLIT_GROUP_ID = 'review-comment-split';

// Empty state for when no file is selected
function DiffViewerEmptyState() {
  return (
    <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
      <FileCode className="h-12 w-12 mb-4" />
      <p className="text-lg font-medium">Select a file to view diff</p>
      <p className="text-sm">Choose a file from the left panel</p>
    </div>
  );
}

function ReviewDetailSkeleton() {
  return (
    <div className="flex flex-col h-full">
      {/* Header skeleton */}
      <div className="border-b p-4">
        <div className="flex items-center gap-4">
          <Skeleton className="h-9 w-9" />
          <div className="flex-1">
            <Skeleton className="h-6 w-48 mb-2" />
            <Skeleton className="h-4 w-32" />
          </div>
          <Skeleton className="h-6 w-20" />
        </div>
      </div>
      {/* Panels skeleton */}
      <div className="flex-1 flex">
        <div className="w-64 border-r p-4 space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-8 w-full" />
          ))}
        </div>
        <div className="flex-1 p-4">
          <Skeleton className="h-full w-full" />
        </div>
        <div className="w-80 border-l p-4 space-y-2">
          <Skeleton className="h-6 w-24 mb-4" />
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      </div>
    </div>
  );
}

export function ReviewDetailPage() {
  const { reviewId } = useParams<{ reviewId: string }>();
  const navigate = useNavigate();
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [diffViewType, setDiffViewType] = useState<ViewType>('unified');

  // Persist file navigator panel layout
  const fileNavLayout = useDefaultLayout({
    id: FILE_NAV_GROUP_ID,
    storage: localStorage,
  });

  // Persist split view layout (diff/comments)
  const splitLayout = useDefaultLayout({
    id: SPLIT_GROUP_ID,
    storage: localStorage,
  });

  // Fetch review data
  const {
    data: review,
    isLoading: reviewLoading,
    isError: reviewError,
  } = useQuery({
    queryKey: ['review', reviewId],
    queryFn: () => fetchReview(reviewId!),
    enabled: !!reviewId,
  });

  // Subscribe to real-time review updates via WebSocket
  useReviewSubscription(reviewId ?? null, review?.projectId ?? null);

  // Comment mutations with optimistic updates
  const createCommentMutation = useCreateComment();
  const replyMutation = useReplyToComment();

  // Fetch changed files
  const { data: changedFiles = [], isLoading: filesLoading } = useQuery({
    queryKey: ['review-files', reviewId, review?.baseSha, review?.headSha],
    queryFn: () => {
      if (!review?.projectId || !review.baseSha || !review.headSha) {
        throw new Error('Review SHAs are not available');
      }
      return fetchChangedFiles(review.projectId, review.baseSha, review.headSha);
    },
    enabled: !!review?.projectId && !!review?.baseSha && !!review?.headSha,
  });

  // Fetch diff for the entire comparison
  const {
    data: diff = '',
    isLoading: diffLoading,
    isError: diffError,
  } = useQuery({
    queryKey: ['review-diff', reviewId, review?.baseSha, review?.headSha],
    queryFn: () => {
      if (!review?.projectId || !review.baseSha || !review.headSha) {
        throw new Error('Review SHAs are not available');
      }
      return fetchDiff(review.projectId, review.baseSha, review.headSha);
    },
    enabled: !!review?.projectId && !!review?.baseSha && !!review?.headSha && !!selectedFile,
  });

  // Fetch comments for the review (shared with CommentPanel via query key)
  const { data: commentsData } = useQuery({
    queryKey: ['review-comments', reviewId],
    queryFn: () => fetchReviewComments(reviewId!),
    enabled: !!reviewId,
  });

  // Filter comments for selected file
  const fileComments: ReviewComment[] =
    commentsData?.items?.filter((c) => c.filePath === selectedFile) ?? [];

  // Handle back navigation
  const handleBack = () => {
    navigate('/reviews');
  };

  // Handle file selection
  const handleSelectFile = (path: string) => {
    setSelectedFile(path);
  };

  // Keyboard shortcut handlers
  const handleNextFile = useCallback(() => {
    if (changedFiles.length === 0) return;
    const currentIndex = selectedFile ? changedFiles.findIndex((f) => f.path === selectedFile) : -1;
    const nextIndex = (currentIndex + 1) % changedFiles.length;
    setSelectedFile(changedFiles[nextIndex].path);
  }, [changedFiles, selectedFile]);

  const handlePreviousFile = useCallback(() => {
    if (changedFiles.length === 0) return;
    const currentIndex = selectedFile ? changedFiles.findIndex((f) => f.path === selectedFile) : 0;
    const prevIndex = currentIndex <= 0 ? changedFiles.length - 1 : currentIndex - 1;
    setSelectedFile(changedFiles[prevIndex].path);
  }, [changedFiles, selectedFile]);

  // Ref for comment panel to allow keyboard navigation
  const commentPanelRef = useRef<{
    focusNextComment: () => void;
    focusPreviousComment: () => void;
  }>(null);

  const handleNextComment = useCallback(() => {
    commentPanelRef.current?.focusNextComment();
  }, []);

  const handlePreviousComment = useCallback(() => {
    commentPanelRef.current?.focusPreviousComment();
  }, []);

  // Keyboard shortcuts
  const { isHelpOpen, closeHelp, openHelp } = useKeyboardShortcuts({
    enabled: !reviewLoading && !reviewError,
    handlers: {
      onNextFile: handleNextFile,
      onPreviousFile: handlePreviousFile,
      onNextComment: handleNextComment,
      onPreviousComment: handlePreviousComment,
    },
  });

  // Loading state
  if (reviewLoading) {
    return <ReviewDetailSkeleton />;
  }

  // Error state
  if (reviewError || !review) {
    return (
      <div className="flex flex-col items-center justify-center h-full">
        <AlertCircle className="h-12 w-12 text-destructive mb-4" />
        <h2 className="text-lg font-medium mb-2">Failed to load review</h2>
        <p className="text-muted-foreground mb-4">
          The review could not be found or there was an error loading it.
        </p>
        <Button onClick={handleBack}>Back to Reviews</Button>
      </div>
    );
  }

  const statusColor = STATUS_COLORS[review.status];
  const statusLabel = STATUS_LABELS[review.status];

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="border-b px-4 py-3 bg-card">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={handleBack} title="Back to reviews">
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-semibold truncate">{review.title}</h1>
              <Badge
                variant="secondary"
                className={cn('shrink-0', statusColor.bg, statusColor.text)}
              >
                {statusLabel}
              </Badge>
            </div>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <GitBranch className="h-4 w-4" />
              <span>
                {review.baseRef}...{review.headRef}
              </span>
              {review.baseSha && review.headSha ? (
                <span className="text-xs">
                  ({review.baseSha.slice(0, 7)}...{review.headSha.slice(0, 7)})
                </span>
              ) : (
                <span className="text-xs">
                  ({review.mode === 'working_tree' ? 'working tree' : 'sha pending'})
                </span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 text-sm text-muted-foreground shrink-0">
            <span>{changedFiles.length} files</span>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={openHelp}
                    title="Keyboard shortcuts"
                  >
                    <Keyboard className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>Keyboard shortcuts (?)</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
        </div>
      </div>

      {/* Two-panel resizable layout: FileNavigator | Diff+Comments */}
      <ResizablePanelGroup
        orientation="horizontal"
        className="flex-1 min-h-0"
        id={FILE_NAV_GROUP_ID}
        defaultLayout={fileNavLayout.defaultLayout}
        onLayoutChanged={fileNavLayout.onLayoutChanged}
      >
        {/* Left panel: File Navigator */}
        <ResizablePanel id="file-nav" defaultSize="256px" minSize="150px" maxSize="40%">
          <div className="h-full border-r bg-card overflow-hidden flex flex-col">
            <div className="p-3 border-b shrink-0">
              <h2 className="text-sm font-medium flex items-center gap-2">
                <FileCode className="h-4 w-4" />
                Files
                {changedFiles.length > 0 && (
                  <Badge variant="secondary" className="text-xs">
                    {changedFiles.length}
                  </Badge>
                )}
              </h2>
            </div>
            <div className="flex-1 min-h-0">
              <FileNavigator
                files={changedFiles}
                selectedFile={selectedFile}
                onSelectFile={handleSelectFile}
                isLoading={filesLoading}
              />
            </div>
          </div>
        </ResizablePanel>

        <ResizableHandle withHandle />

        {/* Right panel: Diff + Comments with adaptive layout */}
        <ResizablePanel id="diff-comments" defaultSize="80%">
          {diffViewType === 'split' ? (
            /* Split view: Vertical resizable panels */
            <ResizablePanelGroup
              orientation="vertical"
              className="h-full"
              id={SPLIT_GROUP_ID}
              defaultLayout={splitLayout.defaultLayout}
              onLayoutChanged={splitLayout.onLayoutChanged}
            >
              <ResizablePanel id="diff-panel" defaultSize="70%" minSize="30%">
                <div className="h-full min-w-0 bg-background overflow-auto">
                  {selectedFile ? (
                    <DiffViewer
                      diff={diff}
                      filePath={selectedFile}
                      isLoading={diffLoading}
                      error={diffError ? 'Failed to load diff' : null}
                      viewType={diffViewType}
                      onViewTypeChange={setDiffViewType}
                      projectId={review?.projectId}
                      comments={fileComments}
                      onAddComment={async (
                        lineStart: number,
                        lineEnd: number,
                        side: 'old' | 'new',
                        content: string,
                        commentType: CommentType,
                        targetAgentIds?: string[],
                      ) => {
                        await createCommentMutation.mutateAsync({
                          reviewId: reviewId!,
                          content,
                          commentType,
                          filePath: selectedFile,
                          lineStart,
                          lineEnd,
                          side,
                          targetAgentIds,
                        });
                      }}
                      onReplyToComment={async (parentId: string, content: string) => {
                        await replyMutation.mutateAsync({
                          reviewId: reviewId!,
                          parentId,
                          content,
                        });
                      }}
                      isSubmittingComment={
                        createCommentMutation.isPending || replyMutation.isPending
                      }
                    />
                  ) : (
                    <DiffViewerEmptyState />
                  )}
                </div>
              </ResizablePanel>
              <ResizableHandle withHandle />
              <ResizablePanel id="comment-panel" defaultSize="30%" minSize="15%">
                <div className="h-full bg-card overflow-hidden border-t">
                  <CommentPanel
                    reviewId={reviewId!}
                    projectId={review?.projectId}
                    selectedFile={selectedFile}
                    onCommentSelect={(comment) => {
                      if (comment.filePath) {
                        setSelectedFile(comment.filePath);
                      }
                    }}
                  />
                </div>
              </ResizablePanel>
            </ResizablePanelGroup>
          ) : (
            /* Unified view: Horizontal grid */
            <div className="h-full grid grid-cols-[1fr_320px]">
              <div className="min-w-0 bg-background overflow-auto">
                {selectedFile ? (
                  <DiffViewer
                    diff={diff}
                    filePath={selectedFile}
                    isLoading={diffLoading}
                    error={diffError ? 'Failed to load diff' : null}
                    viewType={diffViewType}
                    onViewTypeChange={setDiffViewType}
                    projectId={review?.projectId}
                    comments={fileComments}
                    onAddComment={async (
                      lineStart: number,
                      lineEnd: number,
                      side: 'old' | 'new',
                      content: string,
                      commentType: CommentType,
                      targetAgentIds?: string[],
                    ) => {
                      await createCommentMutation.mutateAsync({
                        reviewId: reviewId!,
                        content,
                        commentType,
                        filePath: selectedFile,
                        lineStart,
                        lineEnd,
                        side,
                        targetAgentIds,
                      });
                    }}
                    onReplyToComment={async (parentId: string, content: string) => {
                      await replyMutation.mutateAsync({
                        reviewId: reviewId!,
                        parentId,
                        content,
                      });
                    }}
                    isSubmittingComment={createCommentMutation.isPending || replyMutation.isPending}
                  />
                ) : (
                  <DiffViewerEmptyState />
                )}
              </div>
              <div className="bg-card overflow-hidden border-l">
                <CommentPanel
                  reviewId={reviewId!}
                  projectId={review?.projectId}
                  selectedFile={selectedFile}
                  onCommentSelect={(comment) => {
                    if (comment.filePath) {
                      setSelectedFile(comment.filePath);
                    }
                  }}
                />
              </div>
            </div>
          )}
        </ResizablePanel>
      </ResizablePanelGroup>

      {/* Keyboard shortcuts help modal */}
      <KeyboardShortcutsHelp open={isHelpOpen} onOpenChange={closeHelp} />
    </div>
  );
}
