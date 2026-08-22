import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  useMutation,
  useQuery,
  useQueryClient,
  useInfiniteQuery,
  type InfiniteData,
} from '@tanstack/react-query';
import type {
  ExternalTaskActionResult,
  ExternalTaskComment,
  ExternalTaskCommentInput,
  ExternalTaskCommentPage,
  ExternalTaskStatusInput,
} from '@/modules/external-integrations/models/external-provider.models';
import { useFetchFactory } from '@/ui/hooks/useFetchFactory';
import type { ExternalBoardProvider } from '@/ui/lib/external-board';
import { externalMyWorkQueryKeys } from '@/ui/lib/external-my-work';
import { externalTaskDetailQueryOptions } from '@/ui/lib/external-task-detail-query';
import type { IntegrationConnectionEpoch } from '@/ui/lib/integration-connections';
import { fetchJsonOrThrow } from '@/ui/lib/sessions';

type ExternalTaskMutation =
  | { action: 'change_status'; input: ExternalTaskStatusInput }
  | { action: 'add_comment'; input: ExternalTaskCommentInput };

export const MAX_DUPLICATE_ONLY_CHASE_PAGES = 3;
export const COMMENTS_CHANGED_WHILE_LOADING_MESSAGE =
  'Comments changed while loading. Continue to load earlier.';

/**
 * Live-region text for one chase attempt. Each fetch inside a Load earlier
 * action emits its own attempt number so screen readers announce progress
 * while duplicate-only pages are being traversed.
 */
export function chaseAttemptMessage(attempt: number): string {
  return `Loading earlier comments (attempt ${attempt} of ${MAX_DUPLICATE_ONLY_CHASE_PAGES})…`;
}

function mutationRequest(mutation: ExternalTaskMutation): { path: string; method: string } {
  if (mutation.action === 'change_status') return { path: 'status', method: 'PUT' };
  return { path: 'comments', method: 'POST' };
}

/**
 * Resolves the next page cursor. Stops on a missing (adapter-terminal) cursor
 * or a cursor that already produced a page — a repeated offset would loop the
 * same history forever.
 */
export function nextCommentPageParam(
  lastPage: ExternalTaskCommentPage,
  allPageParams: Array<string | null>,
): string | undefined {
  const cursor = lastPage.nextCursor;
  if (cursor === null || allPageParams.includes(cursor)) return undefined;
  return cursor;
}

/**
 * Merges newest-first pages into a unique newest-first list. Pages arrive
 * newest page first, so the first copy of a duplicated remote ID is the
 * newest copy.
 */
export function mergeExternalTaskCommentPages(
  pages: readonly ExternalTaskCommentPage[],
): ExternalTaskComment[] {
  const seen = new Set<string>();
  const merged: ExternalTaskComment[] = [];
  for (const page of pages) {
    for (const comment of page.comments) {
      if (seen.has(comment.remoteId)) continue;
      seen.add(comment.remoteId);
      merged.push(comment);
    }
  }
  return merged;
}

