import { useState, useCallback, useRef, useMemo, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/ui/hooks/use-toast';
import { Button } from '@/ui/components/ui/button';
import { Badge } from '@/ui/components/ui/badge';
import { Skeleton } from '@/ui/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/components/ui/select';
import { ToggleGroup, ToggleGroupItem } from '@/ui/components/ui/toggle-group';
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
import { useSelectedProject } from '@/ui/hooks/useProjectSelection';
import {
  FolderOpen,
  FileCode,
  AlertCircle,
  GitCommitHorizontal,
  RefreshCw,
  Keyboard,
} from 'lucide-react';
import { cn } from '@/ui/lib/utils';
import {
  fetchAgentPresence,
  fetchActiveSessions,
  type ActiveSession,
  type AgentPresenceMap,
} from '@/ui/lib/sessions';
import { useTerminalWindowManager } from '@/ui/terminal-windows';
import { FileNavigator } from '@/ui/components/review/FileNavigator';
import { DiffViewer, type ViewType } from '@/ui/components/review/DiffViewer';
import { CommentPanel, type CommentNavigationTarget } from '@/ui/components/review/CommentPanel';
import { ReviewCommentsSection } from '@/ui/components/review/ReviewCommentsSection';
import { KeyboardShortcutsHelp } from '@/ui/components/review/KeyboardShortcutsHelp';
import { HelpButton } from '@/ui/components/shared';
import { useReviewSubscription } from '@/ui/hooks/useReviewSubscription';
import {
  useCreateComment,
  useReplyToComment,
  useResolveComment,
  useDeleteComment,
  useEditComment,
} from '@/ui/hooks/useCommentMutations';
import { useKeyboardShortcuts } from '@/ui/hooks/useKeyboardShortcuts';
import {
  fetchWorkingTree,
  fetchCommitDiff,
  fetchActiveReview,
  fetchCommits,
  fetchBranches,
  fetchReviewComments,
  closeReview,
  createReview,
  type WorkingTreeFilter,
  type ChangedFile,
  type CommentType,
  type ReviewComment,
  type GitCommit,
} from '@/ui/lib/reviews';

type ReviewMode = 'working-tree' | 'commit';

// Group IDs for persisting panel layouts (shared with ReviewDetailPage)
const FILE_NAV_GROUP_ID = 'review-file-nav';
const SPLIT_GROUP_ID = 'review-comment-split';

// Empty state for when no changes
function NoChangesEmptyState() {
  return (
    <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
      <FileCode className="h-12 w-12 mb-4" />
      <p className="text-lg font-medium">No changes to review</p>
      <p className="text-sm">Your working tree is clean</p>
    </div>
  );
}

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

function ReviewsPageSkeleton() {
  return (
    <div className="flex flex-col h-full">
      {/* Header skeleton */}
      <div className="border-b p-4">
        <div className="flex items-center gap-4">
          <Skeleton className="h-6 w-32" />
          <Skeleton className="h-9 w-40" />
          <Skeleton className="h-9 w-48" />
          <div className="flex-1" />
          <Skeleton className="h-9 w-24" />
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

export function ReviewsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { selectedProject, selectedProjectId, projectsLoading } = useSelectedProject();

  // UI state
  const [mode, setMode] = useState<ReviewMode>('working-tree');
  const [filter, setFilter] = useState<WorkingTreeFilter>('all');
  const [baseRef, setBaseRef] = useState<string>('HEAD');
  const [selectedCommit, setSelectedCommit] = useState<GitCommit | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [diffViewType, setDiffViewType] = useState<ViewType>('unified');

  // Comment navigation state
  const [selectedCommentId, setSelectedCommentId] = useState<string | null>(null);
  const [reviewCommentsSectionExpanded, setReviewCommentsSectionExpanded] = useState(true);

  // Persist file navigator panel layout (shared with ReviewDetailPage)
  const fileNavLayout = useDefaultLayout({
    id: FILE_NAV_GROUP_ID,
    storage: localStorage,
  });

  // Persist split view layout (shared with ReviewDetailPage)
  const splitLayout = useDefaultLayout({
    id: SPLIT_GROUP_ID,
    storage: localStorage,
  });

  // Fetch active review
  const { data: activeReview, isLoading: reviewLoading } = useQuery({
    queryKey: ['active-review', selectedProjectId],
    queryFn: () => fetchActiveReview(selectedProjectId!),
    enabled: !!selectedProjectId,
  });

  // Subscribe to real-time review updates via WebSocket
  useReviewSubscription(activeReview?.id ?? null, selectedProjectId ?? null);

  // Fetch working tree data
  const {
    data: workingTreeData,
    isLoading: workingTreeLoading,
    isError: workingTreeError,
    refetch: refetchWorkingTree,
  } = useQuery({
    queryKey: ['working-tree', selectedProjectId, filter],
    queryFn: () => fetchWorkingTree(selectedProjectId!, filter),
    enabled: !!selectedProjectId && mode === 'working-tree',
    refetchInterval: 5000, // Auto-refresh every 5 seconds
  });

  // Fetch commit diff when in commit mode
  const {
    data: commitData,
    isLoading: commitLoading,
    isError: commitError,
  } = useQuery({
    queryKey: ['commit-diff', selectedProjectId, selectedCommit?.sha],
    queryFn: () => fetchCommitDiff(selectedProjectId!, selectedCommit!.sha),
    enabled: !!selectedProjectId && mode === 'commit' && !!selectedCommit,
  });

  // Fetch commits for commit selector
  const { data: commits = [] } = useQuery({
    queryKey: ['commits', selectedProjectId],
    queryFn: () => fetchCommits(selectedProjectId!, { limit: 50 }),
    enabled: !!selectedProjectId,
  });

  // Restore UI state from active review when it loads
  useEffect(() => {
    if (activeReview) {
      // Convert mode from API format (underscore) to UI format (hyphen)
      const uiMode = activeReview.mode === 'working_tree' ? 'working-tree' : 'commit';
      setMode(uiMode);
      setBaseRef(activeReview.baseRef);

      // For commit mode, find and set the selected commit from the commits list
      if (activeReview.mode === 'commit' && commits.length > 0) {
        const commit = commits.find((c) => c.sha === activeReview.headRef);
        if (commit) {
          setSelectedCommit(commit);
        }
      }
    }
  }, [activeReview, commits]);

  // Fetch branches for base selector
  const { data: branches = [] } = useQuery({
    queryKey: ['branches', selectedProjectId],
    queryFn: () => fetchBranches(selectedProjectId!),
    enabled: !!selectedProjectId,
  });

  // Fetch comments for the active review
  const { data: commentsData } = useQuery({
    queryKey: ['review-comments', activeReview?.id],
    queryFn: () => fetchReviewComments(activeReview!.id),
    enabled: !!activeReview?.id,
  });

  // Fetch agent presence for terminal integration
  const { data: agentPresence = {} as AgentPresenceMap } = useQuery({
    queryKey: ['agent-presence', selectedProjectId],
    queryFn: () => fetchAgentPresence(selectedProjectId!),
    enabled: !!selectedProjectId,
    refetchInterval: 10000, // Refresh every 10 seconds
  });

  // Fetch active sessions for terminal integration
  const { data: activeSessions = [] } = useQuery({
    queryKey: ['active-sessions', selectedProjectId],
    queryFn: () => fetchActiveSessions(selectedProjectId!),
    enabled: !!selectedProjectId,
    refetchInterval: 10000, // Refresh every 10 seconds
  });

  // Helper to get ActiveSession for an agent (used by comment components for terminal integration)
  const getSessionForAgent = useCallback(
    (agentId: string): ActiveSession | null => {
      const presence = agentPresence[agentId];
      if (!presence?.sessionId) return null;
      return activeSessions.find((s) => s.id === presence.sessionId) ?? null;
    },
    [agentPresence, activeSessions],
  );

  // Terminal window manager for opening agent terminals
  const openTerminalWindow = useTerminalWindowManager();

  // Close review mutation
  const closeReviewMutation = useMutation({
    mutationFn: () => closeReview(activeReview!.id, activeReview!.version),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['active-review', selectedProjectId] });
      queryClient.invalidateQueries({ queryKey: ['review-comments'] });
      toast({
        title: 'Review closed',
        description: 'The review has been closed successfully.',
      });
    },
  });

  // Create review mutation (for auto-create on first comment)
  const createReviewMutation = useMutation({
    mutationFn: async () => {
      // Generate auto-title based on mode
      const title =
        mode === 'commit' && selectedCommit
          ? `Review: ${selectedCommit.sha.slice(0, 7)}`
          : 'Pre-commit review';

      // Generate refs based on mode
      const resolvedBaseRef =
        mode === 'commit' && selectedCommit ? `${selectedCommit.sha}^` : baseRef;
      const resolvedHeadRef = mode === 'commit' && selectedCommit ? selectedCommit.sha : 'HEAD';

      // Convert UI mode (hyphenated) to API mode (underscored)
      const apiMode = mode === 'working-tree' ? 'working_tree' : 'commit';

      return createReview({
        projectId: selectedProjectId!,
        title,
        mode: apiMode,
        baseRef: resolvedBaseRef,
        headRef: resolvedHeadRef,
        status: 'draft',
      });
    },
    onSuccess: (newReview) => {
      // Update the active review cache immediately
      queryClient.setQueryData(['active-review', selectedProjectId], newReview);
    },
  });

  // Comment mutations
  const createCommentMutation = useCreateComment();
  const replyMutation = useReplyToComment();
  const resolveMutation = useResolveComment();
  const deleteMutation = useDeleteComment();
  const editMutation = useEditComment();

  // Handler for adding comments with auto-create review
  const handleAddComment = useCallback(
    async (
      lineStart: number,
      lineEnd: number,
      side: 'old' | 'new',
      content: string,
      commentType: CommentType,
      targetAgentIds?: string[],
    ) => {
      let reviewId = activeReview?.id;

      // Auto-create review if none exists
      if (!reviewId) {
        try {
          const newReview = await createReviewMutation.mutateAsync();
          reviewId = newReview.id;
        } catch (error) {
          // If another request created the active review concurrently, recover by refetching it.
          const existing = await fetchActiveReview(selectedProjectId!);
          if (!existing) throw error;
          queryClient.setQueryData(['active-review', selectedProjectId], existing);
          reviewId = existing.id;
        }
      }

      // Create the comment
      await createCommentMutation.mutateAsync({
        reviewId,
        content,
        commentType,
        filePath: selectedFile!,
        lineStart,
        lineEnd,
        side,
        targetAgentIds,
      });
    },
    [
      activeReview?.id,
      createReviewMutation,
      createCommentMutation,
      queryClient,
      selectedProjectId,
      selectedFile,
    ],
  );

  // Handler for replying to comments with auto-create review
  const handleReplyToComment = useCallback(
    async (parentId: string, content: string) => {
      let reviewId = activeReview?.id;

      // Auto-create review if none exists (edge case, but handle it)
      if (!reviewId) {
        try {
          const newReview = await createReviewMutation.mutateAsync();
          reviewId = newReview.id;
        } catch (error) {
          const existing = await fetchActiveReview(selectedProjectId!);
          if (!existing) throw error;
          queryClient.setQueryData(['active-review', selectedProjectId], existing);
          reviewId = existing.id;
        }
      }

      await replyMutation.mutateAsync({
        reviewId,
        parentId,
        content,
      });
    },
    [activeReview?.id, createReviewMutation, replyMutation, queryClient, selectedProjectId],
  );

  // Handler for navigating to a comment (from sidebar click)
  const handleNavigateToComment = useCallback(
    (target: CommentNavigationTarget) => {
      // Handle commit mode sync if needed
      if (activeReview?.mode === 'commit' && selectedCommit?.sha !== activeReview.headRef) {
        const reviewCommit = commits.find((c) => c.sha === activeReview.headRef);
        if (reviewCommit) {
          setSelectedCommit(reviewCommit);
        }
      }

      if (target.filePath) {
        // File comment: select file, then set selectedCommentId
        setSelectedFile(target.filePath);
        setSelectedCommentId(target.commentId);
      } else {
        // Review-level comment: expand section, set selectedCommentId
        setReviewCommentsSectionExpanded(true);
        setSelectedCommentId(target.commentId);
      }
    },
    [activeReview?.mode, activeReview?.headRef, selectedCommit?.sha, commits],
  );

  // Handler to clear selected comment (after scroll/highlight completes)
  const handleClearSelectedComment = useCallback(() => {
    setSelectedCommentId(null);
  }, []);

  // Handler for resolving comments (with version - used by DiffViewer)
  const handleResolveComment = useCallback(
    async (commentId: string, status: 'resolved' | 'wont_fix', version: number) => {
      if (!activeReview?.id) return;
      await resolveMutation.mutateAsync({
        reviewId: activeReview.id,
        commentId,
        status,
        version,
      });
    },
    [activeReview?.id, resolveMutation],
  );

  // Handler for resolving comments (without version - used by ReviewCommentsSection)
  // Looks up the version from commentsData
  const handleResolveCommentSimple = useCallback(
    async (commentId: string, status: 'resolved' | 'wont_fix') => {
      if (!activeReview?.id || !commentsData?.items) return;
      const comment = commentsData.items.find((c) => c.id === commentId);
      if (!comment) return;
      await resolveMutation.mutateAsync({
        reviewId: activeReview.id,
        commentId,
        status,
        version: comment.version,
      });
    },
    [activeReview?.id, commentsData?.items, resolveMutation],
  );

  // Handler for deleting comments
  const handleDeleteComment = useCallback(
    async (commentId: string) => {
      if (!activeReview?.id) return;
      await deleteMutation.mutateAsync({
        reviewId: activeReview.id,
        commentId,
      });
    },
    [activeReview?.id, deleteMutation],
  );

  // Handler for editing comments
  const handleEditComment = useCallback(
    async (commentId: string, content: string, version: number) => {
      if (!activeReview?.id) return;
      await editMutation.mutateAsync({
        reviewId: activeReview.id,
        commentId,
        content,
        version,
      });
    },
    [activeReview?.id, editMutation],
  );

  // Combined loading state for comment submission
  const isSubmittingComment =
    createReviewMutation.isPending || createCommentMutation.isPending || replyMutation.isPending;

  // Compute changed files based on mode
  const changedFiles: ChangedFile[] = useMemo(() => {
    if (mode === 'working-tree' && workingTreeData) {
      const { staged, unstaged, untracked } = workingTreeData.changes;
      // Combine and dedupe files (staged, unstaged, then untracked)
      const fileMap = new Map<string, ChangedFile>();
      staged.forEach((f) => fileMap.set(f.path, f));
      unstaged.forEach((f) => {
        if (!fileMap.has(f.path)) {
          fileMap.set(f.path, f);
        }
      });
      // Convert untracked paths to ChangedFile objects with 'added' status
      (untracked || []).forEach((path) => {
        if (!fileMap.has(path)) {
          fileMap.set(path, {
            path,
            status: 'added',
            additions: 0,
            deletions: 0,
          });
        }
      });
      return Array.from(fileMap.values());
    }
    if (mode === 'commit' && commitData) {
      return commitData.changedFiles;
    }
    return [];
  }, [mode, workingTreeData, commitData]);

  // Get diff based on mode
  const diff = mode === 'working-tree' ? (workingTreeData?.diff ?? '') : (commitData?.diff ?? '');

  // Filter comments for selected file
  const fileComments: ReviewComment[] =
    commentsData?.items?.filter((c) => c.filePath === selectedFile) ?? [];

  // Get file info for the selected file (used for empty state messaging)
  const selectedFileInfo = selectedFile
    ? changedFiles.find((f) => f.path === selectedFile)
    : undefined;

  // Handle mode change
  const handleModeChange = (newMode: ReviewMode) => {
    setMode(newMode);
    setSelectedFile(null);
    if (newMode === 'commit') {
      setSelectedCommit(null);
    }
  };

  // Handle commit selection
  const handleCommitSelect = (sha: string) => {
    const commit = commits.find((c) => c.sha === sha);
    setSelectedCommit(commit ?? null);
    setSelectedFile(null);
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
    enabled: !projectsLoading,
    handlers: {
      onNextFile: handleNextFile,
      onPreviousFile: handlePreviousFile,
      onNextComment: handleNextComment,
      onPreviousComment: handlePreviousComment,
    },
  });

  // Project guard
  if (!projectsLoading && !selectedProject) {
    return (
      <div className="flex flex-col items-center justify-center h-full py-16">
        <FolderOpen className="h-12 w-12 text-muted-foreground/50 mb-4" />
        <h2 className="text-lg font-medium mb-2">No project selected</h2>
        <p className="text-muted-foreground mb-4">Select a project to view code reviews.</p>
        <Button onClick={() => navigate('/projects')}>Go to Projects</Button>
      </div>
    );
  }

  // Loading state
  if (projectsLoading || reviewLoading) {
    return <ReviewsPageSkeleton />;
  }

  const isLoading = mode === 'working-tree' ? workingTreeLoading : commitLoading;
  const isError = mode === 'working-tree' ? workingTreeError : commitError;
  const hasChanges = changedFiles.length > 0;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="border-b px-4 py-3 bg-card">
        <div className="flex items-center gap-4">
          {/* Title */}
          <div className="flex items-center gap-1">
            <h1 className="text-lg font-semibold">Code Review</h1>
            <HelpButton featureId="reviews" />
          </div>

          {/* Mode selector */}
          <ToggleGroup
            type="single"
            value={mode}
            onValueChange={(v) => v && handleModeChange(v as ReviewMode)}
            className="border rounded-md"
          >
            <ToggleGroupItem value="working-tree" className="text-xs px-3">
              Working Changes
            </ToggleGroupItem>
            <ToggleGroupItem value="commit" className="text-xs px-3">
              <GitCommitHorizontal className="h-3.5 w-3.5 mr-1" />
              Commit
            </ToggleGroupItem>
          </ToggleGroup>

          {/* Mode-specific controls */}
          {mode === 'working-tree' ? (
            <>
              {/* Base selector */}
              <Select value={baseRef} onValueChange={setBaseRef}>
                <SelectTrigger className="w-36" aria-label="Select base reference">
                  <SelectValue placeholder="Base" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="HEAD">HEAD</SelectItem>
                  {branches
                    .filter((b) => ['main', 'master'].includes(b.name))
                    .map((b) => (
                      <SelectItem key={b.name} value={b.name}>
                        {b.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>

              {/* Filter toggle */}
              <ToggleGroup
                type="single"
                value={filter}
                onValueChange={(v) => v && setFilter(v as WorkingTreeFilter)}
                className="border rounded-md"
              >
                <ToggleGroupItem value="all" className="text-xs px-3">
                  All
                </ToggleGroupItem>
                <ToggleGroupItem value="staged" className="text-xs px-3">
                  Staged
                </ToggleGroupItem>
                <ToggleGroupItem value="unstaged" className="text-xs px-3">
                  Unstaged
                </ToggleGroupItem>
              </ToggleGroup>

              {/* Refresh button */}
              <Button
                variant="ghost"
                size="icon"
                onClick={() => refetchWorkingTree()}
                title="Refresh"
              >
                <RefreshCw className={cn('h-4 w-4', workingTreeLoading && 'animate-spin')} />
              </Button>
            </>
          ) : (
            /* Commit selector */
            <Select value={selectedCommit?.sha ?? ''} onValueChange={handleCommitSelect}>
              <SelectTrigger className="w-80" aria-label="Select commit to review">
                <SelectValue placeholder="Select a commit to review" />
              </SelectTrigger>
              <SelectContent>
                {commits.map((commit) => (
                  <SelectItem key={commit.sha} value={commit.sha}>
                    <span className="font-mono text-xs">{commit.sha.slice(0, 7)}</span>
                    <span className="ml-2 truncate">{commit.message}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          <div className="flex-1" />

          {/* File count */}
          {hasChanges && (
            <span className="text-sm text-muted-foreground">
              {changedFiles.length} files
              {workingTreeData?.untrackedDiffsCapped && (
                <span
                  className="ml-1 text-amber-600"
                  title={`Showing diffs for ${workingTreeData.untrackedProcessed} of ${workingTreeData.untrackedTotal} untracked files`}
                >
                  (diffs capped)
                </span>
              )}
            </span>
          )}

          {/* Active review indicator */}
          {activeReview && (
            <Badge variant="secondary" className="bg-blue-100 text-blue-800">
              Active Review
            </Badge>
          )}

          {/* Keyboard shortcuts help */}
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

      {/* Error state */}
      {isError && (
        <div className="flex flex-col items-center justify-center h-full">
          <AlertCircle className="h-12 w-12 text-destructive mb-4" />
          <h2 className="text-lg font-medium mb-2">Failed to load changes</h2>
          <p className="text-muted-foreground mb-4">
            There was an error loading the changes. Please try again.
          </p>
          <Button onClick={() => refetchWorkingTree()}>Retry</Button>
        </div>
      )}

      {/* No changes state */}
      {!isError && !isLoading && !hasChanges && mode === 'working-tree' && <NoChangesEmptyState />}

      {/* Commit mode: no commit selected */}
      {!isError && mode === 'commit' && !selectedCommit && (
        <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
          <GitCommitHorizontal className="h-12 w-12 mb-4" />
          <p className="text-lg font-medium">Select a commit to review</p>
          <p className="text-sm">Choose a commit from the dropdown above</p>
        </div>
      )}

      {/* Two-panel resizable layout: FileNavigator | Diff+Comments */}
      {!isError && hasChanges && (
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
                  isLoading={isLoading}
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
                  <div className="h-full min-w-0 bg-background overflow-auto flex flex-col">
                    {/* Review-level comments section */}
                    {activeReview && commentsData?.items && (
                      <ReviewCommentsSection
                        comments={commentsData.items}
                        selectedCommentId={selectedCommentId}
                        isExpanded={reviewCommentsSectionExpanded}
                        onToggleExpand={() => setReviewCommentsSectionExpanded((prev) => !prev)}
                        onReply={handleReplyToComment}
                        onResolve={handleResolveCommentSimple}
                        onDelete={handleDeleteComment}
                        onEdit={handleEditComment}
                        isReplying={replyMutation.isPending}
                        isResolving={resolveMutation.isPending}
                        isDeleting={deleteMutation.isPending}
                        isEditing={editMutation.isPending}
                        getSessionForAgent={getSessionForAgent}
                        onOpenTerminal={openTerminalWindow}
                      />
                    )}
                    {/* Diff viewer */}
                    <div className="flex-1 min-h-0">
                      {selectedFile ? (
                        <DiffViewer
                          diff={diff}
                          filePath={selectedFile}
                          isLoading={isLoading}
                          error={isError ? 'Failed to load diff' : null}
                          viewType={diffViewType}
                          onViewTypeChange={setDiffViewType}
                          projectId={selectedProjectId}
                          comments={fileComments}
                          onAddComment={handleAddComment}
                          onReplyToComment={handleReplyToComment}
                          onResolveComment={handleResolveComment}
                          onDeleteComment={handleDeleteComment}
                          onEditComment={handleEditComment}
                          isSubmittingComment={isSubmittingComment}
                          isResolvingComment={resolveMutation.isPending}
                          isDeletingComment={deleteMutation.isPending}
                          isEditingComment={editMutation.isPending}
                          getSessionForAgent={getSessionForAgent}
                          onOpenTerminal={openTerminalWindow}
                          fileInfo={selectedFileInfo}
                          selectedCommentId={selectedCommentId}
                          onClearSelectedComment={handleClearSelectedComment}
                        />
                      ) : (
                        <DiffViewerEmptyState />
                      )}
                    </div>
                  </div>
                </ResizablePanel>
                <ResizableHandle withHandle />
                <ResizablePanel id="comment-panel" defaultSize="30%" minSize="15%">
                  <div className="h-full bg-card overflow-hidden border-t">
                    {activeReview ? (
                      <CommentPanel
                        reviewId={activeReview.id}
                        review={activeReview}
                        projectId={selectedProjectId}
                        selectedFile={selectedFile}
                        onNavigateToComment={handleNavigateToComment}
                        onSelectFile={handleSelectFile}
                        selectedCommentId={selectedCommentId}
                        onCloseReview={() => closeReviewMutation.mutate()}
                        isClosingReview={closeReviewMutation.isPending}
                      />
                    ) : (
                      <div className="p-4 text-center text-muted-foreground">
                        <p className="text-sm">Add a comment to start a review</p>
                      </div>
                    )}
                  </div>
                </ResizablePanel>
              </ResizablePanelGroup>
            ) : (
              /* Unified view: Horizontal grid */
              <div className="h-full grid grid-cols-[1fr_320px]">
                <div className="min-w-0 bg-background overflow-auto flex flex-col">
                  {/* Review-level comments section */}
                  {activeReview && commentsData?.items && (
                    <ReviewCommentsSection
                      comments={commentsData.items}
                      selectedCommentId={selectedCommentId}
                      isExpanded={reviewCommentsSectionExpanded}
                      onToggleExpand={() => setReviewCommentsSectionExpanded((prev) => !prev)}
                      onReply={handleReplyToComment}
                      onResolve={handleResolveCommentSimple}
                      onDelete={handleDeleteComment}
                      onEdit={handleEditComment}
                      isReplying={replyMutation.isPending}
                      isResolving={resolveMutation.isPending}
                      isDeleting={deleteMutation.isPending}
                      isEditing={editMutation.isPending}
                      getSessionForAgent={getSessionForAgent}
                      onOpenTerminal={openTerminalWindow}
                    />
                  )}
                  {/* Diff viewer */}
                  <div className="flex-1 min-h-0">
                    {selectedFile ? (
                      <DiffViewer
                        diff={diff}
                        filePath={selectedFile}
                        isLoading={isLoading}
                        error={isError ? 'Failed to load diff' : null}
                        viewType={diffViewType}
                        onViewTypeChange={setDiffViewType}
                        projectId={selectedProjectId}
                        comments={fileComments}
                        onAddComment={handleAddComment}
                        onReplyToComment={handleReplyToComment}
                        onResolveComment={handleResolveComment}
                        onDeleteComment={handleDeleteComment}
                        onEditComment={handleEditComment}
                        isSubmittingComment={isSubmittingComment}
                        isResolvingComment={resolveMutation.isPending}
                        isDeletingComment={deleteMutation.isPending}
                        isEditingComment={editMutation.isPending}
                        getSessionForAgent={getSessionForAgent}
                        onOpenTerminal={openTerminalWindow}
                        fileInfo={selectedFileInfo}
                        selectedCommentId={selectedCommentId}
                        onClearSelectedComment={handleClearSelectedComment}
                      />
                    ) : (
                      <DiffViewerEmptyState />
                    )}
                  </div>
                </div>
                <div className="bg-card overflow-hidden border-l">
                  {activeReview ? (
                    <CommentPanel
                      reviewId={activeReview.id}
                      review={activeReview}
                      projectId={selectedProjectId}
                      selectedFile={selectedFile}
                      onNavigateToComment={handleNavigateToComment}
                      onSelectFile={handleSelectFile}
                      selectedCommentId={selectedCommentId}
                      onCloseReview={() => closeReviewMutation.mutate()}
                      isClosingReview={closeReviewMutation.isPending}
                    />
                  ) : (
                    <div className="p-4 text-center text-muted-foreground">
                      <p className="text-sm">Add a comment to start a review</p>
                    </div>
                  )}
                </div>
              </div>
            )}
          </ResizablePanel>
        </ResizablePanelGroup>
      )}

      {/* Keyboard shortcuts help modal */}
      <KeyboardShortcutsHelp open={isHelpOpen} onOpenChange={closeHelp} />
    </div>
  );
}
