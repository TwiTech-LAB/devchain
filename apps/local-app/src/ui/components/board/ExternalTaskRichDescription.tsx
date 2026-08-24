import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { ExternalLink } from 'lucide-react';
import type { ExternalTaskDetail } from '@/modules/external-integrations/models/external-provider.models';
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
import type { useExternalRichDescriptionEdit } from '@/ui/hooks/board/useExternalRichDescriptionEdit';
import type { ExternalRichDescriptionRead } from '@/ui/lib/external-rich-edit';
import type { ExternalRichDocumentV1 } from '@/modules/external-integrations/models/external-rich-document';
import { safeExternalTaskUrl, type ExternalBoardProvider } from '@/ui/lib/external-board';

/**
 * The editor chunk is imported only here, and this component is only
 * rendered after an explicit Edit — ProseMirror never loads for read-only
 * task views.
 */
const ExternalRichEditor = lazy(() =>
  import('@/ui/components/board/rich/ExternalRichEditor').then((module) => ({
    default: module.ExternalRichEditor,
  })),
);

type RichEditController = ReturnType<typeof useExternalRichDescriptionEdit>;

const descriptionSectionClassName = 'space-y-3 rounded-lg border bg-card p-4 sm:p-5';

function statusMessage(controller: RichEditController): string | null {
  const { state } = controller;
  if (state.error !== null) {
    return state.error;
  }
  switch (state.phase) {
    case 'saving':
      return 'Saving…';
    case 'saved':
      return 'Saved.';
    case 'diverged':
      return 'The remote content changed elsewhere. Save is blocked.';
    case 'unknown':
      return 'The save result could not be confirmed. Verify or retry the same content.';
    case 'blocked':
      return 'The save could not be completed. Verify the remote state.';
    case 'expired':
      return 'The editing session expired.';
    default:
      return null;
  }
}

/**
 * Rich description section: read-only canonical renderer by default, lazy
 * editor after explicit Edit, with explicit Save/Cancel, dirty-close
 * confirmation, divergence Copy-my-draft + Reload-remote, verify/retry for
 * unknown outcomes, and session-refresh draft preservation. Unsupported or
 * oversized descriptions keep the bounded plain fallback plus Open in
 * source; titles are rendered by the parent and stay read-only everywhere.
 */
