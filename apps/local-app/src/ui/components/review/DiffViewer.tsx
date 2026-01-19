import { useState, useMemo, useCallback, useEffect, useRef, ReactNode, memo } from 'react';
import { parseDiff, Diff, Hunk, tokenize, markEdits, getChangeKey } from 'react-diff-view';
import type { ChangeData, HunkData, GutterOptions, ChangeEventArgs } from 'react-diff-view';
// @ts-expect-error refractor has ESM-only exports that don't resolve under moduleResolution: node
import { refractor } from 'refractor';
import 'react-diff-view/style/index.css';
import { Button } from '@/ui/components/ui/button';
import { Badge } from '@/ui/components/ui/badge';
import { Skeleton } from '@/ui/components/ui/skeleton';
import { ScrollArea, ScrollBar } from '@/ui/components/ui/scroll-area';
import {
  FileCode,
  Columns,
  Rows,
  AlertCircle,
  Binary,
  MessageSquare,
  Plus,
  ChevronDown,
  ChevronRight,
  MoreHorizontal,
} from 'lucide-react';
import { cn } from '@/ui/lib/utils';
import { NewCommentForm, CommentIndicator, type LineSelection } from './InlineComment';
import { CommentThread } from './CommentThread';
import type { ReviewComment, CommentType, ChangedFile } from '@/ui/lib/reviews';
import { isPendingComment, groupCommentsByLine } from '@/ui/lib/reviews';
import type { ActiveSession } from '@/ui/lib/sessions';

export type ViewType = 'unified' | 'split';

export interface DiffViewerProps {
  diff: string;
  filePath: string;
  isLoading?: boolean;
  error?: string | null;
  /** Current view type (controlled by parent) */
  viewType: ViewType;
  /** Callback when user changes view type */
  onViewTypeChange: (viewType: ViewType) => void;
  // Comment-related props
  projectId?: string;
  comments?: ReviewComment[];
  onAddComment?: (
    lineStart: number,
    lineEnd: number,
    side: 'old' | 'new',
    content: string,
    commentType: CommentType,
    targetAgentIds?: string[],
  ) => Promise<void>;
  onReplyToComment?: (commentId: string, content: string) => Promise<void>;
  /** Callback when resolving a comment */
  onResolveComment?: (
    commentId: string,
    status: 'resolved' | 'wont_fix',
    version: number,
  ) => Promise<void>;
  /** Callback when deleting a comment */
  onDeleteComment?: (commentId: string) => Promise<void>;
  /** Callback when editing a comment */
  onEditComment?: (commentId: string, content: string, version: number) => Promise<void>;
  isSubmittingComment?: boolean;
  /** Loading state for resolving comments */
  isResolvingComment?: boolean;
  /** Loading state for deleting comments */
  isDeletingComment?: boolean;
  /** Loading state for editing comments */
  isEditingComment?: boolean;
  /** Lookup function to get ActiveSession for an agent (for terminal integration) */
  getSessionForAgent?: (agentId: string) => ActiveSession | null;
  /** Callback to open terminal for a session */
  onOpenTerminal?: (session: ActiveSession) => void;
  /** File info for the selected file (used for empty state messaging) */
  fileInfo?: ChangedFile;
  /** Currently selected/highlighted comment ID for navigation */
  selectedCommentId?: string | null;
  /** Callback when selected comment should be cleared (after scroll/highlight completes) */
  onClearSelectedComment?: () => void;
}

// Map file extensions to refractor language identifiers
const LANGUAGE_MAP: Record<string, string> = {
  js: 'javascript',
  jsx: 'jsx',
  ts: 'typescript',
  tsx: 'tsx',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  c: 'c',
  cpp: 'cpp',
  h: 'c',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  xml: 'markup',
  html: 'markup',
  css: 'css',
  scss: 'scss',
  less: 'less',
  md: 'markdown',
  sql: 'sql',
  graphql: 'graphql',
  dockerfile: 'docker',
  makefile: 'makefile',
};

function getLanguageFromPath(filePath: string): string | null {
  const ext = filePath.split('.').pop()?.toLowerCase();
  if (!ext) return null;
  return LANGUAGE_MAP[ext] || null;
}

function DiffViewerSkeleton() {
  return (
    <div className="h-full flex flex-col">
      <div className="p-3 border-b flex items-center gap-2">
        <Skeleton className="h-5 w-5" />
        <Skeleton className="h-5 w-48" />
        <div className="flex-1" />
        <Skeleton className="h-8 w-20" />
        <Skeleton className="h-8 w-20" />
      </div>
      <div className="flex-1 p-4 space-y-2">
        {Array.from({ length: 15 }).map((_, i) => (
          <Skeleton
            key={i}
            className="h-5 w-full"
            style={{ width: `${60 + Math.random() * 40}%` }}
          />
        ))}
      </div>
    </div>
  );
}

