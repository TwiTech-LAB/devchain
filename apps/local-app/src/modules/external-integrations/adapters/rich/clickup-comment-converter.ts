/**
 * Bidirectional ClickUp task-comment converter for ExternalRichDocumentV1,
 * using the provider's verified rich-write contract: a flat array of
 * `{ text, attributes }` segments where attributes carry `bold`, `italic`,
 * `code`, or `link`. Structural op types (tags, emoticons, checklists) and
 * multi-paragraph or hard-break content are outside the verified contract and
 * fail closed to read-only.
 */
import {
  canonicalizeRichDocument,
  isSafeRichLinkHref,
  RICH_COMMENT_MAX_SEGMENT_COUNT,
  type ExternalRichDocumentResult,
  type ExternalRichDocumentV1,
  type ExternalRichInline,
  type ExternalRichMark,
  type ExternalRichUnsupportedReason,
} from '../../models/external-rich-document';
import { isRecord } from '../vendor-shared';

export type CommentDeltaEmitResult =
  | { ok: true; delta: Array<Record<string, unknown>> }
  | { ok: false; reason: ExternalRichUnsupportedReason };

function parseAttributes(value: unknown): ExternalRichMark[] | null {
  if (value === undefined || value === null) {
    return [];
  }
  if (!isRecord(value)) {
    return null;
  }
  const marks: ExternalRichMark[] = [];
  for (const key of Object.keys(value)) {
    const flag = value[key];
    if (key === 'bold' || key === 'italic' || key === 'code') {
      if (flag !== true) {
        return null;
      }
      marks.push({ type: key });
      continue;
    }
    if (key === 'link') {
      if (typeof flag !== 'string' || !isSafeRichLinkHref(flag)) {
        return null;
      }
      marks.push({ type: 'link', href: flag });
      continue;
    }
    return null;
  }
  return marks;
}

/** Provider comment delta → canonical. The verified contract reads the rich
 * body from task-comment pages; anything beyond flat text segments stays
 * read-only with the existing plain-text projection as fallback. */
export function clickupCommentDeltaToRichDocument(value: unknown): ExternalRichDocumentResult {
  if (!Array.isArray(value)) {
    return { supported: false, reason: 'invalid_input' };
  }
  if (value.length === 0 || value.length > RICH_COMMENT_MAX_SEGMENT_COUNT) {
    return { supported: false, reason: value.length === 0 ? 'invalid_input' : 'limit_exceeded' };
  }
  const inline: ExternalRichInline[] = [];
  for (const segment of value) {
    if (!isRecord(segment) || typeof segment.text !== 'string') {
      return { supported: false, reason: 'unsupported_node' };
    }
    // Provider op types like tags and emoticons are structural rich content
    // outside the verified editing set.
    if (segment.type !== undefined) {
      return { supported: false, reason: 'unsupported_node' };
    }
    const marks = parseAttributes(segment.attributes);
    if (marks === null) {
      return { supported: false, reason: 'unsupported_mark' };
    }
    inline.push({ type: 'text', text: segment.text, marks });
  }
  const canonical = canonicalizeRichDocument({
    version: 1,
    blocks: [{ type: 'paragraph', content: inline }],
  });
  return canonical === null
    ? { supported: false, reason: 'limit_exceeded' }
    : { supported: true, document: canonical };
}

/** Canonical → provider comment delta. Only a single paragraph without hard
 * breaks matches the verified flat-segment contract. */
export function richDocumentToClickUpCommentDelta(
  document: ExternalRichDocumentV1,
): CommentDeltaEmitResult {
  const canonical = canonicalizeRichDocument(document);
  if (canonical === null) {
    return { ok: false, reason: 'limit_exceeded' };
  }
  if (canonical.blocks.length !== 1 || canonical.blocks[0]!.type !== 'paragraph') {
    return { ok: false, reason: 'unsupported_node' };
  }
  const segments: Array<Record<string, unknown>> = [];
  for (const run of canonical.blocks[0]!.content) {
    if (run.type === 'hardBreak') {
      return { ok: false, reason: 'unsupported_node' };
    }
    if (run.marks.length === 0) {
      segments.push({ text: run.text });
      continue;
    }
    const attributes: Record<string, unknown> = {};
    for (const mark of run.marks) {
      if (mark.type === 'link') {
        attributes.link = mark.href;
      } else {
        attributes[mark.type] = true;
      }
    }
    segments.push({ text: run.text, attributes });
  }
  if (segments.length === 0 || segments.length > RICH_COMMENT_MAX_SEGMENT_COUNT) {
    return { ok: false, reason: segments.length === 0 ? 'invalid_input' : 'limit_exceeded' };
  }
  return { ok: true, delta: segments };
}
