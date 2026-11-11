import {
  DescriptionEditAmbiguousError,
  DescriptionEditNotFoundError,
} from '../../../common/errors/error-types';

/** One literal find/replace instruction for an epic description. */
export interface EpicDescriptionEdit {
  find: string;
  replace: string;
}

/** Context around one applied edit, taken from the final description text. */
export interface AppliedEpicDescriptionEdit {
  index: number;
  context: string;
}

export interface EpicDescriptionEditOutcome {
  /** Final description text after all edits and the optional append. */
  text: string;
  /** One entry per edit, in order; contexts are windows into the final text. */
  descriptionEdits?: AppliedEpicDescriptionEdit[];
  /** Present when an append ran. */
  appended?: { context: string };
  /** Length of the final description text. */
  descriptionLength: number;
}

const EDIT_CONTEXT_RADIUS = 80;
const APPEND_CONTEXT_PREFIX_LIMIT = 160;
const APPEND_CONTEXT_TOTAL_LIMIT = 400;

interface Span {
  start: number;
  end: number;
}

/**
 * Counts occurrences of `find` in `text`, including overlapping ones
 * ("aa" occurs twice in "aaa"). An empty `find` counts as no match.
 */
function countOccurrences(text: string, find: string): number {
  if (find.length === 0) {
    return 0;
  }
  let count = 0;
  let pos = text.indexOf(find);
  while (pos !== -1) {
    count += 1;
    pos = text.indexOf(find, pos + 1);
  }
  return count;
}

/**
 * Repositions `span` after the region [regionStart, regionEnd) was replaced by
 * a string of `replacementLength` characters: spans after the region shift by
 * the length delta, spans before it stay, and overlapping spans expand to the
 * union so the context keeps covering the whole replaced text.
 */
function shiftSpan(
  span: Span,
  regionStart: number,
  regionEnd: number,
  replacementLength: number,
): Span {
  const delta = replacementLength - (regionEnd - regionStart);
  if (span.start >= regionEnd) {
    return { start: span.start + delta, end: span.end + delta };
  }
  if (span.end <= regionStart) {
    return span;
  }
  return {
    start: Math.min(span.start, regionStart),
    end: Math.max(span.end, regionEnd) + delta,
  };
}

function buildEditContext(finalText: string, span: Span): string {
  const beforeStart = Math.max(0, span.start - EDIT_CONTEXT_RADIUS);
  const afterEnd = Math.min(finalText.length, span.end + EDIT_CONTEXT_RADIUS);
  const leading = beforeStart > 0 ? '…' : '';
  const trailing = afterEnd < finalText.length ? '…' : '';
  return leading + finalText.slice(beforeStart, afterEnd) + trailing;
}

/** The appended text with up to the last 160 characters before it, as a window into `finalText`. */
function buildAppendContext(finalText: string, textBeforeAppendLength: number): string {
  const start = Math.max(0, textBeforeAppendLength - APPEND_CONTEXT_PREFIX_LIMIT);
  return finalText.slice(start, start + APPEND_CONTEXT_TOTAL_LIMIT);
}

/**
 * Applies literal description edits and an optional append as one atomic text
 * transformation. Each `find` must occur exactly once (overlapping occurrences
 * count) in the text as it stands at that edit's turn; otherwise a domain
 * error is thrown and no partial result escapes — callers keep their original
 * text. `replace` is spliced in literally, so `$&`, `$1`, and `$$` carry no
 * special meaning.
 *
 * `finalize` runs once on the final text, after all edits and the append, and
 * must keep its length and offsets (for example by swapping one character for
 * another); the contexts are taken from its result.
 */
export function applyEpicDescriptionEdits(input: {
  text: string | null;
  edits?: EpicDescriptionEdit[];
  append?: string;
  finalize?: (text: string) => string;
}): EpicDescriptionEditOutcome {
  let text = input.text ?? '';
  const spans: Span[] = [];

  const edits = input.edits ?? [];
  for (let index = 0; index < edits.length; index += 1) {
    const edit = edits[index];
    const matchCount = countOccurrences(text, edit.find);
    if (matchCount === 0) {
      throw new DescriptionEditNotFoundError(index, edit.find, matchCount);
    }
    if (matchCount > 1) {
      throw new DescriptionEditAmbiguousError(index, edit.find, matchCount);
    }
    const start = text.indexOf(edit.find);
    const end = start + edit.find.length;
    for (let i = 0; i < spans.length; i += 1) {
      spans[i] = shiftSpan(spans[i], start, end, edit.replace.length);
    }
    spans.push({ start, end: start + edit.replace.length });
    text = text.slice(0, start) + edit.replace + text.slice(end);
  }

  let textBeforeAppendLength: number | undefined;
  if (input.append !== undefined) {
    textBeforeAppendLength = text.length;
    text = text.length > 0 ? `${text}\n\n${input.append}` : input.append;
  }

  if (input.finalize) {
    const finalized = input.finalize(text);
    if (finalized.length !== text.length) {
      throw new Error('finalize must keep the description length.');
    }
    text = finalized;
  }

  const appended =
    textBeforeAppendLength !== undefined
      ? { context: buildAppendContext(text, textBeforeAppendLength) }
      : undefined;

  return {
    text,
    descriptionEdits:
      spans.length > 0
        ? spans.map((span, index) => ({ index, context: buildEditContext(text, span) }))
        : undefined,
    appended,
    descriptionLength: text.length,
  };
}
