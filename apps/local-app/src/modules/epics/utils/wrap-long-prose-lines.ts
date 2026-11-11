import {
  CLIENT_READ_LINE_LIMIT_BYTES,
  MOVED_TEXT_THRESHOLD_BYTES,
} from '../../../common/constants/client-line-limits';

/** Any indent: a fence inside a list item can sit 4 or more columns deep. */
const FENCE_LINE = /^\s*(```|~~~)/;
/** A piece that starts like this would turn into a new Markdown block. */
const BLOCK_MARKER_START = /^(```|~~~|#|>|\||-|\*|\+|\d+\.)/;
const SENTENCE_END = new Set(['.', '?', '!', ';']);

/** Cumulative UTF-8 byte offsets: `offsets[i]` = bytes of `line.slice(0, i)`. */
function utf8Offsets(line: string): number[] {
  const offsets = new Array<number>(line.length + 1);
  offsets[0] = 0;
  for (let i = 0; i < line.length; i += 1) {
    const code = line.charCodeAt(i);
    let bytes: number;
    if (code < 0x80) bytes = 1;
    else if (code < 0x800) bytes = 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = line.charCodeAt(i + 1);
      // A valid pair counts 4 bytes on its high half; a lone surrogate encodes as U+FFFD.
      bytes = next >= 0xdc00 && next <= 0xdfff ? 4 : 3;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      const prev = line.charCodeAt(i - 1);
      bytes = prev >= 0xd800 && prev <= 0xdbff ? 0 : 3;
    } else bytes = 3;
    offsets[i + 1] = offsets[i] + bytes;
  }
  return offsets;
}

function isWrappableLine(line: string): boolean {
  const trimmed = line.trimStart();
  return !trimmed.startsWith('|') && !trimmed.startsWith('#');
}

/**
 * Returns the indexes of the spaces in `line` that become line breaks. Backtick
 * parity is counted from the line start, so a break never lands in an inline
 * code span, and every piece after a break starts like the same piece would
 * start on its own line — that keeps a second run a no-op.
 */
function chooseBreaks(line: string): number[] {
  const offsets = utf8Offsets(line);
  const candidates: number[] = [];
  let backticks = 0;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '`') {
      backticks += 1;
      continue;
    }
    if (
      ch === ' ' &&
      backticks % 2 === 0 &&
      i > 0 &&
      line[i - 1] !== ' ' &&
      i + 1 < line.length &&
      line[i + 1] !== ' ' &&
      line[i + 1] !== '\r' &&
      !BLOCK_MARKER_START.test(line.slice(i + 1, i + 12))
    ) {
      candidates.push(i);
    }
  }

  const breaks: number[] = [];
  let start = 0;
  let next = 0;
  while (offsets[line.length] - offsets[start] > MOVED_TEXT_THRESHOLD_BYTES) {
    while (next < candidates.length && candidates[next] <= start) next += 1;
    let chosen = -1;
    let sentence = -1;
    let k = next;
    for (; k < candidates.length; k += 1) {
      const at = candidates[k];
      if (offsets[at] - offsets[start] > MOVED_TEXT_THRESHOLD_BYTES) break;
      chosen = at;
      if (SENTENCE_END.has(line[at - 1])) sentence = at;
    }
    if (sentence !== -1) chosen = sentence;
    // A word or code span longer than the window stays whole: break at the first space after it.
    if (chosen === -1 && k < candidates.length) chosen = candidates[k];
    if (chosen === -1) break;
    breaks.push(chosen);
    start = chosen + 1;
  }
  return breaks;
}

/**
 * Breaks prose lines longer than {@link CLIENT_READ_LINE_LIMIT_BYTES} into pieces of
 * at most {@link MOVED_TEXT_THRESHOLD_BYTES}, preferably after a sentence end, by
 * replacing single spaces with `\n`. The result has the same length and the same
 * character offsets as the input. Fenced code, table rows, headings, lines in
 * `keepLines`, and lines without a usable space stay unchanged. Idempotent.
 */
export function wrapLongProseLines(text: string, keepLines?: ReadonlySet<string>): string {
  const lines = text.split('\n');
  let inFence = false;
  let changed = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (FENCE_LINE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || keepLines?.has(line) || !isWrappableLine(line)) continue;
    if (line.length <= CLIENT_READ_LINE_LIMIT_BYTES / 3) continue;
    if (Buffer.byteLength(line, 'utf8') <= CLIENT_READ_LINE_LIMIT_BYTES) continue;
    const breaks = chooseBreaks(line);
    if (breaks.length === 0) continue;
    const chars = line.split('');
    for (const at of breaks) chars[at] = '\n';
    lines[index] = chars.join('');
    changed = true;
  }
  return changed ? lines.join('\n') : text;
}