function BinaryFileMessage({ filePath }: { filePath: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-8">
      <Binary className="h-12 w-12 mb-4" />
      <p className="text-lg font-medium mb-2">Binary file</p>
      <p className="text-sm text-center">Cannot display diff for binary file: {filePath}</p>
    </div>
  );
}

function ErrorMessage({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-full text-destructive p-8">
      <AlertCircle className="h-12 w-12 mb-4" />
      <p className="text-lg font-medium mb-2">Failed to load diff</p>
      <p className="text-sm text-center">{message}</p>
    </div>
  );
}

interface EmptyDiffMessageProps {
  fileInfo?: ChangedFile;
}

function EmptyDiffMessage({ fileInfo }: EmptyDiffMessageProps) {
  // Detect untracked file: status is 'added' with no additions/deletions in the file info
  // (meaning the file was added to changedFiles list but has no patch in the diff)
  const isUntrackedWithoutPatch =
    fileInfo?.status === 'added' && fileInfo?.additions === 0 && fileInfo?.deletions === 0;

  if (isUntrackedWithoutPatch) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-8">
        <FileCode className="h-12 w-12 mb-4" />
        <p className="text-lg font-medium mb-2">New file</p>
        <p className="text-sm text-center max-w-md">
          This is an untracked file. The diff content may not be available if the file is binary,
          too large, or was skipped during diff generation.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-8">
      <FileCode className="h-12 w-12 mb-4" />
      <p className="text-lg font-medium mb-2">No changes</p>
      <p className="text-sm text-center">This file has no visible changes.</p>
    </div>
  );
}

// Get line number from a change
function getLineNumber(change: ChangeData, side: 'old' | 'new'): number | null {
  if (change.type === 'insert') {
    return side === 'new' ? change.lineNumber : null;
  }
  if (change.type === 'delete') {
    return side === 'old' ? change.lineNumber : null;
  }
  // Normal change has both
  return side === 'old' ? change.oldLineNumber : change.newLineNumber;
}

// Threshold for collapsing context lines (lines around changes)
const COLLAPSE_CONTEXT_THRESHOLD = 8;

// Lazy hunk component that only renders when visible
interface LazyHunkProps {
  hunk: HunkData;
  hunkKey: string;
  isExpanded: boolean;
  onToggleExpand: () => void;
  children: ReactNode;
  viewType: ViewType;
}

