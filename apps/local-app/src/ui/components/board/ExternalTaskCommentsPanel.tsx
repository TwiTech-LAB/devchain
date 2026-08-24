import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Loader2 } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/ui/components/ui/alert';
import { Button } from '@/ui/components/ui/button';
import { Checkbox } from '@/ui/components/ui/checkbox';
import { Label } from '@/ui/components/ui/label';
import { Textarea } from '@/ui/components/ui/textarea';
import { OwnedCommentItem } from '@/ui/components/board/OwnedCommentItem';
import type { useExternalTaskController } from '@/ui/hooks/board/useExternalTaskController';
import { useOwnedCommentActions } from '@/ui/hooks/board/useOwnedCommentActions';
import type { ExternalBoardProvider } from '@/ui/lib/external-board';
import { cn } from '@/ui/lib/utils';
import { getErrorMessage } from '@/ui/lib/toast-helpers';

type ExternalTaskController = ReturnType<typeof useExternalTaskController>;

export interface ExternalTaskCommentsPanelProps {
  provider: ExternalBoardProvider;
  taskId: string | null;
  controller: ExternalTaskController;
  canComment: boolean;
  /** Phase 13 capability flags, applied independently per action family. */
  richEditEnabled?: boolean;
  ownedDeleteEnabled?: boolean;
  /** Overrides for the section wrapper; a flex column lets the history fill a dialog column. */
  className?: string;
  /** Overrides for the history scroll container. */
  historyClassName?: string;
}