export function ExternalTaskRichDescription({
  detail,
  controller,
  provider,
  webUrl,
  identityAccepted = true,
}: {
  detail: ExternalTaskDetail;
  controller: RichEditController;
  provider: ExternalBoardProvider;
  webUrl: string;
  identityAccepted?: boolean;
}) {
  const { state, draft } = controller;
  const [confirmClose, setConfirmClose] = useState(false);
  const [copied, setCopied] = useState(false);
  const draftTextRef = useRef('');

  const editing = state.phase !== 'idle' && state.phase !== 'saved';
  const dirty = draft !== null;
  // Identity rejection suppresses rich rendering, cached rich data, and
  // session creation alike; the plain projection stays the only view.
  const readOnlyContent = identityAccepted ? controller.description : undefined;
  const openInSource = (
    <a
      href={safeExternalTaskUrl(provider, webUrl) ?? '#'}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-xs underline"
    >
      <ExternalLink className="h-3 w-3" aria-hidden="true" />
      Open in source
    </a>
  );

  // Keep a plain-text shadow of the draft for Copy my draft.
  useEffect(() => {
    if (draft !== null) {
      const canonical = tipTapJsonToCanonical(draft.document);
      if (canonical !== null) {
        draftTextRef.current = canonicalPlainText(canonical.blocks);
      }
    }
  }, [draft]);

  const requestClose = () => {
    if (
      dirty &&
      (state.phase === 'editing' || state.phase === 'unknown' || state.phase === 'diverged')
    ) {
      setConfirmClose(true);
      return;
    }
    controller.cancelEdit();
  };

  const message = statusMessage(controller);

  if (editing) {
    // The editor seeds from the draft when one exists (session refresh,
    // pending unknown state) and otherwise from the session baseline.
    const seedSource: ExternalRichDocumentV1 =
      draft !== null && draft.document !== null && draft.document !== undefined
        ? (draft.document as ExternalRichDocumentV1)
        : (controller.description?.document ?? { version: 1, blocks: [] });
    const initial = canonicalToTipTapJson(seedSource) as Content;
    return (
      <section
        className={descriptionSectionClassName}
        aria-labelledby="external-task-description-heading"
      >
        <div className="flex items-center justify-between">
          <h3 id="external-task-description-heading" className="font-semibold">
            Description
          </h3>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={requestClose}
              disabled={
                controller.savePending || controller.verifyPending || controller.reloadPending
              }
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={controller.submitSave}
              disabled={
                controller.savePending ||
                !dirty ||
                state.phase === 'diverged' ||
                state.phase === 'expired' ||
                state.phase === 'saving'
              }
            >
              {controller.savePending ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </div>

        {state.phase === 'opening' ? (
          <div
            className="min-h-[8rem] animate-pulse rounded-md border bg-muted/30"
            aria-hidden="true"
          />
        ) : (
          <Suspense
            fallback={
              <div
                className="min-h-[8rem] animate-pulse rounded-md border bg-muted/30"
                aria-hidden="true"
              />
            }
          >
            <ExternalRichEditor
              key={state.session?.sessionId ?? 'session'}
              initialDocument={initial}
              onChange={controller.saveDraft}
              ariaLabel="Edit task description"
            />
          </Suspense>
        )}

        {message !== null ? (
          <p role="status" className="text-xs text-muted-foreground">
            {message}
          </p>
        ) : null}

        {state.phase === 'diverged' ? (
          <div
            className="space-y-2 rounded-md border p-3 text-xs"
            role="region"
            aria-label="Diverged remote content"
          >
            <p>The remote description changed since your session started.</p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={controller.retrySamePayload}
                disabled={controller.savePending}
              >
                Retry same content
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  void navigator.clipboard
                    ?.writeText(draftTextRef.current)
                    .then(() => setCopied(true))
                    .catch(() => setCopied(false));
                }}
              >
                {copied ? 'Draft copied' : 'Copy my draft'}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => controller.reload.mutate()}
                disabled={controller.reloadPending}
              >
                {controller.reloadPending ? 'Reloading…' : 'Reload remote'}
              </Button>
            </div>
            <p className="text-muted-foreground">
              Reload replaces the editor with the remote content. Copy my draft keeps your text.
            </p>
          </div>
        ) : null}

        {(state.phase === 'unknown' || state.phase === 'blocked') && state.lastOutcome !== null ? (
          <div
            className="space-y-2 rounded-md border p-3 text-xs"
            role="region"
            aria-label="Unconfirmed save"
          >
            <p>The save outcome is not confirmed.</p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => controller.verify.mutate()}
                disabled={controller.verifyPending}
              >
                {controller.verifyPending ? 'Verifying…' : 'Verify'}
              </Button>
              {state.phase === 'unknown' ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={controller.retrySamePayload}
                  disabled={controller.savePending}
                >
                  Retry same content
                </Button>
              ) : null}
              {openInSource}
            </div>
          </div>
        ) : null}

        {state.phase === 'expired' ? (
          <div
            className="space-y-2 rounded-md border p-3 text-xs"
            role="region"
            aria-label="Session expired"
          >
            <p>Your draft is preserved locally.</p>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                onClick={controller.refreshSession}
                disabled={controller.openPending}
              >
                {controller.openPending ? 'Refreshing…' : 'Refresh session'}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  void navigator.clipboard
                    ?.writeText(draftTextRef.current)
                    .then(() => setCopied(true))
                    .catch(() => setCopied(false));
                }}
              >
                {copied ? 'Draft copied' : 'Copy my draft'}
              </Button>
              {openInSource}
            </div>
          </div>
        ) : null}

        <Dialog open={confirmClose} onOpenChange={setConfirmClose}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Discard your changes?</DialogTitle>
              <DialogDescription>
                The description has unsaved edits. Cancel keeps them in this editor only — nothing
                is sent to the provider.
              </DialogDescription>
            </DialogHeader>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setConfirmClose(false)}>
                Keep editing
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => {
                  setConfirmClose(false);
                  controller.cancelEdit();
                }}
              >
                Discard changes
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </section>
    );
  }

  if (state.phase === 'saved') {
    return (
      <section
        className={descriptionSectionClassName}
        aria-labelledby="external-task-description-heading"
      >
        <h3 id="external-task-description-heading" className="font-semibold">
          Description
        </h3>
        <p role="status" className="text-xs text-muted-foreground">
          Saved. The verified description follows.
        </p>
        <ReadOnlyDescription
          read={readOnlyContent}
          loading={controller.descriptionLoading}
          fallback={detail}
        />
        <Button variant="outline" size="sm" onClick={controller.cancelEdit}>
          Done
        </Button>
      </section>
    );
  }

  return (
    <section
      className={descriptionSectionClassName}
      aria-labelledby="external-task-description-heading"
    >
      <div className="flex items-center justify-between">
        <h3 id="external-task-description-heading" className="font-semibold">
          Description
        </h3>
        {readOnlyContent?.supported && readOnlyContent.canEdit ? (
          <Button
            size="sm"
            variant="outline"
            onClick={controller.startEdit}
            disabled={controller.openPending}
          >
            {controller.openPending ? 'Opening…' : 'Edit'}
          </Button>
        ) : null}
      </div>
      <ReadOnlyDescription
        read={readOnlyContent}
        loading={controller.descriptionLoading}
        fallback={detail}
      />
      {readOnlyContent && !readOnlyContent.supported ? (
        <p className="text-xs text-muted-foreground">
          This description contains content DevChain cannot safely edit. {openInSource}
        </p>
      ) : null}
      {detail.descriptionTruncated ? (
        <p className="text-xs text-muted-foreground">
          Description was shortened. Open the source task to read the rest.
        </p>
      ) : null}
    </section>
  );
}

