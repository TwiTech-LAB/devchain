import { useCallback, useState } from 'react';
import { useMutation, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import type {
  ExternalCommentDeleteOutcome,
  ExternalEditSessionView,
  ExternalSessionVerifyResult,
  ExternalSessionWriteOutcome,
} from '@/modules/external-integrations/models/external-edit-session.models';
import type {
  ExternalTaskComment,
  ExternalTaskCommentPage,
} from '@/modules/external-integrations/models/external-provider.models';
import { canonicalizeRichDocument } from '@/modules/external-integrations/models/external-rich-document';
import { useFetchFactory } from '@/ui/hooks/useFetchFactory';
import type { ExternalBoardProvider } from '@/ui/lib/external-board';
import { externalMyWorkQueryKeys } from '@/ui/lib/external-my-work';
import {
  createCommentDeleteSession,
  createCommentEditSession,
  executeCommentDelete,
  saveSession,
  verifySession,
} from '@/ui/lib/external-rich-edit';
import type { IntegrationConnectionEpoch } from '@/ui/lib/integration-connections';

export type CommentEditStatus =
  | 'idle'
  | 'opening'
  | 'editing'
  | 'saving'
  | 'saved'
  | 'unknown'
  | 'refresh_required'
  | 'error';

export interface OwnedCommentEditState {
  status: CommentEditStatus;
  session: ExternalEditSessionView | null;
  error: string | null;
}

export type CommentDeleteStatus =
  | 'idle'
  | 'confirming'
  | 'opening'
  | 'deleting'
  | 'deleted'
  | 'unknown'
  | 'refresh_required'
  | 'error';

/**
 * Patch one comment in place inside every loaded page of the infinite
 * comments cache, preserving page boundaries and pagination state.
 */
function patchCommentInPages(
  data: InfiniteData<ExternalTaskCommentPage> | undefined,
  remoteId: string,
  patch: (comment: ExternalTaskComment) => ExternalTaskComment,
): InfiniteData<ExternalTaskCommentPage> | undefined {
  if (!data) {
    return undefined;
  }
  let touched = false;
  const pages = data.pages.map((page) => {
    if (!page.comments.some((comment) => comment.remoteId === remoteId)) {
      return page;
    }
    touched = true;
    return {
      ...page,
      comments: page.comments.map((comment) =>
        comment.remoteId === remoteId ? patch(comment) : comment,
      ),
    };
  });
  return touched ? { ...data, pages } : data;
}

function editRejectionStatus(
  reason: Extract<ExternalSessionWriteOutcome, { outcome: 'pre_dispatch_rejected' }>['reason'],
): CommentEditStatus {
  switch (reason) {
    case 'session_not_found':
    case 'session_expired':
    case 'target_gone':
      return 'refresh_required';
    default:
      return 'error';
  }
}

function deleteRejectionStatus(
  reason: Extract<ExternalCommentDeleteOutcome, { outcome: 'rejected' }>['reason'],
): CommentDeleteStatus {
  return reason === 'session_not_found' || reason === 'session_expired'
    ? 'refresh_required'
    : 'error';
}

function deleteRejectionMessage(
  reason: Extract<ExternalCommentDeleteOutcome, { outcome: 'rejected' }>['reason'],
): string {
  return reason === 'not_owned'
    ? 'Only comments you authored can be deleted.'
    : 'The comment could not be deleted.';
}

/**
 * Per-comment owned-comment management: rich editing (RICH_EDIT_GO) and
 * deletion (OWNED_DELETE_GO) through the backend session routes. Each
 * comment gets independent state; nothing here disables the composer, task
 * actions, or other comments.
 */
export function useOwnedCommentActions(
  provider: ExternalBoardProvider,
  connectionEpoch: IntegrationConnectionEpoch | null,
  taskId: string | null,
  {
    richEditEnabled,
    ownedDeleteEnabled,
  }: { richEditEnabled: boolean; ownedDeleteEnabled: boolean },
) {
  const apiFetch = useFetchFactory();
  const queryClient = useQueryClient();
  const commentsKey = externalMyWorkQueryKeys.taskComments(provider, connectionEpoch, taskId ?? '');

  // ---- Editing (one comment at a time) ----
  const [editTarget, setEditTarget] = useState<string | null>(null);
  const [editState, setEditState] = useState<OwnedCommentEditState>({
    status: 'idle',
    session: null,
    error: null,
  });
  const [editDraft, setEditDraft] = useState<{ document: unknown } | null>(null);

  const openEditSession = useMutation({
    mutationFn: ({ commentId, lookupToken }: { commentId: string; lookupToken: string | null }) =>
      createCommentEditSession(apiFetch, provider, taskId!, commentId, lookupToken),
    onMutate: () => setEditState({ status: 'opening', session: null, error: null }),
    onSuccess: (session) => {
      setEditState({ status: 'editing', session, error: null });
      setEditDraft(null);
    },
    onError: (error: Error) => {
      // A lookup that misses (expired/evicted/shifted ClickUp proof) means
      // the page data is stale: the user must refresh; retry cannot fix it.
      const refreshRequired = /could not be found|not_owned|lookup/i.test(error.message);
      setEditState({
        status: refreshRequired ? 'refresh_required' : 'error',
        session: null,
        error: error.message,
      });
    },
  });

  // A saved comment patches in place: only the matching remoteId changes and
  // the loaded history position (cursor stack) is untouched.
  const commitEditToCache = useCallback(
    (document: unknown) => {
      if (editTarget === null) {
        return;
      }
      queryClient.setQueryData<InfiniteData<ExternalTaskCommentPage>>(commentsKey, (data) =>
        patchCommentInPages(data, editTarget, (existing) => ({
          ...existing,
          rich: { document: document as never, supported: true },
        })),
      );
    },
    [queryClient, commentsKey, editTarget],
  );

  const saveEdit = useMutation({
    mutationFn: ({ document, revision }: { document: unknown; revision: number }) => {
      const canonical = canonicalizeRichDocument(document);
      if (canonical === null) {
        throw new Error('The edited comment is outside the supported set.');
      }
      return saveSession(apiFetch, editState.session!.sessionId, canonical, revision);
    },
    onMutate: () => setEditState((previous) => ({ ...previous, status: 'saving', error: null })),
    onSuccess: (outcome: ExternalSessionWriteOutcome, variables) => {
      if (outcome.outcome === 'saved') {
        setEditState((previous) => ({
          ...previous,
          status: 'saved',
          session: outcome.session,
          error: null,
        }));
        // Patch the saved canonical document into the loaded pages in place.
        commitEditToCache(variables.document);
        return;
      }
      if (outcome.outcome === 'outcome_unknown' || outcome.outcome === 'saved_unverified') {
        setEditState((previous) => ({
          ...previous,
          status: 'unknown',
          session: outcome.session,
          error: null,
        }));
        return;
      }
      const reason = outcome.reason;
      setEditState((previous) => ({
        ...previous,
        status: editRejectionStatus(reason),
        session: outcome.session,
        error: null,
      }));
    },
    onError: (error: Error) => {
      setEditState((previous) => ({ ...previous, status: 'error', error: error.message }));
    },
  });

  const verifyEdit = useMutation({
    mutationFn: () => verifySession(apiFetch, editState.session!.sessionId),
    onSuccess: (result: ExternalSessionVerifyResult) => {
      if (result.remoteState === 'new_payload') {
        setEditState((previous) => ({
          ...previous,
          status: 'saved',
          session: result.session,
          error: null,
        }));
        return;
      }
      setEditState((previous) => ({
        ...previous,
        status: result.remoteState === 'gone' ? 'refresh_required' : 'unknown',
        session: result.session,
      }));
    },
    onError: (error: Error) => {
      setEditState((previous) => ({ ...previous, error: error.message }));
    },
  });

  const closeEdit = useCallback(() => {
    setEditTarget(null);
    setEditDraft(null);
    setEditState({ status: 'idle', session: null, error: null });
  }, []);

  const startEdit = useCallback(
    (comment: ExternalTaskComment) => {
      if (!richEditEnabled) {
        return;
      }
      setEditTarget(comment.remoteId);
      setEditDraft(null);
      openEditSession.mutate({
        commentId: comment.remoteId,
        lookupToken: comment.lookupToken,
      });
    },
    [richEditEnabled, openEditSession],
  );

  // ---- Deletion (per comment, one at a time) ----
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleteStatus, setDeleteStatus] = useState<CommentDeleteStatus>('idle');
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const requestDelete = useCallback(
    (comment: ExternalTaskComment) => {
      if (!ownedDeleteEnabled) {
        return;
      }
      setDeleteTarget(comment.remoteId);
      setDeleteStatus('confirming');
      setDeleteError(null);
    },
    [ownedDeleteEnabled],
  );

  const cancelDelete = useCallback(() => {
    setDeleteTarget(null);
    setDeleteStatus('idle');
    setDeleteError(null);
  }, []);

  // One non-retried vendor delete. Unknown outcomes reset to page one too,
  // because the comment may or may not still exist; the reload is the only
  // honest state.
  const confirmDelete = useMutation({
    mutationFn: async ({
      commentId,
      lookupToken,
    }: {
      commentId: string;
      lookupToken: string | null;
    }) => {
      const session: ExternalEditSessionView = await createCommentDeleteSession(
        apiFetch,
        provider,
        taskId!,
        commentId,
        lookupToken,
      );
      const outcome: ExternalCommentDeleteOutcome = await executeCommentDelete(
        apiFetch,
        session.sessionId,
      );
      return outcome;
    },
    onMutate: () => {
      setDeleteStatus('opening');
      setDeleteError(null);
    },
    onSuccess: (outcome) => {
      if (outcome.outcome === 'deleted' || outcome.outcome === 'already_deleted') {
        setDeleteStatus('deleted');
        // Reset to page one: later pages' cursors may have shifted.
        void queryClient.cancelQueries({ queryKey: commentsKey, exact: true });
        queryClient.resetQueries({ queryKey: commentsKey, exact: true });
        return;
      }
      if (outcome.outcome === 'outcome_unknown') {
        setDeleteStatus('unknown');
        void queryClient.cancelQueries({ queryKey: commentsKey, exact: true });
        queryClient.resetQueries({ queryKey: commentsKey, exact: true });
        return;
      }
      const reason = outcome.reason;
      setDeleteStatus(deleteRejectionStatus(reason));
      setDeleteError(deleteRejectionMessage(reason));
    },
    onError: (error: Error) => {
      const refreshRequired = /could not be found|not_owned|lookup/i.test(error.message);
      setDeleteStatus(refreshRequired ? 'refresh_required' : 'error');
      setDeleteError(error.message);
    },
  });

  return {
    edit: {
      target: editTarget,
      state: editState,
      draft: editDraft,
      setDraft: setEditDraft,
      start: startEdit,
      close: closeEdit,
      submit: () => {
        if (editDraft === null || editState.session === null) {
          return;
        }
        saveEdit.mutate({ document: editDraft.document, revision: editState.session.revision });
      },
      retrySamePayload: () => {
        if (editDraft === null || editState.session === null || editState.status !== 'unknown') {
          return;
        }
        saveEdit.mutate({ document: editDraft.document, revision: editState.session.revision });
      },
      verify: () => verifyEdit.mutate(),
      pending: openEditSession.isPending || saveEdit.isPending || verifyEdit.isPending,
      commitEditToCache,
    },
    delete: {
      target: deleteTarget,
      status: deleteStatus,
      error: deleteError,
      unknown: deleteStatus === 'unknown',
      request: requestDelete,
      confirm: (comment: ExternalTaskComment) =>
        confirmDelete.mutate({
          commentId: comment.remoteId,
          lookupToken: comment.lookupToken,
        }),
      cancel: cancelDelete,
      dismiss: () => {
        setDeleteTarget(null);
        setDeleteStatus('idle');
        setDeleteError(null);
      },
      pending: confirmDelete.isPending,
    },
  };
}
