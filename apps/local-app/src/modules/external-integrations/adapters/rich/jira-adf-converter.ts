/**
 * Bidirectional Jira ADF converter for ExternalRichDocumentV1. The accepted
 * ADF node and mark set is exactly what live probes verified; any other node
 * (tables, media, panels, extensions, ordered or nested lists, unknown marks)
 * fails the whole document closed to read-only.
 */
import {
  canonicalizeRichDocument,
  isSafeRichLinkHref,
  RICH_MAX_DEPTH,
  RICH_MAX_NODE_COUNT,
  type ExternalRichBlock,
  type ExternalRichDocumentResult,
  type ExternalRichDocumentV1,
  type ExternalRichInline,
  type ExternalRichMark,
} from '../../models/external-rich-document';
import { isRecord } from '../vendor-shared';

type AdfNode = Record<string, unknown>;

const SUPPORTED_TEXT_MARKS = new Set(['strong', 'em', 'code', 'link']);

type AdfFailReason = 'unsupported_mark' | 'limit_exceeded';

interface ParseContext {
  nodes: number;
  failReason: AdfFailReason | null;
}

function parseMarks(value: unknown, context: ParseContext): ExternalRichMark[] | null {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    context.failReason = 'unsupported_mark';
    return null;
  }
  const marks: ExternalRichMark[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.type !== 'string') {
      context.failReason = 'unsupported_mark';
      return null;
    }
    if (!SUPPORTED_TEXT_MARKS.has(item.type)) {
      context.failReason = 'unsupported_mark';
      return null;
    }
    if (item.type === 'strong') {
      marks.push({ type: 'bold' });
    } else if (item.type === 'em') {
      marks.push({ type: 'italic' });
    } else if (item.type === 'code') {
      marks.push({ type: 'code' });
    } else if (!isSafeRichLinkHref(isRecord(item.attrs) ? item.attrs.href : undefined)) {
      context.failReason = 'unsupported_mark';
      return null;
    } else {
      marks.push({ type: 'link', href: (item.attrs as { href: string }).href });
    }
  }
  return marks;
}

function parseInline(nodes: AdfNode[], context: ParseContext): ExternalRichInline[] | null {
  const inline: ExternalRichInline[] = [];
  for (const node of nodes) {
    context.nodes += 1;
    if (context.nodes > RICH_MAX_NODE_COUNT) {
      context.failReason = 'limit_exceeded';
      return null;
    }
    if (!isRecord(node) || typeof node.type !== 'string') {
      return null;
    }
    if (node.type === 'hardBreak') {
      inline.push({ type: 'hardBreak' });
      continue;
    }
    if (node.type !== 'text' || typeof node.text !== 'string') {
      return null;
    }
    const marks = parseMarks(node.marks, context);
    if (marks === null) {
      return null;
    }
    inline.push({ type: 'text', text: node.text, marks });
  }
  return inline;
}