function ReadOnlyDescription({
  read,
  loading,
  fallback,
}: {
  read: ExternalRichDescriptionRead | undefined;
  loading: boolean;
  fallback: ExternalTaskDetail;
}): ReactNode {
  if (loading) {
    return <div className="min-h-[4rem] animate-pulse rounded-md bg-muted/30" aria-hidden="true" />;
  }
  // A missing read (query disabled or loading) falls back to the plain text;
  // the rich render is additive on top of the always-available projection.
  if (read?.supported && read.document) {
    return <ExternalRichDocument document={read.document} />;
  }
  // Unsupported, oversized, or absent: the bounded plain fallback is truth.
  return (
    <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">
      {fallback.description ?? 'No description'}
    </p>
  );
}

/** Plain-text shadow of a canonical document for clipboard copying. */
function canonicalPlainText(blocks: Array<{ type: string }>): string {
  const lines: string[] = [];
  for (const block of blocks) {
    const record = block as unknown as Record<string, unknown>;
    const inlineText = (runs: unknown): string =>
      Array.isArray(runs)
        ? runs
            .map((run) =>
              typeof run === 'object' && run !== null && 'text' in run
                ? String((run as Record<string, unknown>).text ?? '')
                : '',
            )
            .join('')
        : '';
    switch (block.type) {
      case 'paragraph':
        lines.push(inlineText(record.content));
        break;
      case 'heading':
        lines.push(
          `#${'='.repeat(Math.max(1, Number(record.level ?? 1)))} ${inlineText(record.content)}`,
        );
        break;
      case 'bulletList':
        for (const item of Array.isArray(record.items) ? record.items : []) {
          lines.push(`- ${inlineText(item)}`);
        }
        break;
      case 'blockquote':
        for (const paragraph of Array.isArray(record.paragraphs) ? record.paragraphs : []) {
          lines.push(`> ${inlineText(paragraph)}`);
        }
        break;
    }
  }
  return lines.join('\n');
}
