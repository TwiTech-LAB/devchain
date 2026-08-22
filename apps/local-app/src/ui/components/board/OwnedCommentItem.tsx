import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { ExternalTaskComment } from '@/modules/external-integrations/models/external-provider.models';
import { Button } from '@/ui/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/ui/components/ui/dialog';
import { ExternalRichDocument } from '@/ui/components/board/rich/ExternalRichDocument';
import type { Content } from '@tiptap/react';
import { canonicalToTipTapJson, tipTapJsonToCanonical } from '@/ui/lib/rich/tiptap-json';
import type { useOwnedCommentActions } from '@/ui/hooks/board/useOwnedCommentActions';
import { getAgentInitials } from '@/ui/lib/multiavatar';
import { Avatar, AvatarFallback } from '@/ui/components/ui/avatar';

/**
 * The editor chunk is shared with the description editor and only imported
 * after an explicit per-comment Edit.
 */
const ExternalRichEditor = lazy(() =>
  import('@/ui/components/board/rich/ExternalRichEditor').then((module) => ({
    default: module.ExternalRichEditor,
  })),
);

type OwnedActions = ReturnType<typeof useOwnedCommentActions>;

export interface OwnedCommentCapabilities {
  /** Server-confirmed RICH_EDIT_GO flag from the rich-description read. */
  richEdit: boolean;
  /** Server-confirmed OWNED_DELETE_GO flag. */
  ownedDelete: boolean;
}

export interface OwnedCommentActionProps {
  comment: ExternalTaskComment;
  actions: OwnedActions;
  capabilities: OwnedCommentCapabilities;
  isOwned: boolean;
}

/**
 * Per-comment owned management: rich render with Edit (RICH_EDIT_GO) and
 * Delete with irreversible confirmation (OWNED_DELETE_GO). Availability is
 * gated independently per capability; comments without server-confirmed
 * ownership render read-only with no actions.
 */
export function OwnedCommentActions({
  comment,
  actions,
  capabilities,
  isOwned,
}: OwnedCommentActionProps) {
  const editingThis = actions.edit.target === comment.remoteId;
  const deletingThis = actions.delete.target === comment.remoteId;

  if (editingThis) {
    return <CommentEditSurface comment={comment} actions={actions} />;
  }

  const canEdit = capabilities.richEdit && isOwned && comment.rich?.supported === true;
  const canDelete = capabilities.ownedDelete && isOwned;

  return (
    <>
      {canEdit ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={() => actions.edit.start(comment)}
          disabled={actions.edit.pending}
        >
          Edit
        </Button>
      ) : null}
      {canDelete ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs text-destructive"
          onClick={() => actions.delete.request(comment)}
          disabled={actions.delete.pending}
        >
          Delete
        </Button>
      ) : null}
      {deletingThis ? <DeleteConfirmation comment={comment} actions={actions} /> : null}
    </>
  );
}

function CommentEditSurface({
  comment,
  actions,
}: {
  comment: ExternalTaskComment;
  actions: OwnedActions;
}) {
  const { state, draft } = actions.edit;
  const [confirmCancel, setConfirmCancel] = useState(false);
  const draftTextRef = useRef('');

  useEffect(() => {
    if (draft !== null) {
      const canonical = tipTapJsonToCanonical(draft.document);
      if (canonical !== null) {
        draftTextRef.current = plainTextOf(canonical);
      }
    }
  }, [draft]);

  const dirty = draft !== null;
  const seed: Content =
    draft !== null
      ? (draft.document as Content)
      : (canonicalToTipTapJson(
          comment.rich?.supported ? comment.rich.document : { version: 1, blocks: [] },
        ) as Content);

  return (
    <div className="space-y-2 rounded-md border p-3" role="region" aria-label="Edit comment">
      <Suspense
        fallback={
          <div className="min-h-[6rem] animate-pulse rounded-md bg-muted/30" aria-hidden="true" />
        }
      >
        <ExternalRichEditor
          key={state.session?.sessionId ?? 'comment-session'}
          initialDocument={seed}
          onChange={(document) => actions.edit.setDraft({ document })}
          ariaLabel="Edit comment"
        />
      </Suspense>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => {
            if (dirty) {
              setConfirmCancel(true);
              return;
            }
            actions.edit.close();
          }}
          disabled={actions.edit.pending}
        >
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={actions.edit.submit}
          disabled={
            actions.edit.pending ||
            !dirty ||
            state.status === 'saving' ||
            state.status === 'refresh_required'
          }
        >
          {state.status === 'saving' ? 'Saving…' : 'Save'}
        </Button>

        {state.status === 'unknown' ? (
          <>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={actions.edit.verify}
              disabled={actions.edit.pending}
            >
              Verify
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={actions.edit.retrySamePayload}
              disabled={actions.edit.pending}
            >
              Retry same content
            </Button>
          </>
        ) : null}

        <p role="status" className="text-xs text-muted-foreground">
          {editStatusMessage(state.status, state.error)}
        </p>
      </div>

      {state.status === 'unknown' || state.status === 'refresh_required' ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => {
            void navigator.clipboard?.writeText(draftTextRef.current).catch(() => undefined);
          }}
        >
          Copy my draft
        </Button>
      ) : null}

      <Dialog open={confirmCancel} onOpenChange={setConfirmCancel}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Discard your comment changes?</DialogTitle>
            <DialogDescription>
              The comment has unsaved edits. Nothing is sent to the provider unless you save.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setConfirmCancel(false)}>
              Keep editing
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                setConfirmCancel(false);
                actions.edit.close();
              }}
            >
              Discard changes
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function editStatusMessage(status: string, error: string | null): string {
  if (error !== null) {
    return error;
  }
  switch (status) {
    case 'opening':
      return 'Opening…';
    case 'saving':
      return 'Saving…';
    case 'saved':
      return 'Saved.';
    case 'unknown':
      return 'The save result could not be confirmed. Verify or retry the same content.';
    case 'refresh_required':
      return 'The comment list changed. Refresh the comments and try again.';
    default:
      return '';
  }
}

