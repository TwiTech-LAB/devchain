/**
 * Bidirectional ClickUp Markdown description converter for
 * ExternalRichDocumentV1, scoped to the provider's verified markdown output:
 * ATX headings, emphasis, inline code, links, `-`/`*` bullets, and quote
 * lines. Anything else the provider can emit (ordered lists, fenced or
 * indented code blocks, nested structures, hard breaks) fails the whole
 * document closed to read-only instead of guessing a lossy mapping.
 */
import {
  canonicalizeRichDocument,
  isSafeRichLinkHref,
  RICH_MAX_BLOCK_COUNT,
  type ExternalRichBlock,
  type ExternalRichDocumentResult,
  type ExternalRichDocumentV1,
  type ExternalRichInline,
  type ExternalRichMark,
  type ExternalRichUnsupportedReason,
} from '../../models/external-rich-document';

export type MarkdownEmitResult =
  | { ok: true; markdown: string }
  | { ok: false; reason: ExternalRichUnsupportedReason };

const BULLET_LINE = /^[-*+]\s+/;
const ORDERED_LINE = /^\d+[.)]\s+/;
const HEADING_LINE = /^(#{1,6})\s+(.*)$/;
const QUOTE_LINE = /^>\s?/;
/** Four-plus spaces or a tab start an indented code block in markdown; that
 * block type is unverified, so the document stays read-only. */
const INDENTED_LINE = /^(?: {4,}|\t)/;
/** Fenced code blocks are likewise outside the verified set. */
const FENCE_LINE = /^\s*(?:```|~~~)/;

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ');
}

interface InlineOutput {
  inline: ExternalRichInline[];
  reason?: ExternalRichUnsupportedReason;
}

/**
 * Parses the provider's inline markdown subset: backslash escapes, `**bold**`,
 * `_italic_`/`*italic*` (word-boundary guarded so literal `snake_case` text
 * stays plain), `` `code` ``, and `[text](https://…)`. Unbalanced markers
 * stay literal text; nesting emphasis inside emphasis is not parsed because
 * the provider never emits it.
 */
export function parseMarkdownInline(line: string): InlineOutput {
  const runs: ExternalRichInline[] = [];
  let plain = '';
  const flush = (marks: ExternalRichMark[]): void => {
    if (plain) {
      runs.push({ type: 'text', text: normalizeWhitespace(plain), marks });
      plain = '';
    }
  };
  const atWordStart = (): boolean => plain === '' || /\s$/.test(plain);
  const closesAtWordEnd = (closingIndex: number): boolean => {
    const after = line[closingIndex + 1];
    return after === undefined || /\s/.test(after) || /[.,;:!?)\]}'"]/.test(after);
  };

  let index = 0;
  while (index < line.length) {
    const char = line[index]!;
    if (char === '\\') {
      const next = line[index + 1];
      if (next !== undefined) {
        plain += next;
        index += 2;
        continue;
      }
      plain += char;
      index += 1;
      continue;
    }
    if (char === '`') {
      const closing = line.indexOf('`', index + 1);
      if (closing > index) {
        const code = line.slice(index + 1, closing);
        if (code.trim()) {
          flush([]);
          runs.push({ type: 'text', text: normalizeWhitespace(code), marks: [{ type: 'code' }] });
          index = closing + 1;
          continue;
        }
      }
      plain += char;
      index += 1;
      continue;
    }
    if (char === '*') {
      if (line.startsWith('**', index)) {
        const closing = line.indexOf('**', index + 2);
        if (closing > index) {
          const content = line.slice(index + 2, closing);
          if (content.trim()) {
            flush([]);
            runs.push({
              type: 'text',
              text: normalizeWhitespace(content),
              marks: [{ type: 'bold' }],
            });
            index = closing + 2;
            continue;
          }
        }
      }
      const singleClosing = line.indexOf('*', index + 1);
      if (
        singleClosing > index &&
        !line.startsWith('**', index + 1) &&
        closesAtWordEnd(singleClosing)
      ) {
        const content = line.slice(index + 1, singleClosing);
        if (content.trim()) {
          flush([]);
          runs.push({
            type: 'text',
            text: normalizeWhitespace(content),
            marks: [{ type: 'italic' }],
          });
          index = singleClosing + 1;
          continue;
        }
      }
      plain += char;
      index += 1;
      continue;
    }
    if (char === '_') {
      const closing = line.indexOf('_', index + 1);
      if (closing > index && atWordStart() && closesAtWordEnd(closing)) {
        const content = line.slice(index + 1, closing);
        if (content.trim()) {
          flush([]);
          runs.push({
            type: 'text',
            text: normalizeWhitespace(content),
            marks: [{ type: 'italic' }],
          });
          index = closing + 1;
          continue;
        }
      }
      plain += char;
      index += 1;
      continue;
    }
    if (char === '[') {
      const textClose = line.indexOf(']', index + 1);
      const hrefOpen = textClose >= 0 ? line.indexOf('](', textClose) : -1;
      const hrefClose = hrefOpen >= 0 ? line.indexOf(')', hrefOpen + 2) : -1;
      if (textClose > index && hrefOpen === textClose && hrefClose > hrefOpen + 1) {
        const text = line.slice(index + 1, textClose);
        const href = line.slice(hrefOpen + 2, hrefClose);
        if (isSafeRichLinkHref(href)) {
          flush([]);
          runs.push({
            type: 'text',
            text: normalizeWhitespace(text),
            marks: [{ type: 'link', href }],
          });
          index = hrefClose + 1;
          continue;
        }
        return { inline: [], reason: 'unsupported_mark' };
      }
      plain += char;
      index += 1;
      continue;
    }
    plain += char;
    index += 1;
  }
  flush([]);
  return { inline: runs };
}

function startsNewBlock(line: string): boolean {
  const trimmed = line.trim();
  const leftTrimmed = line.trimStart();
  return (
    trimmed === '' ||
    HEADING_LINE.test(trimmed) ||
    BULLET_LINE.test(leftTrimmed) ||
    ORDERED_LINE.test(leftTrimmed) ||
    QUOTE_LINE.test(leftTrimmed) ||
    INDENTED_LINE.test(line) ||
    FENCE_LINE.test(line)
  );
}

/** Provider markdown output → canonical. Ambiguous or unsupported structure
 * (ordered lists, code blocks, indentation) yields `supported: false`. */
export function markdownToRichDocument(value: unknown): ExternalRichDocumentResult {
  if (typeof value !== 'string') {
    return { supported: false, reason: 'invalid_input' };
  }
  const lines = value.split(/\r?\n/);
  const blocks: ExternalRichBlock[] = [];
  let index = 0;

  const pushInlineBlock = (
    inline: ExternalRichInline[],
    make: (content: ExternalRichInline[]) => ExternalRichBlock,
    reason?: ExternalRichUnsupportedReason,
  ): ExternalRichUnsupportedReason | null => {
    if (reason) {
      return reason;
    }
    if (inline.length > 0) {
      blocks.push(make(inline));
    }
    return null;
  };

  while (index < lines.length) {
    const line = lines[index]!;
    if (line.trim() === '') {
      index += 1;
      continue;
    }
    if (ORDERED_LINE.test(line.trimStart())) {
      // Could be a real provider ordered list; that node is not in the
      // verified set, so the whole document stays read-only.
      return { supported: false, reason: 'unsupported_node' };
    }
    if (FENCE_LINE.test(line)) {
      return { supported: false, reason: 'unsupported_node' };
    }
    if (INDENTED_LINE.test(line)) {
      return { supported: false, reason: 'unsupported_node' };
    }
    const heading = HEADING_LINE.exec(line.trim());
    if (heading) {
      const parsed = parseMarkdownInline(heading[2]!);
      const failure = pushInlineBlock(
        parsed.inline,
        (content) => ({ type: 'heading', level: heading[1]!.length, content }) as ExternalRichBlock,
        parsed.reason,
      );
      if (failure) {
        return { supported: false, reason: failure };
      }
      index += 1;
      continue;
    }
    if (BULLET_LINE.test(line.trimStart())) {
      // An indented bullet implies nesting; nested lists are unverified.
      if (line !== line.trimStart()) {
        return { supported: false, reason: 'unsupported_node' };
      }
      const items: ExternalRichInline[][] = [];
      while (index < lines.length) {
        const bulletLine = lines[index]!;
        const match = /^[-*+]\s+(.*)$/.exec(bulletLine);
        if (!match) {
          break;
        }
        const parsed = parseMarkdownInline(match[1]!);
        if (parsed.reason) {
          return { supported: false, reason: parsed.reason };
        }
        if (parsed.inline.length === 0) {
          return { supported: false, reason: 'invalid_input' };
        }
        items.push(parsed.inline);
        index += 1;
      }
      if (items.length > 0) {
        blocks.push({ type: 'bulletList', items });
      }
      continue;
    }
    if (QUOTE_LINE.test(line.trimStart())) {
      if (line !== line.trimStart()) {
        return { supported: false, reason: 'unsupported_node' };
      }
      const quoteLines: string[] = [];
      while (index < lines.length) {
        const quoteLine = lines[index]!;
        const match = /^>\s?(.*)$/.exec(quoteLine);
        if (!match) {
          break;
        }
        if (match[1]!.trim()) {
          quoteLines.push(match[1]!);
        }
        index += 1;
      }
      if (quoteLines.length > 0) {
        const parsed = parseMarkdownInline(quoteLines.join(' '));
        if (parsed.reason) {
          return { supported: false, reason: parsed.reason };
        }
        if (parsed.inline.length === 0) {
          return { supported: false, reason: 'invalid_input' };
        }
        blocks.push({ type: 'blockquote', paragraphs: [parsed.inline] });
      }
      continue;
    }
    const paragraphLines: string[] = [];
    while (index < lines.length && !startsNewBlock(lines[index]!)) {
      paragraphLines.push(lines[index]!.trim());
      index += 1;
    }
    if (paragraphLines.length === 0) {
      // Defensive: the line matched a structural pattern handled above.
      return { supported: false, reason: 'unsupported_node' };
    }
    const parsed = parseMarkdownInline(paragraphLines.join(' '));
    const failure = pushInlineBlock(
      parsed.inline,
      (content) => ({ type: 'paragraph', content }),
      parsed.reason,
    );
    if (failure) {
      return { supported: false, reason: failure };
    }
  }

  if (blocks.length === 0 || blocks.length > RICH_MAX_BLOCK_COUNT) {
    return { supported: false, reason: blocks.length === 0 ? 'invalid_input' : 'limit_exceeded' };
  }
  const canonical = canonicalizeRichDocument({ version: 1, blocks });
  return canonical === null
    ? { supported: false, reason: 'limit_exceeded' }
    : { supported: true, document: canonical };
}

const ESCAPED_CHARACTERS = new Set(['\\', '`', '*', '_', '[', ']', '<', '>', '#', '-', '+']);

function escapeMarkdownText(text: string): string {
  let out = '';
  for (const char of text) {
    if (ESCAPED_CHARACTERS.has(char)) {
      out += `\\${char}`;
    } else {
      out += char;
    }
  }
  // Text that reads like an ordered list must not become one on re-parse;
  // digits cannot be escaped, but the following punctuation can.
  out = out.replace(/^(\d+)([.)])/, '$1\\$2');
  return out;
}

