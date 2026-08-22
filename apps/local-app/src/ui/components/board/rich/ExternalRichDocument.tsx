import { Fragment, type ReactNode } from 'react';
import type {
  ExternalRichBlock,
  ExternalRichInline,
  ExternalRichMark,
  ExternalRichDocumentV1,
} from '@/modules/external-integrations/models/external-rich-document';

/**
 * Dependency-free read-only renderer for ExternalRichDocumentV1. The node
 * switch is closed: every block and inline type the canonical model defines
 * renders through explicit JSX, and unknown shapes render nothing — there is
 * no HTML parsing and no dangerouslySetInnerHTML anywhere in this file.
 */

function renderMarks(runs: ReactNode, marks: ExternalRichMark[]): ReactNode {
  let output = runs;
  for (const mark of marks) {
    if (mark.type === 'bold') {
      output = <strong>{output}</strong>;
    } else if (mark.type === 'italic') {
      output = <em>{output}</em>;
    } else if (mark.type === 'code') {
      output = (
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">{output}</code>
      );
    } else {
      // Links stay http(s) by backend validation; the target keeps external
      // pages out of the app's origin without opener access.
      output = (
        <a href={mark.href} target="_blank" rel="noopener noreferrer" className="underline">
          {output}
        </a>
      );
    }
  }
  return output;
}

function renderInline(inline: ExternalRichInline[], keyPrefix: string): ReactNode[] {
  return inline.map((run, index) => {
    const key = `${keyPrefix}-${index}`;
    if (run.type === 'hardBreak') {
      return <br key={key} />;
    }
    if (run.marks.length === 0) {
      return <Fragment key={key}>{run.text}</Fragment>;
    }
    return <Fragment key={key}>{renderMarks(run.text, run.marks)}</Fragment>;
  });
}

function renderBlock(block: ExternalRichBlock, index: number): ReactNode {
  const key = `block-${index}`;
  switch (block.type) {
    case 'paragraph':
      return (
        <p key={key} className="whitespace-pre-wrap break-words">
          {renderInline(block.content, key)}
        </p>
      );
    case 'heading': {
      const levels = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const;
      const Tag = levels[Math.min(Math.max(block.level, 1), 6) - 1]!;
      const sizes = ['text-2xl', 'text-xl', 'text-lg', 'text-base', 'text-sm', 'text-sm'];
      return (
        <Tag key={key} className={`font-semibold ${sizes[block.level - 1]}`}>
          {renderInline(block.content, key)}
        </Tag>
      );
    }
    case 'bulletList':
      return (
        <ul key={key} className="list-disc space-y-1 pl-5">
          {block.items.map((item, itemIndex) => (
            <li key={`${key}-${itemIndex}`}>{renderInline(item, `${key}-${itemIndex}`)}</li>
          ))}
        </ul>
      );
    case 'blockquote':
      return (
        <blockquote key={key} className="border-l-4 border-border pl-3 text-muted-foreground">
          {block.paragraphs.map((paragraph, paragraphIndex) => (
            <p key={`${key}-${paragraphIndex}`} className="whitespace-pre-wrap break-words">
              {renderInline(paragraph, `${key}-${paragraphIndex}`)}
            </p>
          ))}
        </blockquote>
      );
    default:
      // The canonical model is closed; an unknown block cannot occur through
      // validation, and this renderer refuses to guess a representation.
      return null;
  }
}

export function ExternalRichDocument({
  document,
}: {
  document: ExternalRichDocumentV1;
}): ReactNode {
  return (
    <div className="space-y-2 text-sm">
      {document.blocks.map((block, index) => renderBlock(block, index))}
    </div>
  );
}
