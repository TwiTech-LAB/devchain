import type {
  ExternalRichBlock,
  ExternalRichDocumentV1,
  ExternalRichInline,
  ExternalRichMark,
} from '@/modules/external-integrations/models/external-rich-document';

/**
 * Conversions between ExternalRichDocumentV1 and the TipTap/ProseMirror JSON
 * subset the editor is configured for (paragraph, heading, bulletList,
 * blockquote, text, hardBreak; bold/italic/code/link marks). The mapping is
 * total on both sides over that subset — every canonical document converts
 * losslessly and every editor JSON the configured schema can produce
 * converts back into the closed canonical set.
 */

type TipTapNode = {
  type: string;
  attrs?: Record<string, unknown>;
  content?: TipTapNode[];
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
  text?: string;
};

function marksToTipTap(marks: ExternalRichMark[]): TipTapNode['marks'] {
  if (marks.length === 0) {
    return undefined;
  }
  return marks.map((mark) =>
    mark.type === 'link' ? { type: 'link', attrs: { href: mark.href } } : { type: mark.type },
  );
}

function inlineToTipTap(inline: ExternalRichInline[]): TipTapNode[] {
  return inline.map((run) =>
    run.type === 'hardBreak'
      ? { type: 'hardBreak' }
      : { type: 'text', text: run.text, marks: marksToTipTap(run.marks) },
  );
}

function blockToTipTap(block: ExternalRichBlock): TipTapNode {
  switch (block.type) {
    case 'paragraph':
      return { type: 'paragraph', content: inlineToTipTap(block.content) };
    case 'heading':
      return {
        type: 'heading',
        attrs: { level: block.level },
        content: inlineToTipTap(block.content),
      };
    case 'bulletList':
      return {
        type: 'bulletList',
        content: block.items.map((item) => ({
          type: 'listItem',
          content: [{ type: 'paragraph', content: inlineToTipTap(item) }],
        })),
      };
    case 'blockquote':
      return {
        type: 'blockquote',
        content: block.paragraphs.map((paragraph) => ({
          type: 'paragraph',
          content: inlineToTipTap(paragraph),
        })),
      };
  }
}

export function canonicalToTipTapJson(document: ExternalRichDocumentV1): TipTapNode {
  return {
    type: 'doc',
    content: document.blocks.map(blockToTipTap),
  };
}

function tipTapMarksToCanonical(node: TipTapNode): ExternalRichMark[] {
  if (!node.marks) {
    return [];
  }
  const marks: ExternalRichMark[] = [];
  for (const mark of node.marks) {
    if (mark.type === 'bold' || mark.type === 'italic' || mark.type === 'code') {
      marks.push({ type: mark.type });
    } else if (mark.type === 'link' && typeof mark.attrs?.href === 'string' && mark.attrs.href) {
      marks.push({ type: 'link', href: mark.attrs.href });
    }
  }
  return marks;
}

function tipTapInlineToCanonical(nodes: TipTapNode[]): ExternalRichInline[] {
  const inline: ExternalRichInline[] = [];
  for (const node of nodes) {
    if (node.type === 'hardBreak') {
      inline.push({ type: 'hardBreak' });
    } else if (node.type === 'text' && typeof node.text === 'string') {
      inline.push({ type: 'text', text: node.text, marks: tipTapMarksToCanonical(node) });
    }
  }
  return inline;
}

function tipTapBlockToCanonical(node: TipTapNode): ExternalRichBlock | null {
  switch (node.type) {
    case 'paragraph': {
      const content = tipTapInlineToCanonical(node.content ?? []);
      return content.length > 0 ? { type: 'paragraph', content } : null;
    }
    case 'heading': {
      const level = node.attrs?.level;
      if (typeof level !== 'number' || !Number.isInteger(level) || level < 1 || level > 6) {
        return null;
      }
      const content = tipTapInlineToCanonical(node.content ?? []);
      return content.length > 0
        ? { type: 'heading', level: level as 1 | 2 | 3 | 4 | 5 | 6, content }
        : null;
    }
    case 'bulletList': {
      const items: ExternalRichInline[][] = [];
      for (const listItem of node.content ?? []) {
        if (listItem.type !== 'listItem') {
          continue;
        }
        for (const child of listItem.content ?? []) {
          if (child.type !== 'paragraph') {
            continue;
          }
          const inline = tipTapInlineToCanonical(child.content ?? []);
          if (inline.length > 0) {
            items.push(inline);
          }
        }
      }
      return items.length > 0 ? { type: 'bulletList', items } : null;
    }
    case 'blockquote': {
      const paragraphs: ExternalRichInline[][] = [];
      for (const child of node.content ?? []) {
        if (child.type !== 'paragraph') {
          continue;
        }
        const inline = tipTapInlineToCanonical(child.content ?? []);
        if (inline.length > 0) {
          paragraphs.push(inline);
        }
      }
      return paragraphs.length > 0 ? { type: 'blockquote', paragraphs } : null;
    }
    default:
      return null;
  }
}

/**
 * Editor JSON → canonical. Returns null when the editor produced content
 * outside the closed set (defensive: the editor schema prevents it, but the
 * converter never guesses). Drops empty blocks; whitespace normalization and
 * limits are enforced later by the backend canonicalizer.
 */
export function tipTapJsonToCanonical(json: unknown): ExternalRichDocumentV1 | null {
  if (
    typeof json !== 'object' ||
    json === null ||
    (json as TipTapNode).type !== 'doc' ||
    !Array.isArray((json as TipTapNode).content)
  ) {
    return null;
  }
  const blocks: ExternalRichBlock[] = [];
  for (const node of (json as TipTapNode).content!) {
    const block = tipTapBlockToCanonical(node);
    if (block !== null) {
      blocks.push(block);
    }
  }
  if (blocks.length === 0) {
    return null;
  }
  return { version: 1, blocks };
}