const LazyHunk = memo(function LazyHunk({
  hunk,
  hunkKey,
  isExpanded,
  onToggleExpand,
  children,
  viewType,
}: LazyHunkProps) {
  const ref = useRef<HTMLTableSectionElement>(null);
  const [hasBeenVisible, setHasBeenVisible] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setHasBeenVisible(true);
          }
        });
      },
      {
        rootMargin: '200px', // Pre-render 200px before visible
        threshold: 0,
      },
    );

    observer.observe(element);

    return () => {
      observer.disconnect();
    };
  }, []);

  const changeCount = hunk.changes.length;
  const isLargeHunk = changeCount > COLLAPSE_CONTEXT_THRESHOLD * 2;

  // Calculate hunk header info
  const oldStart = hunk.oldStart;
  const newStart = hunk.newStart;

  // Determine colSpan based on view type
  // Unified: [line-num-old, line-num-new, content] = 3 columns
  // Split: [line-num-old, content-old, line-num-new, content-new] = 4 columns
  const colSpan = viewType === 'split' ? 4 : 3;

  return (
    <>
      {/* Sentinel/Header tbody with intersection observer ref */}
      <tbody ref={ref} data-hunk-key={hunkKey}>
        {isLargeHunk ? (
          <tr className="bg-muted/50 border-y text-xs text-muted-foreground">
            <td colSpan={colSpan} className="px-2 py-1">
              <div className="flex items-center gap-2">
                <button
                  onClick={onToggleExpand}
                  className="flex items-center gap-1 hover:text-foreground"
                  aria-expanded={isExpanded}
                  aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${changeCount} lines`}
                >
                  {isExpanded ? (
                    <ChevronDown className="h-3 w-3" aria-hidden="true" />
                  ) : (
                    <ChevronRight className="h-3 w-3" aria-hidden="true" />
                  )}
                  <span>
                    {isExpanded ? 'Collapse' : 'Expand'} {changeCount} lines
                  </span>
                </button>
                <span
                  className="text-muted-foreground/60"
                  aria-label={`Hunk at line ${oldStart} old, ${newStart} new`}
                >
                  @@ -{oldStart} +{newStart} @@
                </span>
              </div>
            </td>
          </tr>
        ) : (
          // Zero-height sentinel row for IntersectionObserver (non-large hunks)
          <tr className="h-0">
            <td colSpan={colSpan} />
          </tr>
        )}
      </tbody>

      {/* Content: either Hunk children or placeholder/collapsed state */}
      {!isLargeHunk || isExpanded ? (
        // Only render if visible or has been visible (keep in DOM once rendered)
        hasBeenVisible ? (
          children
        ) : (
          // Placeholder tbody with estimated height
          <tbody>
            <tr style={{ height: `${changeCount * 22}px` }}>
              <td colSpan={colSpan} className="text-center text-muted-foreground text-sm py-4">
                <MoreHorizontal className="h-4 w-4 animate-pulse inline-block" />
              </td>
            </tr>
          </tbody>
        )
      ) : (
        // Collapsed state
        <tbody>
          <tr>
            <td colSpan={colSpan}>
              <button
                onClick={onToggleExpand}
                className="w-full flex items-center justify-center gap-2 py-2 text-xs text-muted-foreground hover:bg-muted/50 border-b"
                aria-expanded={false}
                aria-label={`Show ${changeCount} hidden lines`}
              >
                <MoreHorizontal className="h-3 w-3" aria-hidden="true" />
                <span>Show {changeCount} hidden lines</span>
                <MoreHorizontal className="h-3 w-3" aria-hidden="true" />
              </button>
            </td>
          </tr>
        </tbody>
      )}
    </>
  );
});

export function DiffViewer({
  diff,
  filePath,
  isLoading,
  error,
  viewType,
  onViewTypeChange,
  projectId,
  comments = [],
  onAddComment,
  onReplyToComment,
  onResolveComment,
  onDeleteComment,
  onEditComment,
  isSubmittingComment = false,
  isResolvingComment = false,
  isDeletingComment = false,
  isEditingComment = false,
  getSessionForAgent,
  onOpenTerminal,
  fileInfo,
  selectedCommentId,
  onClearSelectedComment,
}: DiffViewerProps) {
  const [lineSelection, setLineSelection] = useState<LineSelection | null>(null);
  const [newCommentLine, setNewCommentLine] = useState<{
    lineStart: number;
    lineEnd: number;
    side: 'old' | 'new';
  } | null>(null);

  // Collapsed hunks for large diffs (expanded by default)
  const [collapsedHunks, setCollapsedHunks] = useState<Set<string>>(new Set());

  // Reset collapsed hunks when filePath changes to avoid stale state accumulation
  useEffect(() => {
    setCollapsedHunks(new Set());
  }, [filePath]);

  // Drag selection state
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef<{ line: number; side: 'old' | 'new' } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Text selection captured on + button mousedown (before click collapses it)
  const textSelectionRef = useRef<{
    lineStart: number;
    lineEnd: number;
    side: 'old' | 'new';
  } | null>(null);

  // Clear selection on escape or click outside
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && (lineSelection || newCommentLine)) {
        setLineSelection(null);
        setNewCommentLine(null);
      }
    };

    const handleClickOutside = (e: MouseEvent) => {
      // Only clear if clicking outside the diff container and not on a comment form
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node) &&
        lineSelection &&
        !newCommentLine
      ) {
        setLineSelection(null);
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('mousedown', handleClickOutside);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [lineSelection, newCommentLine]);

  // Handle drag selection (document-level mousemove and mouseup)
  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      // Find the closest gutter element to determine the line
      const gutterElement = document.elementFromPoint(e.clientX, e.clientY);
      if (!gutterElement) return;

      // Look for the line number in the gutter
      const diffLine = gutterElement.closest('.diff-gutter, .diff-gutter-col');
      if (!diffLine) return;

      // Get line info from data attribute or text content
      const lineText = diffLine.textContent?.trim();
      const lineNumber = lineText ? parseInt(lineText, 10) : null;

      if (lineNumber && !isNaN(lineNumber) && dragStartRef.current) {
        const start = Math.min(dragStartRef.current.line, lineNumber);
        const end = Math.max(dragStartRef.current.line, lineNumber);
        setLineSelection({
          lineStart: start,
          lineEnd: end,
          side: dragStartRef.current.side,
        });
      }
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      // If we have a selection and it's more than one line, keep it
      // If single line, the click handler will handle it
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging]);

  // Parse the diff
  const files = useMemo(() => {
    if (!diff) return [];
    try {
      return parseDiff(diff);
    } catch {
      return [];
    }
  }, [diff]);

  // Find the file we're looking for (in case diff contains multiple files)
  const file = useMemo(() => {
    if (files.length === 0) return null;
    // Try to find by path, otherwise use first file
    return files.find((f) => f.newPath === filePath || f.oldPath === filePath) || files[0];
  }, [files, filePath]);

  // Build changeDataMap for text selection support (maps change key -> ChangeData)
  const changeDataMap = useMemo(() => {
    const map = new Map<string, ChangeData>();
    if (!file?.hunks) return map;
    file.hunks.forEach((hunk) => {
      hunk.changes.forEach((change) => {
        map.set(getChangeKey(change), change);
      });
    });
    return map;
  }, [file?.hunks]);

  // Build a map from (side-lineNumber) to hunkKey for navigation
  const lineToHunkKeyMap = useMemo(() => {
    const map = new Map<string, string>();
    if (!file?.hunks) return map;

    file.hunks.forEach((hunk) => {
      const hunkKey = getChangeKey(hunk.changes[0]);
      hunk.changes.forEach((change) => {
        // Map both old and new line numbers to this hunk
        const oldLine = getLineNumber(change, 'old');
        const newLine = getLineNumber(change, 'new');
        if (oldLine !== null) {
          map.set(`old-${oldLine}`, hunkKey);
        }
        if (newLine !== null) {
          map.set(`new-${newLine}`, hunkKey);
        }
      });
    });
    return map;
  }, [file?.hunks]);

  // Navigation to selected comment: expand hunk, scroll, highlight, then clear
  // Handles collapsed hunks and lazy-loaded content with retry logic
  useEffect(() => {
    if (!selectedCommentId) return;

    // Track cleanup for timers
    let isCleanedUp = false;
    let clearTimeoutId: ReturnType<typeof setTimeout> | null = null;
    let retryTimeoutId: ReturnType<typeof setTimeout> | null = null;

    // Find the selected comment in our comments array
    // First check root comments, then check if it's a reply (find root comment's id)
    let targetComment = comments.find((c) => c.id === selectedCommentId);

    // If not found directly, it might be a reply - find its root and navigate there
    if (!targetComment) {
      // Comment might be a reply, search by traversing parentId chain
      for (const comment of comments) {
        if (comment.parentId === selectedCommentId) {
          // This is a child of our target, find the root
          targetComment = comments.find((c) => c.id === comment.parentId) || comment;
          break;
        }
      }
    }

    if (!targetComment || targetComment.lineStart === null) {
      // If comment not found or is a review-level comment (no line), clear and exit
      onClearSelectedComment?.();
      return;
    }

    // Determine the root comment id for DOM lookup
    const rootId = targetComment.parentId === null ? targetComment.id : targetComment.parentId;
    const actualRootId = rootId || selectedCommentId;

    // Find which hunk contains this comment's line
    const commentLineKey = `${targetComment.side || 'new'}-${targetComment.lineStart}`;
    const targetHunkKey = lineToHunkKeyMap.get(commentLineKey);

    // Step 1: Expand collapsed hunk if needed
    if (targetHunkKey && collapsedHunks.has(targetHunkKey)) {
      setCollapsedHunks((prev) => {
        const next = new Set(prev);
        next.delete(targetHunkKey);
        return next;
      });
    }

    // Step 2: Scroll hunk sentinel into view to trigger IntersectionObserver
    const scrollHunkIntoView = () => {
      if (isCleanedUp) return;
      if (targetHunkKey) {
        const hunkSentinel = containerRef.current?.querySelector(
          `[data-hunk-key="${targetHunkKey}"]`,
        );
        if (hunkSentinel) {
          hunkSentinel.scrollIntoView({
            behavior: 'auto', // Use instant scroll for hunk
            block: 'center',
          });
        }
      }
    };

    // Step 3: Retry loop to find and scroll to comment element
    const MAX_RETRY_TIME = 2500; // Max 2.5 seconds of retrying
    const RETRY_INTERVAL = 100; // Check every 100ms
    let elapsedTime = 0;

    const tryScrollToComment = () => {
      if (isCleanedUp) return;

      const widgetElement = containerRef.current?.querySelector(
        `[data-comment-id="${actualRootId}"]`,
      );

      if (widgetElement) {
        // Found the element - scroll and focus
        widgetElement.scrollIntoView({
          behavior: 'smooth',
          block: 'center',
        });

        // Focus the element for accessibility
        if (widgetElement instanceof HTMLElement) {
          widgetElement.focus({ preventScroll: true });
        }

        // Clear selection after 2 seconds
        clearTimeoutId = setTimeout(() => {
          if (!isCleanedUp) {
            onClearSelectedComment?.();
          }
        }, 2000);
      } else if (elapsedTime < MAX_RETRY_TIME) {
        // Element not found yet, retry
        elapsedTime += RETRY_INTERVAL;
        retryTimeoutId = setTimeout(tryScrollToComment, RETRY_INTERVAL);
      } else {
        // Timed out, give up and clear selection
        onClearSelectedComment?.();
      }
    };

    // Start the navigation sequence
    requestAnimationFrame(() => {
      if (isCleanedUp) return;
      // First scroll hunk into view (triggers lazy loading)
      scrollHunkIntoView();
      // Then start trying to find the comment
      retryTimeoutId = setTimeout(tryScrollToComment, 50);
    });

    // Cleanup function to prevent race conditions
    return () => {
      isCleanedUp = true;
      if (clearTimeoutId) clearTimeout(clearTimeoutId);
      if (retryTimeoutId) clearTimeout(retryTimeoutId);
    };
  }, [selectedCommentId, comments, onClearSelectedComment, lineToHunkKeyMap, collapsedHunks]);

  // Check if this is a binary file
  const isBinary = file?.isBinary === true;

  // Get language for syntax highlighting
  const language = useMemo(() => getLanguageFromPath(filePath), [filePath]);

  // Tokenize hunks for syntax highlighting
  const tokens = useMemo(() => {
    if (!file?.hunks || !language) return undefined;
    try {
      // Check if language is registered
      if (!refractor.registered(language)) {
        return undefined;
      }
      return tokenize(file.hunks, {
        highlight: true,
        enhancers: [markEdits(file.hunks, { type: 'block' })],
        language,
        refractor,
      });
    } catch {
      return undefined;
    }
  }, [file?.hunks, language]);

  // Group comments by line
  const commentsByLine = useMemo(() => groupCommentsByLine(comments), [comments]);

  // Build widgets for inline comments and new comment forms
  const widgets = useMemo(() => {
    const widgetMap: Record<string, ReactNode> = {};

    if (!file?.hunks) return widgetMap;

    // Find all changes and their keys
    file.hunks.forEach((hunk: HunkData) => {
      hunk.changes.forEach((change: ChangeData) => {
        const changeKey = getChangeKey(change);
        const lineNumber = getLineNumber(change, 'new') || getLineNumber(change, 'old');
        if (!lineNumber) return;

        // Determine side based on change type (uses 'old'/'new' convention)
        const side: 'old' | 'new' = change.type === 'delete' ? 'old' : 'new';
        const commentKey = `${side}-${lineNumber}`;

        // Check for existing comments (multiple threads per line supported)
        const lineThreads = commentsByLine.get(commentKey);
        if (lineThreads && lineThreads.length > 0) {
          // Helper to find a comment across all threads on this line
          const findComment = (commentId: string): ReviewComment | undefined => {
            for (const thread of lineThreads) {
              if (thread.root.id === commentId) return thread.root;
              const found = thread.replies.find((r) => r.id === commentId);
              if (found) return found;
            }
            return undefined;
          };

          widgetMap[changeKey] = (
            <div className="inline-comment-wrapper my-1 space-y-2">
              {lineThreads.map((thread) => {
                const threadIsPending = isPendingComment({
                  comment: thread.root,
                  replies: thread.replies,
                });
                const isSelected = selectedCommentId === thread.root.id;
                return (
                  <div
                    key={thread.root.id}
                    data-comment-id={thread.root.id}
                    tabIndex={-1}
                    className={cn(
                      'transition-all duration-200 outline-none',
                      isSelected && 'ring-2 ring-primary ring-offset-2 rounded-lg',
                    )}
                  >
                    <CommentThread
                      comment={thread.root}
                      replies={thread.replies}
                      isPending={threadIsPending}
                      getSessionForAgent={getSessionForAgent}
                      onOpenTerminal={onOpenTerminal}
                      onReply={
                        onReplyToComment
                          ? async (parentId, content) => {
                              await onReplyToComment(parentId, content);
                            }
                          : undefined
                      }
                      onResolve={
                        onResolveComment
                          ? async (commentId, status) => {
                              const targetComment = findComment(commentId);
                              if (!targetComment) return;
                              await onResolveComment(commentId, status, targetComment.version);
                            }
                          : undefined
                      }
                      onDelete={onDeleteComment}
                      onEdit={onEditComment}
                      isReplying={isSubmittingComment}
                      isResolving={isResolvingComment}
                      isDeleting={isDeletingComment}
                      isEditing={isEditingComment}
                    />
                  </div>
                );
              })}
            </div>
          );
        }

        // Check for new comment form
        if (
          newCommentLine &&
          newCommentLine.side === side &&
          lineNumber >= newCommentLine.lineStart &&
          lineNumber === newCommentLine.lineEnd
        ) {
          widgetMap[changeKey] = (
            <NewCommentForm
              lineStart={newCommentLine.lineStart}
              lineEnd={newCommentLine.lineEnd}
              side={newCommentLine.side}
              projectId={projectId ?? ''}
              onSubmit={async (content, commentType, targetAgentIds) => {
                if (onAddComment) {
                  await onAddComment(
                    newCommentLine.lineStart,
                    newCommentLine.lineEnd,
                    newCommentLine.side,
                    content,
                    commentType,
                    targetAgentIds,
                  );
                }
                setNewCommentLine(null);
              }}
              onCancel={() => setNewCommentLine(null)}
              isSubmitting={isSubmittingComment}
            />
          );
        }
      });
    });

    return widgetMap;
  }, [
    file?.hunks,
    commentsByLine,
    newCommentLine,
    projectId,
    onAddComment,
    onReplyToComment,
    onResolveComment,
    onDeleteComment,
    onEditComment,
    isSubmittingComment,
    isResolvingComment,
    isDeletingComment,
    isEditingComment,
    getSessionForAgent,
    onOpenTerminal,
    selectedCommentId,
  ]);

  // Handle gutter mousedown for starting drag selection
  const handleGutterMouseDown = useCallback(
    (args: ChangeEventArgs, event: React.MouseEvent) => {
      if (!onAddComment || !args.change) return;

      const change = args.change;
      const side: 'old' | 'new' = args.side === 'old' ? 'old' : 'new';
      const lineNumber = getLineNumber(change, side);

      if (!lineNumber) return;

      // Handle shift+click for range extension
      if (event.shiftKey && lineSelection && lineSelection.side === side) {
        const start = Math.min(lineSelection.lineStart, lineNumber);
        const end = Math.max(lineSelection.lineStart, lineNumber);
        setLineSelection({ lineStart: start, lineEnd: end, side });
        return;
      }

      // Start drag selection
      dragStartRef.current = { line: lineNumber, side };
      setIsDragging(true);
      setLineSelection({ lineStart: lineNumber, lineEnd: lineNumber, side });
    },
    [onAddComment, lineSelection],
  );

  // Handle gutter click for adding comments (after selection)
  const handleGutterClick = useCallback(
    (args: ChangeEventArgs) => {
      if (!onAddComment || !args.change || !lineSelection) return;

      // If we have a selection, open the comment form
      if (!isDragging && lineSelection) {
        setNewCommentLine({
          lineStart: lineSelection.lineStart,
          lineEnd: lineSelection.lineEnd,
          side: lineSelection.side,
        });
      }
    },
    [onAddComment, lineSelection, isDragging],
  );

  // Helper to find data-change-key attribute from a DOM node (walks up the tree)
  const findChangeKey = useCallback((node: Node | null): string | null => {
    let current: Node | null = node;
    while (current) {
      if (current instanceof HTMLElement) {
        const key = current.getAttribute('data-change-key');
        if (key) return key;
      }
      current = current.parentNode;
    }
    return null;
  }, []);

  // Capture text selection on + button mousedown (before click collapses it)
  const handleAddButtonMouseDown = useCallback(
    (side: 'old' | 'new') => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) {
        textSelectionRef.current = null;
        return;
      }

      // Find closest td[data-change-key] for anchor and focus
      const startKey = findChangeKey(selection.anchorNode);
      const endKey = findChangeKey(selection.focusNode);

      if (!startKey || !endKey) {
        textSelectionRef.current = null;
        return;
      }

      // Map keys to line numbers via changeDataMap
      const startChange = changeDataMap.get(startKey);
      const endChange = changeDataMap.get(endKey);

      if (!startChange || !endChange) {
        textSelectionRef.current = null;
        return;
      }

      // Get line numbers using the existing helper
      const startLine = getLineNumber(startChange, side);
      const endLine = getLineNumber(endChange, side);

      if (startLine == null || endLine == null) {
        textSelectionRef.current = null;
        return;
      }

      // Ensure start <= end
      const lineStart = Math.min(startLine, endLine);
      const lineEnd = Math.max(startLine, endLine);

      textSelectionRef.current = { lineStart, lineEnd, side };
    },
    [findChangeKey, changeDataMap],
  );

  // Custom gutter render to show comment indicators and add buttons
  const renderGutter = useCallback(
    (options: GutterOptions): ReactNode => {
      const { change, side, renderDefault, inHoverState } = options;
      const lineNumber = getLineNumber(change, side);

      if (!lineNumber) return renderDefault();

      // Use 'old'/'new' convention for comment lookup
      const commentKey = `${side}-${lineNumber}`;
      const lineThreads = commentsByLine.get(commentKey);
      const hasComments = lineThreads && lineThreads.length > 0;
      // Check if any thread has unresolved comments
      const hasUnresolved =
        lineThreads?.some(
          (thread) =>
            thread.root.status === 'open' || thread.replies.some((r) => r.status === 'open'),
        ) || false;

      // Check if this line is in selection
      const isInSelection =
        lineSelection &&
        lineSelection.side === side &&
        lineNumber >= lineSelection.lineStart &&
        lineNumber <= lineSelection.lineEnd;

      return (
        <div className="flex items-center gap-0.5">
          {/* Line number */}
          <span className={cn(isInSelection && 'bg-blue-100')}>{renderDefault()}</span>

          {/* Comment indicator or add button */}
          <div className="w-5 flex items-center justify-center">
            {hasComments ? (
              <CommentIndicator
                commentCount={lineThreads.length}
                hasUnresolved={hasUnresolved}
                onClick={() => {
                  // Scroll to the first comment thread on this line
                  const firstThreadRootId = lineThreads[0].root.id;
                  const commentElement = containerRef.current?.querySelector(
                    `[data-comment-id="${firstThreadRootId}"]`,
                  );
                  if (commentElement) {
                    commentElement.scrollIntoView({
                      behavior: 'smooth',
                      block: 'center',
                    });
                    // Focus for accessibility
                    if (commentElement instanceof HTMLElement) {
                      commentElement.focus({ preventScroll: true });
                    }
                  }
                }}
              />
            ) : (
              (() => {
                // In unified view, show + button on only one side:
                // - delete: show on 'old' side only (no new line number exists)
                // - insert/normal: show on 'new' side only
                const showAddButton = (() => {
                  if (!onAddComment || !inHoverState) return false;
                  if (viewType === 'split') return true; // Both sides in split
                  // Unified: old for deletes, new for inserts/normal
                  if (change.type === 'delete') return side === 'old';
                  return side === 'new';
                })();

                return showAddButton ? (
                  <button
                    className="h-4 w-4 rounded-full bg-blue-500 hover:bg-blue-600 text-white flex items-center justify-center opacity-60 hover:opacity-100"
                    onMouseDown={() => handleAddButtonMouseDown(side)}
                    onClick={(e) => {
                      e.stopPropagation();
                      // Priority: textSelection (from mouse select) > lineSelection (from gutter) > single line
                      const selection = (textSelectionRef.current?.side === side
                        ? textSelectionRef.current
                        : null) ??
                        (lineSelection?.side === side ? lineSelection : null) ?? {
                          lineStart: lineNumber,
                          lineEnd: lineNumber,
                          side,
                        };
                      setNewCommentLine({
                        lineStart: selection.lineStart,
                        lineEnd: selection.lineEnd,
                        side: selection.side,
                      });
                      // Clear text selection after opening comment form
                      textSelectionRef.current = null;
                      window.getSelection()?.removeAllRanges();
                    }}
                    title="Add comment"
                    aria-label={`Add comment on line ${lineNumber}`}
                  >
                    <Plus className="h-2.5 w-2.5" aria-hidden="true" />
                  </button>
                ) : null;
              })()
            )}
          </div>
        </div>
      );
    },
    [commentsByLine, lineSelection, onAddComment, viewType, handleAddButtonMouseDown],
  );

  // Generate line class for selection highlighting
  const generateLineClassName = useCallback(
    ({ changes }: { changes: ChangeData[]; defaultGenerate: () => string }) => {
      if (!lineSelection || changes.length === 0) return '';

      // react-diff-view can include null entries in split view for insert/delete rows
      const change = (changes as Array<ChangeData | null>).find((c): c is ChangeData => c !== null);
      if (!change) return '';
      const side = lineSelection.side;
      const lineNumber = getLineNumber(change, side);

      if (!lineNumber) return '';

      if (lineNumber >= lineSelection.lineStart && lineNumber <= lineSelection.lineEnd) {
        return 'bg-blue-50';
      }

      return '';
    },
    [lineSelection],
  );

  if (isLoading) {
    return <DiffViewerSkeleton />;
  }

  if (error) {
    return <ErrorMessage message={error} />;
  }

  if (isBinary) {
    return <BinaryFileMessage filePath={filePath} />;
  }

  if (!file || !file.hunks || file.hunks.length === 0) {
    return <EmptyDiffMessage fileInfo={fileInfo} />;
  }

  const additions = file.hunks.reduce(
    (sum, hunk) => sum + hunk.changes.filter((c) => c.type === 'insert').length,
    0,
  );
  const deletions = file.hunks.reduce(
    (sum, hunk) => sum + hunk.changes.filter((c) => c.type === 'delete').length,
    0,
  );

  // Count comments for this file
  const fileCommentCount = comments.filter((c) => c.parentId === null).length;

  return (
    <div
      ref={containerRef}
      className="h-full flex flex-col"
      role="region"
      aria-label={`Diff viewer for ${filePath}`}
    >
      {/* Header */}
      <div className="p-3 border-b flex items-center gap-2 bg-card shrink-0">
        <FileCode className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        <span className="font-mono text-sm truncate">{filePath}</span>
        <div className="flex items-center gap-1 ml-2" role="group" aria-label="File statistics">
          <Badge
            variant="secondary"
            className="text-xs bg-green-100 text-green-700"
            aria-label={`${additions} lines added`}
          >
            +{additions}
          </Badge>
          <Badge
            variant="secondary"
            className="text-xs bg-red-100 text-red-700"
            aria-label={`${deletions} lines removed`}
          >
            -{deletions}
          </Badge>
          {fileCommentCount > 0 && (
            <Badge
              variant="secondary"
              className="text-xs bg-blue-100 text-blue-700"
              aria-label={`${fileCommentCount} comments`}
            >
              <MessageSquare className="h-3 w-3 mr-1" aria-hidden="true" />
              {fileCommentCount}
            </Badge>
          )}
        </div>
        <div className="flex-1" />
        {/* View type toggle */}
        <div
          className="flex items-center gap-1 border rounded-md p-0.5"
          role="group"
          aria-label="View type"
        >
          <Button
            variant={viewType === 'unified' ? 'secondary' : 'ghost'}
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => onViewTypeChange('unified')}
            title="Unified view"
            aria-pressed={viewType === 'unified'}
          >
            <Rows className="h-3.5 w-3.5 mr-1" aria-hidden="true" />
            Unified
          </Button>
          <Button
            variant={viewType === 'split' ? 'secondary' : 'ghost'}
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => onViewTypeChange('split')}
            title="Side-by-side view"
            aria-pressed={viewType === 'split'}
          >
            <Columns className="h-3.5 w-3.5 mr-1" aria-hidden="true" />
            Split
          </Button>
        </div>
      </div>

      {/* Diff content */}
      <ScrollArea className="flex-1">
        <div className={cn('diff-viewer', viewType === 'split' && 'diff-split')}>
          <Diff
            viewType={viewType}
            diffType={file.type}
            hunks={file.hunks}
            tokens={tokens}
            widgets={widgets}
            renderGutter={renderGutter}
            generateLineClassName={generateLineClassName}
            gutterEvents={{
              onMouseDown: handleGutterMouseDown,
              onClick: handleGutterClick,
            }}
          >
            {(hunks) =>
              hunks.map((hunk) => {
                const hunkKey = getChangeKey(hunk.changes[0]);
                const isExpanded = !collapsedHunks.has(hunkKey);
                return (
                  <LazyHunk
                    key={hunkKey}
                    hunk={hunk}
                    hunkKey={hunkKey}
                    isExpanded={isExpanded}
                    onToggleExpand={() => {
                      setCollapsedHunks((prev) => {
                        const next = new Set(prev);
                        if (next.has(hunkKey)) {
                          next.delete(hunkKey);
                        } else {
                          next.add(hunkKey);
                        }
                        return next;
                      });
                    }}
                    viewType={viewType}
                  >
                    <Hunk hunk={hunk} />
                  </LazyHunk>
                );
              })
            }
          </Diff>
        </div>
        <ScrollBar orientation="horizontal" />
      </ScrollArea>
    </div>
  );
}

// Export a lazy-loaded version
export const LazyDiffViewer = DiffViewer;