export function ExternalTaskCommentsPanel({
  provider,
  taskId,
  controller,
  canComment,
  richEditEnabled = false,
  ownedDeleteEnabled = false,
  className,
  historyClassName,
}: ExternalTaskCommentsPanelProps) {
  const ownedActions = useOwnedCommentActions(provider, controller.connectionEpoch, taskId, {
    richEditEnabled,
    ownedDeleteEnabled,
  });
  const { comments, chronologicalComments, loadEarlier, commentsMessage, commentText } = controller;
  const mutation = controller.mutation;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const scrolledToNewest = useRef(false);
  const [notifyAll, setNotifyAll] = useState(false);

  useEffect(() => {
    setNotifyAll(false);
  }, [taskId]);

  useEffect(() => {
    if (scrolledToNewest.current || !comments.isSuccess) return;
    const node = scrollRef.current;
    if (node) {
      node.scrollTop = node.scrollHeight;
    }
    scrolledToNewest.current = true;
  }, [comments.isSuccess, chronologicalComments.length]);

  useEffect(() => {
    if (mutation.data?.action !== 'add_comment') return;
    const node = scrollRef.current;
    if (node) {
      node.scrollTop = node.scrollHeight;
    }
  }, [mutation.data]);

  const handleLoadEarlier = async (): Promise<void> => {
    const node = scrollRef.current;
    const previousHeight = node?.scrollHeight ?? 0;
    const previousTop = node?.scrollTop ?? 0;
    await loadEarlier();
    // Older pages are prepended above the viewport; restoring the offset keeps
    // the reader anchored on the same comment instead of jumping to the top.
    const updated = scrollRef.current;
    if (updated) {
      updated.scrollTop = previousTop + (updated.scrollHeight - previousHeight);
    }
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!commentText.trim()) return;
    mutation.mutate(
      { action: 'add_comment', input: { text: commentText.trim(), notifyAll } },
      { onSuccess: () => setNotifyAll(false) },
    );
  };

  const creationFailed = mutation.isError && mutation.variables?.action === 'add_comment';
  const creationSucceeded = !mutation.isError && mutation.data?.action === 'add_comment';

  return (
    <section
      className={cn('space-y-3 border-t pt-5', className)}
      aria-labelledby="external-task-comments-heading"
    >
      <h3 id="external-task-comments-heading" className="font-semibold">
        Comments
      </h3>

      {commentsMessage ? (
        <p className="text-sm text-muted-foreground" role="status">
          {commentsMessage}
        </p>
      ) : null}

      {comments.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading comments
        </div>
      ) : null}

      {comments.isError && !comments.isFetchNextPageError ? (
        <Alert variant="destructive">
          <AlertTitle>Comments unavailable</AlertTitle>
          <AlertDescription>
            <span className="mr-2">
              {getErrorMessage(comments.error, 'Task comments could not be loaded.')}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void comments.refetch()}
              disabled={comments.isRefetching}
            >
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      <div
        ref={scrollRef}
        role="region"
        aria-label="Comments history"
        className={cn(
          'min-h-24 max-h-96 flex-none space-y-3 overflow-y-auto overscroll-contain lg:max-h-none lg:min-h-0 lg:flex-1',
          historyClassName,
        )}
      >
        {comments.isFetchingNextPage ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading earlier comments
          </div>
        ) : null}

        {comments.data && comments.hasNextPage ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-full"
            onClick={handleLoadEarlier}
            disabled={comments.isFetchingNextPage}
          >
            Load earlier comments
          </Button>
        ) : null}

        {comments.isFetchNextPageError ? (
          <Alert variant="destructive">
            <AlertTitle>Earlier comments unavailable</AlertTitle>
            <AlertDescription>
              <span className="mr-2">
                {getErrorMessage(comments.error, 'Earlier comments could not be loaded.')}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleLoadEarlier}
                disabled={comments.isFetchingNextPage}
              >
                Retry
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}

        {comments.data && chronologicalComments.length === 0 ? (
          <p className="text-sm text-muted-foreground">No comments yet.</p>
        ) : null}

        <ol className="space-y-4">
          {chronologicalComments.map((comment) => (
            <OwnedCommentItem
              key={comment.remoteId}
              comment={comment}
              actions={ownedActions}
              capabilities={{ richEdit: richEditEnabled, ownedDelete: ownedDeleteEnabled }}
              isOwned={comment.owned}
            />
          ))}
        </ol>

        {ownedActions.edit.state.status === 'saved' ? (
          <p role="status" className="text-xs font-medium text-primary">
            Comment saved. Some providers do not report edit timestamps.
          </p>
        ) : null}
        {ownedActions.delete.status === 'deleted' ? (
          <p role="status" className="text-xs font-medium text-primary">
            Comment deleted. Comments reloaded from the newest page.
          </p>
        ) : null}
        {(ownedActions.edit.state.status === 'refresh_required' ||
          ownedActions.delete.status === 'refresh_required') && (
          <Alert>
            <AlertTitle>Comments changed</AlertTitle>
            <AlertDescription>
              The comment list is out of date. Reload the task to see current comments.
            </AlertDescription>
          </Alert>
        )}
      </div>

      {canComment ? (
        <form className="space-y-3" onSubmit={handleSubmit}>
          <Label htmlFor="external-task-comment">Comment</Label>
          <Textarea
            id="external-task-comment"
            name="comment"
            autoComplete="off"
            value={commentText}
            onChange={(event) => controller.setCommentText(event.target.value)}
            maxLength={10_000}
            required
          />
          {provider === 'clickup' ? (
            <div className="flex items-center gap-2">
              <Checkbox
                id="external-task-notify-all"
                name="notifyAll"
                checked={notifyAll}
                onCheckedChange={(checked) => setNotifyAll(checked === true)}
              />
              <Label htmlFor="external-task-notify-all" className="font-normal">
                Notify everyone
              </Label>
            </div>
          ) : null}
          <Button type="submit" disabled={mutation.isPending || !commentText.trim()}>
            {mutation.isPending ? 'Adding…' : 'Add comment'}
          </Button>
        </form>
      ) : (
        <p className="text-sm text-muted-foreground">Comments are unavailable.</p>
      )}

      {creationFailed ? (
        <Alert variant="destructive">
          <AlertTitle>Comment could not be added</AlertTitle>
          <AlertDescription>
            {getErrorMessage(mutation.error, 'The comment could not be added.')}
          </AlertDescription>
        </Alert>
      ) : null}
      {creationSucceeded ? (
        <p className="text-sm font-medium text-primary" role="status">
          Comment added.
        </p>
      ) : null}
    </section>
  );
}
