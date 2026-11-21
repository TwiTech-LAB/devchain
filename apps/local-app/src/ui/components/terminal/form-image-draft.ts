import type { FormSegment } from '@/modules/terminal/dtos/ws-envelope.dto';

export interface DraftImage {
  number: number;
  start: number;
  file: File;
  stage: 'checking' | 'uploading' | 'failed' | 'ready';
  attachmentId?: string;
}

export interface FormDraft {
  text: string;
  images: DraftImage[];
}

export const emptyFormDraft = (): FormDraft => ({ text: '', images: [] });
export const imageLabel = (number: number) => `[Image ${number}]`;
const imageEnd = (image: DraftImage) => image.start + imageLabel(image.number).length;

export function replaceFormRange(
  draft: FormDraft,
  start: number,
  end: number,
  text: string,
  added: DraftImage[] = [],
) {
  for (const image of draft.images) {
    const after = imageEnd(image);
    if (start === end && start > image.start && start < after) {
      start = end = after;
    } else if (start < after && end > image.start) {
      start = Math.min(start, image.start);
      end = Math.max(end, after);
    }
  }
  const delta = text.length - (end - start);
  const images = [
    ...draft.images.filter((image) => imageEnd(image) <= start),
    ...added.map((image) => ({ ...image, start: start + image.start })),
    ...draft.images
      .filter((image) => image.start >= end)
      .map((image) => ({ ...image, start: image.start + delta })),
  ];
  return {
    draft: { text: draft.text.slice(0, start) + text + draft.text.slice(end), images },
    caret: start + text.length,
    start,
    end,
  };
}

export interface FormEditSelection {
  text: string;
  start: number;
  end: number;
}

export function editFormText(
  draft: FormDraft,
  value: string,
  caret: number,
  selection?: FormEditSelection,
) {
  if (!draft.images.length) return { draft: { text: value, images: [] }, caret };
  let oldEnd = caret + draft.text.length - value.length;
  let newEnd = caret;
  if (
    selection &&
    selection.text === draft.text &&
    selection.end === oldEnd &&
    selection.start <= caret &&
    value.startsWith(draft.text.slice(0, selection.start)) &&
    value.slice(caret) === draft.text.slice(oldEnd)
  ) {
    return replaceFormRange(
      draft,
      selection.start,
      selection.end,
      value.slice(selection.start, caret),
    );
  }
  if (oldEnd < 0 || oldEnd > draft.text.length || draft.text.slice(oldEnd) !== value.slice(caret)) {
    oldEnd = draft.text.length;
    newEnd = value.length;
    while (oldEnd > 0 && newEnd > 0 && draft.text[oldEnd - 1] === value[newEnd - 1]) {
      oldEnd--;
      newEnd--;
    }
  }
  let start = 0;
  while (start < oldEnd && start < newEnd && draft.text[start] === value[start]) start++;
  // Without a pre-edit range, preserve the visible replacement if it consumes a marker's end.
  if (start < newEnd && start < oldEnd) {
    const marker = draft.images.find(
      (image) => image.start < start && start < imageEnd(image) && imageEnd(image) <= oldEnd,
    );
    if (marker) start = marker.start;
  }
  return replaceFormRange(draft, start, oldEnd, value.slice(start, newEnd));
}

export function formSegments(draft: FormDraft): FormSegment[] {
  const segments: FormSegment[] = [];
  let start = 0;
  for (const image of draft.images) {
    if (!image.attachmentId || image.stage !== 'ready')
      throw new Error('An attachment is not ready.');
    if (start < image.start)
      segments.push({ kind: 'text', text: draft.text.slice(start, image.start) });
    segments.push({ kind: 'image', attachmentId: image.attachmentId });
    start = imageEnd(image);
  }
  if (start < draft.text.length) segments.push({ kind: 'text', text: draft.text.slice(start) });
  return segments;
}