function emitRun(run: ExternalRichInline): string | null {
  if (run.type === 'hardBreak') {
    // No verified markdown representation exists for hard breaks.
    return null;
  }
  if (run.marks.some((mark) => mark.type === 'code') && run.marks.length > 1) {
    return null;
  }
  const hasLink = run.marks.some((mark) => mark.type === 'link');
  if (hasLink && run.marks.length > 1) {
    return null;
  }
  const isCode = run.marks.some((mark) => mark.type === 'code');
  // ClickUp re-emits backticks inside code spans as escaped plain text, so a
  // code run containing a backtick cannot round-trip; it stays read-only.
  if (isCode && run.text.includes('`')) {
    return null;
  }
  const escaped = escapeMarkdownText(run.text);
  let wrapped = escaped;
  for (const mark of run.marks) {
    switch (mark.type) {
      case 'bold':
        wrapped = `**${wrapped}**`;
        break;
      case 'italic':
        wrapped = `_${wrapped}_`;
        break;
      case 'code':
        wrapped = `\`${escaped}\``;
        break;
      case 'link':
        wrapped = `[${escaped}](${mark.href})`;
        break;
    }
  }
  return wrapped;
}

function emitInline(inline: ExternalRichInline[]): string | null {
  const parts: string[] = [];
  for (const run of inline) {
    const emitted = emitRun(run);
    if (emitted === null) {
      return null;
    }
    parts.push(emitted);
  }
  return parts.join('');
}

