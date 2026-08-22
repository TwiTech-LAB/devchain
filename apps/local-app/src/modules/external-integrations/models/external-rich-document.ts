/**
 * ExternalRichDocumentV1: the closed, versioned canonical rich-document model
 * shared by every provider converter. Membership mirrors exactly the nodes and
 * marks verified by live provider probes — anything a provider can emit that
 * this schema cannot represent must surface as `supported: false` so the whole
 * document stays read-only instead of being silently lossy.
 */

export const RICH_DOCUMENT_VERSION = 1;

export const RICH_MAX_DEPTH = 16;
export const RICH_MAX_BLOCK_COUNT = 1_000;
export const RICH_MAX_NODE_COUNT = 10_000;
export const RICH_MAX_TEXT_RUN_LENGTH = 8_000;
export const RICH_MAX_TOTAL_TEXT_LENGTH = 65_536;
export const RICH_COMMENT_MAX_SEGMENT_COUNT = 1_000;

export type ExternalRichMark =
  | { type: 'bold' }
  | { type: 'italic' }
  | { type: 'code' }
  | { type: 'link'; href: string };

export interface ExternalRichTextRun {
  type: 'text';
  text: string;
  marks: ExternalRichMark[];
}

export interface ExternalRichHardBreak {
  type: 'hardBreak';
}

export type ExternalRichInline = ExternalRichTextRun | ExternalRichHardBreak;

export interface ExternalRichParagraph {
  type: 'paragraph';
  content: ExternalRichInline[];
}

export interface ExternalRichHeading {
  type: 'heading';
  level: 1 | 2 | 3 | 4 | 5 | 6;
  content: ExternalRichInline[];
}

export interface ExternalRichBulletList {
  type: 'bulletList';
  items: ExternalRichInline[][];
}

/** Blockquotes hold paragraphs only; other providers shapes are unverified. */
export interface ExternalRichBlockquote {
  type: 'blockquote';
  paragraphs: ExternalRichInline[][];
}

export type ExternalRichBlock =
  | ExternalRichParagraph
  | ExternalRichHeading
  | ExternalRichBulletList
  | ExternalRichBlockquote;

export interface ExternalRichDocumentV1 {
  version: typeof RICH_DOCUMENT_VERSION;
  blocks: ExternalRichBlock[];
}

export type ExternalRichUnsupportedReason =
  | 'unsupported_node'
  | 'unsupported_mark'
  | 'limit_exceeded'
  | 'invalid_input';

export type ExternalRichDocumentResult =
  | { supported: true; document: ExternalRichDocumentV1 }
  | { supported: false; reason: ExternalRichUnsupportedReason };

const MARK_TYPE_ORDER: Record<ExternalRichMark['type'], number> = {
  bold: 0,
  italic: 1,
  code: 2,
  link: 3,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Content links accept http(s) URLs with a hostname and no credentials.
 * Everything else (javascript:, data:, relative, userinfo) fails closed.
 */
export function isSafeRichLinkHref(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim()) {
    return false;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    (url.protocol === 'https:' || url.protocol === 'http:') &&
    url.hostname !== '' &&
    url.username === '' &&
    url.password === ''
  );
}

function markCompare(left: ExternalRichMark, right: ExternalRichMark): number {
  const leftKey = MARK_TYPE_ORDER[left.type];
  const rightKey = MARK_TYPE_ORDER[right.type];
  if (leftKey !== rightKey) {
    return leftKey - rightKey;
  }
  return left.type === 'link' && right.type === 'link'
    ? left.href < right.href
      ? -1
      : left.href > right.href
        ? 1
        : 0
    : 0;
}

function markEqual(left: ExternalRichMark, right: ExternalRichMark): boolean {
  if (left.type !== right.type) {
    return false;
  }
  return left.type === 'link' && right.type === 'link' ? left.href === right.href : true;
}

function normalizeMarks(value: unknown): ExternalRichMark[] | null {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    return null;
  }
  const marks: ExternalRichMark[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.type !== 'string') {
      return null;
    }
    if (item.type === 'bold' || item.type === 'italic' || item.type === 'code') {
      marks.push({ type: item.type });
      continue;
    }
    if (item.type === 'link') {
      const href = item.href;
      if (!isSafeRichLinkHref(href)) {
        return null;
      }
      marks.push({ type: 'link', href });
      continue;
    }
    return null;
  }
  const deduped: ExternalRichMark[] = [];
  for (const mark of marks) {
    if (!deduped.some((existing) => markEqual(existing, mark))) {
      deduped.push(mark);
    }
  }
  return deduped.sort(markCompare);
}

interface NormalizationLimits {
  nodes: number;
  totalText: number;
}

