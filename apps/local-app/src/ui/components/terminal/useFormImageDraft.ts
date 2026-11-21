import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import type { Socket } from 'socket.io-client';
import {
  FormSendAckSchema,
  formSendTimeoutMs,
  type FormSendInput,
} from '@/modules/terminal/dtos/ws-envelope.dto';
import type { BackendId, FetchFn } from '@/ui/lib/api-transport';
import { toast } from '@/ui/hooks/use-toast';
import { createPasteRequestId, uploadSessionImage } from './tty-image-paste';
import {
  editFormText,
  emptyFormDraft,
  formSegments,
  imageLabel,
  replaceFormRange,
  type DraftImage,
  type FormDraft,
  type FormEditSelection,
} from './form-image-draft';
import {
  clipboardReadIssues,
  type ClipboardFilePaste,
  type ClipboardImageReadResult,
} from './terminal-clipboard-paste';

interface Attempt {
  input: FormSendInput;
  connection: string | undefined;
  state: 'sending' | 'retryable' | 'inspect';
  confirmed: number;
  acknowledgedImages: number;
}

type DraftRef = { current: FormDraft };

export function useFormImageDraft(
  textarea: RefObject<HTMLTextAreaElement>,
  sessionId: string,
  projectId: string | null | undefined,
  projectBackend: BackendId,
  socket: Socket,
  fetchFn: FetchFn,
) {
  const [draft, setDraft] = useState(emptyFormDraft);
  const current = useRef(draft);
  const commit = useCallback((next: FormDraft, owner: DraftRef = current) => {
    owner.current = next;
    if (owner === current) setDraft(next);
  }, []);
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const sending = useRef<Attempt | null>(null);
  const updateAttempt = useCallback((next: Attempt | null) => {
    sending.current = next;
    setAttempt(next);
  }, []);
  const counter = useRef(0);
  const editRevision = useRef(0);
  const scope = useRef<AbortController | null>(null);
  const uploads = useRef(new Map<number, AbortController>());
  // Another paste can temporarily cover an image while its validation or upload completes.
  const displacedSelections = useRef(new Map<number, DraftRef>());
  const tail = useRef(Promise.resolve());

  useLayoutEffect(() => {
    const controller = new AbortController();
    scope.current = controller;
    const activeUploads = uploads.current;
    const selections = displacedSelections.current;
    tail.current = Promise.resolve();
    commit(emptyFormDraft());
    updateAttempt(null);
    return () => {
      controller.abort();
      for (const upload of activeUploads.values()) upload.abort();
      activeUploads.clear();
      selections.clear();
    };
  }, [sessionId, projectId, projectBackend, socket, commit, updateAttempt]);

  const replaceSelection = (text: string, images?: DraftImage[]) => {
    const el = textarea.current;
    const previous = current.current;
    const start = el?.selectionStart ?? previous.text.length;
    const replacement = replaceFormRange(previous, start, el?.selectionEnd ?? start, text, images);
    editRevision.current++;
    flushSync(() => commit(replacement.draft));
    el?.focus();
    el?.setSelectionRange(replacement.caret, replacement.caret);
    return replacement;
  };
  const locateImage = (number: number) => {
    const owners = new Set<DraftRef>([current]);
    for (const owner of owners) {
      for (const image of owner.current.images) {
        if (image.number === number) return { owner, image };
        const displaced = displacedSelections.current.get(image.number);
        if (displaced) owners.add(displaced);
      }
    }
  };
  const replaceImage = (
    number: number,
    content: FormDraft,
    selection?: {
      start: number;
      end: number;
      direction?: HTMLTextAreaElement['selectionDirection'];
    },
  ) => {
    const location = locateImage(number);
    if (!location) return;
    const { owner, image } = location;
    const end = image.start + imageLabel(number).length;
    const next = replaceFormRange(
      owner.current,
      image.start,
      end,
      content.text,
      content.images,
    ).draft;
    if (owner !== current) {
      owner.current = next;
      return;
    }
    const el = textarea.current;
    const startCaret = el?.selectionStart ?? end;
    const endCaret = el?.selectionEnd ?? end;
    const direction = el?.selectionDirection;
    const adjust = (position: number) => {
      if (position <= image.start) return position;
      if (position < end) return image.start;
      return position - (end - image.start) + content.text.length;
    };
    flushSync(() => commit(next));
    if (selection && startCaret === end && endCaret === end) {
      el?.setSelectionRange(
        image.start + selection.start,
        image.start + selection.end,
        selection.direction,
      );
    } else {
      el?.setSelectionRange(adjust(startCaret), adjust(endCaret), direction);
    }
  };
  const remove = (number: number) => {
    if (sending.current) return;
    editRevision.current++;
    uploads.current.get(number)?.abort();
    replaceImage(number, emptyFormDraft());
  };
  const changeStage = (number: number, stage: DraftImage['stage'], attachmentId?: string) => {
    const location = locateImage(number);
    if (!location) return;
    const { owner, image } = location;
    const next = {
      ...owner.current,
      images: owner.current.images.map((item) =>
        item === image ? { ...item, stage, attachmentId } : item,
      ),
    };
    commit(next, owner);
  };
  const upload = async (number: number, lifetime: AbortSignal) => {
    const item = locateImage(number)?.image;
    if (!item || lifetime.aborted || !projectId || uploads.current.has(number)) return;
    const controller = new AbortController();
    uploads.current.set(number, controller);
    changeStage(number, 'uploading');
    try {
      const id = await uploadSessionImage(
        fetchFn,
        { projectId, sessionId },
        item.file,
        controller.signal,
      );
      if (!controller.signal.aborted) changeStage(number, 'ready', id);
    } catch (error) {
      if (!controller.signal.aborted) {
        changeStage(number, 'failed');
        toast({
          title: 'Attachment upload failed',
          description: error instanceof Error ? error.message : item.file.name,
          variant: 'destructive',
        });
      }
    } finally {
      uploads.current.delete(number);
    }
  };
  const paste = (files: ClipboardFilePaste, validation: Promise<ClipboardImageReadResult>) => {
    const lifetime = scope.current?.signal;
    if (sending.current || !lifetime || lifetime.aborted) return;
    const before = current.current;
    const selection = [
      textarea.current?.selectionStart ?? before.text.length,
      textarea.current?.selectionEnd ?? before.text.length,
    ] as const;
    const direction = textarea.current?.selectionDirection;
    let labels = '';
    const added = files.files.map((file) => {
      const number = ++counter.current;
      const image: DraftImage = { number, file, stage: 'checking', start: labels.length };
      labels += imageLabel(number);
      return image;
    });
    const displaced = { current: emptyFormDraft() };
    let originalStart = 0;
    let originalEndMargin = 0;
    if (added.length) {
      const { start, end } = replaceSelection(labels, added);
      displaced.current = {
        text: before.text.slice(start, end),
        images: before.images
          .filter((image) => image.start >= start && image.start < end)
          .map((image) => ({ ...image, start: image.start - start })),
      };
      originalStart = selection[0] - start;
      originalEndMargin = end - selection[1];
      if (displaced.current.images.length) {
        for (const image of added) displacedSelections.current.set(image.number, displaced);
      }
    }
    const revision = editRevision.current;
    const stage = async () => {
      const result = await validation;
      if (lifetime.aborted) return;
      const valid = new Set(result.images.map((image) => image.file));
      for (const image of added) displacedSelections.current.delete(image.number);
      if (!valid.size) {
        const [anchor, ...others] = added.filter((image) => locateImage(image.number));
        for (const image of others.reverse()) replaceImage(image.number, emptyFormDraft());
        if (anchor) {
          const selection =
            editRevision.current === revision
              ? {
                  start: originalStart,
                  end: displaced.current.text.length - originalEndMargin,
                  direction,
                }
              : undefined;
          replaceImage(anchor.number, displaced.current, selection);
        }
      } else {
        for (const image of added) {
          if (!valid.has(image.file)) replaceImage(image.number, emptyFormDraft());
          else await upload(image.number, lifetime);
        }
      }
      if (lifetime.aborted) return;
      const ready = current.current.images.filter(
        (image) => added.some((item) => item.number === image.number) && image.stage === 'ready',
      ).length;
      const details = [
        `Browser supplied ${files.browserFileCount}. Added ${ready} to the draft. Terminal acknowledged 0.`,
        ...clipboardReadIssues(result),
      ];
      toast({ title: 'Clipboard images', description: details.join(' ') });
    };
    tail.current = tail.current.then(stage, stage);
  };
  const send = async (subscribed: boolean, writer: boolean) => {
    const previous = sending.current;
    const lifetime = scope.current?.signal;
    if (
      !projectId ||
      !lifetime ||
      lifetime.aborted ||
      !socket.connected ||
      !subscribed ||
      (previous && previous.state !== 'retryable')
    )
      return;
    if (previous && previous.connection !== socket.id) {
      updateAttempt({ ...previous, state: 'inspect' });
      return;
    }
    const batch = current.current;
    if (!batch.images.length || batch.images.some((i) => i.stage !== 'ready')) return;
    const input: FormSendInput = previous
      ? { ...previous.input, resume: true }
      : {
          kind: 'form-send',
          sessionId,
          projectId,
          sendId: createPasteRequestId(),
          resume: false,
          segments: formSegments(batch),
        };
    const active: Attempt = {
      input,
      connection: socket.id,
      state: 'sending',
      confirmed: previous?.confirmed ?? 0,
      acknowledgedImages: previous?.acknowledgedImages ?? 0,
    };
    updateAttempt(active);
    if (!previous && !writer) socket.emit('terminal:focus', { sessionId });
    const raw = await new Promise<unknown>((resolve) => {
      socket
        .timeout(formSendTimeoutMs(input.segments.length))
        .emit('terminal:input', input, (error: Error | null, ack: unknown) =>
          resolve(error ? null : ack),
        );
    }).catch(() => null);
    if (lifetime.aborted || sending.current !== active) return;
    const parsed = FormSendAckSchema.safeParse(raw);
    const ack = parsed.success && parsed.data.sendId === input.sendId ? parsed.data : null;
    if (
      !ack ||
      ack.confirmedSegments < active.confirmed ||
      ack.confirmedSegments > input.segments.length ||
      ack.acknowledgedImages !==
        input.segments.slice(0, ack.confirmedSegments).filter((s) => s.kind === 'image').length
    ) {
      updateAttempt({ ...active, state: 'inspect' });
      return;
    }
    if (ack.status === 'submitted' && ack.confirmedSegments === input.segments.length) {
      commit(emptyFormDraft());
      updateAttempt(null);
      toast({
        title: 'Draft sent',
        description: `Terminal acknowledged ${ack.acknowledgedImages} ${ack.acknowledgedImages === 1 ? 'image' : 'images'}.`,
      });
      textarea.current?.focus();
    } else if (ack.status === 'rejected' && ack.confirmedSegments === 0) {
      updateAttempt(null);
      toast({
        title: 'Draft retained',
        description: 'The terminal did not accept any segments. Review the draft and send again.',
        variant: 'destructive',
      });
    } else {
      updateAttempt({
        ...active,
        state: ack.status === 'retryable' ? 'retryable' : 'inspect',
        confirmed: ack.confirmedSegments,
        acknowledgedImages: ack.acknowledgedImages,
      });
    }
  };

  return {
    draft,
    attempt,
    paste,
    send,
    remove,
    edit: () => {
      if (sending.current?.state === 'retryable' && sending.current.confirmed === 0)
        updateAttempt(null);
    },
    retryUpload: (number: number) => {
      if (scope.current && !sending.current) void upload(number, scope.current.signal);
    },
    clear: () => {
      commit(emptyFormDraft());
      updateAttempt(null);
    },
    insertText: (text: string) => {
      if (sending.current) return false;
      replaceSelection(text);
      return true;
    },
    changeText: (el: HTMLTextAreaElement, selection?: FormEditSelection) => {
      if (sending.current || (!selection && el.value === current.current.text)) return;
      editRevision.current++;
      const next = editFormText(current.current, el.value, el.selectionStart, selection);
      for (const image of current.current.images)
        if (!next.draft.images.some((i) => i.number === image.number))
          uploads.current.get(image.number)?.abort();
      if (el.value !== next.draft.text || el.selectionStart !== next.caret) {
        flushSync(() => commit(next.draft));
        el.setSelectionRange(next.caret, next.caret);
      } else commit(next.draft);
    },
  };
}