/** Canonical → provider markdown. Fails closed for content the verified
 * markdown contract cannot carry (hard breaks, stacked marks on code or link
 * runs, multi-paragraph quotes). */
export function richDocumentToMarkdown(document: ExternalRichDocumentV1): MarkdownEmitResult {
  const canonical = canonicalizeRichDocument(document);
  if (canonical === null) {
    return { ok: false, reason: 'limit_exceeded' };
  }
  // Blocks separate with a blank line; bullet items of one list stay joined
  // by single newlines, or re-parse would split them into separate lists.
  const blockChunks: string[] = [];
  for (const block of canonical.blocks) {
    switch (block.type) {
      case 'paragraph': {
        const emitted = emitInline(block.content);
        if (emitted === null) {
          return { ok: false, reason: 'unsupported_mark' };
        }
        blockChunks.push(emitted);
        break;
      }
      case 'heading': {
        const emitted = emitInline(block.content);
        if (emitted === null) {
          return { ok: false, reason: 'unsupported_mark' };
        }
        blockChunks.push(`${'#'.repeat(block.level)} ${emitted}`);
        break;
      }
      case 'bulletList': {
        const itemLines: string[] = [];
        for (const item of block.items) {
          const emitted = emitInline(item);
          if (emitted === null) {
            return { ok: false, reason: 'unsupported_mark' };
          }
          itemLines.push(`- ${emitted}`);
        }
        blockChunks.push(itemLines.join('\n'));
        break;
      }
      case 'blockquote': {
        // Only a single-paragraph quote round-trips: consecutive quote lines
        // re-parse as one paragraph, so extra paragraphs would fuse.
        if (block.paragraphs.length !== 1) {
          return { ok: false, reason: 'unsupported_node' };
        }
        const emitted = emitInline(block.paragraphs[0]!);
        if (emitted === null) {
          return { ok: false, reason: 'unsupported_mark' };
        }
        blockChunks.push(`> ${emitted}`);
        break;
      }
    }
  }
  if (blockChunks.length === 0) {
    return { ok: false, reason: 'invalid_input' };
  }
  return { ok: true, markdown: blockChunks.join('\n\n') };
}