function normalizeInline(value: unknown, limits: NormalizationLimits): ExternalRichInline[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const runs: ExternalRichInline[] = [];
  const pushText = (text: string, marks: ExternalRichMark[]): void => {
    // Adjacent runs with equal mark sets are one run; providers legitimately
    // split or pad them and only the merged form is canonical.
    const previous = runs[runs.length - 1];
    if (
      previous !== undefined &&
      previous.type === 'text' &&
      previous.marks.length === marks.length &&
      previous.marks.every((mark, index) => markEqual(mark, marks[index]!))
    ) {
      const merged = `${previous.text}${text}`.replace(/\s+/g, ' ');
      runs[runs.length - 1] = { type: 'text', text: merged, marks };
      return;
    }
    runs.push({ type: 'text', text, marks });
  };

  for (const item of value) {
    limits.nodes += 1;
    if (limits.nodes > RICH_MAX_NODE_COUNT) {
      return null;
    }
    if (isRecord(item) && item.type === 'hardBreak') {
      runs.push({ type: 'hardBreak' });
      continue;
    }
    if (!isRecord(item) || item.type !== 'text' || typeof item.text !== 'string') {
      return null;
    }
    const marks = normalizeMarks(item.marks);
    if (marks === null) {
      return null;
    }
    const collapsed = item.text.replace(/\s+/g, ' ');
    limits.totalText += collapsed.length;
    if (
      collapsed.trim().length > RICH_MAX_TEXT_RUN_LENGTH ||
      limits.totalText > RICH_MAX_TOTAL_TEXT_LENGTH
    ) {
      return null;
    }
    // A spaces-only run between differently-marked runs is a meaningful word
    // boundary; block edges trim it away afterwards.
    if (collapsed !== '') {
      pushText(collapsed, marks);
    }
  }

  // Insignificant edge whitespace: trim the start of the first text run and
  // the end of the last one; interior single boundary spaces stay meaningful.
  const first = runs[0];
  if (first !== undefined && first.type === 'text') {
    runs[0] = { ...first, text: first.text.replace(/^ +/, '') };
  }
  const last = runs[runs.length - 1];
  if (last !== undefined && last.type === 'text') {
    runs[runs.length - 1] = { ...last, text: last.text.replace(/ +$/, '') };
  }
  return runs.filter((run) => run.type !== 'text' || run.text !== '');
}

function normalizeInlineList(
  value: unknown,
  limits: NormalizationLimits,
): ExternalRichInline[][] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const items: ExternalRichInline[][] = [];
  for (const item of value) {
    const inline = normalizeInline(item, limits);
    if (inline === null) {
      return null;
    }
    items.push(inline);
  }
  return items;
}

function normalizeBlock(
  value: unknown,
  depth: number,
  limits: NormalizationLimits,
): ExternalRichBlock | null {
  if (depth > RICH_MAX_DEPTH) {
    return null;
  }
  if (!isRecord(value) || typeof value.type !== 'string') {
    return null;
  }
  limits.nodes += 1;
  if (limits.nodes > RICH_MAX_NODE_COUNT) {
    return null;
  }
  switch (value.type) {
    case 'paragraph': {
      const content = normalizeInline(value.content, limits);
      return content === null || content.length === 0 ? null : { type: 'paragraph', content };
    }
    case 'heading': {
      const level = value.level;
      if (typeof level !== 'number' || !Number.isInteger(level) || level < 1 || level > 6) {
        return null;
      }
      const content = normalizeInline(value.content, limits);
      return content === null || content.length === 0
        ? null
        : { type: 'heading', level: level as 1 | 2 | 3 | 4 | 5 | 6, content };
    }
    case 'bulletList': {
      const items = normalizeInlineList(value.items, limits);
      return items === null || items.length === 0 ? null : { type: 'bulletList', items };
    }
    case 'blockquote': {
      if (!Array.isArray(value.paragraphs)) {
        return null;
      }
      const paragraphs: ExternalRichInline[][] = [];
      for (const paragraph of value.paragraphs) {
        const inline = normalizeInline(paragraph, limits);
        if (inline === null || inline.length === 0) {
          return null;
        }
        paragraphs.push(inline);
      }
      return paragraphs.length === 0 ? null : { type: 'blockquote', paragraphs };
    }
    default:
      return null;
  }
}

/**
 * Validates an arbitrary value against the closed V1 schema and returns the
 * canonical form: mark runs merged, marks deduplicated and order-normalized,
 * whitespace collapsed, empty edges trimmed, limits enforced. Returns null for
 * anything outside the closed set or over limit.
 */
export function canonicalizeRichDocument(value: unknown): ExternalRichDocumentV1 | null {
  if (!isRecord(value) || value.version !== RICH_DOCUMENT_VERSION || !Array.isArray(value.blocks)) {
    return null;
  }
  if (value.blocks.length > RICH_MAX_BLOCK_COUNT) {
    return null;
  }
  const limits: NormalizationLimits = { nodes: 0, totalText: 0 };
  const blocks: ExternalRichBlock[] = [];
  for (const block of value.blocks) {
    const normalized = normalizeBlock(block, 1, limits);
    if (normalized === null) {
      return null;
    }
    blocks.push(normalized);
  }
  if (blocks.length === 0) {
    return null;
  }
  return { version: RICH_DOCUMENT_VERSION, blocks };
}

/** Deterministic semantic fingerprint of the canonical form. Two documents
 * with equal fingerprints are semantically interchangeable for every
 * provider converter, regardless of raw provider string differences. */
export function richDocumentFingerprint(document: ExternalRichDocumentV1): string | null {
  const canonical = canonicalizeRichDocument(document);
  return canonical === null ? null : JSON.stringify(canonical);
}