function DeleteConfirmation({
  comment,
  actions,
}: {
  comment: ExternalTaskComment;
  actions: OwnedActions;
}) {
  const status = actions.delete.status;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          actions.delete.dismiss();
        }
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Delete this comment?</DialogTitle>
          <DialogDescription>
            {actions.delete.unknown
              ? 'The previous delete could not be confirmed. The comment list will reload from the newest page either way.'
              : 'This permanently removes the comment from the provider. This action cannot be undone.'}
          </DialogDescription>
        </DialogHeader>
        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={actions.delete.cancel}
            disabled={actions.delete.pending}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => actions.delete.confirm(comment)}
            disabled={actions.delete.pending}
          >
            {actions.delete.pending ? 'Deleting…' : 'Delete comment'}
          </Button>
        </div>
        {actions.delete.error !== null ? (
          <p role="alert" className="text-xs text-destructive">
            {actions.delete.error}
          </p>
        ) : null}
        {status === 'refresh_required' ? (
          <p role="status" className="text-xs text-muted-foreground">
            The comment list changed. Refresh the comments and try again.
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function plainTextOf(document: unknown): string {
  const blocks = (document as { blocks: Array<Record<string, unknown>> }).blocks;
  const inline = (runs: unknown): string =>
    Array.isArray(runs)
      ? runs
          .map((run) =>
            typeof run === 'object' && run !== null && 'text' in run
              ? String((run as Record<string, unknown>).text ?? '')
              : '',
          )
          .join('')
      : '';
  return blocks
    .map((block) => {
      switch (block.type) {
        case 'paragraph':
          return inline(block.content);
        case 'heading':
          return inline(block.content);
        case 'bulletList':
          return (Array.isArray(block.items) ? block.items : [])
            .map((item) => `- ${inline(item)}`)
            .join('\n');
        case 'blockquote':
          return (Array.isArray(block.paragraphs) ? block.paragraphs : [])
            .map((paragraph) => `> ${inline(paragraph)}`)
            .join('\n');
        default:
          return '';
      }
    })
    .join('\n');
}

/**
 * Renders one comment body: the canonical rich document when supported, the
 * bounded plain text otherwise, with the 8,000-character truncation contract
 * untouched (it is enforced server-side and surfaced via bodyTruncated).
 */
export function CommentBody({ comment }: { comment: ExternalTaskComment }) {
  if (comment.rich?.supported) {
    return (
      <div className="min-w-0">
        <ExternalRichDocument document={comment.rich.document} />
        {comment.bodyTruncated ? (
          <p className="mt-1 text-xs text-muted-foreground">
            Comment was shortened. Open the source task to read the rest.
          </p>
        ) : null}
      </div>
    );
  }
  if (comment.body) {
    return (
      <div className="min-w-0">
        <p className="whitespace-pre-wrap break-words text-sm">{comment.body}</p>
        {comment.bodyTruncated ? (
          <p className="mt-1 text-xs text-muted-foreground">
            Comment was shortened. Open the source task to read the rest.
          </p>
        ) : null}
      </div>
    );
  }
  return <p className="select-none text-xs italic text-muted-foreground">No text content</p>;
}

/** Comment row: avatar, author, timestamp, body, and owned actions. */
export function OwnedCommentItem({
  comment,
  actions,
  capabilities,
  isOwned,
}: OwnedCommentActionProps) {
  return (
    <li className="flex gap-3">
      <Avatar className="h-8 w-8" aria-label={comment.author.displayName}>
        <AvatarFallback className="text-xs">
          {getAgentInitials(comment.author.displayName)}
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-2">
          <span className="text-sm font-medium">{comment.author.displayName}</span>
          <span className="text-xs text-muted-foreground">
            <time dateTime={comment.createdAt}>{new Date(comment.createdAt).toLocaleString()}</time>
            {/* Only a provider-reported edit time renders; providers without
                one show nothing rather than an invented timestamp. */}
            {comment.updatedAt ? ' (edited)' : ''}
          </span>
        </div>
        <CommentBody comment={comment} />
        <div className="mt-1 flex items-center gap-1">
          <OwnedCommentActions
            comment={comment}
            actions={actions}
            capabilities={capabilities}
            isOwned={isOwned}
          />
        </div>
      </div>
    </li>
  );
}