export function useExternalTaskController(
  provider: ExternalBoardProvider,
  taskId: string | null,
  {
    enabled,
    connectionEpoch,
    expectedLinkedEpicId,
  }: {
    enabled: boolean;
    connectionEpoch: IntegrationConnectionEpoch | null;
    expectedLinkedEpicId?: string | null;
  },
) {
  const apiFetch = useFetchFactory();
  const queryClient = useQueryClient();
  const encodedTaskId = taskId ? encodeURIComponent(taskId) : '';
  const [commentText, setCommentText] = useState('');
  const [commentsMessage, setCommentsMessage] = useState<string | null>(null);

  useEffect(() => {
    setCommentText('');
    setCommentsMessage(null);
  }, [taskId, connectionEpoch]);

  const detail = useQuery(
    externalTaskDetailQueryOptions(apiFetch, provider, connectionEpoch, taskId ?? '', {
      enabled,
    }),
  );

  // A replaced connection can reuse a remote task ID inside another account.
  // When an expected Epic is supplied, nothing beyond this detail read may be
  // exposed until its linkState resolves to exactly that Epic — not even
  // comments already sitting in the query cache. Derived during render so a
  // stale acceptance can never survive a detail update.
  const identityAccepted =
    expectedLinkedEpicId == null ||
    (detail.data !== undefined &&
      detail.data.linkState.linked &&
      detail.data.linkState.epicId === expectedLinkedEpicId);
  const identityMismatch =
    expectedLinkedEpicId != null && detail.data !== undefined && !identityAccepted;

  // Memoized so `loadEarlier` below keeps a stable identity: the key is rebuilt
  // by value on every render and would otherwise defeat its own useCallback.
  const commentsKey = useMemo(
    () => externalMyWorkQueryKeys.taskComments(provider, connectionEpoch, taskId ?? ''),
    [provider, connectionEpoch, taskId],
  );
  const commentsQuery = useInfiniteQuery({
    queryKey: commentsKey,
    initialPageParam: null as string | null,
    queryFn: ({ signal, pageParam }) =>
      fetchJsonOrThrow<ExternalTaskCommentPage>(
        `/api/integrations/my-work/${provider}/tasks/${encodedTaskId}/comments${
          pageParam === null ? '' : `?cursor=${encodeURIComponent(pageParam)}`
        }`,
        { signal },
        'Task comments could not be loaded.',
        '',
        apiFetch,
      ),
    enabled: enabled && connectionEpoch !== null && taskId !== null && identityAccepted,
    getNextPageParam: (lastPage, _allPages, _lastPageParam, allPageParams) =>
      nextCommentPageParam(lastPage, allPageParams),
  });

  const loadEarlier = useCallback(async (): Promise<void> => {
    if (!identityAccepted || commentsQuery.isFetchingNextPage) return;
    const readState = (): { hasNext: boolean; uniqueCount: number } => {
      const data =
        queryClient.getQueryData<InfiniteData<ExternalTaskCommentPage, string | null>>(commentsKey);
      if (!data || data.pages.length === 0) return { hasNext: false, uniqueCount: 0 };
      const lastPage = data.pages[data.pages.length - 1]!;
      return {
        hasNext: nextCommentPageParam(lastPage, data.pageParams) !== undefined,
        uniqueCount: mergeExternalTaskCommentPages(data.pages).length,
      };
    };

    let state = readState();
    if (!state.hasNext) return;
    // A duplicate-only page does not end the chase: an advancing Jira cursor
    // can still reach older unique comments, but only three such pages per
    // action so a churn loop cannot fetch unbounded.
    for (let attempt = 1; attempt <= MAX_DUPLICATE_ONLY_CHASE_PAGES; attempt += 1) {
      setCommentsMessage(chaseAttemptMessage(attempt));
      const uniqueBefore = state.uniqueCount;
      // fetchNextPage swallows errors unless throwOnError is set; a swallowed
      // failure would look exactly like a duplicate-only page and retry the
      // same failed cursor. Stop on failure with the query error state left
      // intact so the Retry UI can render from it.
      try {
        await commentsQuery.fetchNextPage({ throwOnError: true });
      } catch {
        setCommentsMessage(null);
        return;
      }
      state = readState();
      if (state.uniqueCount > uniqueBefore || !state.hasNext) {
        setCommentsMessage(null);
        return;
      }
    }
    setCommentsMessage(COMMENTS_CHANGED_WHILE_LOADING_MESSAGE);
  }, [
    identityAccepted,
    commentsQuery.isFetchingNextPage,
    commentsQuery.fetchNextPage,
    commentsKey,
    queryClient,
  ]);

  const mutation = useMutation({
    mutationFn: async (request: ExternalTaskMutation): Promise<ExternalTaskActionResult> => {
      if (!identityAccepted) {
        throw new Error('Linked task unavailable for the current connection.');
      }
      if (!taskId) throw new Error('Select a task before using remote actions.');
      const target = mutationRequest(request);
      return fetchJsonOrThrow<ExternalTaskActionResult>(
        `/api/integrations/my-work/${provider}/tasks/${encodeURIComponent(taskId)}/${target.path}`,
        {
          method: target.method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request.input),
        },
        'The remote action could not be completed.',
        '',
        apiFetch,
      );
    },
    onSuccess: async (_result, request) => {
      if (!taskId) return;
      if (request.action === 'add_comment') {
        // Reset to the initial page only: a full infinite refetch would replay
        // every older cursor the user already paged through.
        setCommentText('');
        await queryClient.cancelQueries({ queryKey: commentsKey, exact: true });
        queryClient.resetQueries({ queryKey: commentsKey, exact: true });
      }
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: externalMyWorkQueryKeys.taskDetail(provider, connectionEpoch, taskId),
          exact: true,
        }),
        queryClient.invalidateQueries({
          queryKey: externalMyWorkQueryKeys.landing(provider, connectionEpoch),
        }),
      ]);
    },
  });

  // The composer's draft lives in this hook, so this runs on every keystroke
  // without the memo. `mergeExternalTaskCommentPages` returns a private array,
  // making the in-place reverse safe.
  const chronologicalComments = useMemo(
    () =>
      identityAccepted && commentsQuery.data
        ? mergeExternalTaskCommentPages(commentsQuery.data.pages).reverse()
        : [],
    [identityAccepted, commentsQuery.data],
  );

  return {
    detail: identityAccepted ? detail : { ...detail, data: undefined },
    comments: identityAccepted ? commentsQuery : { ...commentsQuery, data: undefined },
    chronologicalComments,
    loadEarlier,
    commentText,
    setCommentText,
    commentsMessage,
    mutation,
    identityAccepted,
    identityMismatch,
    connectionEpoch,
  };
}