function parseBlock(node: unknown, depth: number, context: ParseContext): ExternalRichBlock | null {
  if (depth > RICH_MAX_DEPTH) {
    return null;
  }
  if (!isRecord(node) || typeof node.type !== 'string') {
    return null;
  }
  context.nodes += 1;
  if (context.nodes > RICH_MAX_NODE_COUNT) {
    return null;
  }
  switch (node.type) {
    case 'paragraph': {
      if (!Array.isArray(node.content)) {
        return null;
      }
      const content = parseInline(node.content, context);
      return content === null || content.length === 0 ? null : { type: 'paragraph', content };
    }
    case 'heading': {
      const level = isRecord(node.attrs) ? node.attrs.level : undefined;
      if (
        typeof level !== 'number' ||
        !Number.isInteger(level) ||
        level < 1 ||
        level > 6 ||
        !Array.isArray(node.content)
      ) {
        return null;
      }
      const content = parseInline(node.content, context);
      return content === null || content.length === 0
        ? null
        : { type: 'heading', level: level as 1 | 2 | 3 | 4 | 5 | 6, content };
    }
    case 'bulletList': {
      if (!Array.isArray(node.content)) {
        return null;
      }
      const items: ExternalRichInline[][] = [];
      for (const item of node.content) {
        // A verified list item is exactly one paragraph; nested blocks or
        // nested lists were never verified and stay read-only.
        if (
          !isRecord(item) ||
          item.type !== 'listItem' ||
          !Array.isArray(item.content) ||
          item.content.length !== 1 ||
          !isRecord(item.content[0]) ||
          item.content[0].type !== 'paragraph' ||
          !Array.isArray(item.content[0].content)
        ) {
          return null;
        }
        const inline = parseInline(item.content[0].content, context);
        if (inline === null || inline.length === 0) {
          return null;
        }
        items.push(inline);
      }
      return items.length === 0 ? null : { type: 'bulletList', items };
    }
    case 'blockquote': {
      if (!Array.isArray(node.content)) {
        return null;
      }
      const paragraphs: ExternalRichInline[][] = [];
      for (const child of node.content) {
        if (!isRecord(child) || child.type !== 'paragraph' || !Array.isArray(child.content)) {
          return null;
        }
        const inline = parseInline(child.content, context);
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

/** ADF document → canonical. Unsupported or over-limit content yields
 * `supported: false` so callers keep the whole document read-only. */
export function adfToRichDocument(value: unknown): ExternalRichDocumentResult {
  if (
    !isRecord(value) ||
    value.type !== 'doc' ||
    value.version !== 1 ||
    !Array.isArray(value.content)
  ) {
    return { supported: false, reason: 'invalid_input' };
  }
  const context: ParseContext = { nodes: 0, failReason: null };
  const blocks: ExternalRichBlock[] = [];
  for (const node of value.content) {
    const block = parseBlock(node, 1, context);
    if (block === null) {
      return {
        supported: false,
        reason: context.failReason ?? 'unsupported_node',
      };
    }
    blocks.push(block);
  }
  const canonical = canonicalizeRichDocument({ version: 1, blocks });
  return canonical === null
    ? { supported: false, reason: 'limit_exceeded' }
    : { supported: true, document: canonical };
}

function emitMarks(marks: ExternalRichMark[]): unknown[] {
  return marks.map((mark) => {
    switch (mark.type) {
      case 'bold':
        return { type: 'strong' };
      case 'italic':
        return { type: 'em' };
      case 'code':
        return { type: 'code' };
      case 'link':
        return { type: 'link', attrs: { href: mark.href } };
    }
  });
}

function emitInline(inline: ExternalRichInline[]): AdfNode[] {
  return inline.map((run) =>
    run.type === 'hardBreak'
      ? { type: 'hardBreak' }
      : run.marks.length === 0
        ? { type: 'text', text: run.text }
        : { type: 'text', text: run.text, marks: emitMarks(run.marks) },
  );
}

/** Canonical → ADF. Input is the closed model, so emission cannot fail. */
export function richDocumentToAdf(document: ExternalRichDocumentV1): AdfNode {
  const canonical = canonicalizeRichDocument(document);
  const blocks = canonical === null ? document.blocks : canonical.blocks;
  return {
    type: 'doc',
    version: 1,
    content: blocks.map((block) => {
      switch (block.type) {
        case 'paragraph':
          return { type: 'paragraph', content: emitInline(block.content) };
        case 'heading':
          return {
            type: 'heading',
            attrs: { level: block.level },
            content: emitInline(block.content),
          };
        case 'bulletList':
          return {
            type: 'bulletList',
            content: block.items.map((item) => ({
              type: 'listItem',
              content: [{ type: 'paragraph', content: emitInline(item) }],
            })),
          };
        case 'blockquote':
          return {
            type: 'blockquote',
            content: block.paragraphs.map((paragraph) => ({
              type: 'paragraph',
              content: emitInline(paragraph),
            })),
          };
      }
    }),
  };
}
